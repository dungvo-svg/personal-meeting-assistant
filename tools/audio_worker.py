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
import types
import uuid

from follow_source import RATE16, SEGMENT_END, ChannelFollower, cut_window
from mic_state import label_mic_chunk
from timeline import Timeline, parse_wall

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
SILENCE_PHRASES = ('đăng ký kênh', 'subscribe', 'cảm ơn các bạn đã theo dõi', 'cảm ơn các bạn đã xem', 'hẹn gặp lại các bạn', 'ghiền mì gõ', 'like và share',
                   'video hấp dẫn', 'bỏ lỡ những video', 'không bỏ lỡ video', 'nhấn chuông', 'bấm chuông', 'chuông thông báo')
# Whole segments that are only a greeting-style opener; real speech rarely is just these words (audit 30/10, #1523).
SILENCE_WHOLE = ('chào mừng', 'chào mừng các bạn', 'chào mừng các bạn đã đến với kênh')
# A thank-you on its own is ordinary speech; it is a ghost only when the model itself doubts there was speech (audit 30/10, #1707).
SILENCE_THANKS = ('cảm ơn', 'cảm ơn bạn', 'cảm ơn các bạn')
THANKS_NO_SPEECH_ABOVE = 0.3
THANKS_LOGPROB_BELOW = -0.8
# Loops of 1-4 words ("Thủy của Thủy của …", audit 30/10, #1690). One word needs 6 in a row (as before: "có có có có" is
# real speech), a longer phrase 4. Shorter phrases are tried first so "a b a b a b a b" is "a b" x4, not "a b a b" x2.
WORD_CHAR = r'[^\s,.;:!?…]'
WORD_GAP = r'[\s,.;:!?…]+'
WORD = WORD_CHAR + '+'
REPEAT_PATTERNS = tuple(
    (words, re.compile(rf'(?<!{WORD_CHAR})({WORD}(?:{WORD_GAP}{WORD}){{{words - 1}}})(?:{WORD_GAP}\1(?!{WORD_CHAR})){{{5 if words == 1 else 3},}}', re.IGNORECASE))
    for words in (1, 2, 3, 4))


# Longest chunk before a forced cut, and how long a backed-up queue may keep growing a chunk before audio is dropped.
MAX_CHUNK_SECONDS = 20
GPU_MIN_CHUNK_SECONDS = 3
GROWTH_LIMIT_SECONDS = MAX_CHUNK_SECONDS + 10
LANG_UNSURE_BELOW = 0.65
LAO_LOW_LOGPROB = -1.0
# Mixed sessions: when the detector does not hear Vietnamese (probability below LANG_VI_SURE) the chunk is decoded by both
# the main and the Lao model and the more confident transcript wins. Measured on FLEURS cut to 1.5-3 s, the detector alone
# calls ~22% of Lao clips Vietnamese (the main model then invents "Hãy subscribe cho kênh..."); its Vietnamese side is
# reliable, so a clear Vietnamese reading is never second-guessed. A Lao reading that is already confident and long is kept.
LANG_VI_SURE = 0.6
LANG_LAO_SURE_SHARE = 0.85
LANG_LAO_SURE_SECONDS = 4.0
LANG_PICK_BIAS = 0.1  # added to the Lao score: its log-probs run a little lower than the main model's on the same speech
LANG_PICK_DEFAULT = True
# Three-way Tai routing (lo vs th). Measured 31/10 on FLEURS (40 clips per language, beam 5): the detector gives Lao audio a Thai-sounding
# reading (th share of lo+th is 1.0 for both Lao and Thai clips, AUC 0.50), so it cannot separate them. What does: the decoders' own
# scores. score(lo, BuzzASR) - score(th, main) is +0.13 (median) on Lao clips and -0.01 on Thai ones (AUC 0.91 on full clips, 0.72 on 1.5-3 s cuts).
LANG_TAI_LO_MARGIN = 0.08  # the Lao reading is primary only when it beats the Thai one by this much
LANG_TAI_DECISIVE_SECONDS = 4.0  # shorter chunks always keep the other reading as an alternative
LANG_TAI_LO_DECISIVE_DIFF = 0.12  # lo is decisive when it beats th by this much...
LANG_TAI_TH_DECISIVE_SCORE = -0.2  # ...th when its own score is at least this good and lo is not clearly better (diff below LANG_TAI_TH_DECISIVE_DIFF)
LANG_TAI_TH_DECISIVE_DIFF = 0.05
LANG_TAI_UNSURE_PROB = 0.5  # reported language probability when an alternative is returned (below LANG_UNSURE_BELOW, so the chunk is flagged)


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
    whole = re.sub(r'[^\w\s]', '', text.lower()).strip()
    doubtful = segment.no_speech_prob > THANKS_NO_SPEECH_ABOVE or getattr(segment, 'avg_logprob', 0.0) < THANKS_LOGPROB_BELOW
    if any(phrase in text.lower() for phrase in SILENCE_PHRASES) or whole in SILENCE_WHOLE or (whole in SILENCE_THANKS and doubtful) or segment.no_speech_prob > 0.6:
        flags.append('LIKELY_HALLUCINATION')
    if segment.compression_ratio > 2.4 or any(pattern.search(text) for _, pattern in REPEAT_PATTERNS):
        flags.append('REPETITION')
    if language_probability is not None and language_probability < LANG_UNSURE_BELOW:
        flags.append('LANG_UNSURE')
    if language == 'lo' and getattr(segment, 'avg_logprob', 0.0) < LAO_LOW_LOGPROB:
        flags.append('LAO_LOW_CONFIDENCE')
    return flags


def collapse_repeats(text):
    for words, pattern in REPEAT_PATTERNS:
        text = pattern.sub(lambda m, words=words: f'{m.group(1)} [×{len(re.findall(WORD, m.group(0))) // words}]', text)
    return text


LAO_OPTIONS = {'no_repeat_ngram_size': 3, 'repetition_penalty': 1.2}
ASR_BEAM_CUDA = 5  # GPU beam width (FLEURS 30/10: Lao CER 22.6 -> 21.3%, vi 4.3 -> 4.1%, ~7% slower); the CPU keeps 1 to stay real time


def beam_for(model, beam=None):
    # An explicit beam wins; otherwise the GPU width for a CUDA model and 1 for anything else (CPU, test doubles).
    if beam is not None:
        return beam
    try:
        return ASR_BEAM_CUDA if 'cuda' in str(model.model.device) else 1
    except AttributeError:
        return 1


def segments_score(segments):
    # Mean token log-probability of a transcript, weighted by segment length; the more confident decoder has the
    # higher (less negative) value. No text at all scores worst.
    weight = total = 0.0
    for segment in segments:
        tokens = max(1, len(getattr(segment, 'tokens', None) or ()))
        total += getattr(segment, 'avg_logprob', -10.0) * tokens
        weight += tokens
    return total / weight if weight else float('-inf')


def should_pick_language(language, share, vi_probability, seconds):
    # Only a chunk the detector does not hear as Vietnamese pays for a second decoder, unless it is already a long,
    # confident Lao one (an unknown length counts as long). Unknown probabilities (None) count as unsure.
    if vi_probability is not None and vi_probability >= LANG_VI_SURE:
        return False
    confident_lao = language == 'lo' and share is not None and share >= LANG_LAO_SURE_SHARE and (seconds is None or seconds >= LANG_LAO_SURE_SECONDS)
    return not confident_lao


def pick_by_score(vi_segments, lo_segments, lao_bias=LANG_PICK_BIAS):
    # Returns 'vi' or 'lo', whichever transcript the decoders were more sure of; ties go to Vietnamese. A Vietnamese
    # decode that is only a stock phrase Whisper invents over non-Vietnamese audio counts for nothing.
    vi_text = ' '.join(getattr(segment, 'text', '') for segment in vi_segments).lower()
    vi_score = float('-inf') if any(phrase in vi_text for phrase in SILENCE_PHRASES) else segments_score(vi_segments)
    return 'lo' if segments_score(lo_segments) + lao_bias > vi_score else 'vi'


class ChunkSegments(list):
    """The segments of one chunk plus `alternatives`: [{language, text, score}] for the other Tai reading (th vs lo) when
    the chunk could not be told apart with confidence. Empty when the routing was decisive. A plain list subclass, so
    existing callers (iteration, ==) work unchanged; read it with chunk_alternatives(segments)."""
    alternatives = ()


def chunk_alternatives(segments):
    return list(getattr(segments, 'alternatives', ()))


def segments_text(segments):
    return ' '.join((getattr(segment, 'text', '') or '').strip() for segment in segments).strip()


def pick_tai(th_segments, lo_segments, margin=LANG_TAI_LO_MARGIN):
    # 'lo' only when the Lao decoder was clearly the more confident one; ties and anything unclear stay Thai (script
    # Claude reads either way). The language detector cannot make this call: it hears Lao as Thai (AUC 0.50 on FLEURS).
    return 'lo' if segments_score(lo_segments) - segments_score(th_segments) > margin else 'th'


def tai_is_decisive(primary, lo_score, th_score, seconds):
    # A long chunk where one reading clearly won needs no alternative. Short chunks (unknown length counts as long) never do.
    if seconds is not None and seconds < LANG_TAI_DECISIVE_SECONDS:
        return False
    if primary == 'lo':
        return lo_score - th_score >= LANG_TAI_LO_DECISIVE_DIFF
    return th_score >= LANG_TAI_TH_DECISIVE_SCORE and lo_score - th_score < LANG_TAI_TH_DECISIVE_DIFF


def transcribe_chunk(model, waveform16, languages, lao_model=None, vi_model=None, pick=None, beam=None):
    """Returns (segments, language, language_probability). `segments` is a ChunkSegments when the routing decoded more than
    one reading: `chunk_alternatives(segments)` gives [{language, text, score}] for the other Tai reading (th <-> lo), and the
    probability is then capped at LANG_TAI_UNSURE_PROB so segment_flags marks LANG_UNSURE. Languages are any subset of vi, lo, th.
    Tai chunks of a session with both lo and th are decoded twice (main model with th, Lao model with lo) and the primary is
    the more confident one; see LANG_TAI_* for when the other is dropped."""
    # max_new_tokens stops repetition loops on noisy or misdetected chunks.
    options = {'task': 'transcribe', 'max_new_tokens': 224, 'beam_size': beam_for(model, beam), 'temperature': 0, 'condition_on_previous_text': False, 'vad_filter': True, 'vad_parameters': {'min_silence_duration_ms': 400}, 'no_speech_threshold': 0.6}

    def decode(code):
        if code == 'lo' and lao_model:
            return lao_model.transcribe(waveform16, language='lo', **options, **LAO_OPTIONS)[0]
        if code == 'vi' and vi_model:
            return vi_model.transcribe(waveform16, language='vi', **options)[0]
        return model.transcribe(waveform16, language=code, **options)[0]

    if len(languages) == 1:
        return decode(languages[0]), languages[0], None
    has_vi = 'vi' in languages
    pair = 'lo' in languages and 'th' in languages and bool(lao_model)  # both Tai readings are decodable and comparable
    # Without the Lao model a session that has Thai reads every Tai chunk as Thai; one that only has Lao forces lo on the main model.
    single = None if pair else ('th' if 'th' in languages else 'lo')
    seconds = len(waveform16) / 16000 if waveform16 is not None else None
    detected, info, share = None, None, None
    tai_detected = not has_vi
    unsure = False
    if has_vi:
        # Detection reuses the first encoder pass. Whisper hears Lao as Thai, so every Tai probability counts toward Tai.
        detected, info = model.transcribe(waveform16, language=None, **options)
        probabilities = dict(info.all_language_probs or [])
        scores = {'vi': probabilities.get('vi', 0.0), 'tai': probabilities.get('lo', 0.0) + probabilities.get('th', 0.0)}
        tai_detected = scores['tai'] > scores['vi']
        total = scores['vi'] + scores['tai']
        share = scores['tai' if tai_detected else 'vi'] / total if total else None
        can_pick = pair or single != 'lo' or bool(lao_model)
        unsure = bool((LANG_PICK_DEFAULT if pick is None else pick) and can_pick and should_pick_language('lo' if tai_detected else 'vi', share, probabilities.get('vi'), seconds))
    cache = {}

    def segments_of(code):
        if code not in cache:
            # The detection pass already decoded the language it heard; reuse it instead of decoding twice (a dedicated model for that language is used as before).
            reusable = detected is not None and info.language == code and not (code == 'vi' and vi_model) and not (code == 'lo' and lao_model)
            cache[code] = list(detected if reusable else decode(code))
        return cache[code]

    need_vi = has_vi and (not tai_detected or unsure)
    need_tai = tai_detected or unsure
    if need_vi:
        segments_of('vi')
    if need_tai:
        for code in (('th', 'lo') if pair else (single,)):
            segments_of(code)
    alternatives = []
    if need_tai:
        tai = pick_tai(cache['th'], cache['lo']) if pair else single
        if need_vi:
            chosen = tai if pick_by_score(cache['vi'], cache[tai], LANG_PICK_BIAS if tai == 'lo' else 0.0) == 'lo' else 'vi'
        else:
            chosen = tai
        if pair and chosen == tai:
            other = 'lo' if tai == 'th' else 'th'
            if not tai_is_decisive(tai, segments_score(cache['lo']), segments_score(cache['th']), seconds):
                alternatives = [{'language': other, 'text': collapse_repeats(segments_text(cache[other])), 'score': round(segments_score(cache[other]), 3)}]
    else:
        chosen = 'vi'
    result = ChunkSegments(segments_of(chosen))
    result.alternatives = alternatives
    probability = None
    if share is not None:
        probability = round(scores['tai' if chosen != 'vi' else 'vi'] / total, 3)
    if alternatives:
        probability = LANG_TAI_UNSURE_PROB if probability is None else min(probability, LANG_TAI_UNSURE_PROB)
    return result, chosen, probability


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


class MultilingualCT2:
    # CTranslate2 calls BuzzASR (53,474-entry vocabulary) English-only, so faster-whisper drops the language and task
    # tokens and ignores language='lo'. The model does carry <|lo|>; this reports it as multilingual and forwards the rest.
    is_multilingual = True

    def __init__(self, model):
        self._model = model

    def __getattr__(self, name):
        return getattr(self._model, name)


def enable_language_tokens(whisper_model, model_dir, language='lo'):
    """Make faster-whisper decode with <|language|> for an English-flagged model. Returns whether it is in effect;
    it is left untouched (and False) unless the token exists in lang_ids, lands in the start sequence and the
    wrapped model really reports that language."""
    import numpy as np
    from faster_whisper.tokenizer import Tokenizer
    if whisper_model.model.is_multilingual:
        return True
    token_id = whisper_model.hf_tokenizer.token_to_id(f'<|{language}|>')
    try:
        lang_ids = json.loads((Path(model_dir) / 'config.json').read_text(encoding='utf-8')).get('lang_ids') or []
    except (OSError, ValueError):
        lang_ids = []
    if token_id is None or token_id not in lang_ids:
        return False
    if token_id not in Tokenizer(whisper_model.hf_tokenizer, True, task='transcribe', language=language).sot_sequence:
        return False
    original = whisper_model.model
    whisper_model.model = MultilingualCT2(original)
    if whisper_model.transcribe(np.zeros(16000, dtype=np.float32), language=language)[1].language != language:
        whisper_model.model = original
        return False
    return True


def load_models(model_path, lao_model_path, device_choice, threads, vi_model_path=None, lao_token=True):
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
            forced = bool(lao) and lao_token and enable_language_tokens(lao, lao_model_path, 'lo')
            return model, lao, vi, {'device': 'cuda', 'mainModel': Path(model_path).name, 'laoModel': Path(lao_model_path).name if lao else None, 'viModel': Path(vi_model_path).name if vi else None, 'laoLanguageToken': forced}
        except Exception as exc:
            if device_choice == 'cuda':
                raise
            fallback = str(exc)[:200]
    else:
        fallback = 'CUDA libraries not found' if device_choice != 'cpu' else None
    # CPU: only a small main model keeps up in real time.
    cpu_model = model_path if any(size in Path(model_path).name for size in ('small', 'base', 'tiny')) else MODELS / 'small'
    model = WhisperModel(str(cpu_model), device='cpu', compute_type='int8', cpu_threads=threads, num_workers=1, local_files_only=True)
    return model, None, None, {'device': 'cpu', 'mainModel': Path(cpu_model).name, 'laoModel': None, 'viModel': None, 'laoLanguageToken': False, 'cudaFallback': fallback}


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


# Apps that may hold the microphone during a meeting, likeliest first (process names without .exe). The "Tôi" channel
# does not depend on the meeting platform: it is the user's microphone, picked from whatever these apps are using.
MEETING_APPS = ('zoom', 'ms-teams', 'teams', 'slack', 'webex', 'discord', 'skype', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')
MIC_RECHECK_SECONDS = 30
PAUSE_GRACE_SECONDS = 5


def _same_words(text):
    return ' '.join((text or '').lower().split())


def match_mic(name, mics):
    # PortAudio and Core Audio spell one device a little differently (truncation), so a prefix counts. mics: [(index, name)].
    target = _same_words(name)
    if not target:
        return None
    exact = next((mic for mic in mics if _same_words(mic[1]) == target), None)
    return exact or next((mic for mic in mics if _same_words(mic[1]).startswith(target) or target.startswith(_same_words(mic[1]))), None)


def meeting_mic(in_use, mics):
    # The microphone held by the likeliest meeting app, as ((index, name), app); None when no listed app holds one.
    # in_use: [{'device': name, 'apps': [process names]}] from tools/mic_in_use.ps1.
    found = []
    for entry in in_use or []:
        mic = match_mic(entry.get('device'), mics)
        for app in (entry.get('apps') or []) if mic else []:
            rank = MEETING_APPS.index(app.lower()) if app.lower() in MEETING_APPS else len(MEETING_APPS)
            found.append((rank, mic, app))
    if not found:
        return None
    _, mic, app = min(found, key=lambda item: item[0])
    return mic, app


def pick_mic(mics, default_index, in_use):
    # The microphone a meeting app is using now, else the Windows default input. Returns (index, name, why).
    found = meeting_mic(in_use, mics)
    if found:
        return found[0][0], found[0][1], 'meeting_app:' + found[1]
    default = next(((index, name) for index, name in mics if index == default_index), None)
    return (default[0], default[1], 'windows_default') if default else (None, None, None)


def mic_device_change(current_index, mics, in_use):
    # A meeting app now uses another microphone than the one being captured. Reported only: switching mid-capture
    # would cut the user's words, so the new device is used from the next listening.
    found = meeting_mic(in_use, mics)
    if not found or found[0][0] == current_index:
        return None
    return {'from': next((name for index, name in mics if index == current_index), None), 'to': found[0][1], 'app': found[1]}


class MicDeviceWatch:
    # Runs tools/mic_in_use.ps1 (read-only Core Audio) and keeps its latest report; one line every MIC_RECHECK_SECONDS.
    def __init__(self):
        import subprocess
        self.report = None
        self.first_report = threading.Event()
        self.changed = threading.Event()
        script = Path(__file__).with_name('mic_in_use.ps1')
        try:
            self.process = subprocess.Popen(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script), '-ParentPid', str(os.getpid()), '-IntervalSeconds', str(MIC_RECHECK_SECONDS), '-Apps', ','.join(MEETING_APPS)],
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True, encoding='utf-8',
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError:
            self.process = None
            self.first_report.set()
            return
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.report = json.loads(line)
            except ValueError:
                continue
            self.first_report.set()
            self.changed.set()
        self.first_report.set()

    def first(self, timeout=8):
        self.first_report.wait(timeout)
        return self.in_use()

    def in_use(self):
        return (self.report or {}).get('devices') or []

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.kill()


# One WAV per listening and channel (opt-in `pma listen --save-audio`): PCM16 mono at the device's own rate.
def audio_path(directory, capture_id, channel):
    return Path(directory) / f'{capture_id}-{channel}.wav'


def pcm16(mono):
    import numpy as np
    return (np.clip(mono, -1.0, 1.0) * 32767).astype('<i2').tobytes()


class WavWriter:
    # The header length is patched on every write (wave module), so a crash or a kill leaves a playable file.
    def __init__(self, path, rate):
        import wave
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = Path(path)
        self.file = wave.open(str(path), 'wb')
        self.file.setnchannels(1)
        self.file.setsampwidth(2)
        self.file.setframerate(int(rate))

    def write(self, mono):
        self.file.writeframes(pcm16(mono))

    def close(self):
        self.file.close()


def safe_name(value):
    return value if isinstance(value, str) and re.fullmatch(r'[\w-]{1,64}', value) else None


def listening_from_request(request, max_seconds):
    # Everything one listening needs, from the JSON line that wakes a warm worker (the command line does the same cold).
    replay = request.get('replay')
    follow = request.get('follow')
    mic = request.get('micDevice') is not None
    capture_id = safe_name(request.get('captureId')) or uuid.uuid4().hex
    return types.SimpleNamespace(
        replay=replay, follow=Path(follow) if follow and not replay else None, speed=float(request.get('speed', 1)) if replay else 1.0,
        device=None if replay or follow else int(request['device']), device_name=None if replay or follow else str(request['deviceName']),
        mic_device=int(request['micDevice']) if mic else None, mic_name=str(request['micName']) if mic else None, mic_auto=bool(request.get('micAuto')),
        max_seconds=int(request.get('maxSeconds', max_seconds)), capture_id=capture_id, mic_by=None, mic_error=None,
        save_dir=Path(request['saveAudioDir']) if request.get('saveAudioDir') and not replay and not follow else None)


def command_loop(next_line, run_listening, on_warm_again):
    # A warm worker waits for a source line, listens, and on `pause` goes back to waiting with its models still loaded;
    # `stop` (None from next_line) or a listening that ends by itself leaves. run_listening returns 'pause', 'stop' or 'ended'.
    while True:
        line = next_line()
        if not line or line == 'stop':
            return 'stop'
        if line == 'pause':
            continue
        if run_listening(line) != 'pause':
            return 'ended'
        on_warm_again()


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
    if not languages or any(code not in ('vi', 'lo', 'th') for code in languages):
        raise ValueError('Languages must be a subset of vi, lo, th')
    # Mixed sessions on CPU use longer chunks: detection is more reliable and per-chunk overhead stays below real time.
    # On the GPU ASR takes ~0.3 s per chunk, so chunks end at the first pause after 3 s and text arrives sooner (30/10).
    min_chunk_seconds = 6 if len(languages) > 1 else 3
    stop = threading.Event()  # leave the worker
    pause = threading.Event()  # end this listening, keep the models
    drain = threading.Event()  # --follow: read and transcribe what is on disk, then leave
    follow_pause = threading.Event()  # --follow: ASR holds, the read position is kept
    lines = queue.Queue()

    def read_commands():
        # stdin carries `stop`, `pause`, and (warm mode) one JSON source line per listening.
        # With --follow the files are the buffer: `stop` drains instead of leaving, and `pause`/`resume` hold and release ASR.
        for line in sys.stdin:
            line = line.strip()
            if line == 'stop':
                break
            if args.follow:
                if line in ('pause', 'resume'):
                    follow_pause.set() if line == 'pause' else follow_pause.clear()
                    emit({'type': 'status', 'followPaused': line == 'pause'})
                continue
            if line == 'pause':
                pause.set()
            else:
                lines.put(line)
        if args.follow:
            follow_pause.clear()
            drain.set()
            emit({'type': 'status', 'draining': True})
        else:
            stop.set()
        lines.put(None)

    threading.Thread(target=read_commands, daemon=True).start()
    raise_priority()
    profile = asr_profile()
    model_path = Path(args.model or profile['main']).resolve(strict=True)
    started = time.monotonic()
    model, lao_model, vi_model, asr = load_models(model_path, args.lao_model or profile['lo'], args.asr_device, 6, args.vi_model or profile['vi'])
    if asr['device'] == 'cuda':
        min_chunk_seconds = GPU_MIN_CHUNK_SECONDS
    # Model load only: in warm mode the wait for the source comes after this and is reported on its own (audit 30/10, A4).
    load_seconds = round(time.monotonic() - started, 3)
    mic_watch = [None]
    if args.follow:
        # The host starts a follow worker paused and needs to know the models are in memory before `resume` (pma start).
        emit({'type': 'warm', 'asr': asr, 'modelLoadSeconds': load_seconds})
    # A restarted follow worker reads the files from the start again (fast, no ASR) and transcribes only after this.
    skip_until = parse_wall(args.from_wall) if getattr(args, 'from_wall', None) else None

    def run_listening(listening, waited_seconds):
        pause.clear()
        audio = keepalive = None
        streams = []
        mics = []
        source_done = threading.Event()
        listening_over = threading.Event()
        chunks = queue.Queue(maxsize=6)
        speaker_levels = {}  # 0.1 s slot since capture start -> speaker RMS, for the mic echo check
        speaker_progress = [0]  # samples the speaker reader has taken in: a followed mic chunk waits for its slots to exist
        speaker_over = threading.Event()
        followers = {}
        reader_lock = threading.Lock()

        def ending():
            return stop.is_set() or pause.is_set() or listening_over.is_set()

        if listening.follow:
            # The recorder's files (Q-1), read from sample 0 as fast as ASR takes them; no device is opened and no pacing.
            timeline = Timeline(listening.follow)
            followers = {name: ChannelFollower(timeline, name, draining=drain.is_set, holding=follow_pause.is_set) for name in ('speaker', 'mic')}
            rate, channels, source_name, keepalive_note = RATE16, 1, 'FOLLOW:' + listening.follow.name, 'FOLLOW_FILES'
            inputs = [(name, follower.read_block, rate, channels, follower.locate) for name, follower in followers.items()]
        elif listening.replay:
            # Replay a recording through the same chunking and ASR, paced like a live source. No device is opened.
            pcm = load_recording(listening.replay)
            rate, channels, source_name, keepalive_note = 16000, 1, Path(listening.replay).name, 'REPLAY_FILE'
            position = [0]

            def read_block():
                begin = position[0]
                if begin >= len(pcm):
                    raise EOFError
                block = pcm[begin:begin + 2048]
                position[0] += len(block)
                delay = capture_started + position[0] / rate / listening.speed - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                return block.tobytes()
            inputs = [('speaker', read_block, rate, channels)]
        else:
            import pyaudiowpatch as pa
            audio = pa.PyAudio()
            device, rate, channels = open_input(audio, listening.device, listening.device_name)
            source_name = device['name']
            keepalive_note = 'NOT_LOOPBACK'
            if device.get('isLoopbackDevice'):
                try:
                    keepalive = render_keepalive(audio, pa, device)
                    keepalive_note = 'SILENT_RENDER_ACTIVE' if keepalive else 'RENDER_DEVICE_NOT_FOUND_FRAMES_STOP_WHEN_SILENT'
                except Exception as exc:
                    keepalive_note = 'KEEPALIVE_FAILED_FRAMES_STOP_WHEN_SILENT: ' + str(exc)
            stream = audio.open(format=pa.paFloat32, channels=channels, rate=rate, input=True, input_device_index=listening.device, frames_per_buffer=2048)
            streams.append(stream)
            # A short CPU stall must not end a long meeting; overflow is reported, not fatal.
            inputs = [('speaker', lambda: stream.read(2048, exception_on_overflow=False), rate, channels)]
            if listening.mic_auto or listening.mic_device is not None:
                # The user's own microphone ("Tôi"), always on (owner, 30/10/2026): whatever is said into it, whichever
                # meeting platform is used. Speaker sound leaking into it is dropped by mic_is_own_voice.
                try:
                    wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)
                    mics = [(i, d['name']) for i in range(audio.get_device_count()) for d in [audio.get_device_info_by_index(i)]
                            if d['hostApi'] == wasapi['index'] and d['maxInputChannels'] > 0 and not d.get('isLoopbackDevice')]
                    picked_by = 'selected'
                    if listening.mic_device is None:
                        mic_watch[0] = mic_watch[0] or MicDeviceWatch()
                        listening.mic_device, listening.mic_name, picked_by = pick_mic(mics, wasapi['defaultInputDevice'], mic_watch[0].first())
                    if listening.mic_device is not None:
                        mic, mic_rate, mic_channels = open_input(audio, listening.mic_device, listening.mic_name)
                        if mic.get('isLoopbackDevice'):
                            raise RuntimeError('Microphone channel must be a microphone, not a loopback device')
                        mic_stream = audio.open(format=pa.paFloat32, channels=mic_channels, rate=mic_rate, input=True, input_device_index=listening.mic_device, frames_per_buffer=2048)
                        streams.append(mic_stream)
                        inputs.append(('mic', lambda: mic_stream.read(2048, exception_on_overflow=False), mic_rate, mic_channels))
                    listening.mic_by = picked_by or 'NO_MICROPHONE_FOUND'
                    emit({'type': 'status', 'micDevice': listening.mic_name, 'micSelectedBy': listening.mic_by})
                except Exception as exc:
                    # The speaker channel must still be heard when the microphone cannot be opened.
                    listening.mic_device = listening.mic_name = None
                    listening.mic_error = str(exc)[:200]
                    emit({'type': 'status', 'micDevice': None, 'micError': listening.mic_error})
        capture_started = time.monotonic()

        readers_left = [len(inputs)]

        def reader_finished():
            with reader_lock:
                readers_left[0] -= 1
                if readers_left[0] <= 0:
                    source_done.set()

        def reader(channel, read_block, rate, channels, locate=None):
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
            announced = set()
            writer = None

            def cut_chunk(cut, boundary, final=False):
                # Queue blocks[:cut+1] as one chunk. False means ASR is behind and the block keeps growing instead.
                nonlocal blocks, block_rms, block_sizes, block_samples, block_peak_rms, block_start
                cut_samples = sum(block_sizes[:cut + 1])
                keep = max(block_rms[:cut + 1]) >= SOUND_RMS
                if keep and not primary and listening.follow:
                    # Both channels run ahead of the clock here: the speaker levels for this chunk must exist before the check.
                    while speaker_progress[0] < block_start + cut_samples and not speaker_over.is_set() and not stop.is_set() and not listening_over.is_set():
                        time.sleep(0.02)
                if keep and not primary:
                    # Mic chunk: drop it when it is mostly the meeting coming back through the speakers.
                    offsets = [block_start + sum(block_sizes[:i]) for i in range(cut + 1)]
                    speaker = [speaker_levels.get(int(offset / rate * 10), 0.0) for offset in offsets]
                    keep = mic_is_own_voice(block_rms[:cut + 1], speaker)
                # Pure digital/room silence is not sent to ASR; it only costs CPU and backlog.
                if keep:
                    chunk = (np.concatenate(blocks[:cut + 1]), block_start / rate, (block_start + cut_samples) / rate, boundary, channel, rate, locate(block_start) if locate else None)
                    try:
                        if listening.replay or listening.follow or final:
                            # A recording or the recorder's files can wait for ASR, and a paused tail is drained by the main loop; nothing is lost.
                            while not stop.is_set() and not listening_over.is_set():
                                try:
                                    chunks.put(chunk, timeout=0.5)
                                    break
                                except queue.Full:
                                    pass
                        else:
                            chunks.put_nowait(chunk)
                    except queue.Full:
                        # ASR is behind: keep growing this block (bounded) instead of stopping the meeting.
                        if block_samples / rate < GROWTH_LIMIT_SECONDS:
                            return False
                        # Still behind past the growth limit: drop the cut part from RAM and record the gap explicitly.
                        emit({'type': 'gap', 'start': block_start / rate, 'end': (block_start + cut_samples) / rate, 'reason': 'ASR_BEHIND_AUDIO_DROPPED', 'channel': channel})
                blocks = blocks[cut + 1:]
                block_rms = block_rms[cut + 1:]
                block_sizes = block_sizes[cut + 1:]
                block_samples -= cut_samples
                block_peak_rms = max(block_rms, default=0.0)
                block_start += cut_samples
                return True

            try:
                if listening.save_dir:
                    try:
                        writer = WavWriter(audio_path(listening.save_dir, listening.capture_id, channel), rate)
                    except OSError as exc:
                        emit({'type': 'status', 'audioSaveError': f'{channel}: {exc}'[:200]})
                while not ending():
                    if not listening.follow and time.monotonic() - capture_started > listening.max_seconds:
                        raise RuntimeError('Authorized capture duration reached; source stopped.')
                    try:
                        raw = read_block()
                    except EOFError:
                        if block_samples:
                            cut_chunk(len(blocks) - 1, 'END_OF_RECORDING', final=True)
                        block_samples = 0
                        reader_finished()
                        return
                    if raw is SEGMENT_END:
                        # A recorded segment is over: what is left of it is a chunk of its own (the next one may differ in time).
                        if block_samples:
                            cut_chunk(len(blocks) - 1, 'SEGMENT_END', final=True)
                        silence_samples = 0
                        continue
                    if primary and not ready:
                        emit({'type': 'ready', 'device': source_name, 'micDevice': listening.mic_name if listening.mic_device is not None else None, 'micSelectedBy': listening.mic_by, 'micError': listening.mic_error, 'sampleRate': rate, 'channels': channels, 'languages': languages, 'asr': asr, 'modelLoadSeconds': load_seconds, 'waitedForSourceSeconds': round(waited_seconds, 1), 'audioStorage': 'WAV_ON_DISK' if listening.save_dir or listening.follow else 'RAM_ONLY', 'follow': bool(listening.follow), 'maxQueuedChunks': 6, 'maxChunkSeconds': MAX_CHUNK_SECONDS, 'maxSessionSeconds': listening.max_seconds, 'firstReadBytes': len(raw), 'loopbackKeepalive': keepalive_note})
                        ready = True
                    if not raw:
                        continue  # a followed file has nothing new yet (or ASR is on hold); look again
                    mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).mean(axis=1)
                    if writer:
                        try:
                            writer.write(mono)
                        except OSError as exc:
                            # A full disk must not end the meeting; saving stops, listening goes on.
                            emit({'type': 'status', 'audioSaveError': f'{channel}: {exc}'[:200]})
                            writer = None
                    if channel == 'mic' and mic_watch[0] and mic_watch[0].changed.is_set():
                        mic_watch[0].changed.clear()
                        change = mic_device_change(listening.mic_device, mics, mic_watch[0].in_use())
                        if change and change['to'] not in announced:
                            announced.add(change['to'])
                            emit({'type': 'status', 'micDeviceChanged': change})
                    blocks.append(mono.copy())
                    block_sizes.append(len(mono))
                    block_samples += len(mono)
                    samples += len(mono)
                    rms = float(np.sqrt(np.mean(mono * mono)))
                    block_rms.append(rms)
                    if primary:
                        slot = int(samples / rate * 10)
                        speaker_levels[slot] = max(rms, speaker_levels.get(slot, 0.0))
                        speaker_progress[0] = samples
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
                        cut_chunk(cut, 'MAX_WINDOW_SPLIT_AT_QUIETEST' if hard else 'SILENCE_BOUNDARY_HEURISTIC')
                if block_samples and pause.is_set() and not stop.is_set():
                    # Pause keeps what was said before it: the unfinished chunk is transcribed too.
                    cut_chunk(len(blocks) - 1, 'FLUSHED_ON_PAUSE', final=True)
                elif primary and block_samples:
                    emit({'type': 'status', 'discardedTailSeconds': block_samples / rate, 'tailReason': 'STOP_NO_NEW_SOURCE'})
            except Exception as exc:
                emit({'type': 'error', 'message': f'{channel}: {exc}'})
                stop.set()
            finally:
                if primary:
                    speaker_over.set()
                if writer:
                    writer.close()

        threads = [threading.Thread(target=reader, args=item, daemon=True) for item in inputs]
        emit({'type': 'prepared', 'modelReady': True, 'device': source_name, 'firstReadVerified': False})
        for thread in threads:
            thread.start()
        pause_seen = None
        try:
            while not stop.is_set():
                if listening.follow and follow_pause.is_set():
                    time.sleep(0.1)  # paused: the chunks wait in the queue, the readers wait in the files; nothing is lost
                    continue
                try:
                    waveform, begin, end, boundary, channel, chunk_rate, where = chunks.get(timeout=0.2)
                except queue.Empty:
                    if source_done.is_set():
                        emit({'type': 'status', 'followEnded' if listening.follow else 'replayEnded': True})
                        return 'ended'
                    if pause.is_set():
                        # A reader blocked on a silent device cannot flush; do not wait for it forever.
                        pause_seen = pause_seen or time.monotonic()
                        if not any(thread.is_alive() for thread in threads) or time.monotonic() - pause_seen > PAUSE_GRACE_SECONDS:
                            return 'pause'
                    continue
                inference_started = time.monotonic()
                # Where the chunk begins in real time and in the recorder's files (followed sources only).
                place = {'wall': where[0], 'seg': where[1]} if where and where[0] else {}
                if skip_until and place and parse_wall(place['wall']) + (end - begin) <= skip_until:
                    continue  # transcribed by the worker that crashed, or inside the gap the host already recorded
                try:
                    frame = av.AudioFrame.from_ndarray(waveform.reshape(1, -1), format='flt', layout='mono')
                    frame.sample_rate = chunk_rate
                    resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
                    converted = resampler.resample(frame) + resampler.resample(None)
                    waveform16 = np.concatenate([f.to_ndarray().reshape(-1) for f in converted]).astype(np.float32)
                    segments, language, language_probability = transcribe_chunk(model, waveform16, languages, lao_model, vi_model)
                    # The other Lao/Thai reading when the routing was not sure: sent once per chunk, with its first text, for
                    # Claude to translate by meaning (owner 31/10: Lao heard as Thai passes if the meaning holds).
                    others = chunk_alternatives(segments)
                    for segment in segments:
                        if stop.is_set():
                            break
                        text = segment.text.strip()
                        if text:
                            marks = ''.join('; ' + flag for flag in segment_flags(text, segment, language, language_probability))
                            if channel == 'mic':
                                marks += '; CHANNEL_MIC'
                                if listening.follow and place:
                                    # Mic on in the meeting / muted ("nói riêng") / unknown, by what the recorder saw (owner Q7).
                                    begin_wall = parse_wall(place['wall'])
                                    marks += '; ' + label_mic_chunk(timeline.mic_states(), begin_wall, begin_wall + (end - begin))
                            emit({'type': 'source', 'text': collapse_repeats(text), 'start': begin, 'end': end, 'boundary': boundary + '; CHUNK_RANGE_NOT_WORD_TIMESTAMPS' + marks, 'language': language, 'languageProbability': language_probability, 'channel': channel, **place, **({'alternatives': others} if others else {})})
                            others = None
                except Exception as exc:
                    # One bad chunk must not end the meeting: say which stretch has no text and go on with the next.
                    emit({'type': 'gap', 'start': begin, 'end': end, 'reason': 'ASR_ERROR', 'channel': channel, 'message': f'{type(exc).__name__}: {exc}'[:200], **place})
                # How far the text lags behind the audio (seconds of meeting not yet transcribed when this chunk finished).
                if listening.follow:
                    lag = round(followers[channel].disk_samples / RATE16 - end, 1)  # what is on disk but not yet transcribed
                else:
                    lag = round((time.monotonic() - capture_started) * (listening.speed if listening.replay else 1) - end, 1)
                emit({'type': 'status', 'lastASRSeconds': round(time.monotonic() - inference_started, 3), 'lastChunkSeconds': round(end - begin, 3), 'queuedChunks': chunks.qsize(), 'lagSeconds': lag})
                del waveform
            return 'stop'
        finally:
            listening_over.set()
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

    def warm(resumed):
        pause.clear()
        emit({'type': 'warm', 'asr': asr, 'modelLoadSeconds': load_seconds, **({'resumed': True} if resumed else {})})
        warm_since[0] = time.monotonic()

    warm_since = [time.monotonic()]
    try:
        if args.wait_source:
            # Warm start: models load when the session opens; each source arrives later as one JSON line on stdin.
            warm(False)
            command_loop(lines.get, lambda line: run_listening(listening_from_request(json.loads(line), args.max_seconds), time.monotonic() - warm_since[0]), lambda: warm(True))
        elif not stop.is_set():
            run_listening(listening_from_request({'device': args.device, 'deviceName': args.device_name, 'micDevice': args.mic_device, 'micName': args.mic_name, 'micAuto': args.mic_auto,
                                                  'replay': args.replay, 'follow': args.follow, 'speed': args.speed, 'captureId': args.capture_id, 'saveAudioDir': args.save_audio_dir}, args.max_seconds), 0.0)
    finally:
        if mic_watch[0]:
            mic_watch[0].stop()

def silent_audio(waveform16, block=1600):
    # True when no 0.1 s block reaches SOUND_RMS (an empty window counts as silent).
    import numpy as np
    return all(float(np.sqrt(np.mean(waveform16[i:i + block] ** 2))) < SOUND_RMS for i in range(0, len(waveform16), block))


def recheck_window(model, lao_model, vi_model, directory, start, end, channel='speaker', languages=('vi', 'lo', 'th'), beam=8):
    # Cut a wall-time window out of the recorder's files and transcribe it again with a wider beam. `text`/`language` are the
    # usual detection and pick over all languages; `alternatives` is one forced decode per language with its confidence
    # (mean log-probability), so the agent can read the stretch the way it is meant when the detector is unsure.
    timeline = Timeline.load(directory)
    waveform = cut_window(timeline, channel, parse_wall(start), parse_wall(end))
    result = {'text': '', 'language': None, 'alternatives': [], 'silent': silent_audio(waveform), 'seconds': round(len(waveform) / RATE16, 3)}
    if result['silent']:
        return result

    def text_of(segments):
        return collapse_repeats(' '.join(segment.text.strip() for segment in segments if segment.text.strip()))

    for code in languages:
        try:
            segments, _, _ = transcribe_chunk(model, waveform, [code], lao_model, vi_model, beam=beam)
            segments = list(segments)
        except Exception:
            continue  # a language this build cannot decode (th before it is wired in) is left out, not fatal
        score = segments_score(segments)
        result['alternatives'].append({'language': code, 'text': text_of(segments), 'score': round(score, 3) if score > float('-inf') else None})
    try:
        segments, language, _ = transcribe_chunk(model, waveform, list(languages), lao_model, vi_model, beam=beam)
        result.update(text=text_of(list(segments)), language=language)
    except Exception:
        best = max(result['alternatives'], key=lambda item: item['score'] if item['score'] is not None else float('-inf'), default=None)
        if best:
            result.update(text=best['text'], language=best['language'])
    return result


def recheck(args):
    languages = (args.languages or 'vi,lo,th').split(',')
    if not args.from_ or not args.to or args.channel not in ('speaker', 'mic'):
        raise ValueError('--recheck needs --from, --to (ISO times) and --channel speaker or mic')
    profile = asr_profile()
    model_path = Path(args.model or profile['main']).resolve(strict=True)
    model, lao_model, vi_model, _ = load_models(model_path, args.lao_model or profile['lo'], args.asr_device, 6, args.vi_model or profile['vi'])
    emit(recheck_window(model, lao_model, vi_model, args.recheck, args.from_, args.to, args.channel, languages, args.beam))


def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--levels', action='store_true')
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--device', type=int)
    parser.add_argument('--device-name')
    parser.add_argument('--model')
    parser.add_argument('--parent', type=int)
    parser.add_argument('--max-seconds', type=int, default=7200)
    parser.add_argument('--languages')  # default vi,lo,th
    parser.add_argument('--replay')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--asr-device', default='auto', choices=['auto', 'cuda', 'cpu'])
    parser.add_argument('--lao-model')
    parser.add_argument('--vi-model')
    parser.add_argument('--wait-source', action='store_true')
    parser.add_argument('--mic-device', type=int)
    parser.add_argument('--mic-name')
    parser.add_argument('--mic-auto', action='store_true')
    parser.add_argument('--capture-id')
    parser.add_argument('--save-audio-dir')
    parser.add_argument('--follow', help='session audio folder (seg-NNNN-<channel>.wav + timeline.jsonl) to transcribe from sample 0 and tail')
    parser.add_argument('--recheck', help='session audio folder to cut a window from and transcribe again')
    parser.add_argument('--from-wall', help='with --follow: transcribe only audio after this ISO wall time (a restarted worker)')
    parser.add_argument('--from', dest='from_')
    parser.add_argument('--to')
    parser.add_argument('--channel', default='speaker')
    parser.add_argument('--beam', type=int, default=8)
    return parser


if __name__ == '__main__':
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.list:
            emit(list_devices(args.levels))
        elif args.recheck:
            recheck(args)
        elif args.follow or args.capture:
            args.languages = args.languages or 'vi,lo,th'
            if args.capture and not args.follow and not 1 <= args.max_seconds <= 7200:
                raise ValueError('Capture duration must be between 1 and 7200 seconds')
            capture(args)
        else:
            parser.error('Select --list, --capture, --follow or --recheck')
    except Exception as exc:
        emit({'type': 'error', 'message': str(exc)})
        sys.exit(1)
