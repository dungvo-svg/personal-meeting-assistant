"""Put a speaker name on each transcript line from the Claude meeting bot's transcript (names and times are good, its text is not).

Read only: reads a bot transcript saved by Claude as JSON and `pma read --json` pages, prints the PMA transcript with a name per
line. Nothing is saved and nothing is sent anywhere.

Bot transcript shape (the central session writes it from `get_meeting_transcript` / `follow_meeting_transcript`):
    [{"start": "2026-11-23T14:05:12+07:00" | "14:05:12", "end": "14:05:19" (optional), "speaker": "Sơn Nguyễn", "text": "..."}, ...]
`start`/`end`: ISO time (no offset = local time) or HH:MM:SS local time. Without `end` a turn lasts until the next turn starts
(at most --max-turn seconds). The bot's words are used only for the tiebreak below; the words printed are PMA's.

Rules, each line says which applied:
- microphone channel (CHANNEL_MIC) -> the owner ("Tôi"), from the recorder, not from the bot;
- a microphone row flagged MIC_BLEED -> "loa lọt mic" (speaker sound heard through the mic, not the owner);
- otherwise the bot speaker whose turn overlaps the line's time the most; when two speakers share the line, the one holding at
  least 70% of the overlap, else the one whose bot text is clearly closer to the line's words (tiebreak), else both ("A/B");
- no turn overlaps but one is within --near seconds (clock offset between the bot and the recorder) -> that speaker, marked "gần giờ";
- nothing within --near seconds -> "?" (never a guess).
Lines cut from one chunk share the chunk's time range (no word timestamps): that range is split by text length, an estimate.
"""
import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DOMINANT = 0.7
TIE_MARGIN = 0.1
MAX_TURN_SECONDS = 30.0


def parse_time(value, day=None):
    """ISO string or HH:MM:SS -> aware datetime. No offset means local time; HH:MM:SS needs `day` (a local date)."""
    text = str(value).strip().replace('Z', '+00:00')
    if re.fullmatch(r'\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?', text):
        if day is None:
            raise ValueError('HH:MM:SS needs a date: no PMA line to take it from')
        parts = [float(p) for p in text.split(':')]
        hours, minutes, seconds = parts[0], parts[1], parts[2] if len(parts) > 2 else 0.0
        local = datetime(day.year, day.month, day.day).astimezone()
        return local + timedelta(hours=hours, minutes=minutes, seconds=seconds)
    # PowerShell and pma write 3-7 fraction digits; fromisoformat takes 3 or 6
    match = re.match(r'^(.*?)(\.(\d+))?([+-]\d{2}:\d{2})?$', text)
    head, frac, zone = match.group(1), (match.group(3) or ''), match.group(4) or ''
    frac = frac[:6].ljust(6, '0') if frac else ''
    moment = datetime.fromisoformat(head + ('.' + frac if frac else '') + zone)
    return moment if moment.tzinfo else moment.astimezone()


def load_turns(entries, day, shift=0.0, max_turn=MAX_TURN_SECONDS):
    """Normalized turns [(start, end, speaker, text)] sorted by start; a missing end is the next turn's start (capped)."""
    raw = []
    for entry in entries:
        speaker = str(entry.get('speaker') or '').strip()
        if not speaker or entry.get('start') in (None, ''):
            continue
        begin = parse_time(entry['start'], day) + timedelta(seconds=shift)
        end = parse_time(entry['end'], day) + timedelta(seconds=shift) if entry.get('end') not in (None, '') else None
        raw.append([begin, end, speaker, str(entry.get('text') or '')])
    raw.sort(key=lambda turn: turn[0])
    for index, turn in enumerate(raw):
        if turn[1] is None or turn[1] < turn[0]:
            following = raw[index + 1][0] if index + 1 < len(raw) else None
            cap = turn[0] + timedelta(seconds=max_turn)
            turn[1] = min(following, cap) if following and following > turn[0] else cap
    return [tuple(turn) for turn in raw]


def normalize(text):
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', '', (text or '').lower())).strip()


def similarity(a, b):
    """Dice coefficient on character trigrams (works without word spaces, so also for Lao/Thai script); 0 for empty text."""
    def grams(text):
        padded = f' {normalize(text)} '
        counts = {}
        for i in range(len(padded) - 2):
            counts[padded[i:i + 3]] = counts.get(padded[i:i + 3], 0) + 1
        return counts
    ga, gb = grams(a), grams(b)
    total = sum(ga.values()) + sum(gb.values())
    if not ga or not gb or not total:
        return 0.0
    return 2 * sum(min(count, gb.get(gram, 0)) for gram, count in ga.items()) / total


def seconds_between(a_start, a_end, b_start, b_end):
    """Overlap in seconds, or minus the gap when they do not touch."""
    return (min(a_end, b_end) - max(a_start, b_start)).total_seconds()


def name_line(start, end, text, turns, near=3.0):
    """(name, rule) for a PMA line spanning start..end with the given words. Pure: no clock, no I/O."""
    overlap = {}
    for begin, finish, speaker, _ in turns:
        amount = seconds_between(start, end, begin, finish)
        if amount > 0:
            overlap[speaker] = overlap.get(speaker, 0.0) + amount
    if overlap:
        ranked = sorted(overlap.items(), key=lambda item: -item[1])
        if len(ranked) == 1:
            return ranked[0][0], 'bot: trùng giờ'
        total = sum(overlap.values())
        if ranked[0][1] / total >= DOMINANT:
            return ranked[0][0], f'bot: trùng giờ nhiều nhất ({ranked[0][1] / total:.0%})'
        # two or more speakers share the line: the one whose bot words are clearly closer to the line's words
        score = {}
        for begin, finish, speaker, said in turns:
            if speaker in overlap and seconds_between(start, end, begin, finish) > 0:
                score[speaker] = max(score.get(speaker, 0.0), similarity(text, said))
        order = sorted(score.items(), key=lambda item: -item[1])
        if len(order) >= 2 and order[0][1] - order[1][1] >= TIE_MARGIN and order[0][1] > 0:
            return order[0][0], f'bot: nhiều người nói chồng, chọn theo chữ giống nhất ({order[0][1]:.2f} so với {order[1][1]:.2f})'
        return '/'.join(speaker for speaker, _ in sorted(overlap.items(), key=lambda item: min(t[0] for t in turns if t[2] == item[0] and seconds_between(start, end, t[0], t[1]) > 0))), 'bot: nhiều người nói chồng, không phân được'
    gaps = [(-seconds_between(start, end, begin, finish), speaker) for begin, finish, speaker, _ in turns]
    gaps = [gap for gap in gaps if gap[0] <= near]
    if gaps:
        gap, speaker = min(gaps)
        return speaker, f'bot: gần giờ, cách {gap:.1f} giây'
    return '?', f'bot: không có lượt nói trong {near:g} giây'


def estimate_spans(items):
    """Lines cut from one chunk share the chunk's range: split it by text length. {id: (start, end, estimated)} (aware datetimes)."""
    chunks = {}
    for item in items:
        chunks.setdefault((item['wall'], item.get('start'), item.get('end')), []).append(item)
    spans = {}
    for (wall, s, e), group in chunks.items():
        total = sum(len(g.get('text', '')) for g in group) or 1
        at = parse_time(wall)
        duration = max(0.0, (e or 0) - (s or 0))
        for g in group:
            part = duration * len(g.get('text', '')) / total
            spans[g['id']] = (at, at + timedelta(seconds=part), len(group) > 1)
            at += timedelta(seconds=part)
    return spans


def join(items, turns, near=3.0, since=None):
    """[(item, who, rule, local clock)] for the PMA lines, in order."""
    items = [i for i in items if i.get('wall') and not i.get('text', '').startswith('[') and 'LIKELY_HALLUCINATION' not in i.get('boundary', '')]
    spans = estimate_spans(items)
    out = []
    for item in items:
        start, end, estimated = spans[item['id']]
        clock = start.astimezone().strftime('%H:%M:%S')
        if since and clock < since:
            continue
        flags = item.get('boundary', '') or ''
        if 'CHANNEL_MIC' in flags and 'MIC_BLEED' in flags:
            who, rule = 'loa lọt mic', 'micro: tiếng loa lọt vào, không phải Tôi'
        elif 'CHANNEL_MIC' in flags:
            who, rule = 'Tôi', 'micro'
        else:
            who, rule = name_line(start, end, item.get('shown') or item.get('text', ''), turns, near)
            if estimated:
                rule += ', giờ ước theo độ dài câu'
        out.append((item, who, rule, clock))
    return out


def read_all(pma):
    after = None
    while True:
        cmd = ['node', str(Path(pma).with_name('dist') / 'cli.js'), 'read', '--json'] + (['--after', str(after)] if after else [])
        page = json.loads(subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', check=True).stdout)
        yield from page['items']
        if page.get('done') or not page['items']:
            return
        after = page['nextCursor']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('bot', type=Path, help='bot transcript JSON: a list of {start, end?, speaker, text}')
    parser.add_argument('--rows', type=Path, help='read `pma read --json` items from this file (a list, or {"items": [...]}) instead of running pma')
    parser.add_argument('--pma', default=str(ROOT / 'pma'), help='pma command (default: the one in this checkout)')
    parser.add_argument('--since', help='only lines from this local time HH:MM:SS')
    parser.add_argument('--near', type=float, default=3.0, help='seconds a turn may be away from a line and still name it (bot/recorder clock offset)')
    parser.add_argument('--shift', type=float, default=0.0, help='seconds to add to the bot times (the bot clock is behind: positive)')
    parser.add_argument('--max-turn', type=float, default=MAX_TURN_SECONDS, help='longest a turn without an end may last')
    parser.add_argument('--json', action='store_true', help='print [{id, speaker, rule}] instead of lines')
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding='utf-8')
    if args.rows:
        data = json.loads(args.rows.read_text(encoding='utf-8-sig'))
        items = data['items'] if isinstance(data, dict) else data
    else:
        items = list(read_all(args.pma))
    first = next((i['wall'] for i in items if i.get('wall')), None)
    day = parse_time(first).astimezone().date() if first else None
    entries = json.loads(args.bot.read_text(encoding='utf-8-sig'))
    if isinstance(entries, dict):
        entries = entries.get('turns') or entries.get('transcript') or entries.get('items') or []
    turns = load_turns(entries, day, args.shift, args.max_turn)
    rows = join(items, turns, args.near, args.since)
    if args.json:
        print(json.dumps([{'id': item['id'], 'time': clock, 'speaker': who, 'rule': rule} for item, who, rule, clock in rows], ensure_ascii=False, indent=1))
        return 0
    if not turns:
        print('(bot transcript không có lượt nói nào: mọi dòng ngoài micro sẽ là "?")')
    for item, who, rule, clock in rows:
        print(f"#{item['id']} {clock} [{who}] {item.get('language', '?')}: {item.get('shown') or item.get('text')}   ({rule})")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
