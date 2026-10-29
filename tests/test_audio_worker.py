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
