"""tools/recorder.py, tools/timeline.py and the timeline mode of tools/mix_audio.py. No device is opened: audio comes from
a fake source (generated tones, scripted errors, dropped frames) and, in most tests, a fake clock that only moves when told."""
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import mix_audio  # noqa: E402
import recorder  # noqa: E402
import timeline  # noqa: E402

WALL0 = 1_760_000_000.0


class FakeClock(recorder.Clock):
    def __init__(self):
        self._perf = 1000.0
        self._wall = WALL0

    def perf(self):
        return self._perf

    def wall(self):
        return self._wall

    def advance(self, seconds):
        self._perf += seconds
        self._wall += seconds

    def advance_to(self, perf):
        if perf > self._perf:
            self.advance(perf - self._perf)

    def sleep(self, seconds):
        self.advance(seconds)


class FakeSource:
    """A tone delivered 0.1 s at a time on its own virtual timeline. events: {read number: ('error', text) | ('drop', seconds)}.
    A drop is audio that never arrived: the next block comes that much later than its samples say."""

    def __init__(self, clock, rate=16000, freq=440, amplitude=0.3, events=None, name='fake device'):
        self.clock, self.rate, self.freq, self.amplitude = clock, rate, freq, amplitude
        self.events = events or {}
        self.name = name
        self.reads = 0
        self.phase = 0
        self.cursor = 0.0
        self.closed = False

    def open(self):
        self.cursor = self.clock.perf()

    def read(self, timeout):
        self.reads += 1
        event = self.events.get(self.reads)
        if event and event[0] == 'error':
            raise recorder.StreamError(event[1])
        if event and event[0] == 'drop':
            self.cursor += event[1]
        count = self.rate // 10
        samples = (self.amplitude * np.sin(2 * np.pi * self.freq * (self.phase + np.arange(count)) / self.rate)).astype(np.float32)
        self.phase += count
        self.cursor += count / self.rate
        self.clock.advance_to(self.cursor)
        return recorder.Block(self.cursor, samples)

    def close(self):
        self.closed = True


class Factory:
    def __init__(self, clock, plans=None, open_failures=0, **source_options):
        self.clock, self.plans, self.open_failures, self.options = clock, plans or [], open_failures, source_options
        self.made = []
        self.attempts = []  # perf_counter reading of every attempt

    def __call__(self):
        self.attempts.append(self.clock.perf())
        if len(self.attempts) <= self.open_failures:
            raise recorder.StreamError('thiết bị chưa sẵn sàng')
        events = self.plans[len(self.made)] if len(self.made) < len(self.plans) else {}
        source = FakeSource(self.clock, events=events, **self.options)
        self.made.append(source)
        return source


class PacedSource:
    """Real-time fake for the tests that run the whole Recorder on its threads: blocks as large as the time that passed."""

    def __init__(self, rate=8000):
        self.rate, self.name, self.last = rate, 'paced', None

    def open(self):
        self.last = time.perf_counter()

    def read(self, timeout):
        time.sleep(0.02)
        now = time.perf_counter()
        count = max(1, round((now - self.last) * self.rate))
        self.last += count / self.rate
        return recorder.Block(self.last, np.full(count, 0.1, dtype=np.float32))

    def close(self):
        pass


def drive(channels, steps):
    for _ in range(steps):
        for channel in channels:
            channel.step()


def wav_info(path):
    with wave.open(str(path), 'rb') as reading:
        return reading.getnchannels(), reading.getsampwidth(), reading.getframerate(), reading.getnframes()


def dominant(window):
    return int(np.argmax(np.abs(np.fft.rfft(window))))  # 1 s at 16 kHz: bin number = Hz


def strength(window, freq):
    # spectrum magnitude at `freq` for a window of any length at 16 kHz
    return float(np.abs(np.fft.rfft(window))[round(freq * len(window) / 16000)])


def rms(window):
    return float(np.sqrt(np.mean(window ** 2)))


def read_mix(path):
    with wave.open(str(path), 'rb') as reading:
        assert (reading.getnchannels(), reading.getsampwidth(), reading.getframerate()) == (1, 2, 16000)
        return np.frombuffer(reading.readframes(reading.getnframes()), dtype='<i2').astype(np.float32) / 32768


class RecorderCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.clock = FakeClock()
        self.log = recorder.TimelineLog(self.dir / 'timeline.jsonl', self.clock)
        self.addCleanup(self.log.close)
        self.said = []

    def channel(self, name, factory, segment_seconds=600, **options):
        channel = recorder.ChannelRecorder(name, factory, self.log, self.clock, self.dir, segment_seconds, announce=self.said.append, **options)
        self.addCleanup(channel.finish)
        return channel

    def events(self, kind=None, channel=None):
        found = timeline.read_events(self.dir)
        return [e for e in found if (kind is None or e['type'] == kind) and (channel is None or e.get('channel') == channel)]


class SegmentTests(RecorderCase):
    def test_segments_roll_at_the_boundary_and_the_timeline_agrees_with_the_files(self):
        speaker = self.channel('speaker', Factory(self.clock, rate=16000), segment_seconds=1.0)
        drive([speaker], 35)  # 1 step opens the stream, 34 blocks of 0.1 s
        speaker.finish()
        opens, closes = self.events('open'), self.events('close')
        self.assertEqual([e['seg'] for e in opens], [1, 2, 3, 4])
        self.assertEqual([e['samples'] for e in closes], [16000, 16000, 16000, 6400])
        self.assertEqual(sorted(p.name for p in self.dir.glob('seg-*.wav')), [f'seg-000{n}-speaker.wav' for n in (1, 2, 3, 4)])
        for event in closes:
            path = timeline.segment_path(self.dir, event['seg'], 'speaker')
            self.assertEqual(wav_info(path), (1, 2, 16000, event['samples']))
        self.assertEqual(self.events('lost'), [])  # a roll with the stream open loses nothing
        self.assertEqual({e['rate'] for e in opens}, {16000})
        # each segment starts where the previous one ended
        for before, after in zip(closes, opens[1:]):
            self.assertAlmostEqual(before['wall'], after['wall'], places=3)
        tl = timeline.Timeline.load(self.dir)
        second = tl.segments('speaker')[1]
        found = tl.locate('speaker', second.open_wall + 0.5)
        self.assertEqual(found[0].seg, 2)
        self.assertLessEqual(abs(found[1] - 8000), 2)
        self.assertEqual(tl.locate('speaker', tl.segments('speaker')[0].open_wall + 0.25)[0].seg, 1)
        self.assertIsNone(tl.locate('speaker', tl.start_wall() - 1))
        self.assertEqual(tl.lost_intervals(), [])
        # the recording is the tone, with no seam at the roll
        target, samples = mix_audio.mix_timeline(self.dir)
        self.assertLessEqual(abs(samples - 54400), 2)  # microsecond timestamps: the seams add no visible slack
        data = read_mix(target)
        self.assertLess(float(np.abs(np.diff(data[:40000])).max()), 0.06)
        self.assertEqual(dominant(data[:16000]), 440)

    def test_ticks_map_wall_time_to_samples(self):
        speaker = self.channel('speaker', Factory(self.clock, rate=16000))
        drive([speaker], 45)
        ticks = self.events('tick')
        self.assertGreaterEqual(len(ticks), 3)
        self.assertEqual([t['samples'] for t in ticks], sorted(t['samples'] for t in ticks))
        self.assertTrue(all(0.9 <= b['wall'] - a['wall'] <= 1.2 for a, b in zip(ticks, ticks[1:])))
        segment = timeline.Timeline.load(self.dir).segments('speaker')[0]
        for tick in ticks:
            self.assertAlmostEqual(segment.wall_at(tick['samples']), tick['wall'], places=3)
            self.assertLessEqual(abs(segment.sample_at(tick['wall'] - 0.001) - (tick['samples'] - 16)), 2)
        self.assertEqual(segment.open_wall, self.events('open')[0]['wall'])

    def test_timestamps_are_iso_with_offset(self):
        drive([self.channel('speaker', Factory(self.clock))], 3)
        for event in self.events():
            self.assertRegex(event['t'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}[+-]\d\d:\d\d$')
        self.assertAlmostEqual(timeline.parse_wall(self.events('open')[0]['t']), self.events('open')[0]['wall'], places=3)

    def test_segment_numbers_continue_after_a_recorder_restart(self):
        first = self.channel('speaker', Factory(self.clock))
        drive([first], 5)
        first.finish()
        second = self.channel('speaker', Factory(self.clock), resume_wall=self.clock.wall() - 3.0)
        drive([second], 3)
        self.assertEqual([e['seg'] for e in self.events('open')], [1, 2])
        lost = self.events('lost')
        self.assertEqual([(e['seg'], e['reason'], e['at_samples']) for e in lost], [(2, 'recorder_restart', 0)])
        self.assertAlmostEqual(lost[0]['seconds'], 3.0, places=2)


class FailureTests(RecorderCase):
    def test_stream_error_starts_a_new_segment_within_the_retry_window_and_the_other_channel_goes_on(self):
        factory = Factory(self.clock, plans=[{5: ('error', 'thiết bị rút')}])
        speaker = self.channel('speaker', factory)
        mic = self.channel('mic', Factory(self.clock, freq=880))
        drive([speaker, mic], 40)
        speaker.finish(), mic.finish()
        opens = self.events('open', 'speaker')
        self.assertEqual([e['seg'] for e in opens], [1, 2])
        close = self.events('close', 'speaker')[0]
        self.assertEqual(close['samples'], 4 * 1600)  # what arrived before the error is kept and closed
        restart = opens[1]['wall'] - close['wall']
        self.assertGreater(restart, 0.4)
        self.assertLessEqual(restart, 2.0)
        lost = self.events('lost', 'speaker')
        self.assertEqual(len(lost), 1)
        self.assertEqual((lost[0]['seg'], lost[0]['reason'], lost[0]['at_samples']), (2, 'stream_restart', 0))
        self.assertAlmostEqual(lost[0]['seconds'], restart, places=2)
        self.assertEqual([e['message'] for e in self.events('error', 'speaker')], ['thiết bị rút'])
        self.assertIn({'type': 'error', 'channel': 'speaker', 'message': 'thiết bị rút'}, self.said)
        # the microphone never noticed
        self.assertEqual([e['seg'] for e in self.events('open', 'mic')], [1])
        self.assertEqual((self.events('lost', 'mic'), self.events('error', 'mic')), ([], []))
        self.assertEqual(self.events('close', 'mic')[0]['samples'], 40 * 1600 - 1600)
        intervals = timeline.Timeline.load(self.dir).lost_intervals()
        self.assertEqual([(i['channel'], i['reason']) for i in intervals], [('speaker', 'stream_restart')])
        self.assertTrue(factory.made[0].closed)  # the broken stream was let go before the retry


    def test_failed_opens_back_off_and_are_logged_without_flooding(self):
        factory = Factory(self.clock, open_failures=4)
        speaker = self.channel('speaker', factory)
        drive([speaker], 400)
        gaps = [b - a for a, b in zip(factory.attempts, factory.attempts[1:])]
        self.assertEqual(len(factory.made), 1)
        self.assertEqual(len(gaps), 4)
        self.assertLessEqual(gaps[0], 0.7)  # the first retry is quick
        self.assertEqual(gaps, sorted(gaps))  # then it backs off
        self.assertLessEqual(max(gaps), recorder.RETRY_MAX + 0.1)
        self.assertEqual(len(self.events('error', 'speaker')), 1)  # the same message is not logged again every attempt
        self.assertEqual(self.events('open', 'speaker')[0]['seg'], 1)
        self.assertEqual(self.events('lost', 'speaker')[0]['reason'], 'not_started')

    def test_dropped_frames_become_a_lost_entry_in_the_same_segment(self):
        speaker = self.channel('speaker', Factory(self.clock, plans=[{6: ('drop', 1.0)}]))
        drive([speaker], 25)
        speaker.finish()
        lost = self.events('lost')
        self.assertEqual(len(lost), 1)
        self.assertEqual((lost[0]['seg'], lost[0]['reason'], lost[0]['at_samples']), (1, 'dropped_frames', 5 * 1600))
        self.assertAlmostEqual(lost[0]['seconds'], 1.0, places=2)
        self.assertEqual(len(self.events('open')), 1)  # no restart: the stream kept running
        tl = timeline.Timeline.load(self.dir)
        interval = tl.lost_intervals()[0]
        self.assertAlmostEqual(interval['end'] - interval['start'], 1.0, places=2)
        self.assertIsNone(tl.locate('speaker', interval['start'] + 0.5))
        before, after = tl.locate('speaker', interval['start'] - 0.01), tl.locate('speaker', interval['end'] + 0.01)
        self.assertLessEqual(abs(before[1] - 5 * 1600), 400)
        self.assertGreaterEqual(after[1], 5 * 1600)
        # in the mix the hole is silence of the same length: 2.4 s of samples + 1.0 s lost
        target, samples = mix_audio.mix_timeline(self.dir)
        self.assertLessEqual(abs(samples - round(3.4 * 16000)), 2)
        data = read_mix(target)
        start = round((interval['start'] - tl.start_wall()) * 16000)
        self.assertLess(rms(data[start + 800:start + 15200]), 0.001)
        self.assertGreater(rms(data[start - 4000:start - 100]), 0.1)
        self.assertGreater(rms(data[start + 16100:start + 20000]), 0.1)

    def test_jitter_below_the_threshold_is_not_loss(self):
        speaker = self.channel('speaker', Factory(self.clock, plans=[{6: ('drop', 0.15)}]))
        drive([speaker], 20)
        self.assertEqual(self.events('lost'), [])

    def test_a_burst_re_anchors_instead_of_reporting_negative_loss(self):
        speaker = self.channel('speaker', Factory(self.clock, plans=[{6: ('drop', -0.5)}]))
        drive([speaker], 20)
        self.assertEqual(self.events('lost'), [])

    def test_disk_write_error_ends_the_segment_and_recording_resumes_in_a_new_one(self):
        real = recorder.SegmentWav.write
        calls = []

        def flaky(wav, mono):
            calls.append(1)
            if len(calls) == 3:
                raise OSError('disk full')
            return real(wav, mono)

        recorder.SegmentWav.write = flaky
        self.addCleanup(setattr, recorder.SegmentWav, 'write', real)
        speaker = self.channel('speaker', Factory(self.clock))
        drive([speaker], 30)
        speaker.finish()
        self.assertEqual([e['seg'] for e in self.events('open')], [1, 2])
        self.assertIn('disk full', self.events('error')[0]['message'])
        self.assertEqual(self.events('lost')[0]['reason'], 'stream_restart')

    def test_device_change_starts_a_new_segment(self):
        switches = iter([False] * 7 + [True] + [False] * 100)
        mic = self.channel('mic', Factory(self.clock, plans=[{}, {}]), should_switch=lambda: next(switches))
        drive([mic], 30)
        mic.finish()
        self.assertEqual([e['seg'] for e in self.events('open')], [1, 2])
        self.assertEqual([(e['reason'], e['at_samples']) for e in self.events('lost')], [])  # reopened at once: no hole to report
        self.assertEqual(self.events('error'), [])
        self.assertEqual(len(mic.make_source.made), 2)

    def test_unexpected_exception_does_not_kill_the_channel(self):
        factory = Factory(self.clock)
        speaker = self.channel('speaker', factory)
        drive([speaker], 4)
        factory.made[0].read = lambda timeout: (_ for _ in ()).throw(ValueError('boom'))
        drive([speaker], 60)
        self.assertEqual([e['message'] for e in self.events('error')], ['boom'])
        self.assertEqual([e['seg'] for e in self.events('open')], [1, 2])


class RecorderLifetimeTests(RecorderCase):
    def build(self, **options):
        clock = recorder.Clock()
        log = recorder.TimelineLog(self.dir / 'timeline.jsonl', clock)
        self.addCleanup(log.close)
        channels = [recorder.ChannelRecorder(name, PacedSource, log, clock, self.dir, 600, announce=self.said.append) for name in ('speaker', 'mic')]
        return recorder.Recorder(self.dir, channels, log, clock, poll=0.05, announce=self.said.append, **options)

    def start(self, rec):
        result = []
        thread = threading.Thread(target=lambda: result.append(rec.run()), daemon=True)
        thread.start()
        deadline = time.time() + 5
        while time.time() < deadline and len(self.events('open')) < 2:
            time.sleep(0.02)
        self.assertEqual(len(self.events('open')), 2)
        return thread, result

    def test_stop_file_ends_the_recording_cleanly(self):
        rec = self.build()
        thread, result = self.start(rec)
        (self.dir / recorder.STOP_FILE).write_text('')
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [0])
        self.assertEqual(self.events('end')[0]['reason'], 'STOP_file')
        self.assertEqual(self.events()[-1]['type'], 'end')
        self.assertEqual(len(self.events('close')), 2)
        self.assertFalse((self.dir / recorder.STOP_FILE).exists())
        self.assertFalse((self.dir / recorder.PID_FILE).exists())
        self.assertTrue(timeline.Timeline.load(self.dir).ended)
        self.assertEqual(self.said[-1], {'type': 'ended', 'reason': 'STOP_file'})
        self.assertTrue(any(m.get('type') == 'recording' for m in self.said))
        for event in self.events('close'):
            self.assertGreater(event['samples'], 0)
            self.assertEqual(wav_info(timeline.segment_path(self.dir, event['seg'], event['channel']))[3], event['samples'])

    def test_stop_command_and_stdin_eof(self):
        rec = self.build()
        saved = sys.stdin
        try:
            sys.stdin = io.StringIO('')  # a dead host closes stdin: that is not a stop
            recorder.read_commands(rec)
            self.assertFalse(rec.stop_event.is_set())
            sys.stdin = io.StringIO('hello\nstop\n')
            recorder.read_commands(rec)
        finally:
            sys.stdin = saved
        self.assertTrue(rec.stop_event.is_set())
        self.assertEqual(rec.stop_reason, 'stop')

    def test_recording_survives_the_parent_dying(self):
        rec = self.build(parent_pid=999999, parent_alive=lambda pid: False)
        thread, _ = self.start(rec)
        time.sleep(0.4)
        self.assertTrue(thread.is_alive())
        self.assertEqual([m for m in self.said if m.get('parentGone')], [{'type': 'status', 'parentGone': True}])
        self.assertEqual(self.events('end'), [])
        before = max(e['samples'] for e in self.events('tick') if e['channel'] == 'speaker') if self.events('tick') else 0
        rec.request_stop()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.events('end')[0]['reason'], 'stop')
        self.assertGreaterEqual(self.events('close', 'speaker')[0]['samples'], before)

    def test_safety_cap_ends_the_recording(self):
        rec = self.build(max_seconds=0.3)
        thread, result = self.start(rec)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.events('end')[0]['reason'], 'max_seconds')

    def test_a_second_recorder_in_the_same_directory_is_refused(self):
        other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(other.kill)
        (self.dir / recorder.PID_FILE).write_text(str(other.pid))
        with self.assertRaises(recorder.RecorderRunning):
            self.build().claim()
        other.kill()
        other.wait()
        self.build().claim()  # the owner is gone: the pid file is stale and is taken over

    def test_stale_stop_file_does_not_end_a_new_run(self):
        (self.dir / recorder.STOP_FILE).write_text('')
        rec = self.build()
        rec.claim()
        self.assertFalse((self.dir / recorder.STOP_FILE).exists())

    def test_process_alive(self):
        import os
        self.assertTrue(recorder.process_alive(os.getpid()))
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait()
        self.assertFalse(recorder.process_alive(child.pid))
        self.assertFalse(recorder.process_alive(0))


class MicStateTests(unittest.TestCase):
    def test_lines_become_entries_without_repeats_or_garbage(self):
        written = []
        lines = ['{"mic":"on","app":"zoom"}', 'not json', '{"mic":"on","app":"zoom"}', '[1]', '{"mic":"off","app":"zoom"}', '{"mic":"weird"}', '{"mic":"unknown","app":null}']
        recorder.copy_mic_state(lines, lambda state, app: written.append((state, app)))
        self.assertEqual(written, [('on', 'zoom'), ('off', 'zoom'), ('unknown', None)])

    def test_mic_state_is_in_the_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = FakeClock()
            log = recorder.TimelineLog(Path(directory) / 'timeline.jsonl', clock)
            recorder.copy_mic_state(['{"mic":"on","app":"chrome"}'], lambda state, app: log.write('mic_state', state=state, app=app, by='mic_state.ps1'))
            log.close()
            self.assertEqual(timeline.Timeline.load(directory).mic_states(), [{'wall': WALL0, 't': WALL0, 'state': 'on', 'app': 'chrome', 'by': 'mic_state.ps1', 'release': None}])


class TimelineFileTests(unittest.TestCase):
    def test_torn_last_line_and_incremental_update(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'timeline.jsonl'
            line = lambda **e: json.dumps({'t': timeline.format_wall(WALL0 + e.pop('at', 0)), **e}) + '\n'  # noqa: E731
            path.write_text(line(type='open', seg=1, channel='speaker', rate=16000, device='d') + line(type='tick', at=1, seg=1, channel='speaker', samples=16000) + '{"t": "2025', encoding='utf-8')
            tl = timeline.Timeline.load(directory)
            self.assertEqual(len(tl.events), 2)
            self.assertEqual(len(timeline.read_events(directory)), 2)
            with open(path, 'a', encoding='utf-8') as file:
                file.write('")\n' + line(type='close', at=2, seg=1, channel='speaker', samples=32000))  # completes the torn line? no: it is garbage
            fresh = tl.update()
            self.assertEqual([e['type'] for e in fresh], ['close'])
            self.assertTrue(tl.segments('speaker')[0].closed)
            self.assertFalse(tl.ended)


class MixTimelineTests(unittest.TestCase):
    """Hand-built recorder output, so the expected canvas is exact."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.lines = []

    def tone(self, rate, seconds, freq, amplitude):
        t = np.arange(round(rate * seconds)) / rate
        return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)

    def segment(self, seg, channel, rate, seconds, freq, amplitude, at, lost=None):
        """A segment opening `at` seconds after WALL0; lost=(at_samples, seconds) is a hole inside it."""
        wav = recorder.SegmentWav(timeline.segment_path(self.dir, seg, channel), rate)
        wav.write(self.tone(rate, seconds, freq, amplitude))
        wav.close()
        samples = round(rate * seconds)
        add = lambda kind, when, **f: self.lines.append(json.dumps({'t': timeline.format_wall(WALL0 + when), 'type': kind, 'seg': seg, 'channel': channel, **f}))  # noqa: E731
        add('open', at, rate=rate, device='d')
        end = at + seconds
        if lost:
            position, hole = lost
            add('tick', at + position / rate, samples=position)
            add('lost', at + position / rate + hole, seconds=hole, reason='dropped_frames', at_samples=position)
            end += hole
        add('close', end, samples=samples)
        return end

    def write_timeline(self):
        (self.dir / 'timeline.jsonl').write_text('\n'.join(self.lines) + '\n', encoding='utf-8')

    def mix(self):
        self.write_timeline()
        target, samples = mix_audio.mix_timeline(self.dir)
        self.assertEqual(target.name, 'meeting-mix.wav')
        data = read_mix(target)
        self.assertEqual(len(data), samples)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir() if p.suffix in ('.part',)), [])
        return data

    def test_a_delayed_segment_lands_at_its_wall_clock_offset(self):
        self.segment(1, 'speaker', 16000, 1.0, 440, 0.2, at=0.0)
        self.segment(2, 'speaker', 16000, 1.0, 880, 0.2, at=3.0)  # the recorder was down for 2 s in between
        data = self.mix()
        self.assertLessEqual(abs(len(data) - 4 * 16000), 2)
        self.assertEqual(dominant(data[0:16000]), 440)
        self.assertLess(rms(data[16000 + 400:3 * 16000 - 400]), 0.001)  # the gap is silence of the right length
        self.assertEqual(dominant(data[3 * 16000:4 * 16000]), 880)
        self.assertGreater(rms(data[3 * 16000 + 100:4 * 16000 - 100]), 0.1)
        self.assertLess(rms(data[3 * 16000 - 100:3 * 16000 - 5]), 0.001)

    def test_segments_at_other_device_rates_are_resampled_into_place(self):
        self.segment(1, 'speaker', 48000, 1.0, 440, 0.2, at=0.0)
        self.segment(2, 'speaker', 44100, 1.0, 880, 0.2, at=2.0)
        data = self.mix()
        self.assertLessEqual(abs(len(data) - 3 * 16000), 2)
        self.assertEqual(dominant(data[0:16000]), 440)
        self.assertEqual(dominant(data[2 * 16000:3 * 16000 - 2]), 880)

    def test_lost_samples_inside_a_segment_become_silence(self):
        self.segment(1, 'speaker', 16000, 2.0, 440, 0.2, at=0.0, lost=(16000, 1.0))
        data = self.mix()
        self.assertLessEqual(abs(len(data) - 3 * 16000), 2)
        self.assertGreater(rms(data[1000:15000]), 0.1)
        self.assertLess(rms(data[16000 + 400:2 * 16000 - 400]), 0.001)
        self.assertGreater(rms(data[2 * 16000 + 400:3 * 16000 - 400]), 0.1)
        # the same file through the helpers a reader would use
        tl = timeline.Timeline.load(self.dir)
        self.assertEqual([(round(i['seconds'], 3), i['reason']) for i in tl.lost_intervals()], [(1.0, 'dropped_frames')])
        self.assertIsNone(tl.locate('speaker', WALL0 + 1.5))
        self.assertEqual(tl.locate('speaker', WALL0 + 2.5)[1], 24000)
        self.assertEqual(tl.segments('speaker')[0].pieces()[1][:2], (16000, 32000))

    def test_microphone_joins_only_where_it_is_the_users_voice(self):
        self.segment(1, 'speaker', 16000, 2.0, 440, 0.1, at=0.0)
        self.segment(1, 'mic', 16000, 1.0, 1000, 0.1, at=0.0)      # [0,1): the mic hears the speakers again (same level)
        self.segment(2, 'mic', 16000, 2.0, 1000, 0.5, at=1.0)      # [1,2): clearly louder than the speakers; [2,3): speakers silent
        data = self.mix()
        self.assertLessEqual(abs(len(data) - 3 * 16000), 2)
        echo, talk = data[2000:14000], data[16000 + 2000:2 * 16000 - 2000]
        self.assertLess(strength(echo, 1000), 0.05 * strength(echo, 440))  # echo is not doubled
        self.assertGreater(strength(talk, 1000), 5 * strength(talk, 440))
        self.assertEqual(dominant(data[2 * 16000:3 * 16000 - 2]), 1000)
        self.assertLess(float(np.abs(data).max()), 1.0)

    def test_mic_only_recording_is_kept_whole(self):
        self.segment(1, 'mic', 16000, 1.0, 1000, 0.003, at=0.0)  # below SOUND_RMS, yet with no speaker channel there is nothing to echo
        data = self.mix()
        self.assertAlmostEqual(rms(data), 0.003 / np.sqrt(2), delta=0.0005)

    def test_a_segment_still_being_recorded_is_mixed_up_to_what_is_on_disk(self):
        self.segment(1, 'speaker', 16000, 2.0, 440, 0.2, at=0.0)
        self.lines.pop()  # no close entry: the recorder is still running (pause) or was killed
        data = self.mix()
        self.assertLessEqual(abs(len(data) - 2 * 16000), 2)
        self.assertEqual(dominant(data[:16000]), 440)

    def test_nothing_to_mix_raises_leaves_no_file_and_main_reports_it(self):
        with self.assertRaises(FileNotFoundError):
            mix_audio.mix_timeline(self.dir)
        self.assertEqual(list(self.dir.iterdir()), [])
        self.assertEqual(mix_audio.main(['mix_audio.py', str(self.dir)]), 1)

    def test_cli_with_a_directory_only_mixes_by_timeline(self):
        self.segment(1, 'speaker', 16000, 1.0, 440, 0.2, at=0.0)
        self.write_timeline()
        self.assertEqual(mix_audio.main(['mix_audio.py', str(self.dir)]), 0)
        self.assertTrue((self.dir / 'meeting-mix.wav').is_file())


if __name__ == '__main__':
    unittest.main()
