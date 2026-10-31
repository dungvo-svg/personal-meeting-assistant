"""Reads the session's audio folder (Q-1 of docs/PLAN_0_11.md) for the listening worker.

The recorder writes seg-NNNN-<channel>.wav files and timeline.jsonl; this module only reads them. What the timeline
means (segments, anchors, holes, wall time) is tools/timeline.py's job; here are the WAV tail reader, the block source
the chunker pulls from, and the cut of a wall-time window for `--recheck`.
"""
import struct
import time

import timeline as tl

RATE16 = 16000
BLOCK_SAMPLES = 2048  # native samples per block handed to the chunker (what a device read gives)
PAD_MIN_SECONDS = 0.3  # a hole in a channel's audio at least this long is filled with silence, so channels share one time axis
WAIT_SECONDS = 0.2  # how long a reader waits for the recorder before it looks again
SEGMENT_END = object()  # returned by ChannelFollower.read_block when a segment is finished and the chunker must flush


class WavTail:
    """A PCM16 WAV the recorder may still be appending to. Size on disk, not the header's length, says what can be read."""

    def __init__(self, path):
        self.path = path
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
                    raise ValueError(f'{self.path}: only PCM16 is supported')
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


def next_segment(timeline, channel, after):
    # The first segment of the channel numbered above `after` (None: from the start); None when there is none yet.
    later = [segment for segment in timeline.segments(channel) if after is None or segment.seg > after]
    return min(later, key=lambda segment: segment.seg) if later else None


def limit_of(segment, wav):
    # Samples of the segment that can be read now: what is on disk, never past the recorder's own close count.
    available = wav.available()
    return min(available, segment.declared) if segment.closed else available


class ChannelFollower:
    """One channel's audio as a live-like block source: segments in order from sample 0, at 16 kHz, on the session's time axis.

    read_block() returns float32 bytes, b'' (nothing new yet; the caller loops), SEGMENT_END (flush the chunker), or raises
    EOFError when the recorder has ended (or a drain was asked for) and everything on disk has been read. There is no pacing:
    behind the recorder it reads as fast as the consumer takes blocks. Holes the recorder reports (a late-starting channel,
    a lost stretch, a segment after a restart) are filled with silence, so both channels count seconds from the same moment.
    """

    def __init__(self, timeline, channel, draining=lambda: False, holding=lambda: False, sleep=time.sleep):
        self.timeline = timeline
        self.channel = channel
        self.draining = draining  # stop was requested: read what is on disk, do not wait for more
        self.holding = holding  # pause was requested: keep position, read nothing
        self.sleep = sleep
        self.last_seg = None
        self.cur = None  # (Segment, WavTail, next native sample, resampler or None)
        self.out = []  # blocks ready to hand out, first in first out
        self.position = 0  # 16 kHz samples handed out, silence padding included
        self.ranges = []  # [axis sample where the segment's span starts, Segment, [(axis sample, native sample) at each continuous piece's first sample]]
        self.disk_samples = 0  # 16 kHz samples the recorder has put on disk for this channel (for the lag figure)

    def _wait(self):
        self.sleep(WAIT_SECONDS)
        return b''

    def _begin(self, segment):
        import av
        wav = WavTail(segment.path)
        resampler = av.AudioResampler(format='flt', layout='mono', rate=RATE16) if segment.rate != RATE16 else None
        self.cur = (segment, wav, 0, resampler)
        self.last_seg = segment.seg
        self.ranges.append([self.position, segment, []])

    def _emit(self, array):
        # float32 16 kHz samples -> out; counts the position.
        if len(array):
            self.position += len(array)
            self.out.append(array.tobytes())

    def _cuts(self, segment):
        # Sample counts where the recorder lost audio inside the segment: a new continuous piece starts there.
        return sorted({int(item['at_samples']) for item in segment.lost if item.get('at_samples')})

    def _pad_to(self, segment, native_sample):
        # Silence for the hole between the axis position and where this sample really is in wall time. Never negative:
        # overlapping audio is not trimmed.
        import numpy as np
        origin = self.timeline.start_wall() or 0
        missing = int(round((segment.wall_at(native_sample) - origin) * RATE16)) - self.position
        while missing >= PAD_MIN_SECONDS * RATE16:
            piece = min(missing, RATE16)
            self._emit(np.zeros(piece, dtype=np.float32))
            missing -= piece

    def _step(self):
        import av
        import numpy as np
        segment, wav, done, resampler = self.cur
        limit = limit_of(segment, wav)
        self.disk_samples = max(self.disk_samples, self.position + int((limit - done) * RATE16 / segment.rate))
        if done >= limit:
            # Caught up with the file. The close (or the next segment, or the end) is looked at before the size is read
            # again: whatever is on disk by then is all there will be.
            self.timeline.update()
            finished = segment.closed or self.timeline.ended or self.draining() or next_segment(self.timeline, self.channel, segment.seg) is not None
            limit = limit_of(segment, wav)
            if done >= limit:
                if not finished:
                    return self._wait()
                if resampler:
                    self._emit(self._flush(resampler))
                wav.close()
                self.cur = None
                self.out.append(SEGMENT_END)
                return None
        cuts = self._cuts(segment)
        ahead = [cut for cut in cuts if cut > done]
        size = min(BLOCK_SAMPLES, limit - done, (ahead[0] - done) if ahead else BLOCK_SAMPLES)  # a block never straddles a hole
        block = wav.read(done, size)
        if not len(block):
            return self._wait()
        if not self.ranges[-1][2] or done in cuts:
            self._pad_to(segment, done)
            self.ranges[-1][2].append((self.position, done))
        self.cur = (segment, wav, done + len(block), resampler)
        if resampler:
            frame = av.AudioFrame.from_ndarray(block.reshape(1, -1), format='flt', layout='mono')
            frame.sample_rate = segment.rate
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
                self.timeline.update()
                segment = next_segment(self.timeline, self.channel, self.last_seg)
                if segment is None:
                    if self.timeline.ended or self.draining():
                        raise EOFError
                    return self._wait()
                self._begin(segment)
            result = self._step()
            if result is not None:
                return result

    def locate(self, sample):
        # (wall ISO text, segment number) for a sample of this follower's 16 kHz axis; (None, None) before any audio.
        # Inside a stretch of silence padding there is no recorded sample: the axis time from the session's start counts.
        found = None
        for item in self.ranges:
            if item[0] <= sample:
                found = item
        if found is None:
            return None, None
        _, segment, marks = found
        marks = [mark for mark in marks if mark[0] <= sample]
        if marks:
            axis, native = marks[-1]
            return tl.format_wall(segment.wall_at(native + int((sample - axis) * segment.rate / RATE16))), segment.seg
        return tl.format_wall((self.timeline.start_wall() or 0) + sample / RATE16), segment.seg


def sample_for(segment, wall, length):
    # First sample at or after a wall time, clamped to [0, length]; a hole maps to the sample count it stands at.
    low, high = 0, length
    while low < high:
        middle = (low + high) // 2
        if segment.wall_at(middle) < wall:
            low = middle + 1
        else:
            high = middle
    return low


def cut_window(timeline, channel, start_wall, end_wall):
    """The channel's audio between two wall times (epoch seconds) as a 16 kHz float32 array (segments joined end to end)."""
    import numpy as np
    parts = []
    for segment in timeline.segments(channel):
        wav = WavTail(segment.path)
        try:
            length = limit_of(segment, wav)
            if not length or end_wall <= segment.open_wall or start_wall >= segment.wall_at(length):
                continue
            first, last = sample_for(segment, start_wall, length), sample_for(segment, end_wall, length)
            if last > first:
                parts.append(resample16(wav.read(first, last - first), segment.rate or wav.header_rate or RATE16))
        finally:
            wav.close()
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
