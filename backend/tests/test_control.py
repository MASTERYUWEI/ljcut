import hashlib
import json
import os
import subprocess
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
        self.data_env = patch.dict(os.environ, {'LJCUT_DATA_DIR': str(self.root)})
        self.data_env.start()
        self.addCleanup(self.data_env.stop)
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

    def test_long_poll_wakes_on_submit_and_times_out(self):
        self.post('/poll', {'clientId': 'editor'})
        t0 = time.monotonic()
        self.assertIsNone(self.post('/poll', {'clientId': 'editor', 'wait': 0.3}).json())
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)
        got = {}
        def waiter():
            got['res'] = self.post('/poll', {'clientId': 'editor', 'wait': 5}).json()
            got['at'] = time.monotonic()
        th = threading.Thread(target=waiter); th.start()
        time.sleep(0.3)
        self.assertEqual(self.post('/poll', {'clientId': 'other'}).status_code, 409)  # 等待中仍算在線
        sent = time.monotonic()
        self.assertEqual(self.post('/commands', {'id': 'lp1', 'method': 'transcribe', 'params': {}}).json()['status'], 'queued')
        th.join(5)
        self.assertEqual(got['res']['id'], 'lp1')
        self.assertLess(got['at'] - sent, 1.0)
        # 已送出未回覆的命令不會立即重送（避免前端空轉），逾時後才重送
        t0 = time.monotonic()
        self.assertEqual(self.post('/poll', {'clientId': 'editor', 'wait': 0.3}).json()['id'], 'lp1')
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)

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
        # 「儲存」目前開啟的專案：明確 overwrite 才能覆寫，且只能覆寫專案資料夾
        project2=dict(project,language='en')
        self.assertEqual(self.post('/save',{'path':'saved.ljcut','project':project2,'overwrite':True}).status_code,200)
        self.assertEqual(self.post('/open',{'path':'saved.ljcut'}).json()['language'],'en')
        self.assertEqual(self.post('/save',{'path':'saved.ljcut','project':project,'overwrite':True}).status_code,200)
        (self.control.root/'notproject.ljcut').mkdir()
        self.assertEqual(self.post('/save',{'path':'notproject.ljcut','project':project,'overwrite':True}).status_code,409)
        self.assertFalse(any(x.name.startswith(('.replaced-','.saving-')) for x in self.control.root.iterdir()))
        # Simulate the old uploads cleanup: bundle assets must survive independently.
        self.control.media_path(media).unlink()
        reopened=self.post('/open',{'path':'saved.ljcut'}).json()
        self.assertEqual(reopened['timelineClips'],project['timelineClips'])
        self.assertTrue(self.control.media_path(reopened['mediaItems'][0]).is_file())
        job=self.post('/export',{'project':reopened,'revision':3,'burnSubtitles':True}).json()
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

    def test_control_export_defaults_to_clean_video_with_identical_srt(self):
        source = self.control.root/'clean-source.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=black:s=320x180:r=30:d=3',
            '-c:v','libx264','-pix_fmt','yuv420p',str(source)],check=True,capture_output=True,
            creationflags=0x08000000 if os.name=='nt' else 0)
        original = source.read_bytes()
        media = self.post('/media',{'path':source.name}).json()
        intro = dict(id='intro',mediaId=media['id'],bookend='intro',trackIndex=0,startTime=0,
            trimStart=0,trimEnd=1,duration=1,speed=1,segments=[])
        main = dict(id='main',mediaId=media['id'],trackIndex=0,startTime=1,
            trimStart=0,trimEnd=2,duration=2,speed=1,segments=[dict(id=1,start=.25,end=1,text='VISIBLE TEXT')])
        project = dict(schemaVersion=1,projectId='clean-export',mediaItems=[media],timelineClips=[intro,main],
            language='zh',subtitleStyle=dict(fontName='Arial',fontSize=48,posY=50))
        before = json.dumps(project,sort_keys=True)
        srts = []
        for burn in [False, True]:
            body = dict(project=project,revision=1)
            if burn: body['burnSubtitles'] = True
            job = self.post('/export',body).json()
            deadline = time.monotonic()+30
            while time.monotonic()<deadline:
                result = self.client.get('/api/control/jobs/'+job['id'],headers=self.headers).json()
                if result['status'] not in {'queued','running'}: break
                time.sleep(.1)
            self.assertEqual(result['status'],'completed',result)
            self.assertEqual(result['burnSubtitles'],burn)
            frame = subprocess.check_output(['ffmpeg','-v','error','-ss','1.5','-i',result['outputPath'],
                '-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],
                creationflags=0x08000000 if os.name=='nt' else 0)
            bright = sum(pixel > 200 for pixel in frame)
            self.assertGreater(bright,50) if burn else self.assertEqual(bright,0)
            srts.append(Path(result['srtPath']).read_text(encoding='utf-8'))
            self.assertAlmostEqual(FFmpegService.get_media_info(result['outputPath'])['duration'],3,delta=1/30)
            publication = self.client.get('/api/control/publications/'+result['publicationId'],headers=self.headers).json()
            self.assertEqual(publication['mainSegments'],[dict(start=1.25,end=2,text='VISIBLE TEXT')])
        self.assertEqual(srts[0],srts[1])
        self.assertIn('00:00:01,250 --> 00:00:02,000',srts[0])
        self.assertEqual(json.dumps(project,sort_keys=True),before)
        self.assertEqual(source.read_bytes(),original)
        self.assertEqual(self.post('/export',dict(project=project,burnSubtitles='false')).json()['detail']['code'],
            'INVALID_EXPORT_OPTION')

    def test_speed_export_without_subtitles(self):
        fixture=create_fixture(self.control.root/'speed.mp4')
        output=self.root/'speed-output.mp4'
        list(FFmpegService.export_timeline_with_progress([
            {'video_path':str(fixture),'trim_start':2,'trim_end':6,'speed':2,'output_duration':2}],
            str(self.root/'no-subtitles.ass'),str(output),use_nvenc=False,video_width=640,video_height=360))
        self.assertAlmostEqual(FFmpegService.get_media_info(str(output))['duration'],2,delta=1/30)

    def test_three_transitions_render_without_changing_duration(self):
        from array import array
        import math
        from services.transitions import validate_transitions
        fixture=create_fixture(self.control.root/'transitions.mp4')
        source_hash=hashlib.sha256(fixture.read_bytes()).hexdigest()
        for kind,level in [('fade-black',0),('fade-gray',128),('fade-white',255)]:
            clips=[dict(video_path=str(fixture),trim_start=0,trim_end=2,speed=1,output_duration=2),
                   dict(video_path=str(fixture),trim_start=4,trim_end=6,speed=1,output_duration=2,
                        transition_in=dict(kind=kind,duration=.6))]
            output=self.root/(kind+'.mp4')
            list(FFmpegService.export_timeline_with_progress(clips,str(self.root/'none.ass'),str(output),
                use_nvenc=False,video_width=640,video_height=360))
            self.assertAlmostEqual(FFmpegService.get_media_info(str(output))['duration'],4,delta=1/30)
            pixel=subprocess.check_output(['ffmpeg','-v','error','-ss','2','-i',str(output),'-frames:v','1',
                '-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],creationflags=0x08000000 if os.name=='nt' else 0)
            self.assertTrue(all(abs(v-level)<10 for v in pixel),(kind,list(pixel)))
            pcm=array('f',subprocess.check_output(['ffmpeg','-v','error','-i',str(output),
                '-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],
                creationflags=0x08000000 if os.name=='nt' else 0))
            def rms(start):
                samples=pcm[int(start*48000):int((start+.02)*48000)]
                return math.sqrt(sum(v*v for v in samples)/len(samples))
            baseline=rms(.04)
            self.assertGreater(baseline,.1)
            self.assertLess(rms(2.04)/baseline,.3)
            self.assertTrue(.35 < rms(2.14)/baseline < .7)
        self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(),source_hash)
        with self.assertRaises(ValueError):
            validate_transitions([dict(output_duration=.1),dict(output_duration=1,transition_in=dict(kind='fade-black',duration=.6))])

    def test_bookend_file_picker_import(self):
        source = create_fixture(self.root/'external-video.mp4')
        content = source.read_bytes()
        before = self.client.get('/api/control/production-settings', headers=self.headers).json()
        paths = []
        for _ in range(2):
            res = self.client.post('/api/control/bookend-file', headers=self.headers,
                files={'file':('自訂 片尾.mp4',content,'video/mp4')})
            self.assertEqual(res.status_code,200,res.text)
            result = res.json()
            self.assertEqual(result['filename'],'自訂 片尾.mp4')
            imported = self.control.path(result['path'],True)
            self.assertEqual(imported.read_bytes(),content)
            paths.append(result['path'])
        self.assertNotEqual(*paths)  # Same names must never overwrite another choice.
        self.assertEqual(source.read_bytes(),content)
        self.assertEqual(before,self.client.get('/api/control/production-settings',headers=self.headers).json())
        res=self.client.post('/api/control/bookend-file',headers=self.headers,files={'file':('bad.exe',b'no','application/octet-stream')})
        self.assertEqual(res.json()['detail']['code'],'UNSUPPORTED_MEDIA')
        res=self.client.post('/api/control/bookend-file',files={'file':('test.mp4',content,'video/mp4')})
        self.assertEqual(res.status_code,401)
        saved=self.post('/production-settings',dict(expectedSettingsRevision=0,introPath=paths[0],useIntro=True))
        self.assertEqual(saved.status_code,200,saved.text)
        prepared=self.post('/bookends-media',{}).json()
        self.assertEqual(prepared['intro']['filename'],'自訂 片尾.mp4')

    def test_bookend_settings_silent_media_save_reopen_export_srt(self):
        fixture = create_fixture(self.control.root/'main.mp4')
        intro = self.control.root/'intro.mp4'
        outro = self.control.root/'outro.mp4'
        for path, color, duration in [(intro,'red',1),(outro,'blue',2)]:
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'color={color}:s=320x180:r=30:d={duration}',
                '-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,capture_output=True,
                creationflags=0x08000000 if os.name=='nt' else 0)
        hashes = {p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (fixture,intro,outro)}
        settings = dict(introPath='intro.mp4',outroPath='outro.mp4',useIntro=True,useOutro=True,expectedSettingsRevision=0)
        saved = self.post('/production-settings',settings)
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(self.post('/production-settings',settings).json()['detail']['code'],'STALE_SETTINGS')
        self.assertEqual(self.post('/bookends-media',{'outroPath':'../outside.mp4'}).json()['detail']['code'],'OUTSIDE_WORKSPACE')
        self.assertEqual(self.post('/bookends-media',{'outroPath':'missing.mp4'}).json()['detail']['code'],'FILE_NOT_FOUND')
        media = self.post('/bookends-media',{}).json()
        self.assertEqual(media['intro']['id'],self.post('/bookends-media',{}).json()['intro']['id'])
        main = self.post('/media',{'path':'main.mp4'}).json()
        def clip(m,role,start):
            return dict(id=role,mediaId=m['id'],bookend=role,trackIndex=0,startTime=start,trimStart=0,
                trimEnd=m['info']['duration'],duration=m['info']['duration'],speed=1,segments=[])
        main_clip=clip(main,'main',1)
        main_clip.pop('bookend')
        main_clip['segments']=[dict(id=0,start=4.5,end=5.5,text='字幕跟隨主影片')]
        project=dict(schemaVersion=1,projectId='bookends',language='zh',
            subtitleStyle=dict(fontName='Microsoft JhengHei',fontSize=30,posY=90),
            mediaItems=[media['intro'],main,media['outro']],
            timelineClips=[clip(media['intro'],'intro',0),main_clip,clip(media['outro'],'outro',9)])
        self.assertEqual(self.post('/save',{'path':'bookends.ljcut','project':project}).status_code,200)
        reopened = self.post('/open',{'path':'bookends.ljcut'}).json()
        self.assertEqual(reopened['timelineClips'],project['timelineClips'])
        job=self.post('/export',{'project':reopened,'revision':1}).json()
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            result=self.client.get('/api/control/jobs/'+job['id'],headers=self.headers).json()
            if result['status'] not in {'queued','running'}: break
            time.sleep(.1)
        self.assertEqual(result['status'],'completed',result)
        info=FFmpegService.get_media_info(result['outputPath'])
        self.assertAlmostEqual(info['duration'],11,delta=1/30)
        self.assertEqual(info['width'],main['info']['width'])
        self.assertTrue(info.get('audio_codec'))
        srt=Path(result['srtPath']).read_text(encoding='utf-8')
        self.assertIn('00:00:05,500 --> 00:00:06,500',srt)
        self.assertEqual({p:hashlib.sha256(p.read_bytes()).hexdigest() for p in hashes},hashes)


if __name__ == '__main__':
    unittest.main()


class DefaultWorkspaceTests(unittest.TestCase):
    def test_control_enabled_without_env(self):
        """沒設 LJCUT_CONTROL_WORKSPACE 也能存檔：安裝版用文件資料夾，開發用 app_data/control；空字串可關閉。"""
        from services import control as ctl
        env = {k: v for k, v in os.environ.items() if k not in ('LJCUT_CONTROL_WORKSPACE', 'LJCUT_DATA_DIR')}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(ctl.default_workspace().parts[-2:], ('app_data', 'control'))
        with patch.dict(os.environ, {**env, 'LJCUT_DATA_DIR': 'x'}, clear=True):
            self.assertEqual(ctl.default_workspace().name, 'LJCUT 專案')
        with patch.dict(os.environ, {**env, 'LJCUT_CONTROL_WORKSPACE': ''}, clear=True):
            self.assertIsNone(ctl.LocalControl(Path(tempfile.mkdtemp())).root)
