"""Windows source capture and local Vietnamese ASR. Audio stays in bounded RAM."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
output_lock = threading.Lock()


def emit(value):
    with output_lock:
        print(json.dumps(value, ensure_ascii=False), flush=True)


def list_devices():
    import pyaudiowpatch as pa
    with pa.PyAudio() as audio:
        wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)
        result = []
        for index in range(audio.get_device_count()):
            device = audio.get_device_info_by_index(index)
            if device['hostApi'] != wasapi['index'] or device['maxInputChannels'] < 1:
                continue
            loopback = bool(device.get('isLoopbackDevice'))
            result.append({'index': index, 'name': device['name'], 'kind': 'speaker_loopback_all_device_audio' if loopback else 'microphone', 'channels': int(device['maxInputChannels']), 'rate': int(device['defaultSampleRate'])})
        return result


def parent_watch(pid):
    # The recorder must not outlive its owning Node process after a crash.
    if not pid or os.name != 'nt':
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, 0, pid)
    if not handle:
        os._exit(2)
    kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
    kernel.CloseHandle(handle)
    os._exit(0)


def capture(args):
    import numpy as np
    import pyaudiowpatch as pa
    import av
    from faster_whisper import WhisperModel
    threading.Thread(target=parent_watch, args=(args.parent,), daemon=True).start()
    stop = threading.Event()
    chunks = queue.Queue(maxsize=4)

    def commands():
        for line in sys.stdin:
            if line.strip() == 'stop':
                stop.set()
                return
        stop.set()

    threading.Thread(target=commands, daemon=True).start()
    model_path = Path(args.model).resolve(strict=True)
    started = time.monotonic()
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=6, num_workers=1, local_files_only=True)
    if stop.is_set():
        return
    audio = pa.PyAudio()
    device = audio.get_device_info_by_index(args.device)
    if device['name'] != args.device_name or device['maxInputChannels'] < 1:
        raise RuntimeError('Selected audio device changed. Re-select on the panel.')
    rate = int(device['defaultSampleRate'])
    channels = int(device['maxInputChannels'])
    if channels > 8 or rate > 192000:
        raise RuntimeError('Unsupported source format')
    stream = audio.open(format=pa.paFloat32, channels=channels, rate=rate, input=True, input_device_index=args.device, frames_per_buffer=2048)
    capture_started = time.monotonic()

    def reader():
        samples = 0
        block_start = 0
        blocks = []
        silence_samples = 0
        block_samples = 0
        last_meter = 0.0
        ready = False
        try:
            while not stop.is_set():
                if time.monotonic() - capture_started > args.max_seconds:
                    raise RuntimeError('Authorized capture duration reached; source stopped.')
                raw = stream.read(2048, exception_on_overflow=True)
                if not ready:
                    emit({'type': 'ready', 'device': device['name'], 'sampleRate': rate, 'channels': channels, 'language': 'vi', 'model': 'faster-whisper-small-int8-cpu', 'modelLoadSeconds': round(time.monotonic() - started, 3), 'audioStorage': 'RAM_ONLY', 'maxQueuedChunks': 4, 'maxChunkSeconds': 12, 'maxSessionSeconds': args.max_seconds, 'firstReadBytes': len(raw)})
                    ready = True
                mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).mean(axis=1)
                blocks.append(mono.copy())
                block_samples += len(mono)
                samples += len(mono)
                rms = float(np.sqrt(np.mean(mono * mono)))
                silence_samples = silence_samples + len(mono) if rms < 0.006 else 0
                if time.monotonic() - last_meter > 1:
                    emit({'type': 'status', 'capturedSeconds': samples / rate, 'rms': round(rms, 5), 'queuedChunks': chunks.qsize()})
                    last_meter = time.monotonic()
                duration = block_samples / rate
                # Silence boundaries reduce cut words. Long uninterrupted speech has an explicit boundary warning.
                if duration >= 12 or (duration >= 3 and silence_samples / rate >= 0.55):
                    chunk = (np.concatenate(blocks), block_start / rate, samples / rate, 'MAX_WINDOW_POSSIBLE_WORD_CUT' if duration >= 12 else 'SILENCE_BOUNDARY_HEURISTIC')
                    try:
                        chunks.put_nowait(chunk)
                    except queue.Full:
                        raise RuntimeError('ASR_BACKLOG_LIMIT: source stopped; unprocessed audio discarded from RAM, coverage incomplete.')
                    blocks = []
                    block_samples = 0
                    block_start = samples
            if block_samples:
                emit({'type': 'status', 'discardedTailSeconds': block_samples / rate, 'tailReason': 'STOP_NO_NEW_SOURCE'})
        except Exception as exc:
            emit({'type': 'error', 'message': str(exc)})
            stop.set()
        finally:
            stream.stop_stream()
            stream.close()

    reader_thread = threading.Thread(target=reader, daemon=True)
    emit({'type': 'prepared', 'modelReady': True, 'device': device['name'], 'firstReadVerified': False})
    reader_thread.start()
    try:
        while not stop.is_set():
            try:
                waveform, begin, end, boundary = chunks.get(timeout=0.2)
            except queue.Empty:
                continue
            frame = av.AudioFrame.from_ndarray(waveform.reshape(1, -1), format='flt', layout='mono')
            frame.sample_rate = rate
            resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
            converted = resampler.resample(frame) + resampler.resample(None)
            waveform16 = np.concatenate([f.to_ndarray().reshape(-1) for f in converted]).astype(np.float32)
            inference_started = time.monotonic()
            segments, info = model.transcribe(waveform16, language='vi', task='transcribe', beam_size=1, temperature=0, condition_on_previous_text=False, vad_filter=True, vad_parameters={'min_silence_duration_ms': 400}, no_speech_threshold=0.6)
            for segment in segments:
                if stop.is_set():
                    break
                text = segment.text.strip()
                if text:
                    emit({'type': 'source', 'text': text, 'start': begin, 'end': end, 'boundary': boundary + '; CHUNK_RANGE_NOT_WORD_TIMESTAMPS'})
            emit({'type': 'status', 'lastASRSeconds': round(time.monotonic() - inference_started, 3), 'lastChunkSeconds': round(end - begin, 3), 'queuedChunks': chunks.qsize()})
            del waveform, waveform16
    finally:
        stop.set()
        reader_thread.join(timeout=2)
        audio.terminate()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--device', type=int)
    parser.add_argument('--device-name')
    parser.add_argument('--model')
    parser.add_argument('--parent', type=int)
    parser.add_argument('--max-seconds', type=int, default=7200)
    args = parser.parse_args()
    try:
        if args.list:
            emit(list_devices())
        elif args.capture:
            if not 1 <= args.max_seconds <= 7200:
                raise ValueError('Capture duration must be between 1 and 7200 seconds')
            capture(args)
        else:
            parser.error('Select --list or --capture')
    except Exception as exc:
        emit({'type': 'error', 'message': str(exc)})
        sys.exit(1)
