"""Put a speaker name on each transcript line from what Zoom showed on screen (tools/meeting_screen.ps1 -> screen.jsonl).

Read only: reads `pma read --json` pages and screen.jsonl, prints the transcript with a name per line. Nothing is saved.

Rules, each line says which applied:
- microphone channel (CHANNEL_MIC) -> the owner ("Tôi"), from the recorder, not from Zoom;
- otherwise the name Zoom outlined as speaking at the middle of the chunk; when the outline changed inside the chunk,
  every name is given ("A→B");
- no outline seen in the last 30 s before the chunk -> "?" (never a guess).
Zoom's outline follows Zoom's own voice detection and can trail the voice by about a second; chunks are not word-timed.
"""
import argparse
import bisect
from datetime import datetime, timedelta
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('screen', type=Path, help='screen.jsonl written by tools/meeting_screen.ps1')
parser.add_argument('--pma', default=str(ROOT / 'pma'), help='pma command (default: the one in this checkout)')
parser.add_argument('--since', help='only lines from this local time HH:MM:SS')
parser.add_argument('--stale', type=float, default=30, help='seconds after which an outline no longer names a speaker')
args = parser.parse_args()
sys.stdout.reconfigure(encoding='utf-8')


def utc(text):
    """ISO time in UTC; PowerShell writes 7 fraction digits, pma writes 3 with Z."""
    head, _, frac = text.rstrip('Z').partition('.')
    frac = ''.join(c for c in frac if c.isdigit())[:6].ljust(6, '0')
    return datetime.fromisoformat(f'{head}.{frac}+00:00')


events = []
for line in args.screen.read_text(encoding='utf-8-sig').splitlines():
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get('type') == 'speaker' and e.get('name'):
        events.append((utc(e['utc']), e['name']))
    elif e.get('type') == 'share_start':
        events.append((utc(e['utc']), None))  # the strip outline is not read while the share fills the window
events.sort()
times = [t for t, _ in events]


def read_all():
    after = None
    while True:
        cmd = ['node', str(Path(args.pma).with_name('dist') / 'cli.js'), 'read', '--json'] + (['--after', str(after)] if after else [])
        page = json.loads(subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', check=True).stdout)
        yield from page['items']
        if page.get('done') or not page['items']:
            return
        after = page['nextCursor']


def speaker(start, end):
    i = bisect.bisect_right(times, start) - 1
    names = []
    if i >= 0 and (start - times[i]).total_seconds() <= args.stale and events[i][1]:
        names.append(events[i][1])
    for t, name in events[i + 1:]:
        if t > end:
            break
        if name and (not names or names[-1] != name):
            names.append(name)
    return '→'.join(names) if names else '?'


first = events[0][0] if events else None
items = [i for i in read_all() if i.get('wall') and not i.get('text', '').startswith('[')]
# Lines cut from one chunk share the chunk's range (no word timestamps): split that range by text length, an estimate.
chunks = {}
for i in items:
    chunks.setdefault((i['wall'], i.get('start'), i.get('end')), []).append(i)
span = {}
for (wall, s, e), group in chunks.items():
    total = sum(len(g.get('text', '')) for g in group) or 1
    at = utc(wall)
    dur = max(0.0, (e or 0) - (s or 0))
    for g in group:
        part = dur * len(g.get('text', '')) / total
        span[g['id']] = (at, at + timedelta(seconds=part), len(group) > 1)
        at += timedelta(seconds=part)
for item in items:
    start, end, estimated = span[item['id']]
    local = start.astimezone().strftime('%H:%M:%S')
    if args.since and local < args.since:
        continue
    flags = item.get('boundary', '')
    if 'LIKELY_HALLUCINATION' in flags:
        continue
    if 'CHANNEL_MIC' in flags:
        who, how = 'Tôi', 'micro'
    elif first is None or start < first:
        who, how = '?', 'trước khi canh màn hình'
    else:
        who, how = speaker(start, end), 'Zoom, giờ ước theo độ dài câu' if estimated else 'Zoom'
    print(f"#{item['id']} {local} [{who}] {item.get('language', '?')}: {item.get('shown') or item.get('text')}   ({how})")
