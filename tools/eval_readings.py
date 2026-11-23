"""Offline evaluation of the two-readings worker (item 1a): both readings of the same chunk, with timing and VRAM.

    python tools/eval_readings.py manifest --db history.sqlite3 --session ID --from ISO --to ISO --out manifest.jsonl
    python tools/eval_readings.py chunks   --manifest manifest.jsonl --models <.local/models> --out chunks.jsonl
    python tools/eval_readings.py fleurs   --language lo --limit 40 --models <.local/models> --out fleurs-lo.jsonl [--short]
    python tools/eval_readings.py summary  chunks.jsonl [...]

Nothing is written next to the code: the manifest (audio folders, times, labels, old transcript rows) and the outputs belong in a
private folder outside git. The database is opened read-only; audio is read through the recorder's timeline and never written.
Run it only when no meeting is being followed (one GPU job at a time)."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding='utf-8')


class VramPeak:
    """Peak GPU memory (MiB) seen by nvidia-smi while the block runs, sampled every 0.25 s."""

    def __init__(self):
        self.peak = 0
        self.stop = threading.Event()

    def read(self):
        try:
            out = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5).stdout
            return int(out.strip().splitlines()[0])
        except Exception:
            return 0

    def __enter__(self):
        def loop():
            while not self.stop.is_set():
                self.peak = max(self.peak, self.read())
                time.sleep(0.25)
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()


def words(text):
    return re.findall(r'\w+', unicodedata.normalize('NFC', (text or '').lower()))


def word_error(reference, hypothesis):
    """Word-level edit distance / reference length (a WER-like overlap against the old transcript, not against the truth)."""
    a, b = words(reference), words(hypothesis)
    if not a:
        return None
    previous = list(range(len(b) + 1))
    for i, wa in enumerate(a, 1):
        current = [i]
        for j, wb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (wa != wb)))
        previous = current
    return previous[-1] / len(a)


def build_manifest(args):
    db = sqlite3.connect(f'file:{Path(args.db).as_posix()}?mode=ro', uri=True)
    rows = db.execute("SELECT id,wall,start,end,language,text,boundary FROM sources WHERE session_id=? AND wall>=? AND wall<=? AND origin='local_asr_unverified' ORDER BY id",
                      (args.session, args.from_, args.to)).fetchall()
    chunks = {}
    for id_, wall, start, end, language, text, boundary in rows:
        if 'CHANNEL_MIC' in (boundary or ''):
            continue
        chunk = chunks.setdefault((wall, start), {'wall': wall, 'seconds': round(end - start, 3), 'rows': [], 'old': {'language': language, 'text': ''}})
        chunk['rows'].append(id_)
        chunk['old']['text'] = (chunk['old']['text'] + ' ' + text).strip()
    with open(args.out, 'w', encoding='utf-8') as out:
        for chunk in chunks.values():
            out.write(json.dumps({'audio': args.audio, 'channel': 'speaker', 'label': args.label, **chunk}, ensure_ascii=False) + '\n')
    print(json.dumps({'chunks': len(chunks), 'rows': len(rows)}))


def load(models_dir, vi_model=False):
    from audio_worker import load_models
    models = Path(models_dir)
    profile = json.loads((models / 'asr-profile.json').read_text(encoding='utf-8'))
    main, lao = models / profile['main'], models / profile.get('lo', 'buzzasr-lao-ct2')
    model, lao_model, vi, asr = load_models(main, lao, 'cuda', 6, None)
    if lao_model is None:
        raise SystemExit('Lao model not loaded: the two-readings evaluation needs it')
    return model, lao_model, vi, {'main': asr['mainModel'], 'vi': asr['viModel'], 'lo': asr['laoModel']}


def feature_row(result, names, seconds):
    readings = {r['language']: r for r in result.alternatives}
    return {'audioSeconds': round(seconds, 3), 'picked': 'vi' if readings['vi']['picked'] else 'lo', 'undecided': result.undecided, 'decodeSeconds': result.seconds, 'readings': readings}


def run_chunks(args):
    from audio_worker import transcribe_readings
    from follow_source import cut_window
    from timeline import Timeline, parse_wall
    model, lao_model, vi_model, names = load(args.models)
    timelines = {}
    entries = [json.loads(line) for line in open(args.manifest, encoding='utf-8')]
    with VramPeak() as vram, open(args.out, 'w', encoding='utf-8') as out:
        # Warm-up: the first decode pays CUDA initialisation; it is not a chunk of the meeting.
        import numpy as np
        transcribe_readings(model, np.zeros(16000, dtype=np.float32), lao_model, vi_model, model_names=names)
        for entry in entries:
            timeline = timelines.setdefault(entry['audio'], Timeline.load(entry['audio']))
            begin = parse_wall(entry['wall'])
            waveform = cut_window(timeline, entry.get('channel', 'speaker'), begin, begin + entry['seconds'])
            if not len(waveform):
                continue
            started = time.perf_counter()
            result = transcribe_readings(model, waveform, lao_model, vi_model, model_names=names)[0]
            wall_seconds = time.perf_counter() - started
            row = feature_row(result, names, len(waveform) / 16000)
            picked = row['readings'][row['picked']]['text']
            old = entry.get('old') or {}
            row.update(wall=entry['wall'], label=entry.get('label'), rows=entry.get('rows'), totalSeconds=round(wall_seconds, 3), oldLanguage=old.get('language'),
                       oldText=old.get('text'), viVsOld=word_error(old.get('text'), row['readings']['vi']['text']), pickedVsOld=word_error(old.get('text'), picked))
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
            out.flush()
        out.write(json.dumps({'summary': True, 'peakVramMiB': vram.peak}) + '\n')


def run_fleurs(args):
    import eval_asr
    eval_asr.FLEURS = Path(args.fleurs)
    from audio_worker import transcribe_readings
    model, lao_model, vi_model, names = load(args.models)
    import numpy as np
    transcribe_readings(model, np.zeros(16000, dtype=np.float32), lao_model, vi_model, model_names=names)
    with VramPeak() as vram, open(args.out, 'w', encoding='utf-8') as out:
        for name, reference, data in eval_asr.clips(args.language, args.limit, args.offset):
            audio = eval_asr.decode(data)
            pieces = [('full', audio)] if not args.short else [('short', w) for w in eval_asr.short_windows(audio)]
            for kind, piece in pieces:
                started = time.perf_counter()
                result = transcribe_readings(model, piece, lao_model, vi_model, model_names=names)[0]
                row = feature_row(result, names, len(piece) / 16000)
                row.update(clip=name, kind=kind, gold=args.language, totalSeconds=round(time.perf_counter() - started, 3), reference=reference)
                out.write(json.dumps(row, ensure_ascii=False) + '\n')
                out.flush()
        out.write(json.dumps({'summary': True, 'peakVramMiB': vram.peak}) + '\n')


def percentile(values, q):
    values = sorted(values)
    if not values:
        return None
    index = min(len(values) - 1, max(0, int(round(q * (len(values) - 1)))))
    return round(values[index], 3)


def summarize(paths):
    rows, peaks = [], []
    for path in paths:
        for line in open(path, encoding='utf-8'):
            item = json.loads(line)
            (peaks if item.get('summary') else rows).append(item.get('peakVramMiB') if item.get('summary') else item)
    audio = sum(r['audioSeconds'] for r in rows)
    total = [r['totalSeconds'] for r in rows]
    vi = [r['decodeSeconds']['vi'] for r in rows]
    lo = [r['decodeSeconds']['lo'] for r in rows]
    print(json.dumps({'chunks': len(rows), 'audioSeconds': round(audio, 1), 'peakVramMiB': max(peaks) if peaks else None,
                      'totalSeconds': {'p50': percentile(total, .5), 'p95': percentile(total, .95), 'sum': round(sum(total), 1)},
                      'viSeconds': {'p50': percentile(vi, .5), 'p95': percentile(vi, .95)}, 'loSeconds': {'p50': percentile(lo, .5), 'p95': percentile(lo, .95)},
                      'realTimeFactor': round(sum(total) / audio, 3) if audio else None, 'picked': {c: sum(r['picked'] == c for r in rows) for c in ('vi', 'lo')},
                      'undecided': sum(r['undecided'] for r in rows)}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    m = sub.add_parser('manifest')
    m.add_argument('--db', required=True)
    m.add_argument('--session', required=True)
    m.add_argument('--from', dest='from_', required=True)
    m.add_argument('--to', required=True)
    m.add_argument('--audio', required=True)
    m.add_argument('--label', default='')
    m.add_argument('--out', required=True)
    c = sub.add_parser('chunks')
    c.add_argument('--manifest', required=True)
    c.add_argument('--models', required=True)
    c.add_argument('--out', required=True)
    f = sub.add_parser('fleurs')
    f.add_argument('--language', choices=['lo', 'vi'], required=True)
    f.add_argument('--limit', type=int, default=40)
    f.add_argument('--offset', type=int, default=0)
    f.add_argument('--short', action='store_true')
    f.add_argument('--fleurs', required=True, help='folder holding lo_la/ and vi_vn/ (public FLEURS test data)')
    f.add_argument('--models', required=True)
    f.add_argument('--out', required=True)
    s = sub.add_parser('summary')
    s.add_argument('paths', nargs='+')
    args = parser.parse_args()
    {'manifest': build_manifest, 'chunks': run_chunks, 'fleurs': run_fleurs, 'summary': lambda a: summarize(a.paths)}[args.command](args)


if __name__ == '__main__':
    main()
