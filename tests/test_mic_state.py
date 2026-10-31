"""label_mic_chunk / split_points: pure functions, fake timeline, no device and no meeting."""
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import mic_state as ms  # noqa: E402

BASE = datetime(2026, 10, 31, 6, 30, 0, tzinfo=timezone.utc).timestamp()


def reading(second, state, by='uia', **extra):
    return {'t': datetime.fromtimestamp(BASE + second, timezone.utc).isoformat(), 'type': 'mic_state', 'state': state, 'app': 'zoom', 'by': by, **extra}


class LabelTests(unittest.TestCase):
    def test_whole_chunk_in_one_state(self):
        states = [reading(0, 'on')]
        self.assertEqual(ms.label_mic_chunk(states, BASE + 10, BASE + 20), ms.MIC_STATE_ON)
        self.assertEqual(ms.label_mic_chunk([reading(0, 'off')], BASE + 10, BASE + 20), ms.MIC_STATE_OFF)

    def test_majority_of_time_decides(self):
        states = [reading(0, 'on'), reading(12, 'off')]  # chunk 10..20: 2 s on, 8 s off
        self.assertEqual(ms.label_mic_chunk(states, BASE + 10, BASE + 20), ms.MIC_STATE_OFF)
        self.assertEqual(ms.label_mic_chunk(states, BASE + 2, BASE + 14), ms.MIC_STATE_ON)  # 10 s on, 2 s off

    def test_no_reading_or_unknown_is_unknown(self):
        self.assertEqual(ms.label_mic_chunk([], BASE, BASE + 5), ms.MIC_STATE_UNKNOWN)
        self.assertEqual(ms.label_mic_chunk([reading(0, 'unknown')], BASE, BASE + 5), ms.MIC_STATE_UNKNOWN)
        self.assertEqual(ms.label_mic_chunk([reading(100, 'on')], BASE, BASE + 5), ms.MIC_STATE_UNKNOWN)  # first reading is later

    def test_tie_is_unknown(self):
        states = [reading(0, 'on'), reading(5, 'off')]
        self.assertEqual(ms.label_mic_chunk(states, BASE, BASE + 10), ms.MIC_STATE_UNKNOWN)

    def test_no_app_holding_the_mic_counts_as_off(self):
        self.assertEqual(ms.label_mic_chunk([reading(0, 'none')], BASE, BASE + 5), ms.MIC_STATE_OFF)

    def test_manual_override_wins_until_released(self):
        states = [reading(0, 'unknown'), reading(10, 'on', by='manual'), reading(20, 'off'), reading(30, 'unknown', by='manual', release=True)]
        self.assertEqual(ms.label_mic_chunk(states, BASE + 12, BASE + 18), ms.MIC_STATE_ON)
        self.assertEqual(ms.label_mic_chunk(states, BASE + 21, BASE + 29), ms.MIC_STATE_ON)  # the automatic off did not override
        self.assertEqual(ms.label_mic_chunk(states, BASE + 31, BASE + 40), ms.MIC_STATE_OFF)  # released: the reader's latest reading

    def test_other_timeline_lines_and_junk_are_ignored(self):
        states = [{'t': 'x', 'type': 'tick'}, {'type': 'mic_state', 'state': 'on'}, 'junk', reading(0, 'on')]
        self.assertEqual(ms.label_mic_chunk(states, BASE + 1, BASE + 3), ms.MIC_STATE_ON)

    def test_accepts_iso_strings_datetimes_and_epoch_for_the_span(self):
        states = [reading(0, 'on')]
        start = datetime.fromtimestamp(BASE + 1, timezone.utc)
        self.assertEqual(ms.label_mic_chunk(states, start, (BASE + 3)), ms.MIC_STATE_ON)
        self.assertEqual(ms.label_mic_chunk(states, start.isoformat().replace('+00:00', 'Z'), start.isoformat()), ms.MIC_STATE_ON)  # zero length


class SplitTests(unittest.TestCase):
    def test_cut_at_each_label_change(self):
        states = [reading(0, 'on'), reading(30, 'off'), reading(50, 'on')]
        self.assertEqual(ms.split_points(states, BASE + 10, BASE + 60), [BASE + 30, BASE + 50])

    def test_no_cut_when_the_label_does_not_change(self):
        states = [reading(0, 'off'), reading(20, 'none'), reading(30, 'off')]  # all MIC_STATE_OFF
        self.assertEqual(ms.split_points(states, BASE + 5, BASE + 40), [])
        self.assertEqual(ms.split_points([], BASE, BASE + 10), [])

    def test_changes_outside_the_chunk_give_no_cut(self):
        states = [reading(0, 'on'), reading(100, 'off')]
        self.assertEqual(ms.split_points(states, BASE + 10, BASE + 20), [])

    def test_a_flicker_shorter_than_min_segment_is_absorbed(self):
        states = [reading(0, 'on'), reading(30, 'off'), reading(30.4, 'on')]
        self.assertEqual(ms.split_points(states, BASE + 10, BASE + 60), [])
        self.assertEqual(ms.split_points(states, BASE + 10, BASE + 60, min_segment=0.1), [BASE + 30, BASE + 30.4])


if __name__ == '__main__':
    unittest.main()
