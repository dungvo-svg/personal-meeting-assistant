"""Black-box recorder: speaker loopback + the user's microphone to WAV segments and a wall-clock timeline. No ASR, no models.

    python tools/recorder.py --dir <audio dir> --speaker-device <idx> --speaker-name <name>
                             [--mic-device <idx> --mic-name <name> | --mic-auto] [--parent <pid>]

Per channel (`speaker`, `mic`) the recorder writes seg-NNNN-<channel>.wav (PCM16 mono at the device rate, header patched
on every write, so a kill leaves a playable file) and appends one JSON line per event to timeline.jsonl:
    open  {seg, channel, rate, device}      first block of a segment (t = when its first sample was taken)
    tick  {seg, channel, samples}           about once a second: `samples` taken so far, for wall time <-> sample
    lost  {seg, channel, seconds, reason, at_samples}   audio that never arrived; t = end of the hole, at_samples = where
                                            in the segment (0: before it, e.g. after a restart)
    close {seg, channel, samples}
    mic_state {state, app, by}              on|off|unknown|none, copied from tools/mic_state.ps1 when it exists
    error {channel, message}
    end   {reason}                          the recorder finished for good
A new segment starts every 10 minutes, on a device change and after any stream restart. A stream error closes the
segment, the open is retried (0.5 s first, then backing off to 5 s) and the other channel keeps recording. Lost samples
are found by comparing the clock with the samples that arrived.

Lifetime (owner, 31/10): the recording must survive a crash of the host. The recorder therefore does NOT exit when its
parent dies. It ends on the stdin line `stop`, when <dir>/STOP appears (a new host can stop it that way) or after 12 h.
stdout carries JSON status lines for the host: {"type":"recording"|"status"|"error"|"ended", ...}.
"""
import argparse
import ctypes
import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audio_worker import MicDeviceWatch, emit, mic_device_change, pcm16, pick_mic, raise_priority, render_keepalive  # noqa: E402
from timeline import Timeline, format_wall, segment_path  # noqa: E402

SEGMENT_SECONDS = 600
LOST_SECONDS = 0.2  # a gap between the clock and the samples that arrived beyond this is loss, not jitter
TICK_SECONDS = 1.0
READ_TIMEOUT = 0.25
RETRY_FIRST = 0.5
RETRY_MAX = 5.0
ERROR_REPEAT_SECONDS = 30  # the same open failure is logged again only this often
STATUS_SECONDS = 10
MAX_SECONDS = 12 * 3600
STOP_FILE = 'STOP'
PID_FILE = 'recorder.pid'
QUEUE_BLOCKS = 2000  # ~85 s of device blocks if the disk stalls; more is dropped and shows up as lost
MIC_STATE_SCRIPT = Path(__file__).with_name('mic_state.ps1')


def say(value):
    # The host may be gone (that is allowed): a broken stdout must never stop the recording.
    try:
        emit(value)
    except (OSError, ValueError):
        pass


class Clock:
    def perf(self):
        return time.perf_counter()

    def wall(self):
        return time.time()

    def sleep(self, seconds):
        time.sleep(seconds)

    def wall_of(self, perf):
        """Wall time of an earlier perf_counter reading."""
        return self.wall() - (self.perf() - perf)


class StreamError(Exception):
    pass


class Block:
    # One piece of audio from a source: mono float32 samples and the perf_counter reading when its last sample arrived.
    __slots__ = ('perf', 'samples')

    def __init__(self, perf, samples):
        self.perf = perf
        self.samples = samples


class SegmentWav:
    # Own tiny WAV writer: the sizes in the header are patched and flushed after every write, so whatever reached the disk plays.
    def __init__(self, path, rate):
        self.file = open(path, 'wb')
        self.rate = int(rate)
        self.bytes = 0
        self.file.write(self._header())
        self.file.flush()

    def _header(self):
        return struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + self.bytes, b'WAVE', b'fmt ', 16, 1, 1, self.rate, self.rate * 2, 2, 16, b'data', self.bytes)

    def write(self, mono):
        data = pcm16(mono)
        self.file.write(data)
        self.bytes += len(data)
        self.file.seek(0)
        self.file.write(self._header())
        self.file.seek(0, 2)
        self.file.flush()

    def close(self):
        self.file.close()


class TimelineLog:
    def __init__(self, path, clock):
        self.clock = clock
        self.lock = threading.Lock()
        self.file = open(path, 'a', encoding='utf-8')
        self.failed = False

    def write(self, kind, wall=None, **fields):
        entry = {'t': format_wall(self.clock.wall() if wall is None else wall), 'type': kind, **fields}
        line = json.dumps(entry, ensure_ascii=False) + '\n'
        try:
            with self.lock:
                self.file.write(line)
                self.file.flush()
                if kind != 'tick':
                    os.fsync(self.file.fileno())  # the events that matter after a crash; ticks are cheap to lose
            self.failed = False
        except OSError as exc:
            if not self.failed:
                say({'type': 'error', 'message': f'không ghi được timeline: {exc}'})
            self.failed = True
        return entry

    def close(self):
        self.file.close()


def next_segment_number(directory, channel):
    numbers = [0]
    for path in Path(directory).glob(f'seg-*-{channel}.wav'):
        try:
            numbers.append(int(path.name.split('-')[1]))
        except (IndexError, ValueError):
            pass
    return max(numbers) + 1


class ChannelRecorder:
    """One channel: source -> segments + timeline entries. step() does one read and is called in a loop by a thread
    (and one call at a time by the tests, with a fake clock and a fake source)."""

    def __init__(self, channel, make_source, log, clock, directory, segment_seconds=SEGMENT_SECONDS, announce=say, should_switch=None, resume_wall=None):
        self.channel = channel
        self.make_source = make_source
        self.log = log
        self.clock = clock
        self.directory = Path(directory)
        self.segment_seconds = segment_seconds
        self.announce = announce
        self.should_switch = should_switch
        self.next_seg = next_segment_number(directory, channel)
        self.source = None
        self.wav = None
        self.seg = None
        self.rate = 0
        self.samples = 0
        self.anchor_perf = 0.0
        self.lost_total = 0.0
        self.last_tick_perf = 0.0
        self.last_block_wall = None
        self.captured_samples = 0  # all segments, for the status line
        self.lost_seconds = 0.0
        self.attempt = 0
        self.retry_at = 0.0
        # The time before the first segment is a hole too (the recorder started late, or a crashed one is being replaced).
        self.hole_since = resume_wall if resume_wall is not None else clock.wall()
        self.hole_reason = 'recorder_restart' if resume_wall is not None else 'not_started'
        self.last_error = (None, -1e9)

    # ---- one iteration
    def step(self):
        try:
            self._step()
        except Exception as exc:
            self._fail(str(exc) or type(exc).__name__)

    def _step(self):
        if self.source is None:
            return self._try_open()
        if self.should_switch and self.should_switch():
            return self._restart('device_change')
        block = self.source.read(READ_TIMEOUT)
        if block is not None and len(block.samples):
            self._handle(block)

    def _try_open(self):
        wait = self.retry_at - self.clock.perf()
        if wait > 0:
            self.clock.sleep(min(wait, 0.05))
            return
        try:
            source = self.make_source()
            source.open()
        except Exception as exc:
            self.attempt += 1
            self._report(str(exc) or type(exc).__name__)
            self.retry_at = self.clock.perf() + self._backoff()
            return
        self.source = source

    def _backoff(self):
        return min(RETRY_MAX, RETRY_FIRST * 2 ** max(self.attempt - 1, 0))

    def _report(self, message):
        # Open failures repeat every second or so for hours when a device is gone: log the first, then now and then.
        text, when = self.last_error
        now = self.clock.perf()
        if message == text and now - when < ERROR_REPEAT_SECONDS:
            return
        self.last_error = (message, now)
        self.log.write('error', channel=self.channel, message=message)
        self.announce({'type': 'error', 'channel': self.channel, 'message': message})

    def _open_segment(self, block):
        rate = self.source.rate
        start_perf = block.perf - len(block.samples) / rate
        wall = self.clock.wall_of(start_perf)
        self.seg = self.next_seg
        self.next_seg += 1
        self.wav = SegmentWav(segment_path(self.directory, self.seg, self.channel), rate)
        self.rate = rate
        self.samples = 0
        self.anchor_perf = start_perf
        self.lost_total = 0.0
        self.last_tick_perf = start_perf
        self.attempt = 0
        self.log.write('open', wall, seg=self.seg, channel=self.channel, rate=rate, device=self.source.name)
        if self.hole_since is not None:
            seconds = wall - self.hole_since
            if seconds > LOST_SECONDS:
                self.log.write('lost', wall, seg=self.seg, channel=self.channel, seconds=round(seconds, 3), reason=self.hole_reason, at_samples=0)
                self.lost_seconds += seconds
            self.hole_since = None
        self.announce({'type': 'recording', 'channel': self.channel, 'seg': self.seg, 'rate': rate, 'device': self.source.name})

    def _handle(self, block):
        if self.wav is None:
            self._open_segment(block)
        count = len(block.samples)
        rate = self.rate
        # Elapsed clock time at the end of this block against what was written (and already counted lost): the rest never arrived.
        gap = (block.perf - self.anchor_perf) - ((self.samples + count) / rate + self.lost_total)
        if gap > LOST_SECONDS:
            self.log.write('lost', self.clock.wall_of(block.perf - count / rate), seg=self.seg, channel=self.channel, seconds=round(gap, 3), reason='dropped_frames', at_samples=self.samples)
            self.lost_total += gap
            self.lost_seconds += gap
        elif gap < -LOST_SECONDS:
            self.anchor_perf = block.perf - ((self.samples + count) / rate + self.lost_total)  # a burst, not time travel: re-anchor
        self.wav.write(block.samples)
        self.samples += count
        self.captured_samples += count
        self.last_block_wall = self.clock.wall_of(block.perf)
        if block.perf - self.last_tick_perf >= TICK_SECONDS:
            self.log.write('tick', self.last_block_wall, seg=self.seg, channel=self.channel, samples=self.samples)
            self.last_tick_perf = block.perf
        if self.samples / rate >= self.segment_seconds:
            self._close_segment()  # the stream stays open: the next block starts the next segment with no gap

    def _close_segment(self):
        if self.wav is None:
            return
        wav, self.wav = self.wav, None
        try:
            wav.close()
        except OSError:
            pass
        self.log.write('close', self.last_block_wall if self.samples else None, seg=self.seg, channel=self.channel, samples=self.samples)

    def _drop_source(self, reason):
        self._close_segment()
        source, self.source = self.source, None
        if source is not None:
            try:
                source.close()
            except Exception:
                pass
        if self.last_block_wall is not None:
            self.hole_since, self.hole_reason = self.last_block_wall, reason

    def _fail(self, message):
        try:
            self._drop_source('stream_restart')
            self.attempt = 1
            self._report(message)
            self.retry_at = self.clock.perf() + self._backoff()
        except Exception:
            self.source = None  # never let a bookkeeping failure end the channel
            self.retry_at = self.clock.perf() + RETRY_MAX

    def _restart(self, reason):
        self._drop_source(reason)
        self.attempt = 0
        self.retry_at = 0.0

    def finish(self):
        self._close_segment()
        source, self.source = self.source, None
        if source is not None:
            try:
                source.close()
            except Exception:
                pass


# ---- real devices (PyAudioWPatch) ----
class PortAudioHub:
    """One PyAudio instance shared by both channels. PortAudio rescans its device list only when the last user
    terminates, so a restarted channel sees a replugged device only while the other channel is down too."""

    def __init__(self):
        self.lock = threading.Lock()  # PortAudio calls from two threads at once are not worth the risk
        self.audio = None
        self.refs = 0

    def acquire(self):
        with self.lock:
            if self.refs == 0:
                import pyaudiowpatch as pa
                self.audio = pa.PyAudio()
            self.refs += 1
            return self.audio

    def release(self):
        with self.lock:
            self.refs -= 1
            if self.refs == 0 and self.audio is not None:
                try:
                    self.audio.terminate()
                finally:
                    self.audio = None


class DeviceSource:
    """A WASAPI input (speaker loopback or microphone) read through a PortAudio callback, so a silent loopback device or a
    slow disk never blocks the audio thread; every block carries the perf_counter reading of its arrival."""

    def __init__(self, hub, index, name, loopback):
        self.hub = hub
        self.index = index
        self.name = name
        self.loopback = loopback
        self.rate = 0
        self.channels = 1
        self.audio = None
        self.stream = None
        self.keepalive = None
        self.queue = queue.Queue(maxsize=QUEUE_BLOCKS)

    def _find(self, audio, pa):
        wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)

        def usable(device):
            return device['hostApi'] == wasapi['index'] and device['maxInputChannels'] >= 1 and bool(device.get('isLoopbackDevice')) == self.loopback

        try:
            device = audio.get_device_info_by_index(self.index)
            if device['name'] == self.name and usable(device):
                return device
        except Exception:
            pass
        for index in range(audio.get_device_count()):  # the index moved (device replugged): find it by name
            device = audio.get_device_info_by_index(index)
            if device['name'] == self.name and usable(device):
                return device
        raise StreamError(f'không thấy thiết bị {self.name}')

    def open(self):
        import numpy as np
        import pyaudiowpatch as pa
        self.audio = self.hub.acquire()
        try:
            with self.hub.lock:
                device = self._find(self.audio, pa)
                self.rate, self.channels = int(device['defaultSampleRate']), int(device['maxInputChannels'])
                if self.channels > 8 or self.rate > 192000:
                    raise StreamError('định dạng thiết bị không hỗ trợ')
                channels = self.channels

                def callback(data, frames, info, status):
                    try:
                        self.queue.put_nowait((time.perf_counter(), data))
                    except queue.Full:
                        pass  # the gap shows up as lost
                    return (None, pa.paContinue)

                self.stream = self.audio.open(format=pa.paFloat32, channels=channels, rate=self.rate, input=True, input_device_index=device['index'], frames_per_buffer=2048, stream_callback=callback)
                if self.loopback:
                    try:
                        self.keepalive = render_keepalive(self.audio, pa, device)  # silent render so the loopback keeps delivering frames
                    except Exception:
                        self.keepalive = None
        except BaseException:
            self.close()
            raise
        self._np = np

    def read(self, timeout):
        try:
            perf, data = self.queue.get(timeout=timeout)
        except queue.Empty:
            try:
                alive = self.stream is not None and self.stream.is_active()
            except OSError:
                alive = False
            if not alive:
                raise StreamError('luồng âm đã dừng (thiết bị đổi hoặc rút)')
            return None
        samples = self._np.frombuffer(data, dtype=self._np.float32)
        samples = samples[: len(samples) // self.channels * self.channels].reshape(-1, self.channels).mean(axis=1)
        return Block(perf, samples)

    def close(self):
        for stream in (self.stream, self.keepalive):
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
        self.stream = self.keepalive = None
        if self.audio is not None:
            self.audio = None
            self.hub.release()


class MicAuto:
    """--mic-auto: the microphone a meeting app holds (tools/mic_in_use.ps1), else the Windows default input; follows it
    when the app moves to another one (that starts a new segment)."""

    def __init__(self, hub, watch=None):
        self.hub = hub
        self.watch = watch
        self.mics = []
        self.current = None

    def make_source(self):
        import pyaudiowpatch as pa
        audio = self.hub.acquire()
        try:
            with self.hub.lock:
                wasapi = audio.get_host_api_info_by_type(pa.paWASAPI)
                self.mics = [(i, d['name']) for i in range(audio.get_device_count()) for d in [audio.get_device_info_by_index(i)]
                             if d['hostApi'] == wasapi['index'] and d['maxInputChannels'] > 0 and not d.get('isLoopbackDevice')]
                default = wasapi['defaultInputDevice']
        finally:
            self.hub.release()
        self.watch = self.watch or MicDeviceWatch()
        index, name, _ = pick_mic(self.mics, default, self.watch.first())
        if index is None:
            raise StreamError('không tìm thấy micro')
        self.current = index
        return DeviceSource(self.hub, index, name, False)

    def should_switch(self):
        if not self.watch or not self.watch.changed.is_set():
            return False
        self.watch.changed.clear()
        return mic_device_change(self.current, self.mics, self.watch.in_use()) is not None

    def stop(self):
        if self.watch:
            self.watch.stop()


# ---- lifetime ----
def process_alive(pid):
    if not pid:
        return False
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x00100000, 0, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 5  # access denied: it exists
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


class RecorderRunning(Exception):
    pass


class Recorder:
    def __init__(self, directory, channels, log, clock=None, max_seconds=MAX_SECONDS, parent_pid=None, parent_alive=process_alive, poll=0.5, announce=say):
        self.directory = Path(directory)
        self.channels = channels
        self.log = log
        self.clock = clock or Clock()
        self.max_seconds = max_seconds
        self.parent_pid = parent_pid
        self.parent_alive = parent_alive
        self.poll = poll
        self.announce = announce
        self.stop_event = threading.Event()
        self.stop_reason = 'stop'
        self.claimed = False

    def request_stop(self, reason='stop'):
        if not self.stop_event.is_set():
            self.stop_reason = reason
            self.stop_event.set()

    def claim(self):
        # One recorder per directory: a host that attaches again must find this one, not start a second.
        if self.claimed:
            return
        pid_file = self.directory / PID_FILE
        try:
            other = int(pid_file.read_text().strip())
        except (OSError, ValueError):
            other = 0
        if other and other != os.getpid() and process_alive(other):
            raise RecorderRunning(f'recorder đã chạy trong thư mục này (pid {other})')
        pid_file.write_text(str(os.getpid()))
        (self.directory / STOP_FILE).unlink(missing_ok=True)  # a leftover from an earlier run must not end this one
        self.claimed = True

    def _loop(self, channel):
        while not self.stop_event.is_set():
            channel.step()

    def status(self):
        return {'type': 'status', 'channels': {c.channel: {'capturedSeconds': round(c.captured_samples / c.rate, 1) if c.rate else 0, 'lostSeconds': round(c.lost_seconds, 1), 'seg': c.seg, 'recording': c.wav is not None} for c in self.channels}}

    def run(self):
        self.claim()
        started = self.clock.perf()
        threads = [threading.Thread(target=self._loop, args=(channel,), daemon=True, name=f'rec-{channel.channel}') for channel in self.channels]
        for thread in threads:
            thread.start()
        last_status = started
        parent_gone = False
        try:
            while not self.stop_event.wait(self.poll):
                if (self.directory / STOP_FILE).exists():
                    self.request_stop('STOP_file')
                elif self.clock.perf() - started >= self.max_seconds:
                    self.request_stop('max_seconds')
                if self.parent_pid and not parent_gone and not self.parent_alive(self.parent_pid):
                    parent_gone = True  # the recording goes on; the host that comes next reads the timeline and attaches
                    self.announce({'type': 'status', 'parentGone': True})
                if self.clock.perf() - last_status >= STATUS_SECONDS:
                    last_status = self.clock.perf()
                    self.announce(self.status())
        except BaseException:
            self.request_stop('interrupted')
            raise
        finally:
            for thread in threads:
                thread.join(timeout=5)
            for channel in self.channels:
                channel.finish()
            self.log.write('end', reason=self.stop_reason)
            self.announce({'type': 'ended', 'reason': self.stop_reason})
            (self.directory / STOP_FILE).unlink(missing_ok=True)
            (self.directory / PID_FILE).unlink(missing_ok=True)
        return 0


def copy_mic_state(lines, write):
    """JSON lines of tools/mic_state.ps1 ({"mic":"on|off|unknown","app":...}) -> write(state, app), repeats skipped."""
    last = None
    for line in lines:
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        state = data.get('mic') if data.get('mic') in ('on', 'off', 'unknown') else 'unknown'
        key = (state, data.get('app'))
        if key != last:
            last = key
            write(state, data.get('app'))


def start_mic_state(log, stopping):
    """Runs tools/mic_state.ps1 when it exists; its lines become `mic_state` entries. Returns the process or None."""
    if not MIC_STATE_SCRIPT.is_file():
        return None
    try:
        process = subprocess.Popen(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(MIC_STATE_SCRIPT), '-ParentPid', str(os.getpid())],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True, encoding='utf-8',
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except OSError as exc:
        say({'type': 'error', 'channel': 'mic', 'message': f'không chạy được mic_state.ps1: {exc}'})
        return None

    def read():
        copy_mic_state(process.stdout, lambda state, app: log.write('mic_state', state=state, app=app, by='mic_state.ps1'))
        if not stopping.is_set():
            log.write('mic_state', state='unknown', app=None, by='recorder:mic_state.ps1 đã dừng')

    threading.Thread(target=read, daemon=True).start()
    return process


def read_commands(recorder):
    # stdin carries `stop`. EOF is NOT a stop: it is what a dead host looks like, and the recording must go on.
    try:
        for line in sys.stdin:
            if line.strip() == 'stop':
                recorder.request_stop('stop')
                return
    except (OSError, ValueError):
        pass


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Black-box recorder (loa + micro -> WAV + timeline)')
    parser.add_argument('--dir', required=True)
    parser.add_argument('--speaker-device', type=int, required=True)
    parser.add_argument('--speaker-name', required=True)
    parser.add_argument('--mic-device', type=int)
    parser.add_argument('--mic-name')
    parser.add_argument('--mic-auto', action='store_true')
    parser.add_argument('--parent', type=int)
    parser.add_argument('--segment-seconds', type=float, default=SEGMENT_SECONDS)
    parser.add_argument('--max-seconds', type=float, default=MAX_SECONDS)
    args = parser.parse_args(argv)
    if (args.mic_device is None) != (args.mic_name is None):
        parser.error('--mic-device và --mic-name đi cùng nhau')
    if args.mic_auto and args.mic_device is not None:
        parser.error('--mic-auto và --mic-device chọn một')
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    directory = Path(args.dir)
    directory.mkdir(parents=True, exist_ok=True)
    clock = Clock()
    log = TimelineLog(directory / 'timeline.jsonl', clock)
    resume = Timeline.load(directory)  # a crashed recorder's last sample, so the hole before this run is counted
    hub = PortAudioHub()
    mic_auto = MicAuto(hub) if args.mic_auto else None
    channels = [ChannelRecorder('speaker', lambda: DeviceSource(hub, args.speaker_device, args.speaker_name, True), log, clock, directory, args.segment_seconds, resume_wall=resume.end_wall('speaker'))]
    if mic_auto:
        channels.append(ChannelRecorder('mic', mic_auto.make_source, log, clock, directory, args.segment_seconds, should_switch=mic_auto.should_switch, resume_wall=resume.end_wall('mic')))
    elif args.mic_device is not None:
        channels.append(ChannelRecorder('mic', lambda: DeviceSource(hub, args.mic_device, args.mic_name, False), log, clock, directory, args.segment_seconds, resume_wall=resume.end_wall('mic')))
    recorder = Recorder(directory, channels, log, clock, args.max_seconds, args.parent)
    raise_priority()
    process = None
    try:
        recorder.claim()
        log.write('mic_state', state='unknown' if len(channels) > 1 else 'none', app=None, by='recorder')
        process = start_mic_state(log, recorder.stop_event) if len(channels) > 1 else None
        threading.Thread(target=read_commands, args=(recorder,), daemon=True).start()
        return recorder.run()
    except RecorderRunning as exc:
        say({'type': 'error', 'message': str(exc)})
        return 3
    finally:
        if process and process.poll() is None:
            process.kill()
        if mic_auto:
            mic_auto.stop()
        log.close()


if __name__ == '__main__':
    sys.exit(main())
