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

    def test_mic_follows_the_zoom_mic_button_and_unknown_means_off(self):
        gate = self.worker.mic_gate
        self.assertEqual(gate({'meeting': True, 'muted': False, 'device': 'Mic'}), 'ON')
        self.assertEqual(gate({'meeting': True, 'muted': True}), 'MUTED')
        self.assertEqual(gate({'meeting': True, 'muted': None}), 'MUTED')
        self.assertEqual(gate({'meeting': False, 'muted': None}), 'NO_MEETING')
        self.assertEqual(gate({'error': 'zoom_mic_state stopped'}), 'UNKNOWN')
        self.assertEqual(gate(None), 'UNKNOWN')

    def test_mic_is_the_one_zoom_uses_else_the_windows_default(self):
        mics = [(12, 'Mic in at front panel (Pink) (Realtek(R) Audio)'), (15, 'Headset (Jabra)')]
        self.assertEqual(self.worker.pick_mic(mics, 12, 'Headset (Jabra)'), (15, 'Headset (Jabra)'))
        self.assertEqual(self.worker.pick_mic(mics, 12, None), mics[0])
        self.assertEqual(self.worker.pick_mic(mics, 12, 'Unplugged device'), mics[0])
        self.assertEqual(self.worker.pick_mic([], -1, None), (None, None))

    def test_greeting_alone_is_flagged_but_inside_a_sentence_is_not(self):
        flags = self.worker.segment_flags
        self.assertIn('LIKELY_HALLUCINATION', flags('Chào mừng.', self.segment(), 'vi'))
        self.assertNotIn('LIKELY_HALLUCINATION', flags('Chào mừng anh Phet về lại công ty', self.segment(), 'vi'))

    def test_collapse_repeats_keeps_count(self):
        self.assertEqual(self.worker.collapse_repeats('ok dạ dạ dạ dạ dạ dạ dạ xong'), 'ok dạ [×7] xong')
        self.assertEqual(self.worker.collapse_repeats('ba ba xe'), 'ba ba xe')


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


if __name__ == '__main__':
    unittest.main()
