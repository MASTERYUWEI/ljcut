import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
FLAGS = 0x08000000 if os.name == 'nt' else 0


class ExportCancelTests(unittest.TestCase):
    def test_cancel_running_timeline_export(self):
        """介面匯出帶 export_id；按取消後 ffmpeg 被終止、串流回 cancelled、不產生成品。"""
        from fastapi.testclient import TestClient
        import main
        fid = uuid.uuid4().hex[:12]
        src = main.UPLOAD_DIR / f"{fid}.mp4"
        main.UPLOAD_DIR.mkdir(exist_ok=True)
        # 60 秒、較高解析度：確保取消時匯出還在進行
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60',
                        '-f', 'lavfi', '-i', 'sine=d=60', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(src)], check=True, capture_output=True, creationflags=FLAGS)
        out = Path(tempfile.mkdtemp()) / 'cancelled.mp4'
        export_id = str(uuid.uuid4())
        client = TestClient(main.app)
        events = []

        def run():
            with client.stream('POST', '/api/export-timeline', json={
                'clips': [{'file_id': fid, 'trim_start': 0, 'trim_end': 60, 'speed': 1, 'segments': []}],
                'style': {}, 'output_path': str(out), 'export_id': export_id,
                'video_width': 1920, 'video_height': 1080}) as res:
                for line in res.iter_lines():
                    if line.startswith('data: '):
                        events.append(json.loads(line[6:]))

        th = threading.Thread(target=run)
        th.start()
        try:
            deadline = time.monotonic() + 30
            while export_id not in main._export_cancels and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(1.0)   # 讓 ffmpeg 真的開始跑
            self.assertEqual(client.post(f'/api/export-cancel/{export_id}').status_code, 200)
            th.join(60)
            self.assertFalse(th.is_alive(), '取消後匯出應該很快結束')
            self.assertTrue(any(e.get('cancelled') for e in events), events[-3:])
            self.assertFalse(any(e.get('done') for e in events))
            self.assertFalse(out.exists())
            self.assertNotIn(export_id, main._export_cancels)                       # 結束後清掉
            self.assertEqual(client.post(f'/api/export-cancel/{export_id}').status_code, 404)
        finally:
            src.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
