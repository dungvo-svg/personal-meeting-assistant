"""Item 1a: two readings (Vietnamese and Lao) per chunk. Fake models only: no audio device, no ASR, no GPU."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_worker
from test_audio_worker import FakeSession, FakeStdin


def segment(text, logprob=-0.4, no_speech=0.1, tokens=10):
    return type('Segment', (), {'text': text, 'avg_logprob': logprob, 'no_speech_prob': no_speech, 'compression_ratio': 1.2, 'tokens': list(range(tokens)), 'start': 0.0, 'end': 2.0})()


def reading(code, text, logprob, status='ok'):
    return {'rv': 1, 'language': code, 'model': code + '-model', 'text': text, 'avgLogProb': logprob, 'score': logprob, 'status': status, 'picked': False}


class ReadingSignalTests(unittest.TestCase):
    def test_a_reading_carries_its_own_signals_and_the_rule_version(self):
        item = audio_worker.build_reading('vi', 'turbo', [segment('Kho số hai còn đủ hàng cho đơn tuần sau', -0.5)])
        self.assertEqual((item['rv'], item['language'], item['model'], item['status'], item['picked']), (1, 'vi', 'turbo', 'ok', False))
        self.assertEqual((item['avgLogProb'], item['score']), (-0.5, -0.5))
        self.assertEqual((item['viSyllables'], item['viTokens'], item['viSyllableShare']), (10, 10, 1.0))
        self.assertTrue(item['viSyllableVersion'].startswith('vi-syl-rule-'))
        self.assertEqual(item['loopPenalty'], 0.0)

    def test_a_lao_reading_has_no_vietnamese_syllables_and_a_short_one_has_no_share(self):
        lao = audio_worker.build_reading('lo', 'buzz', [segment('ສະບາຍດີ ທຸກຄົນ 120,000 ຂອບໃຈ ຫຼາຍໆ')])
        self.assertEqual((lao['viSyllables'], lao['viSyllableShare']), (0, 0.0))
        short = audio_worker.build_reading('vi', 'turbo', [segment('Dạ vâng')])
        self.assertIsNone(short['viSyllableShare'])
        self.assertEqual(short['viTokens'], 2)

    def test_status_empty_invented_and_ok(self):
        self.assertEqual(audio_worker.build_reading('vi', 'm', [])['status'], 'empty')
        self.assertIsNone(audio_worker.build_reading('vi', 'm', [])['avgLogProb'])
        self.assertEqual(audio_worker.build_reading('vi', 'm', [segment('Hãy subscribe cho kênh Ghiền Mì Gõ')])['status'], 'invented')
        self.assertEqual(audio_worker.build_reading('lo', 'm', [segment('ທ່ານກ່າວວ່າການເລືອກຕັ້ງ', -0.7)])['status'], 'invented')  # Lao news stock phrase at low confidence
        self.assertEqual(audio_worker.build_reading('vi', 'm', [segment('Hãy subscribe cho kênh', -0.2), segment('Kho số hai đủ hàng.')])['status'], 'ok')  # one real sentence keeps it ok

    def test_loop_penalty_counts_characters_in_runs_including_unspaced_scripts(self):
        self.assertEqual(audio_worker.loop_penalty('Kho số hai đủ hàng'), 0.0)
        self.assertEqual(audio_worker.loop_penalty(''), 0.0)
        self.assertGreater(audio_worker.loop_penalty('ຄົນຄົນຄົນຄົນຄົນຄົນຄົນຄົນ'), 0.8)
        self.assertGreater(audio_worker.loop_penalty('x ' + 'dạ ' * 12), 0.5)
        self.assertLess(audio_worker.loop_penalty('dạ dạ ơi'), 0.01)


class PickTests(unittest.TestCase):
    def pick(self, vi_lp, lo_lp, vi_status='ok', lo_status='ok'):
        return audio_worker.pick_reading(reading('vi', 'v', vi_lp, vi_status), reading('lo', 'l', lo_lp, lo_status))

    def test_vietnamese_stays_the_text_when_the_lao_model_is_no_better(self):
        self.assertEqual(self.pick(-0.3, -0.6), ('vi', True))
        self.assertEqual(self.pick(-0.4, -0.4), ('vi', True))
        self.assertEqual(self.pick(-0.5, -0.386), ('vi', False))  # Lao ahead by 0.114 (the most it ever was on Vietnamese speech): still Vietnamese, but not clear

    def test_lao_wins_from_the_measured_margin_and_is_clear_further_up(self):
        self.assertEqual(self.pick(-0.7, -0.5), ('lo', False))  # +0.2
        self.assertEqual(self.pick(-0.8, -0.4), ('lo', True))  # +0.4
        self.assertEqual(self.pick(-0.6, -0.44), ('lo', False))  # +0.16, just over the margin

    def test_an_invented_vietnamese_reading_does_not_compete(self):
        self.assertEqual(self.pick(-0.1, -0.3, vi_status='invented'), ('lo', True))
        self.assertEqual(self.pick(-0.1, -0.6, vi_status='invented'), ('lo', False))  # Lao is all there is, weak but not too weak: undecided
        # 0.13.10 (real meeting 25/11, no Lao speaker): under an invented Vietnamese sentence a Lao reading below -0.68 is not the line either; the row
        # keeps the invented reading (hidden as a ghost, the Lao reading printed beside it).
        self.assertEqual(self.pick(-0.1, -0.9, vi_status='invented'), ('vi', False))
        self.assertEqual(self.pick(-0.1, -0.69, vi_status='invented'), ('vi', False))
        self.assertEqual(self.pick(-0.1, -0.9, vi_status='empty'), ('lo', False))  # an empty Vietnamese reading is not an invented one
        self.assertEqual(self.pick(-0.1, -0.3, vi_status='empty'), ('lo', True))

    def test_a_clean_vietnamese_reading_needs_a_wider_lao_lead(self):
        # A Vietnamese-only participant's short reply read as Lao at +0.179 (real meeting 25/11): a reading that is Vietnamese syllables throughout
        # keeps the line unless Lao is ahead by 0.20.
        clean = dict(reading('vi', 'dạ vâng em gửi bảng giá chiều nay', -0.661), viSyllableShare=1.0, viSyllables=8)
        self.assertEqual(audio_worker.pick_reading(clean, reading('lo', 'l', -0.482)), ('vi', False))
        self.assertEqual(audio_worker.pick_reading(clean, reading('lo', 'l', -0.45)), ('lo', False))  # +0.211
        short = dict(clean, viSyllables=3)  # too few syllables to call it clean: the old margin
        self.assertEqual(audio_worker.pick_reading(short, reading('lo', 'l', -0.482)), ('lo', False))

    def test_a_lao_reading_that_is_empty_or_invented_leaves_vietnamese(self):
        self.assertEqual(self.pick(-0.4, -0.3, lo_status='invented'), ('vi', True))
        self.assertEqual(self.pick(-0.4, None, lo_status='empty'), ('vi', True))
        self.assertEqual(self.pick(-0.4, -0.3, vi_status='invented', lo_status='invented'), ('vi', False))  # nothing usable at all

    def test_missing_scores_fall_back_without_raising(self):
        self.assertEqual(self.pick(None, -0.3), ('lo', True))


class FakeModel:
    def __init__(self, name, log, text, logprob, cuda=True):
        self.name, self.log, self.text, self.logprob = name, log, text, logprob
        self.model = type('Inner', (), {'device': 'cuda' if cuda else 'cpu'})()

    def transcribe(self, audio, language=None, **options):
        self.log.append((self.name, language, options.get('beam_size')))
        return iter([segment(self.text, self.logprob)]), type('Info', (), {'language': language, 'all_language_probs': []})()


class TranscribeReadingsTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        self.audio = np.zeros(16000 * 5, dtype=np.float32)
        self.log = []

    def run_chunk(self, vi_text, vi_lp, lo_text, lo_lp, vi_model=None):
        main = FakeModel('main', self.log, vi_text, vi_lp)
        lao = FakeModel('lao', self.log, lo_text, lo_lp)
        return audio_worker.transcribe_readings(main, self.audio, lao, vi_model, model_names={'main': 'turbo', 'vi': None, 'lo': 'buzz'})

    def test_both_models_decode_every_chunk_one_after_the_other_vietnamese_first(self):
        segments, language, probability = self.run_chunk('kho số hai đủ hàng nhé', -0.3, 'ຂໍ້ມູນ', -0.7)
        self.assertEqual([(name, lang) for name, lang, _ in self.log], [('main', 'vi'), ('lao', 'lo')])
        self.assertEqual((language, probability, segments.undecided), ('vi', None, False))
        self.assertEqual([s.text for s in segments], ['kho số hai đủ hàng nhé'])
        self.assertEqual(set(segments.seconds), {'vi', 'lo'})

    def test_readings_are_listed_with_the_picked_one_first_and_marked(self):
        segments, language, _ = self.run_chunk('kho số hai còn đủ hàng', -0.8, 'ສະບາຍດີ 120,000 ຄົນ', -0.4)
        readings = audio_worker.chunk_alternatives(segments)
        self.assertEqual(language, 'lo')
        self.assertEqual([(r['language'], r['picked'], r['model']) for r in readings], [('lo', True, 'buzz'), ('vi', False, 'turbo')])
        self.assertEqual([s.text for s in segments], ['ສະບາຍດີ 120,000 ຄົນ'])  # the row text is the picked reading
        self.assertEqual(readings[1]['text'], 'kho số hai còn đủ hàng')  # nothing of the other reading is lost
        self.assertFalse(segments.undecided)

    def test_an_unclear_pick_is_flagged_undecided_and_keeps_both_texts(self):
        segments, language, _ = self.run_chunk('kho số hai đủ hàng', -0.5, 'ຄຳເວົ້າ', -0.386)
        self.assertEqual(language, 'vi')
        self.assertTrue(segments.undecided)
        self.assertEqual(len(audio_worker.chunk_alternatives(segments)), 2)

    def test_the_vietnamese_model_is_used_when_there_is_one(self):
        main, lao, vi = FakeModel('main', self.log, 'x', -0.5), FakeModel('lao', self.log, 'y', -0.5), FakeModel('vi', self.log, 'kho số hai đủ hàng', -0.3)
        audio_worker.transcribe_readings(main, self.audio, lao, vi, model_names={'main': 'turbo', 'vi': 'vimodel', 'lo': 'buzz'})
        self.assertEqual([name for name, _, _ in self.log], ['vi', 'lao'])

    def test_readings_run_only_for_vietnamese_plus_lao_with_the_lao_model_loaded(self):
        self.assertTrue(audio_worker.readings_enabled(['vi', 'lo'], object()))
        self.assertTrue(audio_worker.readings_enabled(['vi', 'lo', 'th'], object()))
        self.assertFalse(audio_worker.readings_enabled(['vi'], object()))
        self.assertFalse(audio_worker.readings_enabled(['lo'], object()))
        self.assertFalse(audio_worker.readings_enabled(['vi', 'lo'], None))  # no Lao model: LAO_MODEL_MISSING keeps its behaviour


class WorkerEmitTests(unittest.TestCase):
    """The follow worker with fake models: what a chunk looks like on the wire in each mode."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / 'audio'
        self.dir.mkdir()
        self.session = FakeSession(self.dir)
        self.events, self.calls, self.error = [], [], None
        self.stdin = FakeStdin()
        self.lao = object()

        def one(model, waveform16, languages, lao_model=None, vi_model=None, pick=None, beam=None):
            self.calls.append('chunk')
            return [segment('đoạn một')], 'vi', 0.95

        def both(model, waveform16, lao_model, vi_model=None, beam=None, model_names=None):
            self.calls.append('readings')
            result = audio_worker.ChunkSegments([segment('ສະບາຍດີ 120,000 ຄົນ')])
            result.alternatives = [dict(reading('lo', 'ສະບາຍດີ 120,000 ຄົນ', -0.4), picked=True), reading('vi', 'kho số hai', -0.5)]
            result.undecided = True
            return result, 'lo', None

        def load_models(*args, **kwargs):
            return object(), self.lao, None, {'device': 'cuda', 'mainModel': 'turbo', 'laoModel': 'buzz', 'viModel': None}
        for name, value in (('transcribe_chunk', one), ('transcribe_readings', both), ('load_models', load_models), ('emit', self.events.append),
                            ('raise_priority', lambda: None), ('asr_profile', lambda: {'main': self.tmp.name, 'lo': None, 'vi': None})):
            patcher = mock.patch.object(audio_worker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(sys, 'stdin', self.stdin)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: (self.stdin.close(), time.sleep(0.1)))

    def run_worker(self, languages, extra=()):
        at = self.session.segment(1, 'speaker', 0.0, [(4, 0.2), (1, 0)])
        self.session.end(at)
        args = audio_worker.build_parser().parse_args(['--follow', str(self.dir), '--languages', languages, '--asr-device', 'cpu', *extra])

        def run():
            try:
                audio_worker.capture(args)
            except BaseException as exc:
                self.error = exc
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        thread.join(20)
        self.assertFalse(thread.is_alive(), 'worker did not end')
        self.assertIsNone(self.error)
        return [e for e in self.events if e.get('type') == 'source']

    def test_vietnamese_plus_lao_emits_the_picked_text_both_readings_and_the_undecided_flag(self):
        sources = self.run_worker('vi,lo')
        self.assertEqual(self.calls, ['readings'])
        self.assertEqual(len(sources), 1)
        row = sources[0]
        self.assertEqual((row['language'], row['languageProbability']), ('lo', None))
        self.assertIn('READINGS_UNDECIDED', row['boundary'])
        self.assertEqual([(a['language'], a['picked']) for a in row['alternatives']], [('lo', True), ('vi', False)])
        self.assertEqual(row['alternatives'][0]['rv'], 1)

    def check_old_routing(self, languages, extra=()):
        sources = self.run_worker(languages, extra)
        self.assertEqual(self.calls, ['chunk'], languages)
        self.assertNotIn('alternatives', sources[0])
        self.assertNotIn('READINGS_UNDECIDED', sources[0]['boundary'])

    def test_the_one_reading_switch_keeps_the_old_routing(self):
        self.check_old_routing('vi,lo', ['--one-reading'])

    def test_a_vietnamese_only_session_keeps_the_old_routing(self):
        self.check_old_routing('vi')

    def test_a_lao_only_session_keeps_the_old_routing(self):
        self.check_old_routing('lo')

    def test_no_lao_model_means_no_second_reading(self):
        self.lao = None
        sources = self.run_worker('vi,lo')
        self.assertEqual(self.calls, ['chunk'])
        self.assertNotIn('alternatives', sources[0])


class RecheckReadingsTests(unittest.TestCase):
    """recheck_window carries the same contract: each forced decode is a reading with its signals, and `picked` marks the one that became the text."""

    def test_each_alternative_is_a_reading_and_the_text_language_is_marked_picked(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        session = FakeSession(tmp.name)
        session.segment(1, 'speaker', 0.0, [(5, 0.2)])
        session.end(5.0)

        def transcribe(model, waveform16, langs, lao_model=None, vi_model=None, pick=None, beam=None):
            if langs[0] == 'lo' and len(langs) == 1:
                return [segment('ສະບາຍດີ ທຸກຄົນ 120,000 ຂອບໃຈ ຫຼາຍໆ', -0.3)], 'lo', None
            return [segment('kho số hai còn đủ hàng cho đơn tuần sau', -0.8)], 'vi', None
        with mock.patch.object(audio_worker, 'transcribe_chunk', transcribe):
            result = audio_worker.recheck_window(object(), None, None, tmp.name, session.iso(0.0), session.iso(4.0), 'speaker', ('vi', 'lo'), 8,
                                                 {'vi': 'turbo', 'lo': 'buzz'})
        by = {a['language']: a for a in result['alternatives']}
        self.assertEqual((result['language'], result.get('pickedBy')), ('lo', 'score'))
        self.assertEqual((by['lo']['picked'], by['vi']['picked']), (True, False))
        for item in by.values():
            self.assertEqual(item['rv'], 1)
            for key in ('model', 'avgLogProb', 'score', 'viSyllableShare', 'viSyllables', 'viTokens', 'viSyllableVersion', 'loopPenalty', 'status'):
                self.assertIn(key, item)
        self.assertEqual((by['vi']['model'], by['lo']['model']), ('turbo', 'buzz'))
        self.assertEqual((by['vi']['viSyllables'], by['vi']['viTokens']), (10, 10))
        self.assertEqual(by['lo']['viSyllables'], 0)

    def test_a_looping_reading_never_becomes_the_text_however_confident(self):
        # 25/11: a Thai reading that was one word repeated 16 times scored -0.198 and became the text over a clean Vietnamese reading at
        # -0.368. Its loop share is measured on the text before repeats are folded into "[×16]", and a loop does not compete.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        session = FakeSession(tmp.name)
        session.segment(1, 'speaker', 0.0, [(5, 0.2)])
        session.end(5.0)

        def transcribe(model, waveform16, langs, lao_model=None, vi_model=None, pick=None, beam=None):
            if langs == ['th']:
                return [segment('ทดสอบคำ ' * 16, -0.198)], 'th', None
            if langs == ['lo']:
                return [segment('ສະບາຍດີ ທຸກຄົນ', -0.7)], 'lo', None
            if langs == ['vi']:
                return [segment('dạ vâng em gửi bảng giá chiều nay', -0.368)], 'vi', None
            return [segment('ทดสอบคำ ' * 16, -0.198)], 'th', None  # the detector picked the loop too
        with mock.patch.object(audio_worker, 'transcribe_chunk', transcribe):
            result = audio_worker.recheck_window(object(), None, None, tmp.name, session.iso(0.0), session.iso(4.0), 'speaker', ('vi', 'lo', 'th'), 8)
        by = {a['language']: a for a in result['alternatives']}
        self.assertGreaterEqual(by['th']['loopPenalty'], audio_worker.RECHECK_LOOP_MAX)
        self.assertIn('[×16]', by['th']['text'])
        self.assertEqual(result['language'], 'vi')
        self.assertEqual(result['text'], 'dạ vâng em gửi bảng giá chiều nay')
        self.assertEqual((by['vi']['picked'], by['th']['picked']), (True, False))


if __name__ == '__main__':
    unittest.main()
