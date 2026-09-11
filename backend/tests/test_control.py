import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from services.control import LocalControl
from services.ffmpeg_service import FFmpegService, _watch_cancel
from services.subtitle import SubtitleService
from control_fixture import create_fixture


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.uploads = self.root / 'uploads'
        self.uploads.mkdir()
        with patch.dict(os.environ, {'LJCUT_CONTROL_WORKSPACE': str(self.root / 'workspace')}):
            self.control = LocalControl(self.uploads)
        app = FastAPI()
        app.include_router(self.control.router)
        self.client = TestClient(app)
        self.headers = {'Authorization': 'Bearer ' + self.control.token}

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def post(self, path, body):
        return self.client.post('/api/control' + path, json=body, headers=self.headers)

    def test_auth_workspace_and_dedup(self):
        self.assertEqual(self.client.post('/api/control/commands', json={}).status_code, 401)
        res = self.client.post('/api/control/connect', headers={'Origin': 'https://untrusted.example'})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.post('/media', {'path': '../missing.mp4'}).json()['detail']['code'], 'OUTSIDE_WORKSPACE')
        self.assertEqual(self.post('/media', {'path': 'missing.mp4'}).json()['detail']['code'], 'FILE_NOT_FOUND')
        self.post('/poll', {'clientId':'editor'})
        self.assertEqual(self.post('/poll', {'clientId':'other'}).status_code, 409)
        req={'id':'test1','method':'state','params':{}}
        self.assertEqual(self.post('/commands',req).json()['status'],'queued')
        self.assertEqual(self.post('/poll',{'clientId':'editor'}).json()['status'],'delivered')
        self.post('/ack/test1', {'clientId':'editor','result':{'revision':1}})
        self.assertEqual(self.post('/commands',req).json()['result'],{'revision':1})
        self.assertEqual(self.post('/commands',{**req,'method':'undo'}).status_code,409)
        self.assertEqual(self.post('/export',{'project':{'schemaVersion':1}}).json()['detail']['code'],'INVALID_PROJECT')
        # Lost UI sessions are never replayed into a different editor.
        self.post('/commands',{'id':'lost','method':'undo','params':{}})
        self.control.seen = 0
        self.post('/poll',{'clientId':'new-editor'})
        self.assertEqual(self.client.get('/api/control/commands/lost',headers=self.headers).json()['error']['code'],'EDITOR_DISCONNECTED')

    def test_save_open_export_and_cancel(self):
        fixture=create_fixture(self.control.root/'fixture.mp4')
        original=hashlib.sha256(fixture.read_bytes()).hexdigest()
        media=self.post('/media', {'path':'fixture.mp4'}).json()
        self.assertIn('id',media)
        def clip(cid,start,end,tl):
            return {'id':cid,'mediaId':media['id'],'trackIndex':0,'startTime':tl,'trimStart':start,'trimEnd':end,
                    'duration':end-start,'speed':1,'segments':[{'id':0,'start':4.5,'end':5.5,'text':'保留操作画面'}]}
        project={'schemaVersion':1,'projectId':'fixture-project','mediaItems':[media],
                 'timelineClips':[clip('left',0,2,0),clip('right',4,8,2)],'language':'zh',
                 'subtitleStyle':{'fontName':'Microsoft JhengHei','fontSize':30,'posY':90}}
        saved=self.post('/save',{'path':'saved.ljcut','project':project,'revision':2})
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(self.post('/save',{'path':'saved.ljcut','project':project}).status_code,409)
        # Simulate the old uploads cleanup: bundle assets must survive independently.
        self.control.media_path(media).unlink()
        reopened=self.post('/open',{'path':'saved.ljcut'}).json()
        self.assertEqual(reopened['timelineClips'],project['timelineClips'])
        self.assertTrue(self.control.media_path(reopened['mediaItems'][0]).is_file())
        job=self.post('/export',{'project':reopened,'revision':3}).json()
        self.assertIn('id',job,job)
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            result=self.client.get('/api/control/jobs/'+job['id'],headers=self.headers).json()
            if result['status'] in {'completed','failed'}: break
            time.sleep(.1)
        self.assertEqual(result['status'],'completed',result)
        info=FFmpegService.get_media_info(result['outputPath'])
        self.assertAlmostEqual(info['duration'],6,delta=1/30)
        ass=Path(result['outputPath']).with_name('subtitles.ass').read_text(encoding='utf-8-sig')
        self.assertEqual(ass.count('Dialogue:'),1)
        self.assertIn('0:00:02.50,0:00:03.50',ass)
        self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(),original)
        # Existing ASR extraction keeps source duration and its documented one-second tail.
        wav=self.root/'asr.wav'
        FFmpegService.extract_audio(str(fixture),str(wav))
        with wave.open(str(wav)) as audio:
            self.assertEqual(audio.getframerate(),16000)
            self.assertEqual(audio.getnchannels(),1)
            self.assertAlmostEqual(audio.getnframes()/16000,9,delta=.05)
        # Exercise cancellation while an actual multi-clip export is running.
        long_project=json.loads(json.dumps(reopened))
        long_project['timelineClips']=[{**clip(str(i),0,8,i*8),'segments':[]} for i in range(20)]
        began=threading.Event()
        def observe_process(proc, cancel_event):
            _watch_cancel(proc, cancel_event)
            began.set()
        with patch('services.ffmpeg_service._watch_cancel', side_effect=observe_process):
            running=self.post('/export',{'project':long_project,'revision':4}).json()
            self.assertTrue(began.wait(5), 'FFmpeg did not start')
            self.post('/jobs/'+running['id']+'/cancel',{})
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                cancelled_job=self.client.get('/api/control/jobs/'+running['id'],headers=self.headers).json()
                if cancelled_job['status'] not in {'queued','running'}:break
                time.sleep(.1)
        self.assertEqual(cancelled_job['status'],'cancelled',cancelled_job)
        cancelled=threading.Event(); cancelled.set()
        with self.assertRaisesRegex(RuntimeError,'cancelled'):
            list(FFmpegService.export_timeline_with_progress([],str(self.root/'none.ass'),str(self.root/'cancel.mp4'),cancel_event=cancelled))

    def test_speed_export_without_subtitles(self):
        fixture=create_fixture(self.control.root/'speed.mp4')
        output=self.root/'speed-output.mp4'
        list(FFmpegService.export_timeline_with_progress([
            {'video_path':str(fixture),'trim_start':2,'trim_end':6,'speed':2,'output_duration':2}],
            str(self.root/'no-subtitles.ass'),str(output),use_nvenc=False,video_width=640,video_height=360))
        self.assertAlmostEqual(FFmpegService.get_media_info(str(output))['duration'],2,delta=1/30)


if __name__ == '__main__':
    unittest.main()
