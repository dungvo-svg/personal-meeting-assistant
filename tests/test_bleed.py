"""Speaker sound leaking into the microphone: envelope check of the audio worker. Synthetic signals only, no audio, no model."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))

RATE = 16000


def speech_like(seconds, seed, loud=0.08, pause=0.35):
    """Noise whose loudness rises and falls like phrases with pauses (not a real voice)."""
    import numpy as np
    rng = np.random.default_rng(seed)
    slots = int(seconds * 10)
    gate = np.ones(slots)
    for start in range(0, slots, 7):                       # a pause now and then
        if rng.random() < pause:
            gate[start:start + int(rng.integers(2, 5))] = 0.02
    level = loud * gate * (0.5 + rng.random(slots))
    return np.concatenate([rng.standard_normal(RATE // 10) * value for value in level]).astype(np.float32)


class BleedTests(unittest.TestCase):
    def setUp(self):
        import audio_worker
        import numpy as np
        self.worker, self.np = audio_worker, np

    def noise(self, seconds, level, seed=99):
        return (self.np.random.default_rng(seed).standard_normal(int(seconds * RATE)) * level).astype(self.np.float32)

    def test_mic_that_follows_the_room_is_bleed_even_when_much_quieter(self):
        room = speech_like(6, 1)
        leak = self.np.roll(room, 1600) * 0.06 + self.noise(6, 0.0008)   # 0.1 s of delay, 1:16 in level
        flags = self.worker.bleed_flags(leak, room)
        self.assertTrue(any(f.startswith('MIC_BLEED_ENV') for f in flags), flags)

    def test_owner_voice_over_a_busy_room_is_not_bleed(self):
        room = speech_like(6, 1)
        owner = speech_like(6, 2, loud=0.05)                            # different phrases
        self.assertFalse(any(f.startswith('MIC_BLEED') for f in self.worker.bleed_flags(owner, room)))

    def test_owner_voice_over_a_silent_room_is_not_bleed(self):
        room = self.noise(6, 0.0005)
        owner = speech_like(6, 3, loud=0.05)
        self.assertEqual(self.worker.bleed_flags(owner, room), [])

    def test_owner_voice_over_a_flat_hum_is_not_bleed(self):
        hum = self.noise(6, 0.05)                                       # loud but with no shape to follow
        self.assertFalse(any(f.startswith('MIC_BLEED') for f in self.worker.bleed_flags(speech_like(6, 4), hum)))

    def test_short_chunk_is_left_to_the_text_check(self):
        room = speech_like(1.0, 5)
        leak = room * 0.05
        self.assertEqual(self.worker.envelope_correlation(self.worker.envelope(leak, RATE), self.worker.envelope(room, RATE)), None)
        self.assertFalse(any(f.startswith('MIC_BLEED') for f in self.worker.bleed_flags(leak, room)))

    def test_middling_correlation_stays_the_owner(self):
        room = speech_like(6, 6)
        mixed = room * 0.05 + speech_like(6, 7, loud=0.06)              # owner talking over the room
        value = self.worker.envelope_correlation(self.worker.envelope(mixed, RATE), self.worker.envelope(room, RATE))
        self.assertTrue(value is None or value < self.worker.BLEED_CORRELATION, value)

    def test_faint_mic_in_a_loud_room_is_only_a_hint(self):
        room = speech_like(6, 8, loud=0.1)
        faint = speech_like(6, 9, loud=0.003)                           # unrelated, at the noise floor
        flags = self.worker.bleed_flags(faint, room)
        self.assertIn('MIC_FAINT', flags)
        self.assertFalse(any(f.startswith('MIC_BLEED') for f in flags))

    def test_normal_owner_level_is_not_faint(self):
        self.assertNotIn('MIC_FAINT', self.worker.bleed_flags(speech_like(6, 10, loud=0.05), speech_like(6, 11, loud=0.05)))

    def test_envelope_edges(self):
        self.assertEqual(self.worker.envelope(self.np.zeros(10, dtype=self.np.float32), RATE), [])
        self.assertIsNone(self.worker.envelope_correlation([], []))


if __name__ == '__main__':
    unittest.main()
