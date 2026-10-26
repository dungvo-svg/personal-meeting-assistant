"""No device capture: verify format conversion and orphan-watch termination."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys
import unittest


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
