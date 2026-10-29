import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from services import overlay
from services.ffmpeg_service import FFmpegService
from test_zoom import quadrant_video, pixel, color


def ov(**kw):
    base = {'id': kw.pop('id', 'o'), 'start': 0, 'end': 3, 'x': 0.5, 'y': 0.5}
    return {**base, **kw}


class OverlayUnitTests(unittest.TestCase):
    def test_sanitize(self):
        ok = overlay.sanitize([ov(kind='box', w=.2, h=.2), ov(id='t', kind='title', text='標題', sub='副標')])
        self.assertEqual(ok[0]['color'], 'red')
        self.assertEqual(ok[1]['position'], 'bottom-left')
        for bad in ([ov(kind='box')], [ov(kind='box', w=.8, h=.2, x=.5)], [ov(kind='step')],
                    [ov(kind='step', text='1234')], [ov(kind='title', text='a\nb')], [ov(kind='arrow', **{'from': 'up'})],
                    [ov(kind='box', w=.1, h=.1, color='pink')], [ov(kind='box', w=.1, h=.1, end=0.1)],
                    [ov(kind='laser')], [ov(kind='box', w=.1, h=.1, x="0.5);drawtext")]):
            with self.assertRaises(ValueError, msg=bad):
                overlay.sanitize(bad)

    def test_render_every_kind_stays_in_frame(self):
        W, H = 1280, 720
        items = overlay.sanitize([
            ov(id='a', kind='box', x=.8, y=.02, w=.19, h=.2, text='在畫面邊緣的說明文字'),
            ov(id='b', kind='arrow', x=.05, y=.05, **{'from': 'top-left'}, text='左上角'),
            ov(id='c', kind='spotlight', x=.1, y=.1, w=.3, h=.3, text='聚光'),
            ov(id='d', kind='step', x=.5, y=.5, text='12'),
            ov(id='e', kind='title', text='很長的標題文字測試', sub='第二行', position='top-center'),
        ])
        for o in items:
            img, left, top = overlay.render(o, W, H)
            self.assertGreater(img.getbbox()[2], 0, o['kind'])
            self.assertTrue(0 <= left and 0 <= top and left + img.width <= W + 2 and top + img.height <= H + 2, o['kind'])
        spot, _, _ = overlay.render(items[2], W, H)
        self.assertEqual(spot.size, (W, H))
        self.assertEqual(spot.getpixel((int(W * .25), int(H * .25)))[3], 0)      # 聚光燈中間透明
        self.assertGreater(spot.getpixel((int(W * .8), int(H * .8)))[3], 100)    # 其他地方變暗

    def test_render_cache_and_anim(self):
        with tempfile.TemporaryDirectory() as tmp:
            o = overlay.sanitize([ov(kind='step', text='1')])[0]
            a = overlay.render_cached(o, 640, 360, Path(tmp))
            b = overlay.render_cached({**o, 'start': 9, 'end': 12}, 640, 360, Path(tmp))   # 時間不影響外觀 → 同一張
            self.assertEqual(a['file'], b['file'])
        o = {'kind': 'box', 'start': 1, 'end': 3}
        self.assertEqual(overlay.anim_state(o, 1), (0, 0.8, 0))
        self.assertEqual(overlay.anim_state(o, 2), (1, 1.0, 0))
        self.assertAlmostEqual(overlay.anim_state(o, 2.9)[0], 0.5)
        self.assertEqual(overlay.anim_state({'kind': 'title', 'start': 0, 'end': 2}, 0)[2], -40)


class OverlayExportTests(unittest.TestCase):
    def test_export_layers_follow_zoom_and_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'quad.mp4'
            quadrant_video(src)
            out = Path(tmp) / 'out.mp4'
            ass = Path(tmp) / 'none.ass'
            ass.write_text('', encoding='utf-8')
            # 來源 2–10 秒、2 倍速 → 成品 4 秒（成品 t = (來源 - 2) / 2）
            overlays = [
                ov(id='spot', kind='spotlight', start=2, end=4.4, x=.55, y=.55, w=.4, h=.4),        # 成品 0–1.2：右下以外變暗
                ov(id='step', kind='step', start=4.6, end=8, x=.25, y=.25, text='1', color='blue'),  # 成品 1.3–3：左上放大後在畫面正中
                ov(id='title', kind='title', start=8.4, end=10, text='標題'),                       # 成品 3.2–4：左下深色標題條
            ]
            zooms = [{'id': 'z', 'start': 4.6, 'end': 8, 'x': .25, 'y': .25, 'scale': 2}]
            clips = [{'video_path': str(src), 'trim_start': 2, 'trim_end': 10, 'speed': 2, 'output_duration': 4,
                      'zooms': zooms, 'overlays': overlays}]
            for _ in FFmpegService.export_timeline_with_progress(clips, str(ass), str(out), use_nvenc=False,
                                                                 video_width=640, video_height=360):
                pass
            self.assertAlmostEqual(FFmpegService.get_media_info(str(out))['duration'], 4, delta=0.1)
            r, g, b = pixel(out, 0.6, .2, .2)                        # 聚光燈外：紅色變暗
            self.assertTrue(80 < r < 170 and g < 60, (r, g, b))
            self.assertEqual(color(pixel(out, 0.6, .75, .75)), 'white')     # 聚光燈裡：維持白
            r, g, b = pixel(out, 2.2, .5, .5)                        # 步驟圓圈（#0A84FF）跟著縮放到畫面中央
            self.assertTrue(b > 200 and r < 100, (r, g, b))
            self.assertEqual(color(pixel(out, 2.2, .1, .1)), 'red')         # 放大後左上角仍是紅色象限
            r, g, b = pixel(out, 3.7, .08, .9)                       # 標題條：深色底蓋住藍色象限
            self.assertTrue(b < 180 and r < 60 and g < 60, (r, g, b))
            self.assertGreater(pixel(out, 3.0, .08, .9)[2], 230)     # 標題出現前仍是純藍
            self.assertEqual(color(pixel(out, 3.7, .8, .8)), 'white')      # 標題不影響其他地方


if __name__ == '__main__':
    unittest.main()
