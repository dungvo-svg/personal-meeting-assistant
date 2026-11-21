"""Lao news stock phrases invented by BuzzASR on short chunks (21/11) are flagged as invented; real Lao is not."""
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import audio_worker  # noqa: E402


def seg(text, logprob):
    return types.SimpleNamespace(text=text, avg_logprob=logprob, no_speech_prob=0.1, compression_ratio=1.2)


class LaoStock(unittest.TestCase):
    def test_a_news_opener_at_low_confidence_is_invented(self):
        text = 'ທ່ານກ່າວວ່າ “ຂ້າພະເຈົ້າໄດ້ຮັບຜົນກະທົບຕໍ່ຕ້ານຂໍ້ມູນທີ່ສໍາຄັນຂອງພວກເຮົາ.”'
        self.assertIn('LIKELY_HALLUCINATION', audio_worker.segment_flags(text, seg(text, -0.72), 'lo'))

    def test_real_lao_and_confident_readings_are_kept(self):
        real = 'ລາຄາຖືກ ແຕ່ວ່າຄຸນນະພາບພໍໃຊ້ ເພິ່ນເລືອກສອງແບບນີ້ເວລາປະເມີນ'
        self.assertNotIn('LIKELY_HALLUCINATION', audio_worker.segment_flags(real, seg(real, -0.32), 'lo'))
        said = 'ທ່ານກ່າວວ່າ ລາຄາຖືກ'
        self.assertNotIn('LIKELY_HALLUCINATION', audio_worker.segment_flags(said, seg(said, -0.3), 'lo'))

    def test_only_lao_segments_are_judged_this_way(self):
        text = 'ທ່ານກ່າວວ່າ'
        self.assertFalse(audio_worker.lao_stock_phrase('Kho số hai đủ hàng', seg('Kho số hai đủ hàng', -0.9)))
        self.assertTrue(audio_worker.lao_stock_phrase(text, seg(text, -0.8)))


if __name__ == '__main__':
    unittest.main()
