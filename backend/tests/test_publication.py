import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from fastapi import HTTPException, FastAPI
from fastapi.testclient import TestClient
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import publication as P
from services.control import LocalControl
from services.youtube_service import YouTubeService


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'LJCUT_DATA_DIR':str(self.root),'LJCUT_CONTROL_WORKSPACE':str(self.root/'workspace')})
        self.env.start(); self.addCleanup(self.env.stop)
        self.video = self.root/'video.mp4'; self.video.write_bytes(b'exported video fixture')
        self.clips = [dict(segments=[],time_offset=0,trim_start=0,trim_end=15,speed=1,bookend='intro'),
            dict(segments=[dict(start=3,end=7,text='裁切及變速後的教學'),dict(start=9,end=12,text='被剪掉的內容')],
                time_offset=15,trim_start=4,trim_end=8,speed=2),
            dict(segments=[],time_offset=17,trim_start=0,trim_end=3,speed=1,bookend='outro')]
        self.p = P.record_export(self.video,self.clips,20)
        self.analysis = dict(summary='示範裁切及變速。', highlights=[dict(text='裁切及變速',evidenceStart=15)],
            slogan='剪輯更順手',title='裁切及變速教學',description='示範操作流程',visualBrief='An engineer editing a video timeline.')
        self.images = []
        for i in range(6):
            image = io.BytesIO(); Image.new('RGB',(1280,720),(i*40,50,150)).save(image,'PNG'); self.images.append(image.getvalue())

    def test_captions_bound_to_export_never_double_shift_and_reject_overwrite(self):
        self.assertEqual(self.p['segments'],[dict(start=15,end=16.5,text='裁切及變速後的教學')])
        self.assertIn('00:00:15,000 --> 00:00:16,500',Path(self.p['srtPath']).read_text(encoding='utf-8'))
        self.clips[1]['time_offset']=30
        self.assertEqual(P.publication(self.p['id'])['segments'][0]['start'],15)
        self.video.write_bytes(b'new mismatching export')
        with self.assertRaises(HTTPException) as e: P.publication(self.p['id'])
        self.assertEqual(e.exception.detail['code'],'EXPORT_CHANGED')

    def test_six_covers_refresh_lock_and_export_isolation(self):
        b = P.request_batch(self.p['id'])
        self.assertEqual(len(b['layouts']),6)
        with self.assertRaises(HTTPException): P.complete_batch(b['id'],self.analysis,self.images[:5])
        with self.assertRaises(HTTPException): P.complete_batch(b['id'],self.analysis,[self.images[0]]*6)
        self.assertEqual(P.load(b['id'])['items'],[])
        b = P.complete_batch(b['id'],self.analysis,self.images)
        self.assertEqual(len(b['items']),6)
        chosen = b['items'][4]['file']
        p = P.select_cover(self.p['id'],b['id'],chosen)
        original = Path(P.selected_path(p,chosen)).read_bytes()
        fresh = P.complete_batch(P.request_batch(self.p['id'])['id'],self.analysis,list(reversed(self.images)))
        self.assertTrue(set(i['file'] for i in b['items']).isdisjoint(i['file'] for i in fresh['items']))
        self.assertEqual(Path(P.selected_path(P.publication(p['id']),chosen)).read_bytes(),original)
        with self.assertRaises(HTTPException): P.complete_batch(b['id'],self.analysis,self.images)
        other = P.record_export(self.video,self.clips,20)
        with self.assertRaises(HTTPException): P.select_cover(other['id'],b['id'],chosen)
        Path(P.selected_path(p,chosen)).write_bytes(b'changed')
        with self.assertRaises(HTTPException): P.selected_path(p,chosen)

    def test_analysis_requires_real_main_timestamps_and_no_empty_transcript(self):
        with self.assertRaises(HTTPException): P.request_batch(self.p['id'],'gemini')
        b = P.request_batch(self.p['id'])
        self.analysis['highlights'][0]['evidenceStart']=2
        with self.assertRaises(HTTPException): P.complete_batch(b['id'],self.analysis,self.images)
        p = P.record_export(self.video,[self.clips[0]],15)
        with self.assertRaises(HTTPException): P.request_batch(p['id'])

    def test_control_import_is_authenticated_and_workspace_limited(self):
        control=LocalControl(self.root/'uploads')
        app=FastAPI(); app.include_router(control.router); client=TestClient(app)
        headers={'Authorization':'Bearer '+control.token}
        self.assertEqual(client.get('/api/control/publications/'+self.p['id']).status_code,401)
        b=client.post('/api/control/cover-batches',headers=headers,json={'publicationId':self.p['id']}).json()
        paths=[]
        for i,raw in enumerate(self.images):
            path=control.root/f'{i}.png'; path.write_bytes(raw); paths.append(path.name)
        url='/api/control/cover-batches/'+b['id']+'/complete'
        bad=client.post(url,headers=headers,json={'analysis':self.analysis,'paths':['../outside.png']*6})
        self.assertEqual(bad.json()['detail']['code'],'OUTSIDE_WORKSPACE')
        done=client.post(url,headers=headers,json={'analysis':self.analysis,'paths':paths})
        self.assertEqual(done.status_code,200,done.text)
        self.assertEqual(done.json()['status'],'ready')

    def test_youtube_sends_selected_bytes_captions_then_publishes_and_failure_stays_private(self):
        b=P.complete_batch(P.request_batch(self.p['id'])['id'],self.analysis,self.images)
        p=P.select_cover(self.p['id'],b['id'],b['items'][2]['file'])
        thumbnail=P.selected_path(p,p['selected']['file'])
        for fail_caption in (False,True):
            calls=[]
            def respond(request):
                calls.append(request)
                if request.method=='POST' and request.url.path.endswith('/videos'):
                    self.assertEqual(json.loads(request.content)['status']['privacyStatus'],'private')
                    return httpx.Response(200,headers={'Location':'https://upload.example/session'})
                if request.url.host=='upload.example': return httpx.Response(200,json={'id':'test-video'})
                if request.url.path.endswith('/thumbnails/set'):
                    self.assertEqual(request.content,Path(thumbnail).read_bytes())
                    return httpx.Response(200,json={})
                if request.url.path.endswith('/captions'):
                    self.assertIn(Path(p['srtPath']).read_bytes(),request.content)
                    self.assertIn(b'00:00:15,000 --> 00:00:16,500',request.content)
                    return httpx.Response(403 if fail_caption else 200,json={})
                if request.method=='PUT' and request.url.path.endswith('/videos'):
                    return httpx.Response(200,json={'status':{'privacyStatus':'public'}})
                raise AssertionError(str(request.url))
            real_client=httpx.Client
            with patch('services.youtube_service._get_access_token',return_value='fake'), patch('services.youtube_service.httpx.Client',side_effect=lambda **kw:real_client(transport=httpx.MockTransport(respond),**kw)):
                events=list(YouTubeService.upload_with_progress(str(self.video),'標題',privacy='public',thumbnail_path=thumbnail,srt_path=p['srtPath']))
            updates=[c for c in calls if c.method=='PUT' and c.url.path.endswith('/videos')]
            if fail_caption:
                self.assertFalse(updates); self.assertIn('error',events[-1]); self.assertFalse(events[-1].get('done'))
                self.assertEqual(events[-1]['video_id'],'test-video')
            else:
                self.assertEqual(len(updates),1); self.assertTrue(events[-1]['done'])

    def test_manual_export_captions_and_upload_route_ignore_live_editor_segments(self):
        import main
        control=LocalControl(self.root/'uploads'); control.uploads.mkdir()
        (control.uploads/'fixture.mp4').write_bytes(b'fixture')
        outputs=self.root/'outputs'; outputs.mkdir(exist_ok=True)
        app_client=TestClient(main.app)
        headers={'Authorization':'Bearer '+control.token}
        def render(clips,ass,output,**kwargs):
            Path(output).write_bytes(b'completed export')
            yield {'progress':100}
        clips=[dict(file_id='fixture',trim_start=c['trim_start'],trim_end=c['trim_end'],speed=c['speed'],
                    segments=[],caption_segments=c['segments'],bookend=c.get('bookend')) for c in self.clips]
        received={}
        def upload(video_path,**kwargs):
            received.update(kwargs)
            received['srt']=Path(kwargs['srt_path']).read_text(encoding='utf-8')
            received['thumbnail']=Path(kwargs['thumbnail_path']).read_bytes()
            yield {'done':True,'video_id':'mock','watch_url':'https://youtu.be/mock','studio_url':'https://studio.youtube.com/video/mock/edit'}
        with patch.object(main,'OUTPUT_DIR',outputs),patch.object(main,'UPLOAD_DIR',control.uploads),patch.object(main,'local_control',control),patch.object(main.FFmpegService,'export_timeline_with_progress',side_effect=render):
            response=app_client.post('/api/export-timeline',json={'clips':clips,'video_width':640,'video_height':360})
            events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            self.assertTrue(events[-1].get('done'),events)
            p=P.publication(events[-1]['publication_id'])
            self.assertEqual(p['segments'][0]['start'],15)
            self.assertEqual(p['segments'][0]['end'],16.5)
            # 乾淨影片旁邊有同檔名的 SRT
            sidecar=Path(events[-1]['srt_path'])
            self.assertEqual(sidecar.with_suffix('.mp4').name,Path(events[-1]['output_path']).name)
            self.assertIn('00:00:15,000 --> 00:00:16,500',sidecar.read_text(encoding='utf-8'))
            b=P.complete_batch(P.request_batch(p['id'])['id'],self.analysis,self.images)
            p=P.select_cover(p['id'],b['id'],b['items'][1]['file'])
            body={'publication_id':p['id'],'title':'Test','thumbnail_path':p['selected']['file'],
                'include_srt':True,'segments':[dict(start=0,end=1,text='錯誤的即時字幕')],'video_path':'wrong.mp4'}
            self.assertEqual(app_client.post('/api/yt/upload',json=body).status_code,401)
            with patch.object(main.YouTubeService,'upload_with_progress',side_effect=upload):
                result=app_client.post('/api/yt/upload',headers=headers,json=body)
            self.assertIn('"done": true',result.text)
            self.assertIn('00:00:15,000 --> 00:00:16,500',received['srt'])
            self.assertNotIn('錯誤',received['srt'])
            self.assertEqual(received['thumbnail'],Path(P.selected_path(p,p['selected']['file'])).read_bytes())
            self.assertEqual(app_client.post('/api/yt/thumbnails',json={'title':'Test'}).status_code,409)


if __name__=='__main__': unittest.main()
