"""tools/bot_speaker_join.py: names from the meeting bot's transcript joined onto PMA lines by time. Synthetic data only."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
import bot_speaker_join as bot

ZONE = '+07:00'
DAY = '2026-11-23'


def at(clock):
    return f'{DAY}T{clock}{ZONE}'


def turns(*entries):
    return bot.load_turns([{'start': at(s), **({'end': at(e)} if e else {}), 'speaker': who, 'text': text} for s, e, who, text in entries], None)


def item(id, clock, seconds, text, boundary='SOURCE_LIVE_FOLLOW', language='vi'):
    # wall as pma writes it (UTC, 3 fraction digits, Z); the chunk range is start..start+seconds
    moment = datetime.fromisoformat(at(clock)).astimezone(bot.parse_time('2026-01-01T00:00:00+00:00').tzinfo)
    return {'id': id, 'wall': moment.strftime('%Y-%m-%dT%H:%M:%S.000Z'), 'start': 0, 'end': seconds, 'text': text, 'language': language, 'boundary': boundary}


def who(rows, id):
    return next((w, r) for i, w, r, _ in rows if i['id'] == id)


class TimeTests(unittest.TestCase):
    def test_iso_with_offset_and_seven_fraction_digits(self):
        a = bot.parse_time('2026-11-23T14:05:12.1234567+07:00')
        self.assertEqual(a.utcoffset(), timedelta(hours=7))
        self.assertEqual((a.hour, a.minute, a.second), (14, 5, 12))
        self.assertEqual(bot.parse_time('2026-11-23T07:05:12Z'), bot.parse_time('2026-11-23T14:05:12+07:00'))

    def test_clock_only_uses_the_day_of_the_pma_lines_in_local_time(self):
        day = datetime(2026, 11, 23).date()
        moment = bot.parse_time('08:48:28', day)
        self.assertEqual((moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second), (2026, 11, 23, 8, 48, 28))
        self.assertEqual(moment.utcoffset(), datetime(2026, 11, 23, 12).astimezone().utcoffset())
        with self.assertRaises(ValueError):
            bot.parse_time('08:48:28')

    def test_a_turn_without_an_end_lasts_until_the_next_start_but_never_longer_than_the_cap(self):
        made = turns(('14:00:00', None, 'A', 'x'), ('14:00:10', None, 'B', 'y'), ('14:05:00', None, 'A', 'z'))
        self.assertEqual((made[0][1] - made[0][0]).total_seconds(), 10)
        self.assertEqual((made[2][1] - made[2][0]).total_seconds(), bot.MAX_TURN_SECONDS)
        self.assertEqual((made[1][1] - made[1][0]).total_seconds(), bot.MAX_TURN_SECONDS)

    def test_entries_without_a_speaker_or_start_are_dropped(self):
        self.assertEqual(bot.load_turns([{'start': at('14:00:00'), 'text': 'x'}, {'speaker': 'A'}, {'start': '', 'speaker': 'A'}], None), [])


class JoinTests(unittest.TestCase):
    def test_the_speaker_of_the_overlapping_turn_is_named_with_the_rule(self):
        made = turns(('14:00:00', '14:00:10', 'Sơn', 'chữ bot không dùng'))
        rows = bot.join([item(1, '14:00:02', 4, 'lời của PMA')], made)
        self.assertEqual(who(rows, 1), ('Sơn', 'bot: trùng giờ'))
        self.assertEqual(rows[0][0]['text'], 'lời của PMA')    # the words are PMA's, the bot only names

    def test_the_microphone_stays_the_owner_whatever_the_bot_says(self):
        made = turns(('14:00:00', '14:00:10', 'Sơn', 'x'))
        rows = bot.join([item(1, '14:00:02', 4, 'tôi nói', 'CHANNEL_MIC; MIC_STATE_ON')], made)
        self.assertEqual(who(rows, 1), ('Tôi', 'micro'))

    def test_leaked_speaker_sound_is_not_the_owner_and_not_named(self):
        made = turns(('14:00:00', '14:00:10', 'Sơn', 'x'))
        rows = bot.join([item(1, '14:00:02', 4, 'tiếng loa', 'CHANNEL_MIC; MIC_STATE_OFF; MIC_BLEED #7 TEXT')], made)
        self.assertEqual(who(rows, 1)[0], 'loa lọt mic')

    def test_when_one_speaker_holds_most_of_the_line_it_wins(self):
        made = turns(('14:00:00', '14:00:08', 'A', 'x'), ('14:00:08', '14:00:10', 'B', 'y'))
        who1 = who(bot.join([item(1, '14:00:00', 10, 'câu dài')], made), 1)
        self.assertEqual(who1[0], 'A')
        self.assertIn('80%', who1[1])

    def test_an_even_split_is_decided_by_the_closer_words_when_clearly_closer(self):
        made = turns(('14:00:00', '14:00:05', 'A', 'chúng ta chốt báo giá gói thầu thuốc'), ('14:00:05', '14:00:10', 'B', 'hôm nay trời đẹp quá'))
        who1 = who(bot.join([item(1, '14:00:00', 10, 'chốt báo giá gói thầu')], made), 1)
        self.assertEqual(who1[0], 'A')
        self.assertIn('chữ giống nhất', who1[1])

    def test_an_even_split_with_no_clear_words_names_both_in_time_order(self):
        made = turns(('14:00:00', '14:00:05', 'A', 'abc def'), ('14:00:05', '14:00:10', 'B', 'abc def'))
        who1 = who(bot.join([item(1, '14:00:00', 10, 'abc def')], made), 1)
        self.assertEqual(who1[0], 'A/B')
        self.assertIn('không phân được', who1[1])

    def test_a_turn_just_outside_the_line_names_it_as_near_but_far_ones_do_not(self):
        made = turns(('14:00:00', '14:00:10', 'Sơn', 'x'))
        near = who(bot.join([item(1, '14:00:11', 3, 'lời')], made), 1)
        self.assertEqual(near[0], 'Sơn'); self.assertIn('gần giờ', near[1])
        far = who(bot.join([item(2, '14:00:20', 3, 'lời')], made), 2)
        self.assertEqual(far[0], '?'); self.assertIn('không có lượt nói', far[1])
        self.assertEqual(who(bot.join([item(3, '14:00:20', 3, 'lời')], made, near=15), 3)[0], 'Sơn')

    def test_no_turns_at_all_is_a_question_mark_never_a_guess(self):
        self.assertEqual(who(bot.join([item(1, '14:00:00', 3, 'lời')], []), 1)[0], '?')

    def test_system_text_and_ghost_lines_are_left_out(self):
        rows = bot.join([item(1, '14:00:00', 3, '[KHOẢNG TRỐNG ASR] 3 giây'), item(2, '14:00:00', 3, 'cảm ơn đã theo dõi', 'LIKELY_HALLUCINATION'), item(3, '14:00:00', 3, 'thật')], turns(('14:00:00', '14:00:10', 'A', 'x')))
        self.assertEqual([i['id'] for i, *_ in rows], [3])

    def test_lines_cut_from_one_chunk_are_placed_by_text_length_and_say_it_is_an_estimate(self):
        made = turns(('14:00:00', '14:00:04', 'A', 'x'), ('14:00:04', '14:00:08', 'B', 'y'))
        first, second = item(1, '14:00:00', 8, 'aaaa aaaa'), item(2, '14:00:00', 8, 'bbbb bbbb')
        rows = bot.join([first, second], made)
        self.assertEqual((who(rows, 1)[0], who(rows, 2)[0]), ('A', 'B'))
        self.assertIn('ước theo độ dài câu', who(rows, 1)[1])

    def test_shift_moves_the_bot_clock(self):
        entries = [{'start': at('14:00:00'), 'end': at('14:00:05'), 'speaker': 'A', 'text': 'x'}]
        late = bot.load_turns(entries, None, shift=20)
        self.assertEqual(who(bot.join([item(1, '14:00:21', 3, 'lời')], late), 1)[0], 'A')

    def test_similarity(self):
        self.assertAlmostEqual(bot.similarity('Chốt báo giá!', 'chốt báo giá'), 1.0)
        self.assertEqual(bot.similarity('', 'abc'), 0.0)
        self.assertLess(bot.similarity('hôm nay trời đẹp', 'chốt báo giá thầu'), 0.2)
        self.assertGreater(bot.similarity('ສະບາຍດີທຸກຄົນ', 'ສະບາຍດີທຸກຄົນ'), 0.99)   # no spaces: still compared


class CommandLineTests(unittest.TestCase):
    def test_json_output_from_files_without_running_pma(self):
        with tempfile.TemporaryDirectory() as directory:
            rows = Path(directory) / 'rows.json'; transcript = Path(directory) / 'bot.json'
            rows.write_text(json.dumps({'items': [item(1, '14:00:02', 4, 'lời PMA'), item(2, '14:00:30', 3, 'xa', 'CHANNEL_MIC; MIC_STATE_ON')]}), encoding='utf-8')
            transcript.write_text(json.dumps([{'start': at('14:00:00'), 'end': at('14:00:10'), 'speaker': 'Sơn', 'text': 'x'}]), encoding='utf-8')
            run = subprocess.run([sys.executable, '-I', str(TOOLS / 'bot_speaker_join.py'), str(transcript), '--rows', str(rows), '--json'], capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(run.returncode, 0, run.stderr)
            out = json.loads(run.stdout)
            self.assertEqual([(o['id'], o['speaker']) for o in out], [(1, 'Sơn'), (2, 'Tôi')])


if __name__ == '__main__':
    unittest.main()
