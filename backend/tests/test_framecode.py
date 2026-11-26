"""逐格驗證用的條碼：讀得回來，而且混合、位移、全黑的畫面一律讀不出來（不能猜成別格）。"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "corpus"))
import framecode as F  # noqa: E402


def frame(tag, n):
    img = np.full((180, 320), 80, np.uint8)
    F.draw(img, tag, n)
    return img


class FrameCodeTest(unittest.TestCase):
    def test_round_trip(self):
        for tag, n in ((1, 0), (7, 32767), (3, 1234), (5, 45)):
            self.assertEqual(F.read(frame(tag, n)), (tag, n))

    def test_blend_shift_black_refused(self):
        a, b = frame(1, 44), frame(1, 45)
        self.assertIsNone(F.read(((a.astype(int) + b) // 2).astype(np.uint8)))   # 兩格混合（轉場、取樣錯）
        self.assertIsNone(F.read(np.roll(a, 8, axis=1)))                          # 畫面位移半塊
        self.assertIsNone(F.read(np.zeros((180, 320), np.uint8)))                 # 黑格
        self.assertIsNone(F.read(np.full((180, 320), 235, np.uint8)))             # 白格

    def test_single_bit_error_caught_by_checksum(self):
        img = frame(2, 100)
        r, c = divmod(10, F.COLS)   # 翻轉第 10 位元（格數的一位）
        blk = img[r * 16:(r + 1) * 16, c * 16:(c + 1) * 16]
        blk[:] = F.LO if blk.mean() > 128 else F.HI
        self.assertIsNone(F.read(img))


if __name__ == "__main__":
    unittest.main()
