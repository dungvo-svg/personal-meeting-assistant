"""Read helpers for the recorder's black box: <audio dir>/seg-NNNN-<channel>.wav + timeline.jsonl (see tools/recorder.py).

    from timeline import Timeline
    tl = Timeline.load(directory)            # tl.update() later reads only what the recorder appended since
    tl.segments('speaker')                   # Segment objects in order
    tl.locate('speaker', wall)               # (segment, sample) or None when nothing was recorded at that moment
    tl.lost_intervals()                      # where the recording has holes

Times are wall-clock seconds since the epoch (floats); `parse_wall`/`format_wall` convert the ISO strings of the file.
A segment maps samples to wall time through anchors: (open, 0), every `tick`, both ends of every in-segment `lost`
(the same sample count at two wall times: the hole) and `close`. Between anchors the mapping is linear, so a device
clock that runs a little off the wall clock does not accumulate error.
"""
import bisect
import json
import wave
from datetime import datetime
from pathlib import Path

TIMELINE_FILE = 'timeline.jsonl'
GAP_SECONDS = 0.2  # a hole shorter than this is jitter, not loss (the recorder uses the same threshold)


def parse_wall(value):
    """ISO string from the timeline -> epoch seconds. A string without an offset is taken as local time."""
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()


def format_wall(epoch):
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec='microseconds')


def segment_path(directory, seg, channel):
    return Path(directory) / f'seg-{seg:04d}-{channel}.wav'


def wav_frames(path):
    """Frames the WAV header declares, 0 when the file is missing or unreadable (the header is patched on every write)."""
    try:
        with wave.open(str(path), 'rb') as reading:
            return reading.getnframes()
    except (OSError, EOFError, wave.Error):
        return 0


def read_events(directory):
    """All well-formed events of the timeline file; a torn last line (recorder killed mid-write) is skipped."""
    events = []
    try:
        text = (Path(directory) / TIMELINE_FILE).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return events
    for line in text.splitlines():
        event = _parse_line(line)
        if event:
            events.append(event)
    return events


def _parse_line(line):
    try:
        event = json.loads(line)
        if isinstance(event, dict) and 'type' in event:
            event['wall'] = parse_wall(event['t'])
            return event
    except (ValueError, KeyError, TypeError):
        pass
    return None


class Segment:
    def __init__(self, directory, seg, channel, rate, device, wall):
        self.seg = seg
        self.channel = channel
        self.rate = int(rate)
        self.device = device
        self.path = segment_path(directory, seg, channel)
        self.open_wall = wall
        self.closed = False
        self.declared = 0  # samples named by the latest tick/close
        self.anchors = [(wall, 0)]  # (wall, sample), non-decreasing in both
        self.lost = []  # [{start, end, seconds, reason, at_samples}], in-segment holes and the one before the segment

    def add_anchor(self, wall, sample):
        last_wall, last_sample = self.anchors[-1]
        self.anchors.append((max(wall, last_wall), max(sample, last_sample)))

    def length(self):
        """Samples that really are in the file; the declared count only when the file cannot be read."""
        return wav_frames(self.path) or self.declared

    def wall_at(self, sample):
        """Wall time of one sample; samples past the last anchor extend at the nominal rate."""
        samples = [s for _, s in self.anchors]
        i = bisect.bisect_right(samples, sample) - 1  # last anchor at or before it: after a hole when the sample starts a piece
        wall, base = self.anchors[max(i, 0)]
        if i + 1 < len(self.anchors):
            next_wall, next_sample = self.anchors[i + 1]
            if next_sample > base and next_wall > wall:
                return wall + (sample - base) * (next_wall - wall) / (next_sample - base)
        return wall + (sample - base) / self.rate

    def end_wall(self):
        return self.wall_at(self.length())

    def sample_at(self, wall):
        """Sample index recorded at that wall time; None before the segment, after it, or inside one of its holes."""
        if wall < self.open_wall:
            return None
        length = self.length()
        for (w1, s1), (w2, s2) in zip(self.anchors, self.anchors[1:]):
            if w1 <= wall < w2:
                if s2 == s1:
                    return None  # a hole: the same sample count at both ends
                sample = s1 + (wall - w1) * (s2 - s1) / (w2 - w1)
                return int(sample) if sample < length else None
        w, s = self.anchors[-1]
        sample = s + (wall - w) * self.rate
        return int(sample) if 0 <= sample < length else None

    def pieces(self):
        """The continuous runs of the file: [(first_sample, end_sample, wall_of_first_sample)], split where samples were lost."""
        length = self.length()
        cuts = sorted({int(item['at_samples']) for item in self.lost if item.get('at_samples') and 0 < item['at_samples'] < length})
        edges = [0] + cuts + [length]
        return [(a, b, self.wall_at(a)) for a, b in zip(edges, edges[1:]) if b > a]


class Timeline:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.events = []
        self.by_channel = {}  # channel -> [Segment]
        self.mic_state_events = []
        self.error_events = []
        self.ended = False
        self.end_reason = None
        self._offset = 0

    @classmethod
    def load(cls, directory):
        timeline = cls(directory)
        timeline.update()
        return timeline

    def update(self):
        """Reads what was appended since the last call. Returns the new events (a half-written last line waits for the next call)."""
        try:
            with open(self.directory / TIMELINE_FILE, 'rb') as file:
                file.seek(self._offset)
                data = file.read()
        except OSError:
            return []
        end = data.rfind(b'\n') + 1  # only whole lines
        self._offset += end
        fresh = []
        for line in data[:end].decode('utf-8', errors='replace').splitlines():
            event = _parse_line(line)
            if event:
                self._apply(event)
                fresh.append(event)
        return fresh

    def _segment(self, event):
        for segment in reversed(self.by_channel.get(event.get('channel'), [])):
            if segment.seg == event.get('seg'):
                return segment
        return None

    def _apply(self, event):
        self.events.append(event)
        kind = event['type']
        if kind == 'open':
            segment = Segment(self.directory, int(event['seg']), event['channel'], event['rate'], event.get('device'), event['wall'])
            self.by_channel.setdefault(segment.channel, []).append(segment)
        elif kind in ('tick', 'close'):
            segment = self._segment(event)
            if segment:
                samples = int(event.get('samples', 0))
                segment.add_anchor(event['wall'], samples)
                segment.declared = max(segment.declared, samples)
                segment.closed = segment.closed or kind == 'close'
        elif kind == 'lost':
            segment = self._segment(event)
            if segment:
                seconds = float(event.get('seconds', 0))
                at = event.get('at_samples')
                item = {'start': event['wall'] - seconds, 'end': event['wall'], 'seconds': seconds, 'reason': event.get('reason'), 'at_samples': at}
                segment.lost.append(item)
                if at:  # inside the segment: the sample count stands still while the wall clock jumps
                    segment.add_anchor(item['start'], int(at))
                    segment.add_anchor(item['end'], int(at))
        elif kind == 'mic_state':
            self.mic_state_events.append({'wall': event['wall'], 'state': event.get('state'), 'app': event.get('app'), 'by': event.get('by')})
        elif kind == 'error':
            self.error_events.append({'wall': event['wall'], 'channel': event.get('channel'), 'message': event.get('message')})
        elif kind == 'end':
            self.ended = True
            self.end_reason = event.get('reason')

    def channels(self):
        return sorted(self.by_channel)

    def segments(self, channel):
        return list(self.by_channel.get(channel, []))

    def start_wall(self):
        walls = [segments[0].open_wall for segments in self.by_channel.values() if segments]
        return min(walls) if walls else None

    def end_wall(self, channel=None):
        """When the last recorded sample was taken (of one channel, or of any)."""
        channels = [channel] if channel else list(self.by_channel)
        ends = [segments[-1].end_wall() for name in channels for segments in [self.by_channel.get(name, [])] if segments]
        return max(ends) if ends else None

    def locate(self, channel, wall):
        """(segment, sample) recorded at that wall time, None when the channel has a hole there."""
        for segment in self.by_channel.get(channel, []):
            sample = segment.sample_at(wall)
            if sample is not None:
                return segment, sample
        return None

    def lost_intervals(self, channel=None, include_gaps=True):
        """Holes as dicts {channel, seg, start, end, seconds, reason}, by start time. Besides the recorder's own `lost`
        entries, with include_gaps, time between two segments of one channel that no entry explains (recorder down)."""
        found = []
        for name in [channel] if channel else self.channels():
            segments = self.by_channel.get(name, [])
            explained = []
            for segment in segments:
                for item in segment.lost:
                    found.append({'channel': name, 'seg': segment.seg, 'start': item['start'], 'end': item['end'], 'seconds': item['seconds'], 'reason': item['reason']})
                    explained.append((item['start'], item['end']))
            if not include_gaps:
                continue
            for before, after in zip(segments, segments[1:]):
                start, end = before.end_wall(), after.open_wall
                if end - start > GAP_SECONDS and not any(a <= end + GAP_SECONDS and b >= start - GAP_SECONDS for a, b in explained):
                    found.append({'channel': name, 'seg': after.seg, 'start': start, 'end': end, 'seconds': end - start, 'reason': 'between_segments'})
        return sorted(found, key=lambda item: (item['start'], item['channel']))

    def mic_states(self):
        return list(self.mic_state_events)

    def errors(self):
        return list(self.error_events)
