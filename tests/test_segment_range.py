"""SEG_RANGE: each sentence's place inside its chunk from Whisper's segment times (21/11), clamped to the chunk."""
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from audio_worker import segment_range  # noqa: E402


def seg(start, end):
    return types.SimpleNamespace(start=start, end=end)


class SegmentRange(unittest.TestCase):
    def test_inside(self):
        self.assertEqual(segment_range(seg(6.0, 10.5), 19.27), '; SEG_RANGE 6.00-10.50')

    def test_clamped_to_chunk(self):
        self.assertEqual(segment_range(seg(-0.2, 25), 19.27), '; SEG_RANGE 0.00-19.27')

    def test_unusable(self):
        self.assertEqual(segment_range(seg(5, 5), 10), '')
        self.assertEqual(segment_range(types.SimpleNamespace(text='x'), 10), '')
        self.assertEqual(segment_range(seg(None, 3), 10), '')


if __name__ == '__main__':
    unittest.main()
