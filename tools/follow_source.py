"""Reads the session's audio folder (Q-1 of docs/PLAN_0_11.md) for the listening worker.

The recorder writes seg-NNNN-<channel>.wav files and timeline.jsonl; this module only reads them. Everything that
knows the timeline's line format lives in Timeline, so it can be swapped for tools/timeline.py behind the same few
methods: refresh, ended, origin, next_segment, wall_at, sample_at.
"""
from datetime import datetime
import json
from pathlib import Path
import re
import struct
import time

RATE16 = 16000
BLOCK_SAMPLES = 2048  # native samples per block handed to the chunker (what a device read gives)
PAD_MIN_SECONDS = 0.3  # a hole in a channel's audio at least this long is filled with silence, so channels share one time axis
WAIT_SECONDS = 0.2  # how long a reader waits for the recorder before it looks again
SEGMENT_END = object()  # returned by ChannelFollower.read_block when a segment is finished and the chunker must flush


def parse_iso(value):
    # ISO text -> epoch seconds. A time without an offset is the machine's local time.
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()


def iso_wall(epoch):
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec='milliseconds')


def segment_path(directory, seg, channel):
    return Path(directory) / f'seg-{int(seg):04d}-{channel}.wav'


class SegmentInfo:
    def __init__(self, seg, channel, rate, device, opened):
        self.seg = seg
        self.channel = channel
        self.rate = int(rate) if rate else None
        self.device = device
        self.points = [(opened, 0)]  # (epoch, samples written by then): the open event and every tick
        self.closed = False
        self.close_samples = None

    def add_point(self, epoch, samples):
        last_epoch, last_samples = self.points[-1]
        if epoch >= last_epoch and samples >= last_samples:
            self.points.append((epoch, samples))


class Timeline:
    """Incremental reader of timeline.jsonl: new complete lines are folded into per-segment tick tables."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'timeline.jsonl'
        self.offset = 0
        self.pending = b''
        self.origin = None  # epoch of the first `open`: second 0 of the session's time axis
        self.ended = False
        self.segments = {}  # (seg, channel) -> SegmentInfo

    def refresh(self):
        try:
            with open(self.path, 'rb') as file:
                file.seek(self.offset)
                data = file.read()
        except OSError:
            return
        self.offset += len(data)
        lines = (self.pending + data).split(b'\n')
        self.pending = lines.pop()  # a line the recorder is still writing stays for the next refresh
        for raw in lines:
            try:
                self._apply(json.loads(raw))
            except (ValueError, KeyError, TypeError):
                continue

    def _apply(self, event):
        kind = event.get('type')
        epoch = parse_iso(event['t'])
        if kind == 'end':
            self.ended = True
            return
        if kind not in ('open', 'tick', 'close'):
            return
        key = (int(event['seg']), event['channel'])
        if kind == 'open':
            self.origin = epoch if self.origin is None else self.origin
            self.segments[key] = SegmentInfo(key[0], key[1], event.get('rate'), event.get('device'), epoch)
            return
        info = self.segments.get(key)
        if info is None:
            return
        info.add_point(epoch, int(event['samples']))
        if kind == 'close':
            info.closed = True
            info.close_samples = int(event['samples'])

    def channels(self):
        return sorted({channel for _, channel in self.segments})

    def next_segment(self, channel, after):
        # The first segment of the channel numbered above `after` (None: from the start); None when there is none yet.
        later = [info for (seg, name), info in self.segments.items() if name == channel and (after is None or seg > after)]
        return min(later, key=lambda info: info.seg) if later else None

    def segments_of(self, channel):
        return sorted((info for (_, name), info in self.segments.items() if name == channel), key=lambda info: info.seg)

    def wall_at(self, info, sample):
        # Epoch of a sample of the segment: interpolated between ticks, extrapolated at the device's rate past the last one.
        points = info.points
        sample = max(0, sample)
        if sample >= points[-1][1]:
            return points[-1][0] + (sample - points[-1][1]) / (info.rate or RATE16)
        low, high = 0, len(points) - 1
        while high - low > 1:
            middle = (low + high) // 2
            if points[middle][1] <= sample:
                low = middle
            else:
                high = middle
        (t0, s0), (t1, s1) = points[low], points[high]
        return t0 + (t1 - t0) * (sample - s0) / (s1 - s0) if s1 > s0 else t0

    def sample_at(self, info, epoch):
        # Inverse of wall_at, clamped at the segment's first sample.
        points = info.points
        if epoch <= points[0][0]:
            return 0
        if epoch >= points[-1][0]:
            return int(points[-1][1] + (epoch - points[-1][0]) * (info.rate or RATE16))
        low, high = 0, len(points) - 1
        while high - low > 1:
            middle = (low + high) // 2
            if points[middle][0] <= epoch:
                low = middle
            else:
                high = middle
        (t0, s0), (t1, s1) = points[low], points[high]
        return int(s0 + (s1 - s0) * (epoch - t0) / (t1 - t0)) if t1 > t0 else s0


class WavTail:
    """A PCM16 WAV the recorder may still be appending to. Size on disk, not the header's length, says what can be read."""

    def __init__(self, path):
        self.path = Path(path)
        self.file = None
        self.data_offset = None
        self.channels = 1
        self.header_rate = None

    def _header(self):
        if self.file is None:
            try:
                self.file = open(self.path, 'rb')
            except OSError:
                return False
        if self.data_offset is not None:
            return True
        self.file.seek(0)
        head = self.file.read(4096)
        if len(head) < 12 or head[:4] != b'RIFF' or head[8:12] != b'WAVE':
            return False
        position = 12
        while position + 8 <= len(head):
            name, size = head[position:position + 4], struct.unpack('<I', head[position + 4:position + 8])[0]
            body = position + 8
            if name == b'fmt ' and body + 16 <= len(head):
                tag, channels, rate, _, _, bits = struct.unpack('<HHIIHH', head[body:body + 16])
                if tag not in (1, 0xFFFE) or bits != 16:
                    raise ValueError(f'{self.path.name}: only PCM16 is supported')
                self.channels, self.header_rate = max(1, channels), rate
            elif name == b'data':
                self.data_offset = body
                return True
            position = body + size + (size & 1)
        return False

    def available(self):
        # Whole samples (frames) on disk now.
        if not self._header():
            return 0
        self.file.seek(0, 2)
        return max(0, (self.file.tell() - self.data_offset) // (2 * self.channels))

    def read(self, start, count):
        # float32 mono array of up to `count` samples from sample `start`; shorter (or empty) at the end of what is on disk.
        import numpy as np
        count = min(count, self.available() - start)
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        self.file.seek(self.data_offset + start * 2 * self.channels)
        raw = self.file.read(count * 2 * self.channels)
        data = np.frombuffer(raw[:len(raw) // 2 * 2], dtype='<i2').astype(np.float32) / 32768.0
        usable = len(data) // self.channels * self.channels
        return data[:usable].reshape(-1, self.channels).mean(axis=1) if self.channels > 1 else data

    def close(self):
        if self.file:
            self.file.close()
            self.file = None


def resample16(waveform, rate):
    # One-shot conversion of a mono float32 array to 16 kHz (same resampler the ASR loop uses).
    import av
    import numpy as np
    if int(rate) == RATE16 or not len(waveform):
        return waveform.astype(np.float32)
    frame = av.AudioFrame.from_ndarray(waveform.astype(np.float32).reshape(1, -1), format='flt', layout='mono')
    frame.sample_rate = int(rate)
    resampler = av.AudioResampler(format='flt', layout='mono', rate=RATE16)
    parts = [f.to_ndarray().reshape(-1) for f in resampler.resample(frame) + resampler.resample(None)]
    return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, dtype=np.float32)


class ChannelFollower:
    """One channel's audio as a live-like block source: segments in order from sample 0, at 16 kHz, on the session's time axis.

    read_block() returns float32 bytes, b'' (nothing new yet; the caller loops), SEGMENT_END (flush the chunker), or raises
    EOFError when the recorder has ended (or a drain was asked for) and everything on disk has been read. There is no pacing:
    behind the recorder it reads as fast as the consumer takes blocks.
    """

    def __init__(self, timeline, channel, draining=lambda: False, holding=lambda: False, sleep=time.sleep):
        self.timeline = timeline
        self.channel = channel
        self.draining = draining  # stop was requested: read what is on disk, do not wait for more
        self.holding = holding  # pause was requested: keep position, read nothing
        self.sleep = sleep
        self.last_seg = None
        self.cur = None  # (SegmentInfo, WavTail, next native sample, resampler or None)
        self.out = []  # blocks ready to hand out, first in first out
        self.position = 0  # 16 kHz samples handed out, silence padding included
        self.ranges = []  # (axis sample where the segment's span starts, where its data starts, SegmentInfo)
        self.disk_samples = 0  # 16 kHz samples the recorder has put on disk for this channel (for the lag figure)

    def _wait(self):
        self.sleep(WAIT_SECONDS)
        return b''

    def _begin(self, info):
        import av
        wav = WavTail(segment_path(self.timeline.directory, info.seg, self.channel))
        rate = info.rate or RATE16
        resampler = av.AudioResampler(format='flt', layout='mono', rate=RATE16) if rate != RATE16 else None
        self.cur = (info, wav, 0, resampler)
        self.last_seg = info.seg
        self.ranges.append([self.position, None, info])

    def _emit(self, array):
        # float32 16 kHz samples -> out; counts the position.
        if len(array):
            self.position += len(array)
            self.out.append(array.tobytes())

    def _pad_to(self, info, native_sample):
        # Silence for a hole between the axis position and where this sample really is in wall time (a late-starting
        # channel, a segment after a lost stretch). Never negative: overlapping audio is not trimmed.
        import numpy as np
        wanted = int(round((self.timeline.wall_at(info, native_sample) - (self.timeline.origin or 0)) * RATE16))
        missing = wanted - self.position
        while missing >= PAD_MIN_SECONDS * RATE16:
            piece = min(missing, RATE16)
            self._emit(np.zeros(piece, dtype=np.float32))
            missing -= piece

    def _limit(self, info, wav):
        # Samples of the segment that can be read now: what is on disk, never past the recorder's own close count.
        available = wav.available()
        if info.closed and info.close_samples is not None:
            available = min(available, info.close_samples)
        return available

    def _step(self):
        import av
        import numpy as np
        info, wav, done, resampler = self.cur
        limit = self._limit(info, wav)
        self.disk_samples = max(self.disk_samples, self.position + int((limit - done) * RATE16 / (info.rate or RATE16)))
        if done >= limit:
            # Caught up with the file. The close (or the next segment, or the end) is looked at before the size is read
            # again: whatever is on disk by then is all there will be.
            self.timeline.refresh()
            finished = info.closed or self.timeline.ended or self.draining() or self.timeline.next_segment(self.channel, info.seg) is not None
            limit = self._limit(info, wav)
            if done >= limit:
                if not finished:
                    return self._wait()
                if resampler:
                    self._emit(self._flush(resampler))
                wav.close()
                self.cur = None
                self.out.append(SEGMENT_END)
                return None
        block = wav.read(done, min(BLOCK_SAMPLES, limit - done))
        if not len(block):
            return self._wait()
        if self.ranges[-1][1] is None:
            self._pad_to(info, done)
            self.ranges[-1][1] = self.position
        self.cur = (info, wav, done + len(block), resampler)
        if resampler:
            frame = av.AudioFrame.from_ndarray(block.reshape(1, -1), format='flt', layout='mono')
            frame.sample_rate = info.rate
            block = np.concatenate([f.to_ndarray().reshape(-1) for f in resampler.resample(frame)] or [np.zeros(0, dtype=np.float32)])
        self._emit(block.astype(np.float32))
        return None

    @staticmethod
    def _flush(resampler):
        import numpy as np
        return np.concatenate([f.to_ndarray().reshape(-1) for f in resampler.resample(None)] or [np.zeros(0, dtype=np.float32)]).astype(np.float32)

    def read_block(self):
        while True:
            if self.out:
                return self.out.pop(0)
            if self.holding():
                return self._wait()
            if self.cur is None:
                self.timeline.refresh()
                info = self.timeline.next_segment(self.channel, self.last_seg)
                if info is None:
                    if self.timeline.ended or self.draining():
                        raise EOFError
                    return self._wait()
                self._begin(info)
            result = self._step()
            if result is not None:
                return result

    def locate(self, sample):
        # (wall ISO text, segment number) for a sample of this follower's 16 kHz axis; (None, None) before any audio.
        found = None
        for item in self.ranges:
            if item[0] <= sample:
                found = item
        if found is None:
            return None, None
        _, data_start, info = found
        if data_start is not None and sample >= data_start:
            native = int((sample - data_start) * (info.rate or RATE16) / RATE16)
            return iso_wall(self.timeline.wall_at(info, native)), info.seg
        return iso_wall((self.timeline.origin or 0) + sample / RATE16), info.seg


def cut_window(timeline, channel, start_epoch, end_epoch):
    """The channel's audio between two wall times as a 16 kHz float32 array (segments joined end to end, no padding)."""
    import numpy as np
    parts = []
    for info in timeline.segments_of(channel):
        wav = WavTail(segment_path(timeline.directory, info.seg, channel))
        try:
            available = wav.available()
            if info.closed and info.close_samples is not None:
                available = min(available, info.close_samples)
            if not available:
                continue
            first = timeline.sample_at(info, start_epoch)
            last = min(available, timeline.sample_at(info, end_epoch))
            if last > first:
                parts.append(resample16(wav.read(first, last - first), info.rate or wav.header_rate or RATE16))
        finally:
            wav.close()
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def segment_numbers(directory):
    return sorted(int(m.group(1)) for p in Path(directory).glob('seg-*-*.wav') for m in [re.match(r'seg-(\d+)-', p.name)] if m)
