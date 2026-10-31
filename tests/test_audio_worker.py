"""No device capture: verify format conversion and orphan-watch termination."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys
import unittest


class TranscriptFilterTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        self.worker = audio_worker

    def segment(self, no_speech=0.1, compression=1.2, logprob=-0.3):
        return type('Segment', (), {'no_speech_prob': no_speech, 'compression_ratio': compression, 'avg_logprob': logprob})()

    def test_mic_keeps_own_voice_and_drops_speaker_echo(self):
        own = self.worker.mic_is_own_voice
        self.assertTrue(own([0.05, 0.06, 0.05], [0.0, 0.01, 0.0]))  # user speaks, meeting quiet
        self.assertFalse(own([0.02, 0.02, 0.02], [0.05, 0.06, 0.05]))  # mic only hears the speakers
        self.assertFalse(own([0.001, 0.002], [0.0, 0.0]))  # silence
        self.assertTrue(own([0.05, 0.02, 0.02, 0.06], [0.01, 0.05, 0.05, 0.0]))  # half own voice over a busy meeting

    def test_flags_mark_but_keep_text(self):
        flags = self.worker.segment_flags
        self.assertEqual(flags('Kho số hai đủ hàng.', self.segment(), 'vi'), [])
        self.assertIn('LIKELY_HALLUCINATION', flags('Hãy đăng ký kênh để ủng hộ', self.segment(), 'vi'))
        self.assertIn('LAO_WRITTEN_IN_THAI_SCRIPT', flags('วัน', self.segment(), 'lo'))
        self.assertNotIn('LAO_WRITTEN_IN_THAI_SCRIPT', flags('ສະບາຍດີ', self.segment(), 'lo'))
        self.assertIn('REPETITION', flags('dạ dạ dạ dạ dạ dạ dạ', self.segment(), 'vi'))

    def test_unsure_language_is_flagged_below_threshold_only(self):
        flags = self.worker.segment_flags
        self.assertIn('LANG_UNSURE', flags('Kho số hai đủ hàng.', self.segment(), 'vi', 0.64))
        self.assertNotIn('LANG_UNSURE', flags('Kho số hai đủ hàng.', self.segment(), 'vi', 0.65))
        self.assertNotIn('LANG_UNSURE', flags('Kho số hai đủ hàng.', self.segment(), 'vi', None))

    def test_lao_low_confidence_needs_lao_and_low_logprob(self):
        flags = self.worker.segment_flags
        self.assertIn('LAO_LOW_CONFIDENCE', flags('ສະບາຍດີ', self.segment(logprob=-1.2), 'lo'))
        self.assertNotIn('LAO_LOW_CONFIDENCE', flags('ສະບາຍດີ', self.segment(logprob=-0.5), 'lo'))
        self.assertNotIn('LAO_LOW_CONFIDENCE', flags('Kho số hai đủ hàng.', self.segment(logprob=-1.2), 'vi'))

    MICS = [(12, 'Mic in at front panel (Pink) (Realtek(R) Audio)'), (15, 'Headset (Jabra)')]

    def test_mic_is_the_one_a_meeting_app_holds_else_the_windows_default(self):
        pick = self.worker.pick_mic
        held = lambda device, *apps: [{'device': device, 'apps': list(apps)}]
        self.assertEqual(pick(self.MICS, 12, held('Headset (Jabra)', 'chrome')), (15, 'Headset (Jabra)', 'meeting_app:chrome'))
        self.assertEqual(pick(self.MICS, 12, []), (12, self.MICS[0][1], 'windows_default'))
        self.assertEqual(pick(self.MICS, 12, held('Unplugged device', 'zoom')), (12, self.MICS[0][1], 'windows_default'))
        self.assertEqual(pick([], -1, None), (None, None, None))

    def test_zoom_wins_over_a_browser_and_unknown_apps_rank_last(self):
        in_use = [{'device': 'Headset (Jabra)', 'apps': ['msedge']}, {'device': self.MICS[0][1], 'apps': ['python', 'Zoom']}]
        self.assertEqual(self.worker.pick_mic(self.MICS, 15, in_use), (12, self.MICS[0][1], 'meeting_app:Zoom'))
        self.assertEqual(self.worker.pick_mic(self.MICS, 12, [{'device': 'Headset (Jabra)', 'apps': ['notepad']}])[0:2], (15, 'Headset (Jabra)'))

    def test_core_audio_and_portaudio_spellings_of_one_device_match(self):
        match = self.worker.match_mic
        self.assertEqual(match('Headset (Jabra)', self.MICS), self.MICS[1])
        self.assertEqual(match('headset  (jabra)', self.MICS), self.MICS[1])
        self.assertEqual(match('Mic in at front panel (Pink)', self.MICS), self.MICS[0])
        self.assertIsNone(match('Other', self.MICS))
        self.assertIsNone(match(None, self.MICS))

    def test_device_change_is_reported_only_when_a_meeting_app_moves_to_another_mic(self):
        change = self.worker.mic_device_change
        self.assertIsNone(change(12, self.MICS, []))
        self.assertIsNone(change(12, self.MICS, [{'device': self.MICS[0][1], 'apps': ['zoom']}]))
        self.assertEqual(change(12, self.MICS, [{'device': 'Headset (Jabra)', 'apps': ['chrome']}]), {'from': self.MICS[0][1], 'to': 'Headset (Jabra)', 'app': 'chrome'})

    def test_command_loop_pause_returns_to_waiting_and_stop_leaves(self):
        script = iter(['{"n":1}', '{"n":2}', 'pause', '{"n":3}', 'stop'])
        ran, warmed = [], []
        outcomes = iter(['pause', 'pause', 'pause'])
        result = self.worker.command_loop(lambda: next(script), lambda line: ran.append(line) or next(outcomes), lambda: warmed.append(1))
        self.assertEqual(result, 'stop')
        self.assertEqual(ran, ['{"n":1}', '{"n":2}', '{"n":3}'])
        self.assertEqual(len(warmed), 3)

    def test_command_loop_leaves_when_a_listening_ends_by_itself_or_input_closes(self):
        self.assertEqual(self.worker.command_loop(iter(['{}', 'stop']).__next__, lambda line: 'ended', lambda: self.fail('no warm event after the end')), 'ended')
        self.assertEqual(self.worker.command_loop(lambda: None, lambda line: self.fail('nothing to run'), lambda: None), 'stop')

    def test_listening_request_carries_source_mic_and_audio_saving(self):
        make = self.worker.listening_from_request
        live = make({'device': 13, 'deviceName': 'Loop', 'micAuto': True, 'maxSeconds': 99, 'captureId': 'abc-1', 'saveAudioDir': 'D:/x/audio/s1'}, 7200)
        self.assertEqual((live.device, live.device_name, live.mic_auto, live.mic_device, live.max_seconds, live.capture_id, live.save_dir), (13, 'Loop', True, None, 99, 'abc-1', Path('D:/x/audio/s1')))
        mic = make({'device': 13, 'deviceName': 'Loop', 'micDevice': 12, 'micName': 'Mic'}, 7200)
        self.assertEqual((mic.mic_device, mic.mic_name, mic.max_seconds, mic.save_dir), (12, 'Mic', 7200, None))
        self.assertRegex(make({'device': 1, 'deviceName': 'x', 'captureId': '../evil'}, 60).capture_id, r'^[0-9a-f]{32}$')
        replay = make({'replay': 'a.wav', 'speed': 2, 'saveAudioDir': 'D:/x'}, 60)
        self.assertEqual((replay.replay, replay.speed, replay.device, replay.save_dir), ('a.wav', 2.0, None, None))

    def test_wav_is_written_as_it_goes_and_is_playable_at_every_moment(self):
        import numpy as np
        import tempfile
        import wave
        with tempfile.TemporaryDirectory() as directory:
            path = self.worker.audio_path(directory, 'cap-1', 'mic')
            self.assertEqual(path.name, 'cap-1-mic.wav')
            writer = self.worker.WavWriter(path, 44100)
            writer.write(np.full(4410, 0.5, dtype=np.float32))
            with wave.open(str(path), 'rb') as reading:  # still open for writing
                self.assertEqual((reading.getnchannels(), reading.getsampwidth(), reading.getframerate(), reading.getnframes()), (1, 2, 44100, 4410))
            writer.write(np.array([2.0, -2.0], dtype=np.float32))  # clipped, not wrapped
            writer.close()
            with wave.open(str(path), 'rb') as reading:
                frames = np.frombuffer(reading.readframes(reading.getnframes()), dtype='<i2')
            self.assertEqual((len(frames), int(frames[0]), int(frames[-2]), int(frames[-1])), (4412, 16383, 32767, -32767))

    def test_greeting_alone_is_flagged_but_inside_a_sentence_is_not(self):
        flags = self.worker.segment_flags
        self.assertIn('LIKELY_HALLUCINATION', flags('Chào mừng.', self.segment(), 'vi'))
        self.assertNotIn('LIKELY_HALLUCINATION', flags('Chào mừng anh Phet về lại công ty', self.segment(), 'vi'))

    def test_collapse_repeats_keeps_count(self):
        self.assertEqual(self.worker.collapse_repeats('ok dạ dạ dạ dạ dạ dạ dạ xong'), 'ok dạ [×7] xong')
        self.assertEqual(self.worker.collapse_repeats('ba ba xe'), 'ba ba xe')

    def test_collapse_repeats_folds_phrase_loops(self):
        collapse = self.worker.collapse_repeats
        self.assertEqual(collapse('Kho nhận Mai của Mai của Mai của Mai của Mai của Mai của Mai của Mai của rồi'), 'Kho nhận Mai của [×8] rồi')
        self.assertEqual(collapse('a b a b a b a b'), 'a b [×4]')
        self.assertEqual(collapse('a b c a b c a b c a b c'), 'a b c [×4]')
        self.assertEqual(collapse('a b c d a b c d a b c d a b c d'), 'a b c d [×4]')
        self.assertEqual(collapse('Mai của, Mai của, Mai của, Mai của.'), 'Mai của [×4].')
        # three repeats of a phrase, or four of a single word, are ordinary speech
        self.assertEqual(collapse('Mai của Mai của Mai của'), 'Mai của Mai của Mai của')
        self.assertEqual(collapse('có có có có anh'), 'có có có có anh')
        # a phrase is matched on whole words only
        self.assertEqual(collapse('xa b xa b xa b xa b'), 'xa b [×4]')
        self.assertEqual(collapse('a b a b a b a bc'), 'a b a b a b a bc')

    def test_phrase_loops_are_flagged_as_repetition(self):
        flags = self.worker.segment_flags
        self.assertIn('REPETITION', flags('Mai của Mai của Mai của Mai của', self.segment(), 'vi'))
        self.assertNotIn('REPETITION', flags('Mai của Mai của Mai của', self.segment(), 'vi'))

    def test_invented_channel_pitch_is_flagged(self):
        flags = self.worker.segment_flags
        self.assertIn('LIKELY_HALLUCINATION', flags('Để không bỏ lỡ những video hấp dẫn', self.segment(), 'vi'))
        self.assertIn('LIKELY_HALLUCINATION', flags('Nhấn chuông để nhận thông báo', self.segment(), 'vi'))
        self.assertNotIn('LIKELY_HALLUCINATION', flags('Để không bỏ lỡ hạn giao hàng, anh nhắc kho', self.segment(), 'vi'))

    def test_thanks_alone_is_flagged_only_when_the_model_doubts_speech(self):
        flags = self.worker.segment_flags
        self.assertNotIn('LIKELY_HALLUCINATION', flags('Cảm ơn.', self.segment(no_speech=0.1, logprob=-0.3), 'vi'))
        self.assertIn('LIKELY_HALLUCINATION', flags('Cảm ơn.', self.segment(no_speech=0.35, logprob=-0.3), 'vi'))
        self.assertIn('LIKELY_HALLUCINATION', flags('Cảm ơn.', self.segment(no_speech=0.1, logprob=-0.9), 'vi'))
        self.assertNotIn('LIKELY_HALLUCINATION', flags('Cảm ơn anh đã gửi báo giá', self.segment(no_speech=0.35, logprob=-0.9), 'vi'))


class SplitPointTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        self.worker = audio_worker

    def test_picks_the_quietest_block_inside_the_last_three_seconds(self):
        # 2048-sample blocks at 16 kHz are 128 ms each, so the last 3 s are the last 24 blocks (indices 17-40).
        rms = [0.001] + [0.05] * 40
        rms[30] = 0.004
        rms[38] = 0.02
        self.assertEqual(self.worker.split_point(rms, [2048] * 41, 16000), 30)

    def test_ignores_quiet_blocks_older_than_the_window(self):
        rms = [0.0] * 5 + [0.05] * 40
        self.assertEqual(self.worker.split_point(rms, [2048] * 45, 16000), 44)

    def test_latest_block_wins_ties_and_first_chunk_is_never_empty(self):
        self.assertEqual(self.worker.split_point([0.02] * 30, [2048] * 30, 16000), 29)
        self.assertEqual(self.worker.split_point([0.0], [2048], 16000), 0)
        for rms in ([0.0, 0.5, 0.5], [0.5, 0.0, 0.0], [0.3, 0.3]):
            self.assertGreaterEqual(self.worker.split_point(rms, [48000] * len(rms), 16000), 0)


class LanguageRoutingTests(unittest.TestCase):
    """Fake models: no ASR runs. Checks which model transcribes each chunk."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        self.worker = audio_worker

    def fake(self, name, detected=None, probs=()):
        calls = []

        class Model:
            def transcribe(self, audio, language=None, **options):
                calls.append(language)
                info = type('Info', (), {'language': detected if language is None else language, 'all_language_probs': list(probs)})()
                return [f'{name}:{language}'], info
        model = Model()
        model.calls = calls
        return model

    def test_lao_chunks_go_to_the_lao_model(self):
        main = self.fake('main', 'th', [('th', 0.7), ('lo', 0.1), ('vi', 0.05)])
        lao = self.fake('lao')
        segments, language, share = self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao)
        self.assertEqual((segments, language), (['lao:lo'], 'lo'))
        self.assertEqual(main.calls, [None])
        self.assertGreater(share, 0.9)

    def test_vietnamese_stays_on_the_main_model_in_one_pass(self):
        main = self.fake('main', 'vi', [('vi', 0.9), ('th', 0.02)])
        lao = self.fake('lao')
        segments, language, _ = self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao)
        self.assertEqual((segments, language, lao.calls), (['main:None'], 'vi', []))

    def test_without_a_lao_model_lao_is_forced_on_the_main_model(self):
        main = self.fake('main', 'th', [('th', 0.8), ('vi', 0.1)])
        segments, language, _ = self.worker.transcribe_chunk(main, None, ['vi', 'lo'], None)
        self.assertEqual((segments, language, main.calls), (['main:lo'], 'lo', [None, 'lo']))

    def test_vietnamese_chunks_go_to_the_vietnamese_model_when_configured(self):
        main = self.fake('main', 'vi', [('vi', 0.9)])
        vi, lao = self.fake('vi'), self.fake('lao')
        segments, language, _ = self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao, vi)
        self.assertEqual((segments, language, vi.calls, lao.calls), (['vi:vi'], 'vi', ['vi'], []))
        lao_chunk = self.fake('main', 'lo', [('lo', 0.8)])
        segments, language, _ = self.worker.transcribe_chunk(lao_chunk, None, ['vi', 'lo'], lao, vi)
        self.assertEqual((segments, language), (['lao:lo'], 'lo'))

    def test_lao_only_session_uses_the_lao_model_directly(self):
        main, lao = self.fake('main'), self.fake('lao')
        segments, language, _ = self.worker.transcribe_chunk(main, None, ['lo'], lao)
        self.assertEqual((segments, language, main.calls), (['lao:lo'], 'lo', []))


class LaoLanguageTokenTests(unittest.TestCase):
    """CTranslate2 flags BuzzASR English-only; the proxy and its checks make faster-whisper decode with <|lo|>."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        self.worker = audio_worker

    def whisper(self, multilingual=False, reported='lo', tokens=None):
        ids = {'<|startoftranscript|>': 10, '<|lo|>': 21, '<|vi|>': 22, '<|transcribe|>': 30, '<|translate|>': 31}
        ids.update(tokens or {})

        class Inner:
            device = 'cuda'

            def __init__(self):
                self.is_multilingual = multilingual

            def generate(self, *args):
                return 'generated'

        class Tokenizer:
            def token_to_id(self, name):
                return ids.get(name)

        class Info:
            language = reported

        class Whisper:
            model = Inner()
            hf_tokenizer = Tokenizer()

            def transcribe(self, audio, language=None):
                return [], Info()
        return Whisper()

    def config(self, lang_ids):
        import json
        import tempfile
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        (Path(folder.name) / 'config.json').write_text(json.dumps({'lang_ids': lang_ids}), encoding='utf-8')
        return folder.name

    def test_proxy_reports_multilingual_and_forwards_everything_else(self):
        whisper = self.whisper()
        proxy = self.worker.MultilingualCT2(whisper.model)
        self.assertTrue(proxy.is_multilingual)
        self.assertFalse(whisper.model.is_multilingual)  # the real model is untouched
        self.assertEqual((proxy.device, proxy.generate()), ('cuda', 'generated'))

    def test_token_is_enabled_only_when_it_is_in_lang_ids_and_the_start_sequence(self):
        whisper = self.whisper()
        self.assertTrue(self.worker.enable_language_tokens(whisper, self.config([20, 21, 22]), 'lo'))
        self.assertTrue(whisper.model.is_multilingual)

    def test_a_token_missing_from_lang_ids_or_the_vocabulary_leaves_the_model_alone(self):
        whisper = self.whisper()
        original = whisper.model
        self.assertFalse(self.worker.enable_language_tokens(whisper, self.config([20, 22]), 'lo'))
        self.assertIs(whisper.model, original)
        no_token = self.whisper(tokens={'<|lo|>': None})
        self.assertFalse(self.worker.enable_language_tokens(no_token, self.config([21]), 'lo'))
        self.assertFalse(self.worker.enable_language_tokens(self.whisper(), '.', 'lo'))  # no config.json

    def test_a_model_that_still_reports_another_language_is_reverted(self):
        whisper = self.whisper(reported='en')
        original = whisper.model
        self.assertFalse(self.worker.enable_language_tokens(whisper, self.config([21]), 'lo'))
        self.assertIs(whisper.model, original)

    def test_an_already_multilingual_model_is_not_wrapped(self):
        whisper = self.whisper(multilingual=True)
        original = whisper.model
        self.assertTrue(self.worker.enable_language_tokens(whisper, '.', 'lo'))
        self.assertIs(whisper.model, original)

    def test_real_buzzasr_start_sequence_carries_the_lao_token(self):
        folder = Path(__file__).resolve().parents[1] / '.local' / 'models' / 'buzzasr-lao-ct2'
        if not (folder / 'tokenizer.json').is_file():
            self.skipTest('BuzzASR not installed')
        import json
        import tokenizers
        from faster_whisper.tokenizer import Tokenizer
        hf = tokenizers.Tokenizer.from_file(str(folder / 'tokenizer.json'))
        lo = hf.token_to_id('<|lo|>')
        self.assertIn(lo, json.loads((folder / 'config.json').read_text(encoding='utf-8'))['lang_ids'])
        self.assertIn(lo, Tokenizer(hf, True, task='transcribe', language='lo').sot_sequence)


class LanguagePickTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        self.worker = audio_worker

    def segment(self, text, logprob, tokens=10):
        return type('Segment', (), {'text': text, 'avg_logprob': logprob, 'tokens': list(range(tokens))})()

    def test_score_is_the_token_weighted_mean_and_empty_text_is_worst(self):
        score = self.worker.segments_score
        self.assertAlmostEqual(score([self.segment('a', -0.2, 10), self.segment('b', -0.8, 30)]), -0.65)
        self.assertEqual(score([]), float('-inf'))

    def test_the_second_decoder_runs_only_when_vietnamese_is_not_clearly_heard(self):
        should = self.worker.should_pick_language
        self.assertFalse(should('vi', 0.95, 0.95, 2.0))  # a clear Vietnamese reading is trusted, even when short
        self.assertTrue(should('vi', 0.5, 0.5, 8.0))
        self.assertTrue(should('vi', 1.0, 0.05, 2.0))  # detector heard "something else": short Lao often looks like this
        self.assertTrue(should('lo', 0.9, 0.05, 2.0))  # confident Lao but too short to trust
        self.assertFalse(should('lo', 0.9, 0.05, 8.0))  # confident and long
        self.assertFalse(should('lo', 0.9, 0.05, None))  # unknown length counts as long
        self.assertTrue(should('lo', 0.6, 0.3, 8.0))
        self.assertTrue(should('vi', None, None, 8.0))

    def test_the_more_confident_decoder_wins_and_ties_go_to_vietnamese(self):
        pick = self.worker.pick_by_score
        vi, lo = [self.segment('xin chào các bạn', -0.3)], [self.segment('ສະບາຍດີ', -0.9)]
        self.assertEqual(pick(vi, lo), 'vi')
        self.assertEqual(pick([self.segment('chào', -0.8)], [self.segment('ສະບາຍດີ', -0.3)]), 'lo')
        self.assertEqual(pick([self.segment('chào', -0.5)], [self.segment('ສະບາຍດີ', -0.5)], 0.0), 'vi')

    def test_a_bias_helps_lao_only_inside_its_margin(self):
        vi, lo = [self.segment('chào', -0.45)], [self.segment('ສະບາຍດີ', -0.5)]
        self.assertEqual(self.worker.pick_by_score(vi, lo, 0.0), 'vi')
        self.assertEqual(self.worker.pick_by_score(vi, lo, 0.1), 'lo')

    def test_an_invented_stock_phrase_never_beats_lao_text(self):
        invented = [self.segment('Hãy subscribe cho kênh Ghiền Mì Gõ', -0.1)]
        self.assertEqual(self.worker.pick_by_score(invented, [self.segment('ສະບາຍດີ', -0.9)]), 'lo')
        self.assertEqual(self.worker.pick_by_score(invented, []), 'vi')  # nothing better to offer

    def fake(self, name, detected=None, probs=(), score=-0.5, text=None, device='cuda'):
        calls, options_seen = [], []

        class Inner:
            pass
        Inner.device = device

        class Model:
            model = Inner()

            def transcribe(self, audio, language=None, **options):
                calls.append(language)
                options_seen.append(options)
                info = type('Info', (), {'language': detected if language is None else language, 'all_language_probs': list(probs)})()
                segments = [type('Segment', (), {'text': text or f'{name}:{language}', 'avg_logprob': score, 'tokens': list(range(10))})()]
                return segments, info
        model = Model()
        model.calls, model.options = calls, options_seen
        return model

    def test_a_short_chunk_the_detector_called_vietnamese_but_lao_decodes_better_goes_to_lao(self):
        import numpy as np
        main = self.fake('main', 'vi', [('vi', 0.05), ('th', 0.0)], score=-1.2)
        lao = self.fake('lao', score=-0.4)
        segments, language, probability = self.worker.transcribe_chunk(main, np.zeros(32000, dtype=np.float32), ['vi', 'lo'], lao)
        self.assertEqual((language, [s.text for s in segments]), ('lo', ['lao:lo']))
        self.assertEqual((main.calls, lao.calls), ([None], ['lo']))  # the detection pass is reused as the Vietnamese decode
        self.assertEqual(probability, 0.0)  # the detector disagreed; the result stays flaggable as LANG_UNSURE

    def test_the_vietnamese_decode_wins_when_it_is_more_confident(self):
        main = self.fake('main', 'vi', [('vi', 0.3)], score=-0.2)
        lao = self.fake('lao', score=-0.9)
        segments, language, _ = self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao)
        self.assertEqual((language, [s.text for s in segments]), ('vi', ['main:None']))

    def test_clear_vietnamese_costs_no_second_decode_and_pick_can_be_switched_off(self):
        main, lao = self.fake('main', 'vi', [('vi', 0.97)]), self.fake('lao')
        self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao)
        self.assertEqual((main.calls, lao.calls), ([None], []))
        main, lao = self.fake('main', 'vi', [('vi', 0.05)]), self.fake('lao')
        self.worker.transcribe_chunk(main, None, ['vi', 'lo'], lao, pick=False)
        self.assertEqual(lao.calls, [])

    def test_beam_is_wide_on_cuda_and_one_elsewhere(self):
        beam = self.worker.beam_for
        self.assertEqual(beam(self.fake('m', device='cuda')), self.worker.ASR_BEAM_CUDA)
        self.assertEqual(beam(self.fake('m', device='cpu')), 1)
        self.assertEqual(beam(object()), 1)
        self.assertEqual(beam(self.fake('m', device='cuda'), 2), 2)
        main = self.fake('main', 'vi', [('vi', 0.97)], device='cuda')
        self.worker.transcribe_chunk(main, None, ['vi', 'lo'], self.fake('lao'))
        self.assertEqual(main.options[0]['beam_size'], self.worker.ASR_BEAM_CUDA)


class TaiRoutingTests(unittest.TestCase):
    """Three-way vi / lo / th routing with fake models (no ASR): which decoders run, which reading is primary, what comes back as alternatives."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
        import audio_worker
        import numpy as np
        self.worker = audio_worker
        self.long = np.zeros(16000 * 6, dtype=np.float32)
        self.short = np.zeros(16000 * 2, dtype=np.float32)

    def fake(self, detected=None, probs=(), scores=None, texts=None):
        # scores/texts: language -> value used when the model is asked to decode that language.
        calls = []
        scores = scores or {}
        texts = texts or {}

        class Model:
            def transcribe(self, audio, language=None, **options):
                calls.append(language)
                code = language or detected
                info = type('Info', (), {'language': code, 'all_language_probs': list(probs)})()
                segment = type('Segment', (), {'text': texts.get(code, f'text-{code}'), 'avg_logprob': scores.get(code, -0.5), 'tokens': list(range(10)), 'no_speech_prob': 0.1, 'compression_ratio': 1.2})()
                return [segment], info
        model = Model()
        model.calls = calls
        return model

    def run_chunk(self, main, lao, audio, languages=('vi', 'lo', 'th'), vi=None, **kw):
        segments, language, probability = self.worker.transcribe_chunk(main, audio, list(languages), lao, vi, **kw)
        return segments, language, probability, self.worker.chunk_alternatives(segments)

    def test_a_long_chunk_the_lao_decoder_clearly_wins_is_lao_with_no_alternative(self):
        main = self.fake('th', [('th', 0.9), ('vi', 0.02)], {'th': -0.4})
        lao = self.fake(scores={'lo': -0.15}, texts={'lo': 'ສະບາຍດີ'})
        segments, language, probability, alternatives = self.run_chunk(main, lao, self.long)
        self.assertEqual((language, [s.text for s in segments], alternatives), ('lo', ['ສະບາຍດີ'], []))
        self.assertEqual((main.calls, lao.calls), ([None], ['lo']))  # the detection pass is the Thai decode: nothing is decoded twice
        self.assertGreater(probability, 0.9)

    def test_a_long_chunk_the_thai_decoder_clearly_wins_is_thai_with_no_alternative(self):
        main = self.fake('th', [('th', 0.95), ('vi', 0.01)], {'th': -0.15})
        lao = self.fake(scores={'lo': -0.18})
        segments, language, _, alternatives = self.run_chunk(main, lao, self.long)
        self.assertEqual((language, [s.text for s in segments], alternatives), ('th', ['text-th'], []))

    def test_close_scores_keep_the_other_reading_as_an_alternative_and_flag_the_language_as_unsure(self):
        main = self.fake('th', [('th', 0.95), ('vi', 0.01)], {'th': -0.30}, {'th': 'สวัสดี'})
        lao = self.fake(scores={'lo': -0.25}, texts={'lo': 'ສະບາຍດີ'})
        segments, language, probability, alternatives = self.run_chunk(main, lao, self.long)
        self.assertEqual((language, [s.text for s in segments]), ('th', ['สวัสดี']))  # lo wins by 0.05 only: below LANG_TAI_LO_MARGIN
        self.assertEqual(alternatives, [{'language': 'lo', 'text': 'ສະບາຍດີ', 'score': -0.25}])
        self.assertEqual(probability, self.worker.LANG_TAI_UNSURE_PROB)
        flags = self.worker.segment_flags('สวัสดี', segments[0], language, probability)
        self.assertIn('LANG_UNSURE', flags)

    def test_a_short_chunk_always_returns_the_other_reading_even_when_one_wins_clearly(self):
        main = self.fake('th', [('th', 0.9), ('vi', 0.02)], {'th': -0.6}, {'th': 'สวัสดี'})
        lao = self.fake(scores={'lo': -0.1}, texts={'lo': 'ສະບາຍດີ'})
        segments, language, _, alternatives = self.run_chunk(main, lao, self.short)
        self.assertEqual((language, [a['language'] for a in alternatives], [a['text'] for a in alternatives]), ('lo', ['th'], ['สวัสดี']))

    def test_clear_vietnamese_decodes_no_tai_reading(self):
        main, lao = self.fake('vi', [('vi', 0.97)]), self.fake()
        segments, language, _, alternatives = self.run_chunk(main, lao, self.long)
        self.assertEqual((language, main.calls, lao.calls, alternatives), ('vi', [None], [], []))

    def test_vietnamese_still_beats_a_weaker_tai_reading_and_a_stock_phrase_still_loses(self):
        main = self.fake('vi', [('vi', 0.3), ('th', 0.4)], {'vi': -0.2, 'th': -0.7})
        lao = self.fake(scores={'lo': -0.8})
        _, language, _, alternatives = self.run_chunk(main, lao, self.long)
        self.assertEqual((language, alternatives), ('vi', []))
        main = self.fake('vi', [('vi', 0.3), ('th', 0.4)], {'vi': -0.1, 'th': -0.5}, {'vi': 'Hãy subscribe cho kênh'})
        lao = self.fake(scores={'lo': -0.6})
        _, language, _, alternatives = self.run_chunk(main, lao, self.short)
        self.assertEqual(language, 'th')  # the Vietnamese decode was an invented stock phrase

    def test_lao_gets_its_bias_against_vietnamese_but_thai_does_not(self):
        main = self.fake('vi', [('vi', 0.3), ('th', 0.4)], {'vi': -0.5, 'th': -0.55})
        lao = self.fake(scores={'lo': -0.55})
        _, language, _, _ = self.run_chunk(main, lao, self.short)
        self.assertEqual(language, 'vi')  # th is 0.05 behind vi and gets no bias
        main = self.fake('vi', [('vi', 0.3), ('th', 0.4)], {'vi': -0.5, 'th': -0.9})
        lao = self.fake(scores={'lo': -0.45})
        _, language, _, _ = self.run_chunk(main, lao, self.short)
        self.assertEqual(language, 'lo')  # lo is 0.05 ahead of vi, and +0.1 bias applies

    def test_a_session_without_vietnamese_skips_detection_and_decodes_both_readings(self):
        main = self.fake(None, (), {'th': -0.3})
        lao = self.fake(scores={'lo': -0.05}, texts={'lo': 'ສະບາຍດີ'})
        segments, language, probability, alternatives = self.run_chunk(main, lao, self.long, ('lo', 'th'))
        self.assertEqual((language, main.calls, lao.calls, alternatives), ('lo', ['th'], ['lo'], []))
        self.assertIsNone(probability)
        main = self.fake(None, (), {'th': -0.3})
        lao = self.fake(scores={'lo': -0.28})
        _, language, probability, alternatives = self.run_chunk(main, lao, self.long, ('lo', 'th'))
        self.assertEqual((language, alternatives[0]['language'], probability), ('th', 'lo', self.worker.LANG_TAI_UNSURE_PROB))

    def test_thai_without_lao_never_wakes_the_lao_model(self):
        main = self.fake('th', [('th', 0.9), ('lo', 0.05), ('vi', 0.02)])
        lao = self.fake()
        segments, language, _, alternatives = self.run_chunk(main, lao, self.long, ('vi', 'th'))
        self.assertEqual((language, main.calls, lao.calls, alternatives), ('th', [None], [], []))

    def test_lao_without_thai_keeps_the_old_routing(self):
        main = self.fake('th', [('th', 0.9), ('vi', 0.02)])
        lao = self.fake(texts={'lo': 'ສະບາຍດີ'})
        segments, language, _, alternatives = self.run_chunk(main, lao, self.long, ('vi', 'lo'))
        self.assertEqual((language, [s.text for s in segments], main.calls, lao.calls, alternatives), ('lo', ['ສະບາຍດີ'], [None], ['lo'], []))

    def test_a_session_with_both_but_no_lao_model_reads_tai_as_thai(self):
        main = self.fake('th', [('th', 0.9), ('lo', 0.05), ('vi', 0.02)])
        segments, language, _, alternatives = self.run_chunk(main, None, self.long)
        self.assertEqual((language, main.calls, alternatives), ('th', [None], []))

    def test_a_thai_only_session_goes_straight_to_the_main_model_and_a_plain_list_has_no_alternatives(self):
        main = self.fake()
        segments, language, probability = self.worker.transcribe_chunk(main, self.long, ['th'], self.fake())
        self.assertEqual((language, probability, main.calls), ('th', None, ['th']))
        self.assertEqual(self.worker.chunk_alternatives(list(segments)), [])

    def test_pick_tai_ties_and_empty_decodes_stay_thai(self):
        seg = lambda score: [type('Segment', (), {'text': 'x', 'avg_logprob': score, 'tokens': [1] * 5})()]
        self.assertEqual(self.worker.pick_tai(seg(-0.3), seg(-0.2)), 'lo')
        self.assertEqual(self.worker.pick_tai(seg(-0.3), seg(-0.25)), 'th')
        self.assertEqual(self.worker.pick_tai(seg(-0.3), []), 'th')
        self.assertEqual(self.worker.pick_tai([], seg(-0.9)), 'lo')
        self.assertEqual(self.worker.pick_tai([], []), 'th')

    def test_decisive_needs_length_and_a_clear_margin(self):
        decisive = self.worker.tai_is_decisive
        self.assertTrue(decisive('lo', -0.1, -0.35, 6))
        self.assertFalse(decisive('lo', -0.1, -0.35, 3.9))
        self.assertTrue(decisive('lo', -0.1, -0.35, None))
        self.assertFalse(decisive('lo', -0.2, -0.3, 6))
        self.assertTrue(decisive('th', -0.17, -0.19, 6))
        self.assertFalse(decisive('th', -0.3, -0.31, 6))  # th decoded poorly
        self.assertFalse(decisive('th', -0.15, -0.25, 6))  # lo decoded clearly better, so th is not a safe single reading

    def test_thai_script_is_flagged_only_when_the_text_is_labelled_lao(self):
        segment = type('Segment', (), {'no_speech_prob': 0.1, 'compression_ratio': 1.2, 'avg_logprob': -0.3})()
        flags = self.worker.segment_flags
        self.assertNotIn('LAO_WRITTEN_IN_THAI_SCRIPT', flags('สวัสดีครับ', segment, 'th'))
        self.assertIn('LAO_WRITTEN_IN_THAI_SCRIPT', flags('สวัสดีครับ', segment, 'lo'))
        self.assertEqual(flags('สวัสดีครับ', segment, 'th'), [])


class AudioInfrastructureTests(unittest.TestCase):
    def test_resample_lengths(self):
        import av
        import numpy as np
        for rate in (44100, 48000):
            frame = av.AudioFrame.from_ndarray(np.zeros((1, rate * 3), dtype=np.float32), format='flt', layout='mono')
            frame.sample_rate = rate
            resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
            frames = resampler.resample(frame) + resampler.resample(None)
            self.assertEqual(sum(f.to_ndarray().size for f in frames), 48000)

    @unittest.skipUnless(os.name == 'nt', 'Windows parent handle contract')
    def test_watcher_exits_when_owned_parent_exits(self):
        tools = str(Path(__file__).resolve().parents[1] / 'tools')
        child_code = f"import sys;sys.path.insert(0,{tools!r});from audio_worker import parent_watch;parent_watch(int(sys.argv[1]))"
        parent_code = "import os,subprocess,sys,time;p=subprocess.Popen([sys.executable,'-c',sys.argv[1],str(os.getpid())]);print(p.pid,flush=True);time.sleep(30)"
        parent = subprocess.Popen([sys.executable, '-c', parent_code, child_code], stdout=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = None
        try:
            child_pid = int(parent.stdout.readline().strip())
            handle = kernel.OpenProcess(0x00100000, 0, child_pid)
            self.assertTrue(handle)
            parent.terminate()
            parent.wait(timeout=5)
            self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, 'Orphan watcher did not exit')
        finally:
            if parent.poll() is None:
                parent.terminate()
                parent.wait(timeout=5)
            if handle:
                kernel.CloseHandle(handle)
            parent.stdout.close()


class MixAudioTests(unittest.TestCase):
    """tools/mix_audio.py: the speaker + mic WAVs of one listening become one 16 kHz file for `pma replay`."""

    def setUp(self):
        tools = str(Path(__file__).resolve().parents[1] / 'tools')
        if tools not in sys.path:
            sys.path.insert(0, tools)
        import mix_audio
        self.mix = mix_audio
        self.worker = __import__('audio_worker')

    def wav(self, directory, name, rate, samples):
        writer = self.worker.WavWriter(Path(directory) / name, rate)
        writer.write(samples)
        writer.close()

    def sine(self, rate, seconds, freq, amplitude):
        import numpy as np
        t = np.arange(int(rate * seconds)) / rate
        return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)

    def read(self, path):
        import numpy as np
        import wave
        with wave.open(str(path), 'rb') as reading:
            self.assertEqual((reading.getnchannels(), reading.getsampwidth(), reading.getframerate()), (1, 2, 16000))
            return np.frombuffer(reading.readframes(reading.getnframes()), dtype='<i2').astype(np.float32) / 32768

    def test_own_voice_slot_is_added_and_echo_slot_is_not(self):
        import numpy as np
        slot = self.mix.SLOT
        speaker = np.zeros(4 * slot, dtype=np.float32)
        speaker[:2 * slot] = 0.1                    # slots 0-1: the meeting talks
        mic = np.zeros(4 * slot, dtype=np.float32)
        mic[:slot] = 0.15                           # slot 0: mic hears the speakers again (1.5x, not clearly louder)
        mic[slot:2 * slot] = 0.3                    # slot 1: the user talks over the meeting (3x)
        mic[2 * slot:3 * slot] = 0.2                # slot 2: the user talks, meeting quiet
        mic[3 * slot:] = 0.002                      # slot 3: room noise below SOUND_RMS
        out = self.mix.mix_block(speaker, mic)
        self.assertAlmostEqual(float(out[0]), 0.1, places=5)                     # echo not added
        self.assertAlmostEqual(float(out[slot]), 0.4, places=5)                  # own voice added
        self.assertAlmostEqual(float(out[2 * slot]), 0.2, places=5)              # own voice, alone
        self.assertAlmostEqual(float(out[3 * slot]), 0.0, places=5)              # noise not added
        loud = self.mix.mix_block(np.full(slot, 0.9, dtype=np.float32), np.full(slot, 0.95, dtype=np.float32), speaker_present=False)
        self.assertEqual(float(loud.max()), 1.0)                                 # clipped to [-1, 1], never wrapped

    def test_mic_without_speaker_file_is_kept_whole(self):
        import numpy as np
        out = self.mix.mix_block(np.zeros(0, dtype=np.float32), np.full(self.mix.SLOT, 0.003, dtype=np.float32), speaker_present=False)
        self.assertAlmostEqual(float(out[0]), 0.003, places=6)

    def test_inputs_at_different_rates_become_one_16k_file_of_the_longer_length(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            self.wav(directory, 'cap-speaker.wav', 48000, self.sine(48000, 3.0, 440, 0.1))
            self.wav(directory, 'cap-mic.wav', 44100, self.sine(44100, 3.5, 880, 0.4))
            target, samples = self.mix.mix_files(directory, 'cap')
            self.assertEqual(target.name, 'cap-mix.wav')
            data = self.read(target)
            self.assertEqual(len(data), samples)
            self.assertLessEqual(abs(samples - 3.5 * 16000), 2)                  # the longer input sets the length
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['cap-mic.wav', 'cap-mix.wav', 'cap-speaker.wav'])  # no .part left
            self.assertLessEqual(float(abs(data).max()), 1.0)

    def test_missing_mic_file_gives_the_speaker_resampled(self):
        import numpy as np
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            self.wav(directory, 'cap-speaker.wav', 48000, self.sine(48000, 2.0, 440, 0.2))
            target, samples = self.mix.mix_files(directory, 'cap')
            data = self.read(target)
            self.assertLessEqual(abs(samples - 32000), 2)
            self.assertGreater(float(np.sqrt(np.mean(data[4000:-4000] ** 2))), 0.13)  # 0.2/sqrt(2) = 0.141
            self.assertTrue(mix_has_tone(data, 440))

    def test_nothing_to_mix_raises_and_leaves_no_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                self.mix.mix_files(directory, 'cap')
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertEqual(self.mix.main(['mix_audio.py', directory, 'cap']), 1)
            self.assertEqual(self.mix.main(['mix_audio.py', directory, '../x']), 2)

    def test_long_input_streams_in_small_blocks(self):
        import numpy as np
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            # 70 s of speaker: more than one block, so the stateful resamplers and the 1 s loop are exercised end to end.
            self.wav(directory, 'cap-speaker.wav', 44100, self.sine(44100, 70.0, 300, 0.1))
            reads = []
            original = self.mix.Channel.read
            self.mix.Channel.read = lambda channel, count: reads.append(count) or original(channel, count)
            try:
                target, samples = self.mix.mix_files(directory, 'cap')
            finally:
                self.mix.Channel.read = original
            self.assertTrue(all(count == self.mix.BLOCK for count in reads))
            self.assertLessEqual(abs(samples - 70 * 16000), 2)
            data = self.read(target)
            self.assertLess(float(abs(np.diff(data)).max()), 0.05)               # no jump at block seams


def mix_has_tone(data, freq):
    import numpy as np
    spectrum = np.abs(np.fft.rfft(data[:16000]))
    return abs(int(np.argmax(spectrum)) - freq) <= 1


if __name__ == '__main__':
    unittest.main()
