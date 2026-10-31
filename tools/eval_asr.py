"""Score a local ASR model on public FLEURS test clips (CC-BY-4.0). Reads audio straight from the tar into RAM.
Reports CER, Lao vs Thai characters, and speed. Nothing leaves the machine; results go to .local/eval/results.
--short-clips scores language identification on 1.5-3 s cuts of the clips; --mixed runs a mixed vi/lo recording;
--lo-as-th decodes Lao clips as Thai (main model) and keeps example pairs for a manual meaning check."""
import argparse
import csv
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import time
import unicodedata

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from audio_worker import chunk_alternatives, enable_cuda_libraries, load_models, transcribe_chunk  # noqa: E402
FLEURS = root / '.local' / 'eval' / 'fleurs' / 'data'
LANGS = {'lo': 'lo_la', 'vi': 'vi_vn', 'th': 'th_th'}  # th_th: huggingface-cli download google/fleurs data/th_th/test.tsv data/th_th/audio/test.tar.gz (CC-BY-4.0)


def normalize(text, language):
    # NFKC, lowercase, punctuation removed; Lao and Thai have no word spaces, so spaces are ignored there.
    text = unicodedata.normalize('NFKC', text).lower()
    text = ''.join(ch for ch in text if not unicodedata.category(ch).startswith('P'))
    text = re.sub(r'\s+', ' ', text).strip()
    return text.replace(' ', '') if language in ('lo', 'th') else text


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def script_counts(text):
    return {'lao': sum('຀' <= ch <= '໿' for ch in text), 'thai': sum('฀' <= ch <= '๿' for ch in text)}


def clips(language, limit, offset=0):
    folder = FLEURS / LANGS[language]
    rows = list(csv.reader(open(folder / 'test.tsv', encoding='utf-8'), delimiter='\t', quoting=csv.QUOTE_NONE))
    wanted = {row[1]: row[3] or row[2] for row in rows[offset:offset + limit]}
    with tarfile.open(folder / 'audio' / 'test.tar.gz') as archive:
        for member in archive:
            name = Path(member.name).name
            if name in wanted:
                yield name, wanted.pop(name), archive.extractfile(member).read()
                if not wanted:
                    return


def decode(data):
    import av
    import numpy as np
    container = av.open(io.BytesIO(data))
    resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
    pcm = [f.to_ndarray().reshape(-1) for p in container.decode(audio=0) for f in resampler.resample(p)] + [f.to_ndarray().reshape(-1) for f in resampler.resample(None)]
    return np.concatenate(pcm).astype('float32')


SHORT_LENGTHS = (1.5, 2.0, 2.5, 3.0)


def short_windows(audio, rate=16000, lengths=SHORT_LENGTHS):
    # Consecutive cuts of 1.5-3 s by default (lengths cycle), keeping those where most 100 ms blocks carry speech: FLEURS clips have
    # silent edges that would otherwise count as language-less chunks.
    import numpy as np
    block = rate // 10
    rms = np.array([np.sqrt(np.mean(audio[i:i + block] ** 2)) for i in range(0, len(audio) - block + 1, block)])
    loud = rms >= max(0.004, 0.25 * float(np.percentile(rms, 90)))
    position, index = 0, 0
    while True:
        length = int(lengths[index % len(lengths)] * rate)
        if position + length > len(audio):
            return
        if loud[position // block:(position + length) // block].mean() >= 0.7:
            yield audio[position:position + length]
        position += length
        index += 1


def silence_chunks(audio, rate=16000, min_seconds=6, silence_seconds=0.55, max_seconds=20, quiet=0.006):
    # The live worker's mixed-session chunking, on a recording: cut after a quiet stretch once min_seconds is reached.
    import numpy as np
    block = rate // 10
    begin = quiet_blocks = 0
    for i in range(0, len(audio) - block + 1, block):
        rms = float(np.sqrt(np.mean(audio[i:i + block] ** 2)))
        quiet_blocks = quiet_blocks + 1 if rms < quiet else 0
        end = i + block
        if (end - begin) / rate >= max_seconds or ((end - begin) / rate >= min_seconds and quiet_blocks * 0.1 >= silence_seconds):
            yield begin / rate, end / rate, audio[begin:end]
            begin, quiet_blocks = end, 0
    if len(audio) - begin >= rate:
        yield begin / rate, len(audio) / rate, audio[begin:]


class Routing:
    """Tallies of where chunks of one gold language went. Lao and Thai are mutually intelligible, so next to the strict
    accuracy (chosen == gold) it keeps what matters for the product: a Tai chunk read as lo or th with the other reading
    offered as an alternative still reaches Claude in both scripts ("covered"); vi vs Tai is the hard error."""

    def __init__(self, gold):
        self.gold, self.chosen, self.chunks, self.with_alternative, self.covered = gold, {}, 0, 0, 0

    def add(self, chosen, alternatives):
        self.chunks += 1
        self.chosen[chosen] = self.chosen.get(chosen, 0) + 1
        self.with_alternative += bool(alternatives)
        readings = {chosen, *(alt['language'] for alt in alternatives)}
        self.covered += self.gold in readings

    def summary(self):
        n = max(1, self.chunks)
        tai = ('lo', 'th')
        right_family = sum(count for code, count in self.chosen.items() if (code in tai) == (self.gold in tai))
        return {'chunks': self.chunks, 'chosen': self.chosen, 'strictAccuracy': round(self.chosen.get(self.gold, 0) / n, 3), 'familyAccuracy': round(right_family / n, 3),
                'withAlternative': round(self.with_alternative / n, 3), 'goldReadingReturned': round(self.covered / n, 3)}


def run_short(args, model, lao_model, vi_model, pick):
    totals = {'windows': 0, 'audio': 0.0, 'asr': 0.0}
    routing = Routing(args.language)
    languages = args.languages.split(',')
    for _, _, data in clips(args.language, args.limit, args.offset):
        for window in short_windows(decode(data), lengths=tuple(float(x) for x in args.windows.split(','))):
            t = time.monotonic()
            segments, chosen, _ = transcribe_chunk(model, window, languages, lao_model, vi_model, pick=pick, beam=args.beam)
            list(segments)
            totals['asr'] += time.monotonic() - t
            totals['audio'] += len(window) / 16000
            totals['windows'] += 1
            routing.add(chosen, chunk_alternatives(segments))
    return {'windowCount': totals['windows'], 'audioSeconds': round(totals['audio'], 1), 'languages': args.languages, 'routing': routing.summary(),
            'languageAccuracy': routing.summary()['strictAccuracy'], 'realTimeFactor': round(totals['asr'] / max(1e-9, totals['audio']), 3), 'windows': args.windows,
            'note': 'FLEURS cut into windows (seconds above); strictAccuracy = routed to the language of the clip, familyAccuracy = vi vs Tai right, goldReadingReturned = the clip language is the primary or an alternative.'}


def run_lo_as_th(args, model):
    # Lao clips decoded by the main model forced to Thai: what a Thai-script reading of Lao speech looks like. The Lao reference is in Lao
    # script, so a CER against it means nothing; the pairs are kept for a manual check that the meaning survives (Claude translates either).
    options = {'task': 'transcribe', 'max_new_tokens': 224, 'beam_size': 5, 'temperature': 0, 'condition_on_previous_text': False, 'vad_filter': True, 'vad_parameters': {'min_silence_duration_ms': 400}, 'no_speech_threshold': 0.6}
    pairs, seen = [], set()
    # FLEURS has several speakers per sentence: one pair per distinct sentence, scanning up to 8x --limit clips.
    for name, reference, data in clips('lo', args.limit * 8, args.offset):
        if reference in seen:
            continue
        seen.add(reference)
        audio = decode(data)
        text = ' '.join(s.text.strip() for s in model.transcribe(audio, language='th', **options)[0])
        pairs.append({'clip': name, 'seconds': round(len(audio) / 16000, 1), 'laoReference': reference, 'turboThOutput': text})
        if len(pairs) >= args.limit:
            break
    out = root / '.local' / 'eval' / 'results'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'lo-as-th-pairs.json').write_text(json.dumps(pairs, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'pairs': len(pairs), 'file': str(out / 'lo-as-th-pairs.json')}, ensure_ascii=False))


def run_mixed(args, model, lao_model, vi_model, pick):
    audio = decode(open(args.mixed, 'rb').read())
    rows, asr_seconds = [], 0.0
    for begin, end, chunk in silence_chunks(audio):
        t = time.monotonic()
        segments, chosen, share = transcribe_chunk(model, chunk, args.languages.split(','), lao_model, vi_model, pick=pick, beam=args.beam)
        text = ' '.join(s.text.strip() for s in segments)
        asr_seconds += time.monotonic() - t
        counts = script_counts(text)
        rows.append({'start': round(begin, 1), 'end': round(end, 1), 'language': chosen, 'share': share, 'laoChars': counts['lao'], 'thaiChars': counts['thai'], 'alternatives': [alt['language'] for alt in chunk_alternatives(segments)], 'text': text[:140]})
    # Script is the proxy for truth here (no reference text): a chunk labelled lo should hold Lao characters, th Thai ones, vi neither.
    consistent = sum((row['laoChars'] > 0 if row['language'] == 'lo' else row['thaiChars'] > 0 if row['language'] == 'th' else row['laoChars'] + row['thaiChars'] == 0) for row in rows)
    return {'chunks': rows, 'scriptConsistency': round(consistent / max(1, len(rows)), 3), 'realTimeFactor': round(asr_seconds / (len(audio) / 16000), 3), 'switches': sum(a['language'] != b['language'] for a, b in zip(rows, rows[1:]))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, help='faster-whisper (CTranslate2) model directory')
    parser.add_argument('--language', choices=list(LANGS), required=True)
    parser.add_argument('--force-language', help='language token passed to the model (default: --language)')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--compute-type', default=None)
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--offset', type=int, default=0, help='skip this many clips first (a held-out slice after tuning on the first ones)')
    parser.add_argument('--label', default=None)
    parser.add_argument('--pipeline-lao-model', help='score the live pipeline instead: --model detects vi/lo, Lao chunks go to this model')
    parser.add_argument('--pipeline-vi-model', help='with --pipeline-lao-model: Vietnamese chunks go to this model')
    parser.add_argument('--lao-token', choices=['on', 'off'], default='on', help='pipeline: decode the Lao model with <|lo|> (default) or as the old English-only start')
    parser.add_argument('--pick', choices=['on', 'off', 'default'], default='default', help='pipeline: decode uncertain/short chunks with both models and keep the more confident')
    parser.add_argument('--beam', type=int, default=None, help='pipeline: beam width (default: the worker constant for this device)')
    parser.add_argument('--windows', default=','.join(str(x) for x in SHORT_LENGTHS), help='with --short-clips: window lengths in seconds, cycled (e.g. 4,6,8 for realistic chunks)')
    parser.add_argument('--short-clips', action='store_true', help='pipeline: score language identification on 1.5-3 s cuts of the clips')
    parser.add_argument('--mixed', help='pipeline: run this mixed vi/lo recording through the live chunking instead of FLEURS')
    parser.add_argument('--languages', default='vi,lo,th', help='pipeline: session languages passed to the worker (subset of vi,lo,th)')
    parser.add_argument('--lo-as-th', action='store_true', help='decode --limit Lao clips with the main model forced to Thai and keep (Lao reference, Thai output) pairs in results/lo-as-th-pairs.json')
    args = parser.parse_args()
    if (args.short_clips or args.mixed) and not args.pipeline_lao_model:
        parser.error('--short-clips and --mixed need --pipeline-lao-model')
    if args.lo_as_th:
        args.language = 'lo'
    if args.device == 'cuda':
        enable_cuda_libraries()
    from faster_whisper import WhisperModel
    compute = args.compute_type or ('int8_float16' if args.device == 'cuda' else 'int8')
    started = time.monotonic()
    lao_model = None
    if args.pipeline_lao_model:
        model, lao_model, vi_model, asr = load_models(args.model, args.pipeline_lao_model, args.device, 8, args.pipeline_vi_model, lao_token=args.lao_token == 'on')
        compute = f"pipeline {asr['device']} main={asr['mainModel']} vi={asr['viModel']} lao={asr['laoModel']} lao-token={asr['laoLanguageToken']}"
    else:
        model = WhisperModel(str(args.model), device=args.device, compute_type=compute, cpu_threads=8, local_files_only=True)
    load_seconds = time.monotonic() - started
    pick = {'on': True, 'off': False, 'default': None}[args.pick]
    if args.lo_as_th:
        run_lo_as_th(args, model)
        return
    if args.short_clips or args.mixed:
        mode = 'mixed' if args.mixed else 'short-clips'
        result = {'label': args.label or Path(args.model).name, 'mode': mode, 'language': 'mixed' if args.mixed else args.language, 'computeType': compute, 'pick': args.pick, 'beam': args.beam,
                  'laoToken': asr['laoLanguageToken'], 'loadSeconds': round(load_seconds, 1), **(run_mixed if args.mixed else run_short)(args, model, lao_model, vi_model, pick)}
        out = root / '.local' / 'eval' / 'results'
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{result['label']}-{mode}-{result['language']}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in result.items() if k != 'chunks'}, ensure_ascii=False))
        return
    totals = {'edits': 0, 'chars': 0, 'audio': 0.0, 'asr': 0.0, 'lao': 0, 'thai': 0, 'clips': 0, 'languageCorrect': 0, 'goldEdits': 0, 'goldChars': 0, 'goldClips': 0}
    examples = []
    routing = Routing(args.language)
    chosen = args.language
    for name, reference, data in clips(args.language, args.limit, args.offset):
        audio = decode(data)
        t = time.monotonic()
        if args.pipeline_lao_model:
            segments, chosen, _ = transcribe_chunk(model, audio, args.languages.split(','), lao_model, vi_model, pick=pick, beam=args.beam)
            totals['languageCorrect'] += chosen == args.language
            routing.add(chosen, chunk_alternatives(segments))
        else:
            segments, _ = model.transcribe(audio, language=args.force_language or args.language, beam_size=1, temperature=0, condition_on_previous_text=False, max_new_tokens=200, no_repeat_ngram_size=3, repetition_penalty=1.2)
        hypothesis = ' '.join(s.text.strip() for s in segments)
        totals['asr'] += time.monotonic() - t
        totals['audio'] += len(audio) / 16000
        ref, hyp = normalize(reference, args.language), normalize(hypothesis, args.language)
        edits = distance(ref, hyp)
        totals['edits'] += edits
        totals['chars'] += len(ref)
        if chosen == args.language:  # only a reading in the clip's own script can be scored against its reference
            totals['goldEdits'] += edits
            totals['goldChars'] += len(ref)
            totals['goldClips'] += 1
        counts = script_counts(hypothesis)
        totals['lao'] += counts['lao']
        totals['thai'] += counts['thai']
        totals['clips'] += 1
        if len(examples) < 3:
            examples.append({'reference': reference, 'hypothesis': hypothesis})
        print(f"{totals['clips']:3d} CER so far {totals['edits'] / max(1, totals['chars']):.3f}", file=sys.stderr, flush=True)
    result = {'label': args.label or Path(args.model).name, 'model': str(args.model), 'language': args.language, 'device': args.device, 'computeType': compute,
              'clips': totals['clips'], 'audioSeconds': round(totals['audio'], 1), 'beam': args.beam, 'cer': round(totals['edits'] / max(1, totals['chars']), 4),
              'realTimeFactor': round(totals['asr'] / max(1e-9, totals['audio']), 3), 'loadSeconds': round(load_seconds, 1),
              'laoChars': totals['lao'], 'thaiChars': totals['thai'], 'examples': examples,
              'cerWhenRoutedToClipLanguage': round(totals['goldEdits'] / max(1, totals['goldChars']), 4) if args.pipeline_lao_model else None, 'clipsRoutedToClipLanguage': totals['goldClips'],
              'routing': routing.summary() if args.pipeline_lao_model else None, 'languages': args.languages if args.pipeline_lao_model else None,
              'languageAccuracy': round(totals['languageCorrect'] / max(1, totals['clips']), 3) if args.pipeline_lao_model else None,
              'note': 'FLEURS read speech, not meetings. CER after NFKC, lowercase, punctuation removed' + (', spaces ignored (Lao, Thai)' if args.language in ('lo', 'th') else '') + '.'}
    out = root / '.local' / 'eval' / 'results'
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{result['label']}-{args.language}-{args.device}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'examples'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
