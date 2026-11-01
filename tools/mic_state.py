"""Classify a chunk of the owner's microphone ("Tôi") by what the mic was doing, from the recorder's timeline.

The recorder writes `mic_state` lines into timeline.jsonl (readings of tools/mic_state.ps1, plus manual ones from
`pma me --on|--off|--auto`):
    {"t": "2026-10-31T13:31:07.420+07:00", "type": "mic_state", "state": "on|off|unknown|none", "app": "zoom", "by": "uia"}
Pure functions, no I/O, no model: the worker passes the parsed lines and a chunk's wall-clock span.

* `on`    -> MIC_STATE_ON       the mic was open in the meeting
* `off`   -> MIC_STATE_OFF      muted in the meeting ("nói riêng": the owner talking to someone else)
* `none`  -> MIC_STATE_OFF      no meeting app was holding the microphone, so nothing of it went to the meeting
* `unknown` or no reading yet -> MIC_STATE_UNKNOWN
A manual entry (by "manual") wins over automatic readings until a manual release (`release: true`, written by `--auto`).
"""
from datetime import datetime

MIC_STATE_ON = 'MIC_STATE_ON'
MIC_STATE_OFF = 'MIC_STATE_OFF'
MIC_STATE_UNKNOWN = 'MIC_STATE_UNKNOWN'

_LABEL = {'on': MIC_STATE_ON, 'off': MIC_STATE_OFF, 'none': MIC_STATE_OFF}


def to_epoch(value):
    """Seconds since the epoch from an epoch number, a datetime or an ISO-8601 string (naive means local time)."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    return datetime.fromisoformat(str(value).strip().replace('Z', '+00:00')).timestamp()


def _readings(states):
    """The mic_state entries as (time, entry), oldest first. Entries of other types and unreadable ones are ignored."""
    rows = []
    for entry in states or []:
        if not isinstance(entry, dict) or entry.get('type', 'mic_state') != 'mic_state':
            continue
        try:
            rows.append((to_epoch(entry['t']), entry))
        except (KeyError, ValueError, TypeError):
            continue
    rows.sort(key=lambda row: row[0])
    return rows


def effective_segments(states, start_wall, end_wall):
    """[(from, to, label)] covering start..end: the label in force over each stretch, where it changes."""
    begin, end = sorted((to_epoch(start_wall), to_epoch(end_wall)))
    override = None
    auto = MIC_STATE_UNKNOWN

    def apply(entry):
        nonlocal override, auto
        label = _LABEL.get(str(entry.get('state', '')).lower(), MIC_STATE_UNKNOWN)
        if entry.get('by') == 'manual':
            override = None if entry.get('release') else label
        else:
            auto = label

    rows = _readings(states)
    index = 0
    while index < len(rows) and rows[index][0] <= begin:
        apply(rows[index][1])
        index += 1
    current, since = override or auto, begin
    segments = []
    for moment, entry in rows[index:]:
        if moment >= end:
            break
        apply(entry)
        changed = override or auto
        if changed != current:
            segments.append((since, moment, current))
            since, current = moment, changed
    segments.append((since, end, current))
    return segments


def label_mic_chunk(states, start_wall, end_wall):
    """MIC_STATE_ON / _OFF / _UNKNOWN for a chunk: the state that held for most of its time. A tie is UNKNOWN."""
    totals = {}
    segments = effective_segments(states, start_wall, end_wall)
    for begin, end, label in segments:
        totals[label] = totals.get(label, 0.0) + (end - begin)
    if not any(totals.values()):  # zero-length chunk: the state at that instant
        return segments[0][2]
    ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)
    if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < 1e-9:
        return MIC_STATE_UNKNOWN
    return ranked[0][0]


def whole_on(states, start_wall, end_wall):
    """True only if the mic was MIC_STATE_ON for the whole chunk: every stretch of `effective_segments` is ON.

    This is the evidence for sharing a mic chunk with the attendees. No majority and no smoothing: one second of OFF or
    UNKNOWN anywhere in the chunk, however short (a flicker too), makes it False, and so does a chunk that begins before
    the first reading (UNKNOWN there). A zero-length chunk is the state at that instant. `label_mic_chunk` stays the
    majority label for RAW display and must never stand in for this.
    """
    return all(label == MIC_STATE_ON for _begin, _end, label in effective_segments(states, start_wall, end_wall))


def reader_alive(states, start_wall, end_wall, max_gap=4.0):
    """True only if the automatic mic reader was seen alive all through the chunk AND after it: an automatic reading at or before
    its start, one at or after its end (a positive observation past the covered end, not an old reading carried forward), and none
    more than `max_gap` seconds after the previous one.

    A change is written the moment the reader sees it, so with a reading at r >= end every change before r is already in the
    timeline, and `whole_on` over the chunk is then based on what was seen, not on an extrapolation.

    The recorder writes a reading on every change and, while nothing changes, again every few seconds (a beat). A hung reader stops
    writing without exiting, so its last "on" would otherwise stand for ever: no recent reading means no evidence, not "still on".
    Manual entries (`pma me`) are the owner's word, not a sign the reader is alive, and do not count here.
    """
    begin, end = sorted((to_epoch(start_wall), to_epoch(end_wall)))
    times = [moment for moment, entry in _readings(states) if entry.get('by') != 'manual']
    seen = [moment for moment in times if begin - max_gap <= moment <= end + max_gap]
    if not seen or seen[0] > begin or seen[-1] < end:
        return False
    return all(later - earlier <= max_gap for earlier, later in zip(seen, seen[1:]))


def share_ok(states, start_wall, end_wall):
    """Whether a mic chunk may go to the shared translation session (owner 01/11: mic OFF and UNKNOWN never do).

    Three things must all hold:
    - the label the owner sees is ON for the whole chunk (a manual `--off` hides it);
    - the AUTOMATIC reader alone saw ON for the whole chunk (a manual `--on` changes the RAW label, but it is not a reading of the
      meeting's mic, so it never turns an automatic OFF/UNKNOWN into consent to publish);
    - the automatic reader was seen alive through and past the chunk (`reader_alive`).
    `end_wall` is the end of the covered stretch (the worker adds its grace).
    """
    automatic = [entry for entry in states or [] if not (isinstance(entry, dict) and entry.get('by') == 'manual')]
    return whole_on(states, start_wall, end_wall) and whole_on(automatic, start_wall, end_wall) and reader_alive(states, start_wall, end_wall)


def split_points(states, start_wall, end_wall, min_segment=1.0):
    """Wall-clock times (epoch seconds) strictly inside the chunk where its label changes, so the worker can cut there.

    A stretch shorter than `min_segment` seconds (a flicker of the reader) is absorbed by its neighbour and gives no cut.
    """
    segments = [list(segment) for segment in effective_segments(states, start_wall, end_wall)]
    merged = True
    while merged and len(segments) > 1:
        merged = False
        for index, (begin, end, _label) in enumerate(segments):
            if end - begin >= min_segment:
                continue
            neighbour = segments[index - 1] if index else segments[index + 1]
            neighbour[0], neighbour[1] = min(neighbour[0], begin), max(neighbour[1], end)
            del segments[index]
            merged = True
            break
        # neighbours of one label after an absorption are one stretch
        for index in range(len(segments) - 1, 0, -1):
            if segments[index][2] == segments[index - 1][2]:
                segments[index - 1][1] = segments[index][1]
                del segments[index]
    return [segment[0] for segment in segments[1:]]
