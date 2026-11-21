"""配樂壓低、平台響度、節拍偵測：用合成聲音實測（不靠肉耳）。"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import audio_mix as A  # noqa: E402

if sys.platform == "win32":
    import ctypes
    ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(-1), 0x4000)


def lavfi(expr: str, seconds: float, out: str, sr: int = 48000):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"aevalsrc='{expr}':s={sr}:d={seconds}", "-ac", "2", out],
                   check=True, creationflags=A._FLAGS)


def rms_db(x: np.ndarray) -> float:
    return 20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-12)


class AudioMixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="ljcut-audio-"))
        cls.music = str(cls.dir / "music.wav")
        lavfi("0.3*sin(2*PI*330*t)", 6, cls.music)

    def test_ducking_lowers_music_by_requested_db_only_during_speech(self):
        # 前端算的包絡：2–4 秒旁白，壓低 12 dB，前後 0.25 秒斜坡
        env = [[0, 0], [1.75, 0], [2.0, -12], [4.0, -12], [4.25, 0], [6, 0]]
        m = A.sanitize_music({"volume": 1, "envelope": env, "fadeIn": 0, "fadeOut": 0, "loop": True}, 6)
        out = str(self.dir / "ducked.wav")
        A.render_music(self.music, m, out)
        x = A.decode(out)[:, 0]
        quiet, loud = rms_db(x[int(2.3 * 48000):int(3.7 * 48000)]), rms_db(x[int(0.3 * 48000):int(1.5 * 48000)])
        self.assertAlmostEqual(loud - quiet, 12, delta=0.3)
        # 沒包絡（沒旁白）時不壓低
        flat = A.sanitize_music({"volume": 1, "envelope": [], "fadeIn": 0, "fadeOut": 0}, 6)
        A.render_music(self.music, flat, out)
        y = A.decode(out)[:, 0]
        self.assertLess(abs(rms_db(y[int(2.3 * 48000):int(3.7 * 48000)]) - loud), 0.3)

    def test_loop_offset_and_length(self):
        m = A.sanitize_music({"volume": 1, "envelope": [], "offset": 1, "loop": True, "fadeIn": 0, "fadeOut": 0}, 14)
        out = str(self.dir / "loop.wav")
        A.render_music(self.music, m, out)
        x = A.decode(out)
        self.assertEqual(x.shape[0], 14 * 48000)
        self.assertGreater(rms_db(x[13 * 48000:, 0]), -20)   # 循環到結尾仍有聲音

    def test_platform_loudness_within_1_lu(self):
        src = str(self.dir / "speech.wav")
        lavfi("0.05*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))", 20, src)
        for target in (-14.0, -16.0):
            out = str(self.dir / f"norm{int(-target)}.wav")
            rep = A.normalize(src, out, target)
            after = float(A.measure(out, target)["input_i"])
            self.assertLess(abs(after - target), 1.0, rep)
            self.assertLessEqual(float(A.measure(out, target)["input_tp"]), A.TRUE_PEAK + 0.6)

    def test_beats_on_metronome_within_50ms(self):
        for bpm, first in ((120, 0.25), (97, 0.1)):
            per = 60 / bpm
            src = str(self.dir / f"click{bpm}.wav")
            lavfi(f"if(lt(mod(t-{first},{per}),0.02),0.8*sin(2*PI*1200*t),0)", 30, src, 44100)
            r = A.beats(src)
            self.assertAlmostEqual(r["bpm"], bpm, delta=1.0)
            b = np.array(r["beats"])
            err = np.abs(b - (first + per * np.round((b - first) / per)))
            self.assertLess(err.max(), 0.05, f"{bpm} BPM 最大誤差 {err.max() * 1000:.0f}ms")

    def test_resolve_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            A.sanitize_music({"volume": 5}, 10)
        with self.assertRaises(ValueError):
            A.sanitize_music({"envelope": [[2, 0], [1, 0]]}, 10)
        with self.assertRaises(ValueError):
            A.resolve({"loudness": "loud"}, 10, self.dir)
        with self.assertRaises(ValueError):
            A.resolve({"music": {"asset": {"id": "a_000000000000"}}}, 10, self.dir)
        self.assertIsNone(A.resolve({"loudness": "off"}, 10, self.dir))


if __name__ == "__main__":
    unittest.main()
