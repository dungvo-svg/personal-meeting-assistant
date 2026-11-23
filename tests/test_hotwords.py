"""Item 8: the name table reaches the recogniser as hotwords. Fake models only: no audio device, no ASR, no GPU."""
import json
import os
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_worker
from test_readings import FakeModel


class RecordingModel(FakeModel):
    seen = []  # (model, language, hotwords) of every call

    def transcribe(self, audio, language=None, **options):
        RecordingModel.seen.append((self.name, language, options.get('hotwords')))
        return super().transcribe(audio, language=language, **options)


def write(path, vi='', lo=''):
    path.write_text(json.dumps({'v': 1, 'vi': vi, 'lo': lo}, ensure_ascii=False), encoding='utf-8')


class HotwordsFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'hotwords.json'
        self.addCleanup(self.tmp.cleanup)
        self.old = audio_worker.HOTWORDS
        self.addCleanup(setattr, audio_worker, 'HOTWORDS', self.old)

    def test_no_file_no_path_or_an_unreadable_file_means_no_hotwords_and_the_options_are_as_before(self):
        audio_worker.HOTWORDS = audio_worker.Hotwords(self.path)  # file not there
        self.assertNotIn('hotwords', audio_worker.decode_options(object(), 8, 'vi'))
        self.path.write_text('{not json', encoding='utf-8')
        self.assertNotIn('hotwords', audio_worker.decode_options(object(), 8, 'vi'))
        audio_worker.HOTWORDS = audio_worker.Hotwords(None)
        self.assertNotIn('hotwords', audio_worker.decode_options(object(), 8, 'lo'))

    def test_each_language_gets_its_own_terms_and_an_unknown_language_gets_none(self):
        write(self.path, vi='Namfon, Claude, OKR', lo='ຄຳຟອນ')
        audio_worker.HOTWORDS = audio_worker.Hotwords(self.path)
        self.assertEqual(audio_worker.decode_options(object(), 8, 'vi')['hotwords'], 'Namfon, Claude, OKR')
        self.assertEqual(audio_worker.decode_options(object(), 8, 'lo')['hotwords'], 'ຄຳຟອນ')
        self.assertNotIn('hotwords', audio_worker.decode_options(object(), 8, None))  # language detection
        self.assertNotIn('hotwords', audio_worker.decode_options(object(), 8, 'th'))

    def test_a_name_added_in_the_middle_of_a_meeting_is_used_from_the_next_chunk(self):
        write(self.path, vi='Namfon')
        audio_worker.HOTWORDS = audio_worker.Hotwords(self.path)
        self.assertEqual(audio_worker.decode_options(object(), 8, 'vi')['hotwords'], 'Namfon')
        write(self.path, vi='Namfon, Khamla')
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10_000_000))  # a file system with a coarse clock
        self.assertEqual(audio_worker.decode_options(object(), 8, 'vi')['hotwords'], 'Namfon, Khamla')

    def test_the_prompt_is_cut_at_the_cap(self):
        write(self.path, vi=' '.join(['Tên'] * 400))
        audio_worker.HOTWORDS = audio_worker.Hotwords(self.path)
        self.assertLessEqual(len(audio_worker.decode_options(object(), 8, 'vi')['hotwords']), audio_worker.HOTWORDS_MAX_CHARS)

    def test_the_default_file_is_next_to_the_recorders_files_for_follow_and_recheck_and_explicit_for_capture(self):
        self.assertEqual(audio_worker.hotwords_for(Namespace(follow='D:/a', recheck=None, hotwords_file=None)).path, Path('D:/a') / 'hotwords.json')
        self.assertEqual(audio_worker.hotwords_for(Namespace(follow=None, recheck='D:/b', hotwords_file=None)).path, Path('D:/b') / 'hotwords.json')
        self.assertEqual(audio_worker.hotwords_for(Namespace(follow=None, recheck=None, hotwords_file='D:/c/h.json')).path, Path('D:/c/h.json'))
        self.assertIsNone(audio_worker.hotwords_for(Namespace(follow=None, recheck=None, hotwords_file=None)).path)


class HotwordsReachTheDecoderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'hotwords.json'
        self.old = audio_worker.HOTWORDS
        self.addCleanup(setattr, audio_worker, 'HOTWORDS', self.old)

    def test_both_readings_are_decoded_with_the_terms_of_their_own_language(self):
        write(self.path, vi='Namfon, Claude', lo='ຄຳຟອນ')
        audio_worker.HOTWORDS = audio_worker.Hotwords(self.path)
        log = []
        RecordingModel.seen = []
        vi = RecordingModel('vi', log, 'kho số hai còn đủ hàng cho đơn tuần sau', -0.4)
        lo = RecordingModel('lo', log, 'ສະບາຍດີ ທຸກຄົນ', -0.4)
        audio_worker.transcribe_readings(vi, None, lo, None, model_names={'vi': 'v', 'lo': 'l'})
        self.assertEqual(RecordingModel.seen, [('vi', 'vi', 'Namfon, Claude'), ('lo', 'lo', 'ຄຳຟອນ')])

    def test_without_a_file_the_decoder_is_called_exactly_as_before(self):
        audio_worker.HOTWORDS = audio_worker.Hotwords(None)
        log = []
        RecordingModel.seen = []
        vi = RecordingModel('vi', log, 'kho số hai còn đủ hàng cho đơn tuần sau', -0.4)
        lo = RecordingModel('lo', log, 'ສະບາຍດີ ທຸກຄົນ', -0.4)
        audio_worker.transcribe_readings(vi, None, lo, None, model_names={})
        self.assertEqual(RecordingModel.seen, [('vi', 'vi', None), ('lo', 'lo', None)])


if __name__ == '__main__':
    unittest.main()
