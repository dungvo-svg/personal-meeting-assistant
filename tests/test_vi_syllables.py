"""Vietnamese syllable validity by rule (tools/vi_syllables.py): the list is generated, not copied; scores come with numerator and denominator."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import vi_syllables as vi


class SyllableRuleTests(unittest.TestCase):
    def test_ordinary_syllables_with_every_tone_position_are_valid(self):
        for word in ('mục', 'nông', 'không', 'được', 'nhưng', 'quốc', 'khuya', 'yêu', 'gì', 'giữ', 'ngoài', 'hoàn', 'xuyên', 'thuyết', 'nghiên', 'kiên', 'kỹ',
                     'của', 'mưa', 'người', 'nước', 'quý', 'hòa', 'hoà', 'tuần', 'chuyện', 'nghĩ', 'ghế', 'kể', 'cá', 'tiếng', 'việc', 'Việt', 'ĐƯỢC'):
            self.assertTrue(vi.is_syllable(word), word)

    def test_spelling_rules_reject_wrong_pairs_and_stop_codas_take_two_tones_only(self):
        for word in ('cê', 'kae', 'ghan', 'ngha', 'gha', 'nge', 'cươ', 'bc', 'dng', 'crowd', 'xyz', 'ຍັງ'):
            self.assertFalse(vi.is_syllable(word), word)
        self.assertTrue(vi.is_syllable('học') and vi.is_syllable('hóc'))
        self.assertFalse(vi.is_syllable('hòc'))  # a stop coda never takes the falling tone
        self.assertFalse(vi.is_syllable('hỏc'))

    def test_generated_list_has_a_version_and_is_in_a_plausible_range(self):
        self.assertTrue(vi.VERSION.startswith('vi-syl-rule-'))
        self.assertTrue(10000 < len(vi.SYLLABLES) < 30000)

    def test_input_is_normalised_so_decomposed_marks_count(self):
        import unicodedata
        self.assertTrue(vi.is_syllable(unicodedata.normalize('NFD', 'không')))


class ShareTests(unittest.TestCase):
    def test_numerator_and_denominator_are_both_kept(self):
        result = vi.share('Kho số hai còn đủ hàng cho đơn tuần sau')
        self.assertEqual((result['viSyllables'], result['viTokens'], result['viSyllableShare']), (10, 10, 1.0))
        self.assertEqual(result['viSyllableVersion'], vi.VERSION)

    def test_numbers_abbreviations_and_names_stay_out_of_the_denominator(self):
        result = vi.share('ABC giao được 3 đơn rồi, anh Sunisa nói 120,000 khách')
        self.assertEqual((result['viSyllables'], result['viTokens']), (7, 7))
        self.assertEqual(result['viSyllableShare'], 1.0)

    def test_an_unknown_lowercase_word_counts_against_but_a_capitalised_name_do_not(self):
        result = vi.share('crowd Cloudy xyz và nó')
        self.assertEqual((result['viSyllables'], result['viTokens']), (2, 4))

    def test_lao_script_is_all_non_syllable_and_too_short_is_none(self):
        lao = vi.share('ສະບາຍດີ ທຸກຄົນ 120,000 ຂອບໃຈ ຫຼາຍໆ')
        self.assertEqual((lao['viSyllables'], lao['viSyllableShare']), (0, 0.0))
        short = vi.share('Dạ vâng')
        self.assertEqual((short['viTokens'], short['viSyllableShare']), (2, None))
        self.assertIsNone(vi.share('')['viSyllableShare'])


if __name__ == '__main__':
    unittest.main()
