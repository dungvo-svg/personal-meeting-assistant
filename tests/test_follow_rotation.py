"""Following the recorder's files across segment rotation: one Timeline shared by the two channel readers (as in production),
a lost timeline line recovered from the disk, a segment that is really absent reported, end followed by a new open."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import follow_source
import timeline as timeline_module
from test_audio_worker import FakeSession

RATE = 16000


def drain(follower, limit=30.0):
    """Reads a follower until EOFError; returns (samples handed out, SEGMENT_END count). Fails instead of hanging."""
    total, ends, end = 0, 0, time.monotonic() + limit
    while True:
        assert time.monotonic() < end, 'follower did not reach EOF'
        try:
            block = follower.read_block()
        except EOFError:
            return total, ends
        if block is follow_source.SEGMENT_END:
            ends += 1
        else:
            total += len(block) // 4


class TimelineThreadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / 'timeline.jsonl').write_bytes(b'')

    def test_two_threads_updating_one_timeline_lose_and_duplicate_nothing(self):
        boundaries = 150
        lines = []

        def line(offset, kind, **fields):
            lines.append(json.dumps({'t': f'2026-10-31T09:{offset // 60 % 60:02d}:{offset % 60:02d}.000+07:00', 'type': kind, **fields}) + '\n')

        for seg in range(1, boundaries + 1):  # production layout: ticks, then speaker close+open, then mic close+open
            for channel in ('speaker', 'mic'):
                if seg == 1:
                    line(0, 'open', seg=1, channel=channel, rate=RATE, device='fake')
            for tick in range(3):
                for channel in ('speaker', 'mic'):
                    line(seg * 10 + tick, 'tick', seg=seg, channel=channel, samples=(tick + 1) * RATE)
            for channel in ('speaker', 'mic'):
                line(seg * 10 + 3, 'close', seg=seg, channel=channel, samples=3 * RATE)
                if seg < boundaries:
                    line(seg * 10 + 3, 'open', seg=seg + 1, channel=channel, rate=RATE, device='fake')
        shared = timeline_module.Timeline(self.dir)
        done = threading.Event()
        errors = []
        interval = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)  # switch threads between nearly every bytecode: the unlocked read/offset window shows up
        self.addCleanup(sys.setswitchinterval, interval)

        def reader():
            try:
                while not done.is_set():
                    shared.update()
            except Exception as exc:
                errors.append(exc)

        def writer():
            with open(self.dir / 'timeline.jsonl', 'ab') as file:
                for text in lines:
                    file.write(text.encode())
                    file.flush()
                    time.sleep(0)
            done.set()

        threads = [threading.Thread(target=reader) for _ in range(4)] + [threading.Thread(target=writer)]  # more readers than production: the race shows sooner
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        shared.update()
        self.assertEqual(errors, [])
        self.assertEqual(len(shared.events), len(lines))  # no line lost, none applied twice
        for channel in ('speaker', 'mic'):
            self.assertEqual([s.seg for s in shared.segments(channel)], list(range(1, boundaries + 1)))
            self.assertTrue(all(s.closed and s.declared == 3 * RATE for s in shared.segments(channel)))

    def test_an_open_after_an_end_clears_ended_and_reload_rebuilds_the_same_state(self):
        session = FakeSession(self.dir)
        session.segment(1, 'speaker', 0.0, [(1, 0)])
        session.end(1.0)
        shared = timeline_module.Timeline.load(self.dir)
        self.assertTrue(shared.ended)
        held = shared.segments('speaker')[0]
        session.segment(2, 'speaker', 1.0, [(1, 0)])
        shared.update()
        self.assertFalse(shared.ended)
        self.assertIsNone(shared.end_reason)
        shared._offset = 10 ** 9  # as if lines were skipped
        shared.reload()
        self.assertEqual([s.seg for s in shared.segments('speaker')], [1, 2])
        self.assertIs(shared.segments('speaker')[0], held)  # a reader's segment object stays the live one
        self.assertEqual(len(shared.events), len(timeline_module.read_events(self.dir)))
        self.assertIsNot(shared.segments('speaker'), shared.segments('speaker'))  # copies


class FollowerRotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.session = FakeSession(self.dir)
        self.missing = []

    def follower(self, shared, channel='speaker', **kwargs):
        return follow_source.ChannelFollower(shared, channel, sleep=lambda seconds: time.sleep(0.002), on_missing=lambda *args: self.missing.append(args), check_seconds=0.02, **kwargs)

    def test_segments_rotating_while_tailed_are_all_read_by_both_channels_sharing_one_timeline(self):
        session, count = self.session, 12

        def record():
            for seg in range(1, count + 1):
                if seg == 1:
                    session.begin(1, 'speaker', 0.0)
                    session.begin(1, 'mic', 0.0)
                for part in range(2):
                    at = (seg - 1) + 0.5 * (part + 1)
                    for channel in ('speaker', 'mic'):
                        session.add(seg, channel, session.wave(0.5, 0.2), at)
                    time.sleep(0.003)
                session.finish(seg, 'speaker', seg)
                if seg < count:
                    session.begin(seg + 1, 'speaker', seg)
                session.finish(seg, 'mic', seg)
                if seg < count:
                    session.begin(seg + 1, 'mic', seg)
            session.end(count)

        shared = timeline_module.Timeline(self.dir)
        followers = {name: self.follower(shared, name) for name in ('speaker', 'mic')}
        results, errors = {}, []

        def run(name):
            try:
                results[name] = drain(followers[name])
            except BaseException as exc:
                errors.append(exc)
        threads = [threading.Thread(target=run, args=(name,)) for name in followers] + [threading.Thread(target=record)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(errors, [])
        for name, follower in followers.items():
            total, ends = results[name]
            self.assertEqual(ends, count, name)
            self.assertAlmostEqual(total / RATE, count, delta=0.05)
            self.assertEqual([item[1].seg for item in follower.ranges], list(range(1, count + 1)), name)
        self.assertEqual(self.missing, [])

    def test_a_line_lost_on_the_way_is_recovered_from_the_disk(self):
        session = self.session
        session.segment(1, 'speaker', 0.0, [(1, 0.2)])
        shared = timeline_module.Timeline.load(self.dir)
        session.segment(2, 'speaker', 1.0, [(1, 0.2)])
        session.end(2.0)
        shared._offset = (self.dir / 'timeline.jsonl').stat().st_size  # the race: the offset went past lines nobody read
        follower = self.follower(shared)
        total, ends = drain(follower)
        self.assertEqual((ends, round(total / RATE, 2)), (2, 2.0))
        self.assertEqual([item[1].seg for item in follower.ranges], [1, 2])
        self.assertEqual(self.missing, [])

    def test_a_segment_whose_open_is_not_in_the_file_is_reported_and_reading_goes_on(self):
        session = self.session
        session.segment(1, 'speaker', 0.0, [(1, 0.2)])
        session.samples[(2, 'speaker')] = 0
        session.write_header(2, 'speaker')  # the WAV exists, its `open` line never reached the timeline
        session.add(2, 'speaker', session.wave(1, 0.2), 2.0)
        session.segment(3, 'speaker', 2.0, [(1, 0.2)])
        session.end(3.0)
        shared = timeline_module.Timeline.load(self.dir)
        follower = self.follower(shared)
        total, ends = drain(follower)
        self.assertEqual([item[1].seg for item in follower.ranges], [1, 3])
        self.assertAlmostEqual(total / RATE, 3.0, delta=0.05)  # the missing second is silence, on the same axis
        self.assertEqual(len(self.missing), 1)
        channel, segs, start, end = self.missing[0]
        self.assertEqual((channel, segs), ('speaker', [2]))
        self.assertAlmostEqual(start, timeline_module.parse_wall(session.iso(1.0)), delta=0.01)
        self.assertAlmostEqual(end, timeline_module.parse_wall(session.iso(2.0)), delta=0.01)

    def test_a_channel_that_starts_in_a_later_segment_is_no_loss(self):
        session = self.session
        session.segment(1, 'speaker', 0.0, [(1, 0.2)])
        session.segment(2, 'speaker', 1.0, [(1, 0.2)])
        session.segment(2, 'mic', 1.0, [(1, 0.2)])  # no seg-0001-mic anywhere
        session.end(2.0)
        total, _ = drain(self.follower(timeline_module.Timeline.load(self.dir), 'mic'))
        self.assertEqual(self.missing, [])
        self.assertAlmostEqual(total / RATE, 2.0, delta=0.05)

    def test_an_end_followed_by_a_new_open_is_not_the_end(self):
        session = self.session
        session.segment(1, 'speaker', 0.0, [(1, 0.2)])
        session.end(1.0)
        session.begin(2, 'speaker', 1.0)  # the recorder started again into the same folder
        session.add(2, 'speaker', session.wave(1, 0.2), 2.0)
        actions = [lambda: session.add(2, 'speaker', session.wave(1, 0.2), 3.0), lambda: (session.finish(2, 'speaker', 3.0), session.end(3.0))]

        def sleep(seconds):
            if actions:
                actions.pop(0)()
            time.sleep(0.002)
        follower = follow_source.ChannelFollower(timeline_module.Timeline.load(self.dir), 'speaker', sleep=sleep, check_seconds=0.02)
        total, ends = drain(follower)
        self.assertEqual(actions, [])  # EOF came only after the second end
        self.assertEqual(ends, 2)
        self.assertAlmostEqual(total / RATE, 3.0, delta=0.05)

    def test_status_names_the_state_the_segment_and_the_axis_position(self):
        session = self.session
        session.begin(1, 'speaker', 0.0)
        session.add(1, 'speaker', session.wave(1, 0.2), 1.0)
        follower = self.follower(timeline_module.Timeline.load(self.dir))
        while not follower.out and follower.state != 'reading':
            follower.read_block()
        status = follower.status()
        self.assertEqual((status['state'], status['seg']), ('reading', 1))
        self.assertGreater(status['axisSeconds'], 0)
        while follower.read_block() != b'':
            pass
        self.assertEqual(follower.status()['state'], 'waiting_audio')
        follower.mark_blocked('waiting_asr')
        self.assertEqual(follower.status()['state'], 'waiting_asr')
        follower.mark_blocked(None)
        follower.holding = lambda: True
        follower.read_block()
        self.assertEqual(follower.status()['state'], 'held')


if __name__ == '__main__':
    unittest.main()
