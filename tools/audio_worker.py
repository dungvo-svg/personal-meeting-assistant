"""Windows source capture and local Vietnamese ASR. Audio stays in bounded RAM."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import queue
import re
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


def loopback_level(audio, pa, device, seconds):
    # Level only: peak of what the output device is playing now. No audio is kept.
    import numpy as np
    state = {'frames': 0, 'peak': 0.0}

    def callback(data, frames, info, status):
        samples = np.frombuffer(data, dtype=np.float32)
        state['frames'] += frames
        if len(samples):
            state['peak'] = max(state['peak'], float(np.abs(samples).max()))
        return (None, pa.paContinue)

    stream = audio.open(format=pa.paFloat32, channels=int(device['maxInputChannels']), rate=int(device['defaultSampleRate']), input=True, input_device_index=device['index'], frames_per_buffer=1024, stream_callback=callback)
    try:
        time.sleep(seconds)
    finally:
        stream.stop_stream()
        stream.close()
    return {'framesReceived': state['frames'], 'peak': round(state['peak'], 4), 'probeSeconds': seconds}


def list_devices(levels=False):
    import pyaudiowpatch as pa
    with pa.PyAudio() as audio:
        wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)
        default_output = audio.get_device_info_by_index(wasapi['defaultOutputDevice'])['name'] if wasapi['defaultOutputDevice'] >= 0 else None
        result = []
        for index in range(audio.get_device_count()):
            device = audio.get_device_info_by_index(index)
            if device['hostApi'] != wasapi['index'] or device['maxInputChannels'] < 1:
                continue
            loopback = bool(device.get('isLoopbackDevice'))
            item = {'index': index, 'name': device['name'], 'kind': 'speaker_loopback_all_device_audio' if loopback else 'microphone', 'channels': int(device['maxInputChannels']), 'rate': int(device['defaultSampleRate'])}
            if loopback:
                item['isDefaultOutput'] = bool(default_output) and device['name'] == default_output + ' [Loopback]'
                if levels:
                    # Microphones are never opened by the probe.
                    try:
                        item['level'] = loopback_level(audio, pa, device, 1.5)
                    except Exception as exc:
                        item['level'] = {'error': str(exc)}
            result.append(item)
        return result


def render_keepalive(audio, pa, loopback_device):
    # WASAPI loopback delivers no frames while the device is silent. Playing digital
    # silence on the same output keeps frames flowing, so silence boundaries flush
    # and the level meter stays truthful. Adds nothing audible.
    target = loopback_device['name'].removesuffix(' [Loopback]')
    wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)
    for index in range(audio.get_device_count()):
        device = audio.get_device_info_by_index(index)
        if device['hostApi'] == wasapi['index'] and device['name'] == target and device['maxOutputChannels'] > 0 and not device.get('isLoopbackDevice'):
            channels = min(2, int(device['maxOutputChannels']))
            return audio.open(format=pa.paFloat32, channels=channels, rate=int(device['defaultSampleRate']), output=True, output_device_index=index, frames_per_buffer=1024, stream_callback=lambda _data, frames, *_: (bytes(4 * channels * frames), pa.paContinue))
    return None


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


# Phrases Whisper invents over silence or music. They are kept but flagged, never silently removed.
SILENCE_PHRASES = ('đăng ký kênh', 'subscribe', 'cảm ơn các bạn đã theo dõi', 'cảm ơn các bạn đã xem', 'hẹn gặp lại các bạn', 'ghiền mì gõ', 'like và share')
REPEAT = re.compile(r'(\b\S+\b)(?:\W+\1\b){5,}', re.IGNORECASE)


def segment_flags(text, segment, language):
    flags = []
    # Whisper small often writes Lao speech in Thai script; flag it instead of presenting it as Lao text.
    if language == 'lo' and any('฀' <= ch <= '๿' for ch in text):
        flags.append('LAO_WRITTEN_IN_THAI_SCRIPT')
    if any(phrase in text.lower() for phrase in SILENCE_PHRASES) or segment.no_speech_prob > 0.6:
        flags.append('LIKELY_HALLUCINATION')
    if segment.compression_ratio > 2.4 or REPEAT.search(text):
        flags.append('REPETITION')
    return flags


def collapse_repeats(text):
    return REPEAT.sub(lambda m: f'{m.group(1)} [×{len(re.findall(re.escape(m.group(1)), m.group(0), re.IGNORECASE))}]', text)


def transcribe_chunk(model, waveform16, languages):
    # max_new_tokens stops repetition loops on noisy or misdetected chunks.
    options = {'task': 'transcribe', 'max_new_tokens': 160, 'beam_size': 1, 'temperature': 0, 'condition_on_previous_text': False, 'vad_filter': True, 'vad_parameters': {'min_silence_duration_ms': 400}, 'no_speech_threshold': 0.6}
    if len(languages) == 1:
        segments, _ = model.transcribe(waveform16, language=languages[0], **options)
        return segments, languages[0], None
    # Detection reuses the first encoder pass. Whisper often hears Lao as Thai, so Thai
    # counts toward Lao. A detected language other than vi/lo costs a second, forced pass.
    segments, info = model.transcribe(waveform16, language=None, **options)
    probabilities = dict(info.all_language_probs or [])
    scores = {'vi': probabilities.get('vi', 0.0), 'lo': probabilities.get('lo', 0.0) + probabilities.get('th', 0.0)}
    language = max(languages, key=lambda code: scores[code])
    if language != info.language:
        segments, _ = model.transcribe(waveform16, language=language, **options)
    total = scores['vi'] + scores['lo']
    return segments, language, round(scores[language] / total, 3) if total else None


def capture(args):
    import numpy as np
    import pyaudiowpatch as pa
    import av
    from faster_whisper import WhisperModel
    threading.Thread(target=parent_watch, args=(args.parent,), daemon=True).start()
    languages = args.languages.split(',')
    if not languages or any(code not in ('vi', 'lo') for code in languages):
        raise ValueError('Languages must be vi, lo or vi,lo')
    # Mixed sessions use longer chunks: detection is more reliable and per-chunk overhead stays below real time.
    min_chunk_seconds = 6 if len(languages) > 1 else 3
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
    keepalive = None
    keepalive_note = 'NOT_LOOPBACK'
    if device.get('isLoopbackDevice'):
        try:
            keepalive = render_keepalive(audio, pa, device)
            keepalive_note = 'SILENT_RENDER_ACTIVE' if keepalive else 'RENDER_DEVICE_NOT_FOUND_FRAMES_STOP_WHEN_SILENT'
        except Exception as exc:
            keepalive_note = 'KEEPALIVE_FAILED_FRAMES_STOP_WHEN_SILENT: ' + str(exc)
    stream = audio.open(format=pa.paFloat32, channels=channels, rate=rate, input=True, input_device_index=args.device, frames_per_buffer=2048)
    capture_started = time.monotonic()

    def reader():
        samples = 0
        block_start = 0
        blocks = []
        silence_samples = 0
        block_samples = 0
        block_peak_rms = 0.0
        last_meter = 0.0
        ready = False
        try:
            while not stop.is_set():
                if time.monotonic() - capture_started > args.max_seconds:
                    raise RuntimeError('Authorized capture duration reached; source stopped.')
                # A short CPU stall must not end a long meeting; overflow is reported, not fatal.
                raw = stream.read(2048, exception_on_overflow=False)
                if not ready:
                    emit({'type': 'ready', 'device': device['name'], 'sampleRate': rate, 'channels': channels, 'languages': languages, 'model': 'faster-whisper-small-int8-cpu', 'modelLoadSeconds': round(time.monotonic() - started, 3), 'audioStorage': 'RAM_ONLY', 'maxQueuedChunks': 4, 'maxChunkSeconds': 12, 'maxSessionSeconds': args.max_seconds, 'firstReadBytes': len(raw), 'loopbackKeepalive': keepalive_note})
                    ready = True
                mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).mean(axis=1)
                blocks.append(mono.copy())
                block_samples += len(mono)
                samples += len(mono)
                rms = float(np.sqrt(np.mean(mono * mono)))
                block_peak_rms = max(block_peak_rms, rms)
                silence_samples = silence_samples + len(mono) if rms < 0.006 else 0
                if time.monotonic() - last_meter > 1:
                    emit({'type': 'status', 'capturedSeconds': samples / rate, 'rms': round(rms, 5), 'queuedChunks': chunks.qsize(), 'lastSoundSecondsAgo': round(silence_samples / rate, 1)})
                    last_meter = time.monotonic()
                duration = block_samples / rate
                # Silence boundaries reduce cut words. Long uninterrupted speech has an explicit boundary warning.
                if duration >= 12 or (duration >= min_chunk_seconds and silence_samples / rate >= 0.55):
                    # Pure digital/room silence is not sent to ASR; it only costs CPU and backlog.
                    if block_peak_rms >= 0.006:
                        chunk = (np.concatenate(blocks), block_start / rate, samples / rate, 'MAX_WINDOW_POSSIBLE_WORD_CUT' if duration >= 12 else 'SILENCE_BOUNDARY_HEURISTIC')
                        try:
                            chunks.put_nowait(chunk)
                        except queue.Full:
                            # ASR is behind: keep growing this block (bounded) instead of stopping the meeting.
                            if duration < 30:
                                continue
                            # Still behind after 30 s: drop this block from RAM and record the gap explicitly.
                            emit({'type': 'gap', 'start': block_start / rate, 'end': samples / rate, 'reason': 'ASR_BEHIND_AUDIO_DROPPED'})
                    blocks = []
                    block_samples = 0
                    block_peak_rms = 0.0
                    block_start = samples
            if block_samples:
                emit({'type': 'status', 'discardedTailSeconds': block_samples / rate, 'tailReason': 'STOP_NO_NEW_SOURCE'})
        except Exception as exc:
            emit({'type': 'error', 'message': str(exc)})
            stop.set()
        finally:
            stream.stop_stream()
            stream.close()
            if keepalive:
                keepalive.stop_stream()
                keepalive.close()

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
            segments, language, language_probability = transcribe_chunk(model, waveform16, languages)
            for segment in segments:
                if stop.is_set():
                    break
                text = segment.text.strip()
                if text:
                    marks = ''.join('; ' + flag for flag in segment_flags(text, segment, language))
                    emit({'type': 'source', 'text': collapse_repeats(text), 'start': begin, 'end': end, 'boundary': boundary + '; CHUNK_RANGE_NOT_WORD_TIMESTAMPS' + marks, 'language': language, 'languageProbability': language_probability})
            emit({'type': 'status', 'lastASRSeconds': round(time.monotonic() - inference_started, 3), 'lastChunkSeconds': round(end - begin, 3), 'queuedChunks': chunks.qsize()})
            del waveform, waveform16
    finally:
        stop.set()
        reader_thread.join(timeout=2)
        audio.terminate()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--levels', action='store_true')
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--device', type=int)
    parser.add_argument('--device-name')
    parser.add_argument('--model')
    parser.add_argument('--parent', type=int)
    parser.add_argument('--max-seconds', type=int, default=7200)
    parser.add_argument('--languages', default='vi,lo')
    args = parser.parse_args()
    try:
        if args.list:
            emit(list_devices(args.levels))
        elif args.capture:
            if not 1 <= args.max_seconds <= 7200:
                raise ValueError('Capture duration must be between 1 and 7200 seconds')
            capture(args)
        else:
            parser.error('Select --list or --capture')
    except Exception as exc:
        emit({'type': 'error', 'message': str(exc)})
        sys.exit(1)
