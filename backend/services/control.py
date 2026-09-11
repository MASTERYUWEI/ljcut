"""Optional loopback command mailbox. The editor, not this service, owns the timeline.

Enable with LJCUT_CONTROL_WORKSPACE. Paths are relative to that workspace;
project bundles copy media out of the application's disposable uploads directory.
"""
import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import FileResponse
from .ffmpeg_service import FFmpegService
from .subtitle import SubtitleService


def fail(code, message, status=400):
    raise HTTPException(status, {"code": code, "message": message})


def project_payload(p):
    """Validate untrusted file/API structure before file IO; no second live state."""
    if not isinstance(p, dict) or p.get('schemaVersion') != 1 or not isinstance(p.get('projectId'), str):
        fail('INVALID_PROJECT', '不支援的專案格式')
    if not isinstance(p.get('mediaItems'), list) or not isinstance(p.get('timelineClips'), list) or not isinstance(p.get('subtitleStyle'), dict):
        fail('INVALID_PROJECT', '專案缺少素材、片段或字幕樣式')
    ids = set()
    for m in p['mediaItems']:
        if not isinstance(m, dict) or not isinstance(m.get('id'), str) or m['id'] in ids or not isinstance(m.get('url'), str):
            fail('INVALID_MEDIA', '素材 ID 必須唯一且包含有效 URL')
        ids.add(m['id'])
    clip_ids = set()
    for c in p['timelineClips']:
        if not isinstance(c, dict) or not isinstance(c.get('id'), str) or c['id'] in clip_ids:
            fail('INVALID_CLIP', '片段 ID 必須唯一')
        clip_ids.add(c['id'])
        if not isinstance(c.get('mediaId'), str) or c['mediaId'] not in ids:
            fail('MEDIA_NOT_FOUND', '片段對應素材不存在', 404)
        if any(type(c.get(k)) not in (float, int) or not math.isfinite(c[k]) for k in ('startTime', 'duration', 'trimStart', 'trimEnd', 'speed')):
            fail('INVALID_RANGE', '時間與速度必須為有限數值')
        if not (c['startTime'] >= 0 and 0 <= c['trimStart'] < c['trimEnd'] and 1 <= c['speed'] <= 5 and c.get('trackIndex') == 0):
            fail('INVALID_RANGE', '片段時間、速度或軌道無效')
        if not isinstance(c.get('segments'), list):
            fail('INVALID_SUBTITLE', '字幕需為陣列')
        for seg in c['segments']:
            if not isinstance(seg, dict) or not isinstance(seg.get('text'), str) or any(type(seg.get(k)) not in (float, int) or not math.isfinite(seg[k]) for k in ('start', 'end')):
                fail('INVALID_SUBTITLE', '字幕文字或時間無效')
            if not 0 <= seg['start'] < seg['end']:
                fail('INVALID_SUBTITLE', '字幕時間無效')
    return p


class LocalControl:
    def __init__(self, uploads: Path):
        configured = os.getenv("LJCUT_CONTROL_WORKSPACE")
        self.root = Path(configured).resolve() if configured else None
        self.uploads = uploads.resolve()
        self.token = secrets.token_urlsafe(32)
        self.commands = {}
        self.owner = None
        self.seen = 0
        self.jobs = {}
        self.router = APIRouter(prefix="/api/control", dependencies=[])
        if self.root:
            self.root.mkdir(parents=True, exist_ok=True)
        self._routes()

    def path(self, relative: str, must_exist=False):
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ':' in relative:
            fail("WORKSPACE_PATH_REQUIRED", "請提供工作區內的相對路徑")
        p = (self.root / relative).resolve()
        if not p.is_relative_to(self.root) or p == self.root:
            fail("OUTSIDE_WORKSPACE", "路徑超出指定工作區")
        if must_exist and not p.is_file():
            fail("FILE_NOT_FOUND", f"找不到檔案：{relative}", 404)
        return p

    def authorize(self, request: Request, bootstrap=False):
        if not self.root:
            fail("CONTROL_DISABLED", "尚未設定 LJCUT_CONTROL_WORKSPACE", 404)
        if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            fail("LOCAL_ONLY", "控制介面限本機", 403)
        origin = request.headers.get("origin", "")
        if origin and origin not in {"http://localhost:5173", "http://127.0.0.1:5173",
                                     "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}:
            fail("ORIGIN_REJECTED", "不允許此來源呼叫控制介面", 403)
        if bootstrap:
            if not origin:
                fail("ORIGIN_REQUIRED", "編輯器連線需提供來源", 403)
        elif not secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + self.token):
            fail("UNAUTHORIZED", "缺少或無效的本機控制憑證", 401)

    def media_path(self, media):
        mid = media.get("id", "")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", mid):
            fail("INVALID_MEDIA", "素材 ID 無效")
        # URLs are only identifiers here: never fetch a user-supplied remote URL.
        name = media.get("url", "").replace('\\', '/').rsplit('/', 1)[-1]
        if Path(name).stem != mid or Path(name).suffix.lower() not in {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.mp3', '.wav', '.m4a'}:
            fail("INVALID_MEDIA", "素材 URL 與 ID 不一致")
        p = (self.uploads / name).resolve()
        if not p.is_relative_to(self.uploads) or not p.is_file():
            fail("MEDIA_NOT_FOUND", f"找不到素材 {mid}", 404)
        return p

    def _routes(self):
        r = self.router

        @r.post('/connect')
        async def connect(request: Request):
            self.authorize(request, bootstrap=True)
            port = request.url.port or 80
            descriptor = {"url": f"http://127.0.0.1:{port}", "token": self.token, "workspace": str(self.root)}
            target = self.root / '.ljcut-control.json'
            temp = target.with_suffix('.tmp')
            temp.write_text(json.dumps(descriptor), encoding='utf-8')
            os.replace(temp, target)
            return {"token": self.token, "workspace": str(self.root)}

        @r.post('/commands')
        async def submit(request: Request, body: dict = Body(...)):
            self.authorize(request)
            cid = body.get('id')
            if not isinstance(cid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', cid):
                fail('INVALID_REQUEST', '每個命令需提供唯一 id')
            if cid in self.commands:
                if self.commands[cid]['request'] != body:
                    fail('REQUEST_ID_REUSED', '同一 id 不可搭配不同內容', 409)
                return self.commands[cid]
            if body.get('method') not in {'state', 'dry_run', 'apply', 'undo', 'redo', 'import', 'save', 'open', 'preview', 'export'} or not isinstance(body.get('params', {}), dict):
                fail('UNSUPPORTED_COMMAND', '不支援的控制命令')
            if not self.owner or time.monotonic() - self.seen > 10:
                fail('EDITOR_OFFLINE', '請先開啟已啟用控制的 LJ Cut 編輯器', 409)
            if len(self.commands) >= 2000:
                fail('SESSION_LIMIT', '此工作階段已達 2000 個命令，請儲存後重新連線', 429)
            self.commands[cid] = {"id": cid, "status": "queued", "request": body, "owner": self.owner}
            return self.commands[cid]

        @r.get('/commands/{cid}')
        async def result(cid: str, request: Request):
            self.authorize(request)
            if cid not in self.commands:
                fail('COMMAND_NOT_FOUND', '找不到命令', 404)
            return self.commands[cid]

        @r.post('/poll')
        async def poll(request: Request, body: dict = Body(...)):
            self.authorize(request)
            client = body.get('clientId')
            if not isinstance(client, str) or not client:
                fail('INVALID_CLIENT', '缺少編輯器識別碼')
            if self.owner != client:
                if self.owner and time.monotonic() - self.seen < 10:
                    fail('EDITOR_ALREADY_CONNECTED', '另一個 LJ Cut 編輯器正在控制此工作階段', 409)
                for command in self.commands.values():
                    if command['status'] in {'queued', 'delivered'}:
                        command.update(status='failed', error={"code": "EDITOR_DISCONNECTED", "message": "編輯器已中斷；請讀取狀態確認，命令不會自動重送到另一專案"})
                self.owner = client
            self.seen = time.monotonic()
            for command in self.commands.values():
                if command['owner'] == client and command['status'] in {'queued', 'delivered'}:
                    command['status'] = 'delivered'
                    return command
            return None

        @r.post('/ack/{cid}')
        async def ack(cid: str, request: Request, body: dict = Body(...)):
            self.authorize(request)
            command = self.commands.get(cid)
            if not command or command['owner'] != body.get('clientId') or self.owner != body.get('clientId'):
                fail('INVALID_ACK', '命令不屬於此編輯器', 409)
            if command['status'] == 'delivered':
                command.update(status='failed' if body.get('error') else 'completed',
                               result=body.get('result'), error=body.get('error'))
            return {"status": command['status']}

        @r.post('/media')
        async def import_media(request: Request, body: dict = Body(...)):
            self.authorize(request)
            source = self.path(body.get('path'), True)
            if source.suffix.lower() not in {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.wmv', '.mp3', '.wav', '.m4a'}:
                fail('UNSUPPORTED_MEDIA', '不支援的素材格式')
            info = await asyncio.to_thread(FFmpegService.get_media_info, str(source))
            if not info.get('duration', 0) > 0:
                fail('INVALID_MEDIA', '無法讀取有效的媒體長度')
            mid = uuid.uuid4().hex[:12]
            dest = self.uploads / (mid + source.suffix.lower())
            await asyncio.to_thread(shutil.copyfile, source, dest)
            return {"id": mid, "filename": source.name, "url": '/uploads/' + dest.name,
                    "info": info, "waveformPeaks": []}

        @r.post('/validate-media')
        async def validate_media(request: Request, body: dict = Body(...)):
            self.authorize(request)
            for media in body.get('mediaItems', []):
                self.media_path(media)
            return {"valid": True}

        @r.post('/save')
        async def save(request: Request, body: dict = Body(...)):
            self.authorize(request)
            p = project_payload(body.get('project'))
            target = self.path(body.get('path'))
            if target.suffix != '.ljcut':
                fail('INVALID_PROJECT_PATH', '另存路徑需以 .ljcut 結尾（專案資料夾）')
            sources = [(m, self.media_path(m)) for m in p.get('mediaItems', [])]
            if target.exists():
                fail('DESTINATION_EXISTS', '另存專案不可覆寫既有路徑', 409)
            staging = self.root / ('.saving-' + uuid.uuid4().hex)
            staging.mkdir()
            try:
                (staging / 'assets').mkdir()
                for media, source in sources:
                    await asyncio.to_thread(shutil.copyfile, source, staging / 'assets' / source.name)
                    media['url'] = '/uploads/' + source.name
                    media.pop('thumbnailUrl', None)
                (staging / 'project.json').write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding='utf-8')
                target.parent.mkdir(parents=True, exist_ok=True)
                # Windows rename refuses an existing destination; never replace a saved project.
                staging.rename(target)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            return {"path": str(target), "projectId": p['projectId'], "savedRevision": body.get('revision')}

        @r.post('/open')
        async def open_project(request: Request, body: dict = Body(...)):
            self.authorize(request)
            source = self.path(body.get('path'))
            manifest = self.path(str(source.relative_to(self.root) / 'project.json'), True)
            try:
                p = project_payload(json.loads(manifest.read_text(encoding='utf-8-sig')))
            except (ValueError, UnicodeError):
                fail('INVALID_PROJECT', '專案 JSON 無法解析')
            for m in p.get('mediaItems', []):
                name = m.get('url', '').rsplit('/', 1)[-1]
                if not re.fullmatch(r'[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+', name) or Path(name).stem != m.get('id'):
                    fail('INVALID_MEDIA', '專案素材名稱無效')
                asset = self.path(str(source.relative_to(self.root) / 'assets' / name), True)
                dest = self.uploads / name
                if dest.exists():
                    def digest(path):
                        with path.open('rb') as stream:
                            return hashlib.file_digest(stream, 'sha256').hexdigest()
                    if await asyncio.to_thread(digest, asset) != await asyncio.to_thread(digest, dest):
                        fail('MEDIA_ID_COLLISION', '素材 ID 已存在但內容不同，拒絕覆寫', 409)
                else:
                    await asyncio.to_thread(shutil.copyfile, asset, dest)
                m['url'] = '/uploads/' + name
                m['info'] = await asyncio.to_thread(FFmpegService.get_media_info, str(asset))
            return p

        @r.post('/export')
        async def export(request: Request, body: dict = Body(...)):
            self.authorize(request)
            project = project_payload(body.get('project'))
            medias = {m['id']: self.media_path(m) for m in project.get('mediaItems', [])}
            infos = {mid: await asyncio.to_thread(FFmpegService.get_media_info, str(path)) for mid, path in medias.items()}
            clips = []
            subtitle_clips = []
            offset = 0.0
            for c in sorted(project.get('timelineClips', []), key=lambda c: c['startTime']):
                if c['mediaId'] not in medias:
                    fail('MEDIA_NOT_FOUND', '片段素材不存在', 404)
                if c['trackIndex'] != 0 or abs(c['startTime'] - offset) > 1e-6:
                    fail('UNSUPPORTED_LAYOUT', '輸出僅支援連續單軌')
                start, end, speed = c['trimStart'], c['trimEnd'], c['speed']
                if not (0 <= start < end and 1 <= speed <= 5):
                    fail('INVALID_RANGE', '裁切範圍／速度無效')
                info = infos[c['mediaId']]
                if end > info.get('duration', 0) + .001 or not info.get('width') or not info.get('audio_codec'):
                    fail('UNSUPPORTED_MEDIA', '第一階段輸出需為同時含影片與音訊的有效素材')
                length = (end - start) / speed
                if abs(c['duration'] - length) > 1e-6:
                    fail('INVALID_RANGE', '片段長度不一致')
                clips.append({"video_path": str(medias[c['mediaId']]), "trim_start": start,
                              "trim_end": end, "speed": speed, "output_duration": length})
                subtitle_clips.append({"segments": c['segments'], "trim_start": start, "trim_end": end,
                                       "speed": speed, "time_offset": offset})
                offset += length
            if not clips:
                fail('EMPTY_TIMELINE', '時間軸沒有片段')
            jid = uuid.uuid4().hex
            out_dir = self.root / 'exports' / jid
            out_dir.mkdir(parents=True)
            ass = out_dir / 'subtitles.ass'
            first = infos[project['timelineClips'][0]['mediaId']]
            width, height = first['width'], first['height']
            SubtitleService.multi_clip_segments_to_ass(subtitle_clips, str(ass),
                style=project.get('subtitleStyle', {}), video_width=width, video_height=height)
            job = {"id": jid, "status": "queued", "progress": 0, "projectId": project['projectId'],
                   "revision": body.get('revision'), "expectedDuration": offset,
                   "outputPath": str(out_dir / 'video.mp4'), "cancel": threading.Event()}
            self.jobs[jid] = job

            def run():
                job['status'] = 'running'
                try:
                    for ev in FFmpegService.export_timeline_with_progress(clips, str(ass), job['outputPath'],
                            use_nvenc=False, video_width=width, video_height=height, cancel_event=job['cancel']):
                        job.update(ev)
                    job['status'] = 'completed'
                    job['progress'] = 100
                except Exception as e:
                    job['status'] = 'cancelled' if job['cancel'].is_set() else 'failed'
                    job['error'] = {"code": 'EXPORT_CANCELLED' if job['cancel'].is_set() else 'EXPORT_FAILED', "message": str(e)}
            threading.Thread(target=run, daemon=True).start()
            return {k: v for k, v in job.items() if k != 'cancel'}

        @r.get('/jobs/{jid}')
        async def job_status(jid: str, request: Request):
            self.authorize(request)
            if jid not in self.jobs:
                fail('JOB_NOT_FOUND', '找不到工作', 404)
            return {k: v for k, v in self.jobs[jid].items() if k != 'cancel'}

        @r.post('/jobs/{jid}/cancel')
        async def cancel(jid: str, request: Request):
            self.authorize(request)
            if jid not in self.jobs:
                fail('JOB_NOT_FOUND', '找不到工作', 404)
            job = self.jobs[jid]
            if job['status'] in {'queued', 'running'}:
                job['cancel'].set()
            return {"id": jid, "status": job['status'], "cancelRequested": job['cancel'].is_set()}

        @r.get('/jobs/{jid}/video')
        async def job_video(jid: str, request: Request):
            self.authorize(request)
            if jid not in self.jobs or self.jobs[jid]['status'] != 'completed':
                fail('OUTPUT_NOT_READY', '影片尚未完成', 409)
            return FileResponse(self.jobs[jid]['outputPath'], media_type='video/mp4')
