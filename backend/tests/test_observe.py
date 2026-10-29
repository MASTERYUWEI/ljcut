"""觀察工具（/api/control/observe/*）：唯讀分析、工作區限制、無需編輯器在線。

測試素材：8 秒，畫面在 2/4/6 秒換色；每秒前 0.2 秒有嗶聲、其餘 0.8 秒靜音。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from services.control import LocalControl
from control_fixture import create_fixture


class ObserveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.uploads = cls.root / 'uploads'
        cls.uploads.mkdir()
        create_fixture(cls.uploads / 'fixture01.mp4')
        with patch.dict(os.environ, {'LJCUT_CONTROL_WORKSPACE': str(cls.root / 'workspace')}):
            cls.control = LocalControl(cls.uploads)
        app = FastAPI()
        app.include_router(cls.control.router)
        cls.client = TestClient(app)
        cls.headers = {'Authorization': 'Bearer ' + cls.control.token}

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.temp.cleanup()

    def post(self, path, body, auth=True):
        return self.client.post('/api/control' + path, json=body, headers=self.headers if auth else {})

    def test_requires_token(self):
        self.assertEqual(self.post('/observe/silences', {'mediaId': 'fixture01'}, auth=False).status_code, 401)

    def test_frames_contact_sheet(self):
        res = self.post('/observe/frames', {'mediaId': 'fixture01', 'times': [1, 3, 5, 7], 'cols': 2, 'thumbWidth': 200})
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body['grid'], [2, 2])
        sheet = Image.open(self.root / 'workspace' / body['path']).convert('RGB')
        w, h = sheet.size
        # 每格中央取色：紅 → 綠 → 藍 → 黃（避開左上時間標籤）
        centers = [sheet.getpixel((int(w * x), int(h * y))) for x, y in [(.25, .3), (.75, .3), (.25, .8), (.75, .8)]]
        dominant = [max(range(3), key=lambda i: c[i]) for c in centers]
        self.assertEqual(dominant[:3], [0, 1, 2])
        self.assertTrue(centers[3][0] > 150 and centers[3][1] > 150 and centers[3][2] < 100)
        # 圖檔可經 observe/file 讀回
        got = self.client.get('/api/control/observe/file', params={'path': body['path']}, headers=self.headers)
        self.assertEqual(got.status_code, 200)

    def test_silences(self):
        body = self.post('/observe/silences', {'mediaId': 'fixture01', 'noiseDb': -40, 'minSilence': 0.5}).json()
        self.assertGreaterEqual(len(body['silences']), 6)
        for s in body['silences']:
            self.assertAlmostEqual(s['duration'], 0.8, delta=0.15)

    def test_scene_changes(self):
        body = self.post('/observe/scenes', {'mediaId': 'fixture01', 'threshold': 0.2}).json()
        # 2 秒處是紅→綠：ffmpeg 的紅與綠亮度幾乎相同，scene 分數 ≈0 抓不到（亮度為主的偵測）；
        # 4 秒（→藍）與 6 秒（→黃）亮度變化大，必須偵測到。
        for t in (4, 6):
            self.assertTrue(any(abs(c - t) < 0.1 for c in body['changes']), (t, body['changes']))

    def test_audio_levels(self):
        body = self.post('/observe/audio-levels', {'mediaId': 'fixture01', 'window': 0.5}).json()
        self.assertEqual(len(body['levels']), 16)
        loud, quiet = body['levels'][0], body['levels'][1]   # 0–0.5s 有嗶聲、0.5–1s 靜音
        self.assertGreater(loud - quiet, 20)

    def test_rejects_bad_input(self):
        self.assertEqual(self.post('/observe/frames', {'mediaId': '../x', 'times': [1]}).json()['detail']['code'], 'INVALID_MEDIA')
        self.assertEqual(self.post('/observe/frames', {'mediaId': 'nope', 'times': [1]}).json()['detail']['code'], 'MEDIA_NOT_FOUND')
        self.assertEqual(self.post('/observe/frames', {'path': '../../etc', 'times': [1]}).json()['detail']['code'], 'OUTSIDE_WORKSPACE')
        self.assertEqual(self.post('/observe/silences', {'mediaId': 'fixture01', 'noiseDb': 5}).json()['detail']['code'], 'INVALID_PARAM')
        res = self.client.get('/api/control/observe/file', params={'path': 'production-settings.json'}, headers=self.headers)
        self.assertIn(res.status_code, (403, 404))


if __name__ == '__main__':
    unittest.main()
