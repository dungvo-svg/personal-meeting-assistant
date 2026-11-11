"""Exercise the recorder entry point with fake native backends; never open hardware."""
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy  # load before patch.dict snapshots sys.modules; no native audio backend

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import recorder


class CapturePrivacyTests(unittest.TestCase):
    def run_entry(self, mic_args):
        opens = []

        class FakeSource:
            rate = 16000
            name = 'synthetic source'

            def __init__(self, hub, index, name, loopback):
                self.loopback = loopback

            def open(self):
                opens.append('speaker' if self.loopback else 'mic')

            def close(self):
                pass

        class FakeRecorder:
            def __init__(self, directory, channels, *args):
                self.channels = channels
                self.stop_event = threading.Event()

            def claim(self):
                pass

            def run(self):
                # Use the real ChannelRecorder device-open path, with an instrumented source.
                for channel in self.channels:
                    channel.step()
                    channel.finish()
                return 0

        fake_pa = types.SimpleNamespace(PyAudio=lambda: types.SimpleNamespace(terminate=lambda: None))
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(sys.modules, {'pyaudiowpatch': fake_pa}), \
                patch.object(recorder, 'PortAudioHub'), \
                patch.object(recorder, 'DeviceSource', FakeSource), \
                patch.object(recorder, 'Recorder', FakeRecorder), \
                patch.object(recorder, 'MicAuto', side_effect=AssertionError('unexpected auto mic')), \
                patch.object(recorder, 'start_mic_state'), \
                patch.object(recorder, 'raise_priority'), \
                patch.object(recorder.threading, 'Thread'):
            result = recorder.main(['--dir', directory, '--speaker-device', '13', '--speaker-name', 'Loop', *mic_args])
        self.assertEqual(result, 0)
        return opens

    def test_loopback_only_entry_opens_zero_microphones(self):
        self.assertEqual(self.run_entry([]), ['speaker'])

    def test_instrumentation_detects_explicit_microphone_open(self):
        self.assertEqual(self.run_entry(['--mic-device', '12', '--mic-name', 'Mic']), ['speaker', 'mic'])


if __name__ == '__main__':
    unittest.main()
