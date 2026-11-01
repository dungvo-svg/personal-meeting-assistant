"""label_mic_chunk / whole_on / split_points: pure functions, fake timeline, no device and no meeting."""
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


class ReaderAliveTests(unittest.TestCase):
    def at(self, seconds):
        return 1_800_000_000.0 + seconds

    def reading(self, seconds, state='on', by='mic_state.ps1'):
        return {'type': 'mic_state', 't': self.at(seconds), 'state': state, 'by': by}

    def test_steady_beats_through_the_chunk(self):
        states = [self.reading(s) for s in (0, 2, 4, 6, 8, 10, 12, 14, 16)]
        self.assertTrue(ms.reader_alive(states, self.at(5), self.at(15)))
        self.assertFalse(ms.reader_alive(states, self.at(5), self.at(16.5)), 'nothing read yet after the end: no evidence')

    def test_a_reader_that_stalls_without_exiting_is_not_alive(self):
        # last "on" at 4 s, then nothing (hung, not exited) while the audio goes on
        states = [self.reading(0), self.reading(2)]
        self.assertTrue(ms.reader_alive(states, self.at(0.5), self.at(2)))
        self.assertFalse(ms.reader_alive(states, self.at(1), self.at(4)), 'short chunk, last ON at its start, then the reader hangs')
        self.assertFalse(ms.reader_alive(states, self.at(8), self.at(12)))
        self.assertFalse(ms.reader_alive(states, self.at(30), self.at(33)))
        self.assertTrue(ms.whole_on(states, self.at(30), self.at(33)))  # the label alone would still say on

    def test_a_gap_inside_the_chunk_is_not_alive(self):
        states = [self.reading(0), self.reading(2), self.reading(8), self.reading(12)]
        self.assertFalse(ms.reader_alive(states, self.at(1), self.at(11)))

    def test_no_reading_at_or_before_the_start(self):
        self.assertFalse(ms.reader_alive([self.reading(3), self.reading(6)], self.at(1), self.at(7)))
        self.assertFalse(ms.reader_alive([], self.at(1), self.at(2)))

    def test_manual_entries_are_not_a_sign_of_life(self):
        states = [self.reading(0), self.reading(5, by='manual'), self.reading(9, by='manual')]
        self.assertFalse(ms.reader_alive(states, self.at(1), self.at(8)))


class WholeOnTests(unittest.TestCase):
    def test_on_for_the_whole_chunk(self):
        states = [reading(0, 'on')]
        self.assertTrue(ms.whole_on(states, BASE + 10, BASE + 20))
        self.assertTrue(ms.whole_on(states, BASE, BASE + 20))  # a reading exactly at the start counts

    def test_on_then_off_inside_the_chunk_is_not_whole_even_when_on_is_the_majority(self):
        states = [reading(0, 'on'), reading(17, 'off')]  # chunk 10..20: 7 s on, 3 s off
        self.assertEqual(ms.label_mic_chunk(states, BASE + 10, BASE + 20), ms.MIC_STATE_ON)  # majority label for RAW stays
        self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20))

    def test_on_then_unknown_inside_the_chunk_is_not_whole(self):
        states = [reading(0, 'on'), reading(17, 'unknown')]
        self.assertEqual(ms.label_mic_chunk(states, BASE + 10, BASE + 20), ms.MIC_STATE_ON)
        self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20))

    def test_a_transition_under_one_second_is_not_absorbed(self):
        for state in ('off', 'unknown', 'none'):
            states = [reading(0, 'on'), reading(19.5, state)]  # 0.5 s tail; split_points would absorb it
            self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20), state)
            states = [reading(0, 'on'), reading(10.3, state)]  # 0.3 s of off right after the start, then reading ends the chunk
            self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20), state)
        flicker = [reading(0, 'on'), reading(15, 'off'), reading(15.4, 'on')]  # an 0.4 s OFF flicker in the middle
        self.assertEqual(ms.split_points(flicker, BASE + 10, BASE + 20), [])
        self.assertFalse(ms.whole_on(flicker, BASE + 10, BASE + 20))

    def test_off_then_back_on_is_not_whole(self):
        states = [reading(0, 'off'), reading(12, 'on')]
        self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20))
        self.assertTrue(ms.whole_on(states, BASE + 12, BASE + 20))

    def test_a_tie_is_unknown_and_not_whole(self):
        states = [reading(0, 'on'), reading(5, 'off')]
        self.assertEqual(ms.label_mic_chunk(states, BASE, BASE + 10), ms.MIC_STATE_UNKNOWN)
        self.assertFalse(ms.whole_on(states, BASE, BASE + 10))

    def test_manual_off_inside_an_automatic_on_stretch(self):
        states = [reading(0, 'on'), reading(15, 'off', by='manual')]
        self.assertFalse(ms.whole_on(states, BASE + 10, BASE + 20))
        self.assertTrue(ms.whole_on(states, BASE + 10, BASE + 14))
        self.assertFalse(ms.whole_on(states, BASE + 16, BASE + 20))

    def test_manual_off_wins_over_automatic_on_until_released(self):
        states = [reading(0, 'on'), reading(5, 'off', by='manual'), reading(10, 'on'), reading(30, 'unknown', by='manual', release=True)]
        self.assertFalse(ms.whole_on(states, BASE + 12, BASE + 18))  # the automatic on does not override the manual off
        self.assertTrue(ms.whole_on(states, BASE + 31, BASE + 40))  # released: the reader's latest reading (on)
        self.assertFalse(ms.whole_on(states, BASE + 25, BASE + 35))  # the release happens inside: manual off before it

    def test_manual_on_wins_over_automatic_off(self):
        states = [reading(0, 'off'), reading(5, 'on', by='manual'), reading(10, 'off')]
        self.assertTrue(ms.whole_on(states, BASE + 6, BASE + 20))

    def test_chunk_beginning_before_the_first_reading_is_not_whole(self):
        states = [reading(10, 'on')]
        self.assertFalse(ms.whole_on(states, BASE + 8, BASE + 20))  # unknown before the first reading
        self.assertTrue(ms.whole_on(states, BASE + 10, BASE + 20))
        self.assertFalse(ms.whole_on(states, BASE, BASE + 5))
        self.assertFalse(ms.whole_on([], BASE, BASE + 5))

    def test_no_meeting_app_holding_the_mic_is_not_whole(self):
        self.assertFalse(ms.whole_on([reading(0, 'none')], BASE, BASE + 5))
        self.assertFalse(ms.whole_on([reading(0, 'on'), reading(2, 'none')], BASE, BASE + 5))
        self.assertFalse(ms.whole_on([reading(0, 'unknown')], BASE, BASE + 5))

    def test_zero_length_chunk_is_the_state_at_that_instant(self):
        states = [reading(0, 'on'), reading(10, 'off')]
        self.assertTrue(ms.whole_on(states, BASE + 5, BASE + 5))
        self.assertFalse(ms.whole_on(states, BASE + 12, BASE + 12))
        self.assertFalse(ms.whole_on([], BASE, BASE))

    def test_the_span_may_be_given_reversed_or_as_iso_strings(self):
        states = [reading(0, 'on')]
        self.assertTrue(ms.whole_on(states, BASE + 20, BASE + 10))
        self.assertTrue(ms.whole_on(states, datetime.fromtimestamp(BASE + 1, timezone.utc).isoformat(), BASE + 3))


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
