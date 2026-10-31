"""Mix the speaker and microphone WAVs of one listening into a single 16 kHz mono WAV for `pma replay`.

    python tools/mix_audio.py <audio dir>               # recorder output: seg-*.wav + timeline.jsonl -> meeting-mix.wav
    python tools/mix_audio.py <audio dir> <captureId>   # older listening: <captureId>-speaker.wav/-mic.wav -> <captureId>-mix.wav

Timeline mode (tools/recorder.py): every segment is placed at its wall-clock position on one 16 kHz mono canvas, so a
restart, a device change or dropped frames leave silence of the right length instead of shifting the rest. The file is
streamed to meeting-mix.part and renamed to meeting-mix.wav at the end; it can be made while the recorder still runs.
Legacy mode reads <captureId>-speaker.wav and <captureId>-mic.wav (either may be missing), writes <captureId>-mix.wav.
The meeting app does not play the user's own voice back through the speakers, so a replay of the speaker file alone
lacks it. The microphone is added only in 0.1 s slots where it is clearly the user's voice (the same rule the live
worker uses); elsewhere it mostly hears the speakers again and would double the speech. Streams in ~1 s blocks, so
a two-hour meeting needs no more memory than a short one.
"""
import json
import os
from fractions import Fraction
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audio_worker import MIC_OVER_SPEAKER, SOUND_RMS, WavWriter  # noqa: E402
from timeline import Timeline  # noqa: E402

RATE = 16000
SLOT = RATE // 10  # the unit of the own-voice decision: 0.1 s
BLOCK = 10 * SLOT  # processed at a time: 1 s
MIX_NAME = 'meeting-mix.wav'


class Channel:
    """A saved channel WAV read as 16 kHz mono float32, one stateful resampler for the whole file.
    `first`/`frames` read only that run of source frames (a piece of a recorder segment)."""

    def __init__(self, path, first=0, frames=None):
        self.reader = None
        self.resampler = None
        self.pending = []  # converted pieces not handed out yet
        self.held = 0
        self.consumed = 0  # source frames fed so far (the frame clock)
        self.done = True
        self.remaining = frames  # source frames left to read; None = to the end of the file
        path = Path(path)
        if not path.is_file():
            return
        self.reader = wave.open(str(path), 'rb')
        self.rate = self.reader.getframerate()
        self.channels = self.reader.getnchannels()
        self.width = self.reader.getsampwidth()
        if self.width != 2 or self.rate <= 0 or self.channels < 1:
            self.reader.close()
            self.reader = None
            raise ValueError(f'{path.name}: chỉ nhận WAV PCM16')
        import av
        self.av = av
        self.resampler = av.AudioResampler(format='flt', layout='mono', rate=RATE)
        if first:
            self.reader.setpos(first)
        self.done = False

    @property
    def present(self):
        return self.reader is not None

    def _convert(self, frames):
        piece = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
        if self.channels > 1:
            piece = piece[: len(piece) // self.channels * self.channels].reshape(-1, self.channels).mean(axis=1)
        frame = self.av.AudioFrame.from_ndarray(piece.reshape(1, -1).astype(np.float32), format='flt', layout='mono')
        frame.sample_rate = self.rate
        frame.pts = self.consumed
        frame.time_base = Fraction(1, self.rate)
        self.consumed += len(piece)
        return self.resampler.resample(frame)

    def _pull(self):
        want = self.rate if self.remaining is None else min(self.rate, self.remaining)  # ~1 s of source audio
        frames = self.reader.readframes(want) if want > 0 else b''
        if self.remaining is not None:
            self.remaining -= len(frames) // (2 * self.channels)
        if frames:
            out = self._convert(frames)
        else:
            out = self.resampler.resample(None)  # flush once at the end
            self.done = True
            self.reader.close()
        for frame in out:
            piece = frame.to_ndarray().reshape(-1).astype(np.float32)
            self.pending.append(piece)
            self.held += len(piece)

    def read(self, count):
        """Up to `count` samples; fewer only at the end of the file."""
        while self.held < count and not self.done:
            self._pull()
        if not self.pending:
            return np.zeros(0, dtype=np.float32)
        joined = np.concatenate(self.pending)
        out, rest = joined[:count], joined[count:]
        self.pending = [rest] if len(rest) else []
        self.held = len(rest)
        return out

    def close(self):
        if self.reader is not None and not self.done:
            self.reader.close()
        self.done = True


def slot_rms(block):
    """RMS of each 0.1 s slot of a block (the last slot may be shorter)."""
    count = -(-len(block) // SLOT)
    padded = np.zeros(count * SLOT, dtype=np.float64)
    padded[: len(block)] = block
    sums = (padded.reshape(count, SLOT) ** 2).sum(axis=1)
    lengths = np.full(count, SLOT, dtype=np.float64)
    lengths[-1] = len(block) - (count - 1) * SLOT
    return np.sqrt(sums / lengths)


def mix_block(speaker, mic, speaker_present=True):
    """One block of the mix. Channels are padded with silence to the longer one; mic joins only in own-voice slots."""
    size = max(len(speaker), len(mic))
    if size == 0:
        return np.zeros(0, dtype=np.float32)
    out = np.zeros(size, dtype=np.float32)
    out[: len(speaker)] += speaker
    if len(mic):
        full = np.zeros(size, dtype=np.float32)
        full[: len(mic)] = mic
        if speaker_present:
            padded_speaker = np.zeros(size, dtype=np.float32)
            padded_speaker[: len(speaker)] = speaker
            mic_level, speaker_level = slot_rms(full), slot_rms(padded_speaker)
            own = (mic_level >= SOUND_RMS) & (mic_level > MIC_OVER_SPEAKER * speaker_level)
            out += full * np.repeat(own, SLOT)[:size]
        else:
            out += full  # no speaker file: nothing to echo, the microphone is all there is
    return np.clip(out, -1.0, 1.0)


def mix_files(directory, capture_id):
    """Writes <captureId>-mix.wav (via a temp name, renamed at the end). Returns the output path and the sample count."""
    directory = Path(directory)
    speaker = Channel(directory / f'{capture_id}-speaker.wav')
    mic = Channel(directory / f'{capture_id}-mic.wav')
    try:
        if not speaker.present and not mic.present:
            raise FileNotFoundError(f'không có file loa hoặc micro của lượt nghe {capture_id} trong {directory}')
        target = directory / f'{capture_id}-mix.wav'
        part = directory / f'{capture_id}-mix.part'  # not *.wav: never taken for a finished mix
        samples = 0
        writer = WavWriter(part, RATE)
        try:
            while True:
                s, m = speaker.read(BLOCK), mic.read(BLOCK)
                block = mix_block(s, m, speaker.present)
                if not len(block):
                    break
                writer.write(block)
                samples += len(block)
        except BaseException:
            writer.close()
            part.unlink(missing_ok=True)
            raise
        writer.close()
        if not samples:
            part.unlink(missing_ok=True)
            raise ValueError('hai file không có mẫu âm nào')
        os.replace(part, target)
        return target, samples
    finally:
        speaker.close()
        mic.close()


class ChannelCanvas:
    """One channel laid out on the mix canvas: pieces at their start samples, silence everywhere else. read(count) hands out
    the next `count` canvas samples (always exactly that many). Pieces must not overlap (plan_pieces clips them)."""

    def __init__(self, pieces):
        self.pending = list(pieces)  # [{start, length, path, first, frames}] by start
        self.pos = 0
        self.current = None  # (Channel, start, length)

    def read(self, count):
        out = np.zeros(count, dtype=np.float32)
        end = self.pos + count
        while True:
            if self.current is None:
                if not self.pending or self.pending[0]['start'] >= end:
                    break
                item = self.pending.pop(0)
                self.current = (Channel(item['path'], item['first'], item['frames']), item['start'], item['length'])
            channel, start, length = self.current
            low, high = max(self.pos, start), min(end, start + length)
            if high > low:
                data = channel.read(high - low)
                out[low - self.pos: low - self.pos + len(data)] = data  # a resampler that ends a sample short leaves silence
            if start + length > end:
                break
            channel.close()
            self.current = None
        self.pos = end
        return out

    def close(self):
        if self.current is not None:
            self.current[0].close()
            self.current = None


def plan_pieces(timeline, channel, origin):
    """Placed pieces of one channel: every continuous run of every segment at its wall-clock sample on the 16 kHz canvas."""
    pieces = []
    for segment in timeline.segments(channel):
        for first, end, wall in segment.pieces():
            pieces.append({'start': round((wall - origin) * RATE), 'length': round((end - first) * RATE / segment.rate),
                           'path': segment.path, 'first': first, 'frames': end - first})
    pieces.sort(key=lambda item: item['start'])
    for before, after in zip(pieces, pieces[1:]):
        before['length'] = min(before['length'], after['start'] - before['start'])  # a rounding overlap: the later piece wins
    return [item for item in pieces if item['length'] > 0]


def mix_timeline(directory, name=MIX_NAME):
    """Writes <dir>/meeting-mix.wav from the recorder's timeline (via a temp name, renamed at the end). Returns the path
    and the sample count. Where a channel has a hole the canvas is silent; the microphone only joins in own-voice slots."""
    directory = Path(directory)
    timeline = Timeline.load(directory)
    origin = timeline.start_wall()
    if origin is None:
        raise FileNotFoundError(f'không có khúc ghi nào trong timeline của {directory}')
    speaker_pieces, mic_pieces = plan_pieces(timeline, 'speaker', origin), plan_pieces(timeline, 'mic', origin)
    total = max((item['start'] + item['length'] for item in speaker_pieces + mic_pieces), default=0)
    speaker, mic = ChannelCanvas(speaker_pieces), ChannelCanvas(mic_pieces)
    target = directory / name
    part = target.with_suffix('.part')  # not *.wav: never taken for a finished mix
    try:
        if not total:
            raise ValueError('các khúc ghi không có mẫu âm nào')
        writer = WavWriter(part, RATE)
        try:
            done = 0
            while done < total:
                count = min(BLOCK, total - done)
                writer.write(mix_block(speaker.read(count), mic.read(count), bool(speaker_pieces)))
                done += count
        finally:
            writer.close()
        os.replace(part, target)
        return target, total
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    finally:
        speaker.close()
        mic.close()


def main(argv):
    if len(argv) == 2:
        try:
            target, samples = mix_timeline(argv[1])
        except Exception as exc:
            print(json.dumps({'error': str(exc)}, ensure_ascii=False))
            return 1
        print(json.dumps({'mix': str(target), 'seconds': round(samples / RATE, 1)}, ensure_ascii=False))
        return 0
    if len(argv) != 3 or not all(c.isalnum() or c in '-_' for c in argv[2]):
        print('python tools/mix_audio.py <thư mục audio> [captureId]', file=sys.stderr)
        return 2
    try:
        target, samples = mix_files(argv[1], argv[2])
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({'mix': str(target), 'seconds': round(samples / RATE, 1)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
