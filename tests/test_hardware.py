"""Hardware tiers (owner 21/11): which machine may run which meeting. Fake measurements only; no nvidia-smi, no models."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import hardware  # noqa: E402


def machine(vram=None, ram=16.0, disk=50.0, windows=True, lao=True):
    return {'windows': windows, 'ramGiB': ram, 'diskFreeGiB': disk, 'cpus': 12,
            'gpus': [{'name': 'GPU', 'vramMiB': vram, 'driver': '1'}] if vram else [],
            'models': {'main': 'whisper-large-v3-turbo-ct2', 'mainInstalled': True, 'lo': 'buzzasr-lao-ct2', 'loInstalled': lao}}


class Tiers(unittest.TestCase):
    def test_the_tested_machine_is_full_and_runs_lao(self):
        v = hardware.assess(['vi', 'lo', 'th'], machine(vram=6144, ram=15.8))
        self.assertEqual((v['tier'], v['meeting']['ok']), ('day-du', True))

    def test_full_hardware_without_the_lao_model_refuses_lao_and_says_what_to_install(self):
        v = hardware.assess(['vi', 'lo'], machine(vram=8192, lao=False))
        self.assertEqual((v['tier'], v['meeting']['refused']), ('day-du', ['lo']))
        self.assertIn('setup_lao_gpu', v['reasons'][0])

    def test_a_4gb_card_is_vietnamese_only(self):
        v = hardware.assess(['vi', 'lo', 'th'], machine(vram=4096))
        self.assertEqual((v['tier'], v['meeting']['refused']), ('tieng-viet', ['lo']))
        self.assertTrue(hardware.assess(['vi'], machine(vram=4096))['meeting']['ok'])

    def test_no_gpu_little_ram_or_disk_or_not_windows_is_not_enough(self):
        for m in (machine(), machine(vram=2048), machine(vram=8192, ram=6), machine(vram=8192, disk=4), machine(vram=8192, windows=False)):
            v = hardware.assess(['vi'], m)
            self.assertEqual(v['tier'], 'khong-du', m)
            self.assertFalse(v['meeting']['ok'])
            self.assertTrue(v['reasons'])


if __name__ == '__main__':
    unittest.main()
