"""Score a local ASR model on public FLEURS test clips (CC-BY-4.0). Reads audio straight from the tar into RAM.
Reports CER, Lao vs Thai characters, and speed. Nothing leaves the machine; results go to .local/eval/results."""
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
from audio_worker import enable_cuda_libraries, load_models, transcribe_chunk  # noqa: E402
FLEURS = root / '.local' / 'eval' / 'fleurs' / 'data'
LANGS = {'lo': 'lo_la', 'vi': 'vi_vn'}


def normalize(text, language):
    # NFKC, lowercase, punctuation removed; Lao has no word spaces, so spaces are ignored there.
    text = unicodedata.normalize('NFKC', text).lower()
    text = ''.join(ch for ch in text if not unicodedata.category(ch).startswith('P'))
    text = re.sub(r'\s+', ' ', text).strip()
    return text.replace(' ', '') if language == 'lo' else text


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


def clips(language, limit):
    folder = FLEURS / LANGS[language]
    rows = list(csv.reader(open(folder / 'test.tsv', encoding='utf-8'), delimiter='\t', quoting=csv.QUOTE_NONE))
    wanted = {row[1]: row[3] or row[2] for row in rows[:limit]}
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, help='faster-whisper (CTranslate2) model directory')
    parser.add_argument('--language', choices=list(LANGS), required=True)
    parser.add_argument('--force-language', help='language token passed to the model (default: --language)')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--compute-type', default=None)
    parser.add_argument('--limit', type=int, default=40)
    parser.add_argument('--label', default=None)
    parser.add_argument('--pipeline-lao-model', help='score the live pipeline instead: --model detects vi/lo, Lao chunks go to this model')
    args = parser.parse_args()
    if args.device == 'cuda':
        enable_cuda_libraries()
    from faster_whisper import WhisperModel
    compute = args.compute_type or ('int8_float16' if args.device == 'cuda' else 'int8')
    started = time.monotonic()
    lao_model = None
    if args.pipeline_lao_model:
        model, lao_model, asr = load_models(args.model, args.pipeline_lao_model, args.device, 8)
        compute = f"pipeline {asr['device']} lao={asr['laoModel']}"
    else:
        model = WhisperModel(str(args.model), device=args.device, compute_type=compute, cpu_threads=8, local_files_only=True)
    load_seconds = time.monotonic() - started
    totals = {'edits': 0, 'chars': 0, 'audio': 0.0, 'asr': 0.0, 'lao': 0, 'thai': 0, 'clips': 0, 'languageCorrect': 0}
    examples = []
    for name, reference, data in clips(args.language, args.limit):
        audio = decode(data)
        t = time.monotonic()
        if args.pipeline_lao_model:
            segments, chosen, _ = transcribe_chunk(model, audio, ['vi', 'lo'], lao_model)
            totals['languageCorrect'] += chosen == args.language
        else:
            segments, _ = model.transcribe(audio, language=args.force_language or args.language, beam_size=1, temperature=0, condition_on_previous_text=False, max_new_tokens=200, no_repeat_ngram_size=3, repetition_penalty=1.2)
        hypothesis = ' '.join(s.text.strip() for s in segments)
        totals['asr'] += time.monotonic() - t
        totals['audio'] += len(audio) / 16000
        ref, hyp = normalize(reference, args.language), normalize(hypothesis, args.language)
        totals['edits'] += distance(ref, hyp)
        totals['chars'] += len(ref)
        counts = script_counts(hypothesis)
        totals['lao'] += counts['lao']
        totals['thai'] += counts['thai']
        totals['clips'] += 1
        if len(examples) < 3:
            examples.append({'reference': reference, 'hypothesis': hypothesis})
        print(f"{totals['clips']:3d} CER so far {totals['edits'] / max(1, totals['chars']):.3f}", file=sys.stderr, flush=True)
    result = {'label': args.label or Path(args.model).name, 'model': str(args.model), 'language': args.language, 'device': args.device, 'computeType': compute,
              'clips': totals['clips'], 'audioSeconds': round(totals['audio'], 1), 'cer': round(totals['edits'] / max(1, totals['chars']), 4),
              'realTimeFactor': round(totals['asr'] / max(1e-9, totals['audio']), 3), 'loadSeconds': round(load_seconds, 1),
              'laoChars': totals['lao'], 'thaiChars': totals['thai'], 'examples': examples,
              'languageAccuracy': round(totals['languageCorrect'] / max(1, totals['clips']), 3) if args.pipeline_lao_model else None,
              'note': 'FLEURS read speech, not meetings. CER after NFKC, lowercase, punctuation removed' + (', spaces ignored (Lao)' if args.language == 'lo' else '') + '.'}
    out = root / '.local' / 'eval' / 'results'
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{result['label']}-{args.language}-{args.device}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'examples'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
