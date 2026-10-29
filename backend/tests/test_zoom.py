import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import zoom
from services.ffmpeg_service import FFmpegService

FLAGS = 0x08000000 if os.name == 'nt' else 0


def quadrant_video(path: Path, seconds=10, size=(640, 360)):
    """四象限不同顏色（左上紅、右上綠、左下藍、右下白）的測試片。"""
    w, h = size
    subprocess.run(['ffmpeg', '-v', 'error', '-y',
                    '-f', 'lavfi', '-i', f'color=red:s={w // 2}x{h // 2}:r=30:d={seconds}',
                    '-f', 'lavfi', '-i', f'color=lime:s={w // 2}x{h // 2}:r=30:d={seconds}',
                    '-f', 'lavfi', '-i', f'color=blue:s={w // 2}x{h // 2}:r=30:d={seconds}',
                    '-f', 'lavfi', '-i', f'color=white:s={w // 2}x{h // 2}:r=30:d={seconds}',
                    '-f', 'lavfi', '-i', f'sine=d={seconds}',
                    '-filter_complex', '[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack[v]',
                    '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(path)],
                   check=True, capture_output=True, creationflags=FLAGS)


def pixel(video: Path, t: float, x: float, y: float) -> tuple[int, int, int]:
    """取某秒某位置（比例）的 RGB。"""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(video), '-frames:v', '1',
                          '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         check=True, capture_output=True, creationflags=FLAGS).stdout
    i = (int(y * 35) * 64 + int(x * 63)) * 3
    return raw[i], raw[i + 1], raw[i + 2]


def color(rgb):
    r, g, b = rgb
    return {(1, 0, 0): 'red', (0, 1, 0): 'lime', (0, 0, 1): 'blue', (1, 1, 1): 'white'}.get(
        (int(r > 128), int(g > 128), int(b > 128)), str(rgb))


class ZoomMathTests(unittest.TestCase):
    def test_zoom_at_matches_frontend_formula(self):
        z = [{'id': 'z', 'start': 2, 'end': 6, 'x': 0.9, 'y': 0.1, 'scale': 2, 'ease': 0.5}]
        self.assertEqual(zoom.zoom_at(z, 1), (1, 0.5, 0.5))
        self.assertAlmostEqual(zoom.zoom_at(z, 2.25)[0], 1.5)
        self.assertEqual(zoom.zoom_at(z, 4), (2, 0.75, 0.25))
        self.assertEqual(zoom.zoom_at(z, 6)[0], 1)

    def test_sanitize_rejects_untrusted_values(self):
        ok = {'start': 1, 'end': 2, 'x': .5, 'y': .5, 'scale': 2}
        self.assertEqual(zoom.sanitize([ok])[0]['ease'], 0.4)
        for bad in ([{**ok, 'scale': "2);drawtext=text='x"}], [{**ok, 'x': float('nan')}], [{**ok, 'end': 1.2}],
                    [{**ok, 'scale': 9}], [ok, {**ok, 'start': 1.5, 'end': 3}], 'x', [{'start': 1}]):
            with self.assertRaises(ValueError, msg=bad):
                zoom.sanitize(bad)

    def test_cursor_suggestions_group_clicks(self):
        track = {'width': 1000, 'height': 500, 'clicks': [
            [5.0, 800, 100, 1], [6.0, 820, 110, 1], [6.5, 790, 90, 1],   # 一組（右上）
            [7.5, 100, 450, 1],                                          # 時間接近但位置很遠 → 另一組
            [20.0, 500, 250, 1],                                         # 很久之後 → 另一組
        ]}
        s = zoom.suggest_from_cursor(track, 30)
        self.assertEqual([z['clicks'] for z in s], [3, 1, 1])
        self.assertAlmostEqual(s[0]['x'], 0.803, places=3)
        self.assertEqual(s[0]['start'], 4.2)
        for a, b in zip(s, s[1:]):
            self.assertLessEqual(a['end'], b['start'])
        self.assertEqual(zoom.sanitize([{**z} for z in s])[0]['scale'], s[0]['scale'])
        self.assertEqual(zoom.suggest_from_cursor({'width': 0, 'height': 0, 'clicks': []}, 10), [])


class ZoomExportTests(unittest.TestCase):
    def test_export_zooms_on_source_time_with_trim_and_speed(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'quad.mp4'
            quadrant_video(src)
            out = Path(tmp) / 'out.mp4'
            ass = Path(tmp) / 'none.ass'
            ass.write_text('', encoding='utf-8')
            # 來源 2–10 秒、2 倍速 → 成品 4 秒；縮放在來源 4–8 秒放大右上（綠）
            clips = [{'video_path': str(src), 'trim_start': 2, 'trim_end': 10, 'speed': 2, 'output_duration': 4,
                      'zooms': [{'id': 'z', 'start': 4, 'end': 8, 'x': 0.75, 'y': 0.25, 'scale': 2, 'ease': 0.4}]}]
            for _ in FFmpegService.export_timeline_with_progress(clips, str(ass), str(out), use_nvenc=False,
                                                                 video_width=640, video_height=360):
                pass
            self.assertAlmostEqual(FFmpegService.get_media_info(str(out))['duration'], 4, delta=0.1)
            # 成品 0.3 秒 = 來源 2.6：沒縮放，四象限都在
            self.assertEqual([color(pixel(out, 0.3, x, y)) for x, y in ((.2, .2), (.8, .2), (.2, .8), (.8, .8))],
                             ['red', 'lime', 'blue', 'white'])
            # 成品 2.0 秒 = 來源 6：完全放大右上，整個畫面都是綠
            self.assertEqual({color(pixel(out, 2.0, x, y)) for x, y in ((.1, .1), (.9, .1), (.1, .9), (.9, .9))},
                             {'lime'})
            # 成品 3.6 秒 = 來源 9.2：已縮回
            self.assertEqual(color(pixel(out, 3.6, .2, .8)), 'blue')


    def test_many_zooms_in_one_clip_export(self):
        """長錄影大量縮放：表達式走 filter_script，不受命令列長度限制。"""
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'quad.mp4'
            quadrant_video(src, seconds=30, size=(320, 180))
            out = Path(tmp) / 'out.mp4'
            ass = Path(tmp) / 'none.ass'
            ass.write_text('', encoding='utf-8')
            zs = [{'id': f'z{i}', 'start': i * 0.7, 'end': i * 0.7 + 0.6, 'x': 0.75, 'y': 0.25, 'scale': 2}
                  for i in range(40)]
            self.assertGreater(len(','.join(zoom.zoom_filters(zs, 0, 1, 320, 180))), 32767 // 4)
            clips = [{'video_path': str(src), 'trim_start': 0, 'trim_end': 30, 'speed': 1, 'output_duration': 30,
                      'zooms': zs}]
            for _ in FFmpegService.export_timeline_with_progress(clips, str(ass), str(out), use_nvenc=False,
                                                                 video_width=320, video_height=180):
                pass
            self.assertAlmostEqual(FFmpegService.get_media_info(str(out))['duration'], 30, delta=0.1)
            self.assertEqual(color(pixel(out, 0.7 * 10 + 0.3, .2, .8)), 'lime')   # 第 11 段放大中
            self.assertEqual(color(pixel(out, 29, .2, .8)), 'blue')               # 區段之後恢復


if __name__ == '__main__':
    unittest.main()
