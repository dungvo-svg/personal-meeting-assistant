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


def enable_cuda_libraries():
    # cuBLAS/cuDNN come from pip NVIDIA wheels (site-packages/nvidia/*/bin). CTranslate2 loads them by name,
    # which on Windows searches PATH, not os.add_dll_directory. Returns whether any were found.
    import glob
    import site
    dirs = [d for base in site.getsitepackages() for d in glob.glob(os.path.join(base, 'nvidia', '*', 'bin'))]
    if dirs:
        os.environ['PATH'] = os.pathsep.join(dirs + [os.environ.get('PATH', '')])
    return bool(dirs)


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


# Longest chunk before a forced cut, and how long a backed-up queue may keep growing a chunk before audio is dropped.
MAX_CHUNK_SECONDS = 20
GROWTH_LIMIT_SECONDS = MAX_CHUNK_SECONDS + 10
LANG_UNSURE_BELOW = 0.65
LAO_LOW_LOGPROB = -1.0


def split_point(block_rms, block_sizes, rate, window_seconds=3):
    # Where to cut a chunk that hit the hard window: the quietest block among those covering the last window_seconds
    # (the latest one on ties). Returns the index of the last block of the first chunk; never below 0.
    best = len(block_rms) - 1
    covered = 0
    for index in range(len(block_rms) - 1, -1, -1):
        if block_rms[index] < block_rms[best]:
            best = index
        covered += block_sizes[index]
        if covered >= window_seconds * rate:
            break
    return best


def segment_flags(text, segment, language, language_probability=None):
    flags = []
    # Whisper small often writes Lao speech in Thai script; flag it instead of presenting it as Lao text.
    if language == 'lo' and any('฀' <= ch <= '๿' for ch in text):
        flags.append('LAO_WRITTEN_IN_THAI_SCRIPT')
    if any(phrase in text.lower() for phrase in SILENCE_PHRASES) or segment.no_speech_prob > 0.6:
        flags.append('LIKELY_HALLUCINATION')
    if segment.compression_ratio > 2.4 or REPEAT.search(text):
        flags.append('REPETITION')
    if language_probability is not None and language_probability < LANG_UNSURE_BELOW:
        flags.append('LANG_UNSURE')
    if language == 'lo' and getattr(segment, 'avg_logprob', 0.0) < LAO_LOW_LOGPROB:
        flags.append('LAO_LOW_CONFIDENCE')
    return flags


def collapse_repeats(text):
    return REPEAT.sub(lambda m: f'{m.group(1)} [×{len(re.findall(re.escape(m.group(1)), m.group(0), re.IGNORECASE))}]', text)


LAO_OPTIONS = {'no_repeat_ngram_size': 3, 'repetition_penalty': 1.2}


def transcribe_chunk(model, waveform16, languages, lao_model=None, vi_model=None):
    # max_new_tokens stops repetition loops on noisy or misdetected chunks.
    options = {'task': 'transcribe', 'max_new_tokens': 224, 'beam_size': 1, 'temperature': 0, 'condition_on_previous_text': False, 'vad_filter': True, 'vad_parameters': {'min_silence_duration_ms': 400}, 'no_speech_threshold': 0.6}
    if languages == ['lo'] and lao_model:
        segments, _ = lao_model.transcribe(waveform16, language='lo', **options, **LAO_OPTIONS)
        return segments, 'lo', None
    if languages == ['vi'] and vi_model:
        segments, _ = vi_model.transcribe(waveform16, language='vi', **options)
        return segments, 'vi', None
    if len(languages) == 1:
        segments, _ = model.transcribe(waveform16, language=languages[0], **options)
        return segments, languages[0], None
    # Detection reuses the first encoder pass. Whisper often hears Lao as Thai, so Thai
    # counts toward Lao. A detected language other than vi/lo costs a second, forced pass.
    segments, info = model.transcribe(waveform16, language=None, **options)
    probabilities = dict(info.all_language_probs or [])
    scores = {'vi': probabilities.get('vi', 0.0), 'lo': probabilities.get('lo', 0.0) + probabilities.get('th', 0.0)}
    language = max(languages, key=lambda code: scores[code])
    if language == 'lo' and lao_model:
        # Lao goes to the Lao model (Lao script); the multilingual model would write Thai script.
        segments, _ = lao_model.transcribe(waveform16, language='lo', **options, **LAO_OPTIONS)
    elif language == 'vi' and vi_model:
        # A Vietnamese-specialised model, when configured, transcribes what the detector called Vietnamese.
        segments, _ = vi_model.transcribe(waveform16, language='vi', **options)
    elif language != info.language:
        segments, _ = model.transcribe(waveform16, language=language, **options)
    total = scores['vi'] + scores['lo']
    return segments, language, round(scores[language] / total, 3) if total else None


MODELS = Path(__file__).resolve().parents[1] / '.local' / 'models'


def asr_profile():
    """Which models to use. .local/models/asr-profile.json may set {"main", "vi", "lo"} (folder names under
    .local/models); "main" detects vi/lo and transcribes anything without a dedicated model. Defaults: Whisper
    small as main, no Vietnamese model, BuzzASR/lao when installed."""
    try:
        profile = json.loads((MODELS / 'asr-profile.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        profile = {}

    def path(name):
        return MODELS / name if name and (MODELS / name).is_dir() else None
    return {'main': path(profile.get('main')) or MODELS / 'small', 'vi': path(profile.get('vi')), 'lo': path(profile.get('lo', 'buzzasr-lao-ct2'))}


def load_models(model_path, lao_model_path, device_choice, threads, vi_model_path=None):
    """Main model on CUDA when it works (pip NVIDIA libraries), else CPU. The Lao and Vietnamese models are
    Whisper large size: they load only on CUDA, on CPU they cannot keep up with a live meeting."""
    import numpy as np
    from faster_whisper import WhisperModel
    if device_choice in ('auto', 'cuda') and enable_cuda_libraries():
        try:
            def gpu(path):
                return WhisperModel(str(path), device='cuda', compute_type='int8_float16', local_files_only=True)
            model = gpu(model_path)
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language='vi')[0])
            lao = gpu(lao_model_path) if lao_model_path and Path(lao_model_path).is_dir() else None
            vi = gpu(vi_model_path) if vi_model_path and Path(vi_model_path).is_dir() else None
            return model, lao, vi, {'device': 'cuda', 'mainModel': Path(model_path).name, 'laoModel': Path(lao_model_path).name if lao else None, 'viModel': Path(vi_model_path).name if vi else None}
        except Exception as exc:
            if device_choice == 'cuda':
                raise
            fallback = str(exc)[:200]
    else:
        fallback = 'CUDA libraries not found' if device_choice != 'cpu' else None
    # CPU: only a small main model keeps up in real time.
    cpu_model = model_path if any(size in Path(model_path).name for size in ('small', 'base', 'tiny')) else MODELS / 'small'
    model = WhisperModel(str(cpu_model), device='cpu', compute_type='int8', cpu_threads=threads, num_workers=1, local_files_only=True)
    return model, None, None, {'device': 'cpu', 'mainModel': Path(cpu_model).name, 'laoModel': None, 'viModel': None, 'cudaFallback': fallback}


def load_recording(path):
    # Decode a recording to 16 kHz mono float32 in RAM; no audio file is written.
    import av
    import numpy as np
    container = av.open(str(path))
    resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
    parts = [frame.to_ndarray().reshape(-1) for packet in container.decode(audio=0) for frame in resampler.resample(packet)]
    parts += [frame.to_ndarray().reshape(-1) for frame in resampler.resample(None)]
    container.close()
    return np.concatenate(parts).astype(np.float32)


# A microphone near the speakers also hears the meeting. A mic chunk is kept as the user's own speech only when, in
# enough of its loud blocks, the mic is clearly louder than what the speakers play at the same moment.
MIC_OVER_SPEAKER = 2.0
MIC_OWN_SHARE = 0.3
SOUND_RMS = 0.006


def mic_is_own_voice(mic_rms, speaker_rms, ratio=MIC_OVER_SPEAKER, share=MIC_OWN_SHARE):
    loud = [(m, s) for m, s in zip(mic_rms, speaker_rms) if m >= SOUND_RMS]
    if not loud:
        return False
    return sum(1 for m, s in loud if m > ratio * s) / len(loud) >= share


def raise_priority():
    # Other work on the machine (agents, builds) must not make the transcript fall behind the meeting.
    if os.name == 'nt':
        try:
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x8000)  # ABOVE_NORMAL
        except Exception:
            pass


def open_input(audio, index, expected_name):
    device = audio.get_device_info_by_index(index)
    if device['name'] != expected_name or device['maxInputChannels'] < 1:
        raise RuntimeError('Selected audio device changed. Re-select the source.')
    rate, channels = int(device['defaultSampleRate']), int(device['maxInputChannels'])
    if channels > 8 or rate > 192000:
        raise RuntimeError('Unsupported source format')
    return device, rate, channels


def capture(args):
    import numpy as np
    import av
    threading.Thread(target=parent_watch, args=(args.parent,), daemon=True).start()
    languages = args.languages.split(',')
    if not languages or any(code not in ('vi', 'lo') for code in languages):
        raise ValueError('Languages must be vi, lo or vi,lo')
    # Mixed sessions use longer chunks: detection is more reliable and per-chunk overhead stays below real time.
    min_chunk_seconds = 6 if len(languages) > 1 else 3
    stop = threading.Event()
    chunks = queue.Queue(maxsize=6)

    def commands():
        for line in sys.stdin:
            if line.strip() == 'stop':
                stop.set()
                return
        stop.set()

    if not args.wait_source:
        threading.Thread(target=commands, daemon=True).start()
    raise_priority()
    profile = asr_profile()
    model_path = Path(args.model or profile['main']).resolve(strict=True)
    started = time.monotonic()
    model, lao_model, vi_model, asr = load_models(model_path, args.lao_model or profile['lo'], args.asr_device, 6, args.vi_model or profile['vi'])
    if args.wait_source:
        # Warm start: models load when the session opens; the source arrives later as one JSON line on stdin.
        emit({'type': 'warm', 'asr': asr, 'modelLoadSeconds': round(time.monotonic() - started, 3)})
        line = sys.stdin.readline().strip()
        if not line or line == 'stop':
            return
        request = json.loads(line)
        if request.get('replay'):
            args.replay, args.speed = request['replay'], float(request.get('speed', 1))
        else:
            args.device, args.device_name = int(request['device']), str(request['deviceName'])
            if request.get('micDevice') is not None:
                args.mic_device, args.mic_name = int(request['micDevice']), str(request['micName'])
        args.max_seconds = int(request.get('maxSeconds', args.max_seconds))
        threading.Thread(target=commands, daemon=True).start()
    if stop.is_set():
        return
    audio = keepalive = None
    streams = []
    source_done = threading.Event()
    speaker_levels = {}  # 0.1 s slot since capture start -> speaker RMS, for the mic echo check
    if args.replay:
        # Replay a recording through the same chunking and ASR, paced like a live source. No device is opened.
        pcm = load_recording(args.replay)
        rate, channels, source_name, keepalive_note = 16000, 1, Path(args.replay).name, 'REPLAY_FILE'
        position = [0]

        def read_block():
            begin = position[0]
            if begin >= len(pcm):
                raise EOFError
            block = pcm[begin:begin + 2048]
            position[0] += len(block)
            delay = capture_started + position[0] / rate / args.speed - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            return block.tobytes()
        inputs = [('speaker', read_block, rate, channels)]
    else:
        import pyaudiowpatch as pa
        audio = pa.PyAudio()
        device, rate, channels = open_input(audio, args.device, args.device_name)
        source_name = device['name']
        keepalive_note = 'NOT_LOOPBACK'
        if device.get('isLoopbackDevice'):
            try:
                keepalive = render_keepalive(audio, pa, device)
                keepalive_note = 'SILENT_RENDER_ACTIVE' if keepalive else 'RENDER_DEVICE_NOT_FOUND_FRAMES_STOP_WHEN_SILENT'
            except Exception as exc:
                keepalive_note = 'KEEPALIVE_FAILED_FRAMES_STOP_WHEN_SILENT: ' + str(exc)
        stream = audio.open(format=pa.paFloat32, channels=channels, rate=rate, input=True, input_device_index=args.device, frames_per_buffer=2048)
        streams.append(stream)
        # A short CPU stall must not end a long meeting; overflow is reported, not fatal.
        inputs = [('speaker', lambda: stream.read(2048, exception_on_overflow=False), rate, channels)]
        if args.mic_device is not None:
            # The user's own microphone ("Tôi"), only when they agreed to it in chat for this session.
            mic, mic_rate, mic_channels = open_input(audio, args.mic_device, args.mic_name)
            if mic.get('isLoopbackDevice'):
                raise RuntimeError('Microphone channel must be a microphone, not a loopback device')
            mic_stream = audio.open(format=pa.paFloat32, channels=mic_channels, rate=mic_rate, input=True, input_device_index=args.mic_device, frames_per_buffer=2048)
            streams.append(mic_stream)
            inputs.append(('mic', lambda: mic_stream.read(2048, exception_on_overflow=False), mic_rate, mic_channels))
    capture_started = time.monotonic()

    def reader(channel, read_block, rate, channels):
        primary = channel == 'speaker'
        samples = 0
        block_start = 0
        blocks = []
        block_rms = []
        block_sizes = []
        silence_samples = 0
        block_samples = 0
        block_peak_rms = 0.0
        last_meter = 0.0
        ready = False
        try:
            while not stop.is_set():
                if time.monotonic() - capture_started > args.max_seconds:
                    raise RuntimeError('Authorized capture duration reached; source stopped.')
                try:
                    raw = read_block()
                except EOFError:
                    if block_samples and block_peak_rms >= SOUND_RMS:
                        chunks.put((np.concatenate(blocks), block_start / rate, samples / rate, 'END_OF_RECORDING', channel, rate))
                    block_samples = 0
                    source_done.set()
                    return
                if primary and not ready:
                    emit({'type': 'ready', 'device': source_name, 'micDevice': args.mic_name if args.mic_device is not None else None, 'sampleRate': rate, 'channels': channels, 'languages': languages, 'asr': asr, 'modelLoadSeconds': round(time.monotonic() - started, 3), 'audioStorage': 'RAM_ONLY', 'maxQueuedChunks': 6, 'maxChunkSeconds': MAX_CHUNK_SECONDS, 'maxSessionSeconds': args.max_seconds, 'firstReadBytes': len(raw), 'loopbackKeepalive': keepalive_note})
                    ready = True
                mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).mean(axis=1)
                blocks.append(mono.copy())
                block_sizes.append(len(mono))
                block_samples += len(mono)
                samples += len(mono)
                rms = float(np.sqrt(np.mean(mono * mono)))
                block_rms.append(rms)
                if primary:
                    slot = int(samples / rate * 10)
                    speaker_levels[slot] = max(rms, speaker_levels.get(slot, 0.0))
                block_peak_rms = max(block_peak_rms, rms)
                silence_samples = silence_samples + len(mono) if rms < SOUND_RMS else 0
                if primary and time.monotonic() - last_meter > 1:
                    emit({'type': 'status', 'capturedSeconds': samples / rate, 'rms': round(rms, 5), 'queuedChunks': chunks.qsize(), 'lastSoundSecondsAgo': round(silence_samples / rate, 1)})
                    last_meter = time.monotonic()
                duration = block_samples / rate
                # Silence boundaries reduce cut words. At the hard window the cut goes after the quietest block of the
                # last seconds, not the last block; the blocks after it start the next chunk.
                hard = duration >= MAX_CHUNK_SECONDS
                if hard or (duration >= min_chunk_seconds and silence_samples / rate >= 0.55):
                    cut = split_point(block_rms, block_sizes, rate) if hard else len(blocks) - 1
                    cut_samples = sum(block_sizes[:cut + 1])
                    keep = max(block_rms[:cut + 1]) >= SOUND_RMS
                    if keep and not primary:
                        # Mic chunk: drop it when it is mostly the meeting coming back through the speakers.
                        offsets = [block_start + sum(block_sizes[:i]) for i in range(cut + 1)]
                        speaker = [speaker_levels.get(int(offset / rate * 10), 0.0) for offset in offsets]
                        keep = mic_is_own_voice(block_rms[:cut + 1], speaker)
                    # Pure digital/room silence is not sent to ASR; it only costs CPU and backlog.
                    if keep:
                        chunk = (np.concatenate(blocks[:cut + 1]), block_start / rate, (block_start + cut_samples) / rate, 'MAX_WINDOW_SPLIT_AT_QUIETEST' if hard else 'SILENCE_BOUNDARY_HEURISTIC', channel, rate)
                        try:
                            if args.replay:
                                # A recording can wait for ASR; nothing is lost by slowing the replay down.
                                while not stop.is_set():
                                    try:
                                        chunks.put(chunk, timeout=0.5)
                                        break
                                    except queue.Full:
                                        pass
                            else:
                                chunks.put_nowait(chunk)
                        except queue.Full:
                            # ASR is behind: keep growing this block (bounded) instead of stopping the meeting.
                            if duration < GROWTH_LIMIT_SECONDS:
                                continue
                            # Still behind past the growth limit: drop the cut part from RAM and record the gap explicitly.
                            emit({'type': 'gap', 'start': block_start / rate, 'end': (block_start + cut_samples) / rate, 'reason': 'ASR_BEHIND_AUDIO_DROPPED', 'channel': channel})
                    blocks = blocks[cut + 1:]
                    block_rms = block_rms[cut + 1:]
                    block_sizes = block_sizes[cut + 1:]
                    block_samples -= cut_samples
                    block_peak_rms = max(block_rms, default=0.0)
                    block_start += cut_samples
            if primary and block_samples:
                emit({'type': 'status', 'discardedTailSeconds': block_samples / rate, 'tailReason': 'STOP_NO_NEW_SOURCE'})
        except Exception as exc:
            emit({'type': 'error', 'message': f'{channel}: {exc}'})
            stop.set()

    threads = [threading.Thread(target=reader, args=item, daemon=True) for item in inputs]
    emit({'type': 'prepared', 'modelReady': True, 'device': source_name, 'firstReadVerified': False})
    for thread in threads:
        thread.start()
    try:
        while not stop.is_set():
            try:
                waveform, begin, end, boundary, channel, rate = chunks.get(timeout=0.2)
            except queue.Empty:
                if source_done.is_set():
                    emit({'type': 'status', 'replayEnded': True})
                    break
                continue
            frame = av.AudioFrame.from_ndarray(waveform.reshape(1, -1), format='flt', layout='mono')
            frame.sample_rate = rate
            resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
            converted = resampler.resample(frame) + resampler.resample(None)
            waveform16 = np.concatenate([f.to_ndarray().reshape(-1) for f in converted]).astype(np.float32)
            inference_started = time.monotonic()
            segments, language, language_probability = transcribe_chunk(model, waveform16, languages, lao_model, vi_model)
            for segment in segments:
                if stop.is_set():
                    break
                text = segment.text.strip()
                if text:
                    marks = ''.join('; ' + flag for flag in segment_flags(text, segment, language, language_probability))
                    if channel == 'mic':
                        marks += '; CHANNEL_MIC'
                    emit({'type': 'source', 'text': collapse_repeats(text), 'start': begin, 'end': end, 'boundary': boundary + '; CHUNK_RANGE_NOT_WORD_TIMESTAMPS' + marks, 'language': language, 'languageProbability': language_probability, 'channel': channel})
            # How far the text lags behind the audio (seconds of meeting not yet transcribed when this chunk finished).
            lag = round((time.monotonic() - capture_started) * (args.speed if args.replay else 1) - end, 1)
            emit({'type': 'status', 'lastASRSeconds': round(time.monotonic() - inference_started, 3), 'lastChunkSeconds': round(end - begin, 3), 'queuedChunks': chunks.qsize(), 'lagSeconds': lag})
            del waveform, waveform16
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=2)
        for stream in streams:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        if keepalive:
            keepalive.stop_stream()
            keepalive.close()
        if audio:
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
    parser.add_argument('--replay')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--asr-device', default='auto', choices=['auto', 'cuda', 'cpu'])
    parser.add_argument('--lao-model')
    parser.add_argument('--vi-model')
    parser.add_argument('--wait-source', action='store_true')
    parser.add_argument('--mic-device', type=int)
    parser.add_argument('--mic-name')
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
