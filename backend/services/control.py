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

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from .ffmpeg_service import FFmpegService
from .subtitle import SubtitleService
from .transitions import validate_transitions
from . import publication as publications
from . import observe
from . import zoom as zoom_service
from . import overlay as overlay_service
from . import asset as asset_service


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
        try:
            zoom_service.sanitize(m.get('zooms'))
        except ValueError as error:
            fail('INVALID_ZOOM', str(error))
        try:
            overlay_service.sanitize(m.get('overlays'))
        except ValueError as error:
            fail('INVALID_OVERLAY', str(error))
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
    try:
        validate_transitions(sorted(p['timelineClips'], key=lambda c:c['startTime']))
    except ValueError as error:
        fail('INVALID_TRANSITION', str(error))
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
        self.waiting = 0               # 正在長輪詢等待命令的編輯器請求數
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

        def production_settings():
            target = self.root / 'production-settings.json'
            if not target.exists():
                return dict(schemaVersion=1, revision=0, introPath='', outroPath='', useIntro=False, useOutro=False, transitionMode='random', transitionDuration=0.6)
            try:
                settings = json.loads(target.read_text(encoding='utf-8'))
                if settings.get('schemaVersion') != 1 or type(settings.get('revision')) is not int:
                    raise ValueError()
                return {'transitionMode':'random', 'transitionDuration':0.6, **settings}
            except (ValueError, AttributeError):
                fail('INVALID_SETTINGS', '製作設定無法讀取，請先檢查設定檔')

        def selected_settings(base, body):
            result = {**base, **{k: body[k] for k in ('introPath', 'outroPath', 'useIntro', 'useOutro', 'transitionMode', 'transitionDuration') if k in body}}
            if result['transitionMode'] not in ('random','none','fade-black','fade-gray','fade-white'):
                fail('INVALID_TRANSITION', '不支援的轉場')
            duration = result['transitionDuration']
            if type(duration) not in (int,float) or not .2 <= duration <= 1.5:
                fail('INVALID_TRANSITION', '轉場長度需為 0.2–1.5 秒')
            for role in ('intro', 'outro'):
                path, enabled = result[role + 'Path'], result['use' + role.title()]
                if not isinstance(path, str) or type(enabled) is not bool:
                    fail('INVALID_SETTINGS', '片頭片尾需為相對路徑及啟用開關')
                if path:
                    source = self.path(path, True)
                    if source.suffix.lower() not in {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.wmv'}:
                        fail('UNSUPPORTED_MEDIA', '片頭片尾請使用影片檔')
                elif enabled:
                    fail('BOOKEND_PATH_REQUIRED', '啟用片頭／片尾前請先指定檔案')
            return result

        @r.get('/publications/{pid}')
        async def publication(pid: str, request: Request):
            self.authorize(request)
            return publications.publication(pid)

        @r.post('/cover-batches')
        async def cover_batch(request: Request, body: dict = Body(...)):
            self.authorize(request)
            batch = publications.request_batch(body.get('publicationId'), body.get('provider','codex'))
            return batch

        @r.get('/cover-batches/{bid}')
        async def read_cover_batch(bid: str, request: Request):
            self.authorize(request)
            batch = publications.load(bid)
            if batch.get('kind') != 'cover-batch':
                fail('INVALID_BATCH', '找不到封面批次')
            publications.publication(batch['publicationId'])
            return batch

        @r.post('/cover-batches/{bid}/complete')
        async def complete_cover_batch(bid: str, request: Request, body: dict = Body(...)):
            self.authorize(request)
            paths = body.get('paths')
            if not isinstance(paths,list) or len(paths) != 6:
                fail('SIX_REQUIRED', '請提供工作區內 6 張不同封面的路徑')
            files = [self.path(p,True) for p in paths]
            if any(p.suffix.lower() not in ('.jpg','.jpeg','.png','.webp') or p.stat().st_size > 25_000_000 for p in files):
                fail('INVALID_IMAGE', '請提供 25MB 以內的圖片')
            return await asyncio.to_thread(publications.complete_batch, bid, body.get('analysis'), [p.read_bytes() for p in files])

        @r.post('/publications/{pid}/select-cover')
        async def select_cover(pid: str, request: Request, body: dict = Body(...)):
            self.authorize(request)
            return publications.select_cover(pid, body.get('batchId'), body.get('file'))

        @r.get('/production-settings')
        async def get_settings(request: Request):
            self.authorize(request)
            return production_settings()

        @r.post('/bookend-file')
        async def upload_bookend(request: Request, file: UploadFile = File(...)):
            self.authorize(request)
            # Receive only the file chosen by the user; never accept an external path to read.
            name = (file.filename or '').replace('\\', '/').rsplit('/', 1)[-1]
            if not name or ':' in name or Path(name).suffix.lower() not in {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.wmv'}:
                await file.close()
                fail('UNSUPPORTED_MEDIA', '請選擇 MP4、MOV、MKV、WebM、AVI 或 WMV 影片')
            relative = str(Path('branding') / uuid.uuid4().hex / name)
            target = self.path(relative)
            target.parent.mkdir(parents=True, exist_ok=False)
            complete = False
            try:
                with target.open('xb') as stream:
                    while chunk := await file.read(1024 * 1024):
                        stream.write(chunk)
                info = await asyncio.to_thread(FFmpegService.get_media_info, str(target))
                if not (info.get('duration', 0) > 0 and info.get('width') and info.get('height')):
                    fail('UNSUPPORTED_MEDIA', '選取的檔案沒有可用的影片畫面')
                complete = True
                return {'path': relative.replace('\\', '/'), 'filename': name, 'info': info}
            finally:
                await file.close()
                if not complete:
                    target.unlink(missing_ok=True)
                    target.parent.rmdir()

        @r.post('/production-settings')
        async def save_settings(request: Request, body: dict = Body(...)):
            self.authorize(request)
            current = production_settings()
            if body.get('expectedSettingsRevision') != current['revision']:
                fail('STALE_SETTINGS', '製作設定已變更，請重新讀取', 409)
            updated = selected_settings(current, body)
            updated['revision'] += 1
            target = self.root / 'production-settings.json'
            temp = self.root / ('.settings-' + uuid.uuid4().hex)
            temp.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temp, target)
            return updated

        @r.post('/bookends-media')
        async def bookends_media(request: Request, body: dict = Body(...)):
            self.authorize(request)
            settings = selected_settings(production_settings(), body)
            selected = {}
            # Inspect every selected file before copying anything or updating the editor.
            for role in ('intro', 'outro'):
                if settings['use' + role.title()]:
                    source = self.path(settings[role + 'Path'], True)
                    info = await asyncio.to_thread(FFmpegService.get_media_info, str(source))
                    if not (info.get('duration', 0) > 0 and info.get('width') and info.get('height')):
                        fail('UNSUPPORTED_MEDIA', '片頭片尾需包含有效影片畫面')
                    selected[role] = (source, info)
            if not selected:
                fail('BOOKENDS_REQUIRED', '請至少啟用片頭或片尾')
            result = {'settings': settings}
            def cache_media(source):
                with source.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                mid = 'b_' + digest
                dest = self.uploads / (mid + source.suffix.lower())
                if not dest.exists():
                    temp = self.uploads / ('.bookend-' + uuid.uuid4().hex)
                    try:
                        shutil.copyfile(source, temp)
                        with temp.open('rb') as stream:
                            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                                fail('MEDIA_CHANGED', '素材在準備期間已變更，請重新檢查')
                        temp.rename(dest)
                    finally:
                        temp.unlink(missing_ok=True)
                else:
                    with dest.open('rb') as stream:
                        if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                            fail('MEDIA_ID_COLLISION', '快取素材內容不一致，拒絕覆寫')
                return mid, dest
            for role, (source, info) in selected.items():
                mid, dest = await asyncio.to_thread(cache_media, source)
                result[role] = dict(id=mid, filename=source.name, url='/uploads/' + dest.name, info=info, waveformPeaks=[])
            return result

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
            if body.get('method') not in {'state', 'dry_run', 'apply', 'undo', 'redo', 'import', 'save', 'open', 'preview', 'export', 'production_settings', 'set_production_settings', 'prepare_bookends', 'prepare_transitions', 'publication', 'prepare_covers', 'cover_batch', 'complete_covers', 'select_cover', 'transcribe'} or not isinstance(body.get('params', {}), dict):
                fail('UNSUPPORTED_COMMAND', '不支援的控制命令')
            if not self.owner or (not self.waiting and time.monotonic() - self.seen > 10):
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
                if self.owner and (self.waiting or time.monotonic() - self.seen < 10):
                    fail('EDITOR_ALREADY_CONNECTED', '另一個 LJ Cut 編輯器正在控制此工作階段', 409)
                for command in self.commands.values():
                    if command['status'] in {'queued', 'delivered'}:
                        command.update(status='failed', error={"code": "EDITOR_DISCONNECTED", "message": "編輯器已中斷；請讀取狀態確認，命令不會自動重送到另一專案"})
                self.owner = client
            self.seen = time.monotonic()

            def take(states):
                for command in self.commands.values():
                    if command['owner'] == client and command['status'] in states:
                        command['status'] = 'delivered'
                        return command

            # 長輪詢：新命令立刻送出；沒有就等到有命令或逾時（不靠前端計時器，視窗最小化/背景分頁也不會被節流拖慢）
            # 已送出但未回覆的命令只在逾時後重送，避免前端執行長命令時反覆空轉
            if (command := take({'queued'})):
                return command
            wait = body.get('wait', 0)
            if isinstance(wait, (int, float)) and wait > 0:
                # 每 0.1 秒檢查一次：延遲可忽略，且不依賴跨事件迴圈的 Event
                deadline = time.monotonic() + min(float(wait), 8.0)
                self.waiting += 1
                try:
                    while time.monotonic() < deadline and self.owner == client:
                        if any(c['owner'] == client and c['status'] == 'queued' for c in self.commands.values()):
                            break
                        await asyncio.sleep(0.1)
                finally:
                    self.waiting -= 1
                if self.owner != client or await request.is_disconnected():
                    return None  # 頁面已關閉/重新整理：不刷新 seen，讓新頁面盡快接手
                self.seen = time.monotonic()
            return take({'queued'}) or take({'delivered'})

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
            # LJ Cut 錄影旁的游標軌跡一起帶進來（自動縮放用）；放子資料夾，避免被 {id}.* 搜尋誤抓
            track = source.with_name(source.name + '.cursor.json')
            has_cursor = track.is_file() and zoom_service.load_track_file(track) is not None
            if has_cursor:
                (self.uploads / 'cursor').mkdir(exist_ok=True)
                await asyncio.to_thread(shutil.copyfile, track, self.uploads / 'cursor' / f'{mid}.json')
            return {"id": mid, "filename": source.name, "url": '/uploads/' + dest.name,
                    "info": info, "waveformPeaks": [], "cursorTrack": has_cursor}

        # ── 觀察工具（唯讀，不需編輯器在線）：給 AI 看畫面、聽停頓 ──
        def media_file(body):
            mid = body.get("mediaId")
            if body.get("path"):
                return self.path(body["path"], True)
            if not isinstance(mid, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", mid):
                fail("INVALID_MEDIA", "需提供 mediaId 或工作區相對 path")
            for p in sorted(self.uploads.glob(mid + ".*")):
                if p.suffix.lower() != ".wav" and p.is_file():
                    return p
            fail("MEDIA_NOT_FOUND", f"找不到素材 {mid}", 404)

        def num(body, key, default, lo, hi):
            v = body.get(key, default)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
                fail("INVALID_PARAM", f"{key} 需介於 {lo}–{hi}")
            return float(v)

        @r.post('/observe/frames')
        async def observe_frames(request: Request, body: dict = Body(...)):
            self.authorize(request)
            src = media_file(body)
            times = body.get("times")
            if not isinstance(times, list) or not times or not all(isinstance(t, (int, float)) and t >= 0 for t in times):
                fail("INVALID_PARAM", "times 需為非負秒數陣列")
            labels = body.get("labels") if isinstance(body.get("labels"), list) else None
            width = int(num(body, "thumbWidth", 384, 160, 960))
            cols = int(num(body, "cols", 4, 1, 8))
            zooms = body.get("zooms")
            if zooms is not None:
                ok = isinstance(zooms, list) and all(z is None or (isinstance(z, dict) and all(
                    isinstance(z.get(k), (int, float)) and not isinstance(z.get(k), bool) for k in ("x", "y", "scale"))
                    and 0 <= z["x"] <= 1 and 0 <= z["y"] <= 1 and 1 <= z["scale"] <= 4) for z in zooms)
                if not ok:
                    fail("INVALID_PARAM", "zooms 需為 {x,y,scale} 或 null 的陣列（x/y 0–1、倍率 1–4）")
            mode = body.get("zoomMode", "box")
            if mode not in ("box", "crop"):
                fail("INVALID_PARAM", "zoomMode 需為 box 或 crop")
            layers = body.get("overlays")
            asset_root = self.uploads
            if layers is not None:
                if not isinstance(layers, list):
                    fail("INVALID_PARAM", "overlays 需為每個時間點一個疊加層陣列（或 null）")
                try:
                    layers = [overlay_service.sanitize(x) if x else None for x in layers]
                except ValueError as error:
                    fail("INVALID_OVERLAY", str(error))
            out = self.root / "observe" / f"frames-{uuid.uuid4().hex[:10]}.jpg"
            try:
                res = await asyncio.to_thread(observe.contact_sheet, src, [float(t) for t in times], out,
                                              [str(x) for x in labels] if labels else None, width, cols,
                                              body.get("grid") is True, zooms, mode, layers, asset_root)
            except ValueError as e:
                fail("INVALID_PARAM", str(e))
            res["path"] = out.relative_to(self.root).as_posix()
            return res

        @r.post('/asset')
        async def import_asset(request: Request, body: dict = Body(...)):
            """把工作區內的圖片／影片匯入子母畫面素材庫，回傳可直接放進 add_overlay 的 asset。"""
            self.authorize(request)
            source = self.path(body.get('path'), True)
            try:
                return await asyncio.to_thread(asset_service.import_file, source, self.uploads)
            except ValueError as error:
                fail('UNSUPPORTED_MEDIA', str(error))

        @r.get('/asset/{asset_id}')
        async def asset_info(asset_id: str, request: Request):
            self.authorize(request)
            path = asset_service.find(self.uploads, asset_id)
            if not path:
                fail('ASSET_NOT_FOUND', f'找不到子母畫面素材 {asset_id}', 404)
            meta = await asyncio.to_thread(asset_service.probe, path)
            return {"id": asset_id, "filename": path.name, "url": f"/uploads/assets/{path.name}", **meta}

        @r.post('/observe/cursor')
        async def observe_cursor(request: Request, body: dict = Body(...)):
            """錄影時記下的滑鼠點擊（來源秒數、畫面比例座標）與自動縮放建議。"""
            self.authorize(request)
            src = media_file(body)
            mid = body.get("mediaId") or ""
            track = zoom_service.load_track(self.uploads, mid) if mid else None
            if track is None:
                fail("NO_CURSOR_TRACK", "此素材沒有游標紀錄（只有 LJ Cut 錄影會記錄）；請改用 ljcut_frames 加 grid 判斷位置", 404)
            duration = (await asyncio.to_thread(FFmpegService.get_media_info, str(src))).get("duration", 0)
            return zoom_service.track_report(track, duration)

        @r.post('/observe/silences')
        async def observe_silences(request: Request, body: dict = Body(...)):
            self.authorize(request)
            src = media_file(body)
            return await asyncio.to_thread(observe.silences, src, num(body, "noiseDb", -35, -80, -10),
                                           num(body, "minSilence", 0.8, 0.1, 30))

        @r.post('/observe/scenes')
        async def observe_scenes(request: Request, body: dict = Body(...)):
            self.authorize(request)
            src = media_file(body)
            return await asyncio.to_thread(observe.scene_changes, src, num(body, "threshold", 0.3, 0.01, 0.95))

        @r.post('/observe/audio-levels')
        async def observe_levels(request: Request, body: dict = Body(...)):
            self.authorize(request)
            src = media_file(body)
            try:
                return await asyncio.to_thread(observe.audio_levels, src, num(body, "window", 1.0, 0.1, 60))
            except ValueError as e:
                fail("NO_AUDIO", str(e))

        @r.get('/observe/file')
        async def observe_file(request: Request, path: str):
            self.authorize(request)
            p = self.path(path, True)
            if not p.is_relative_to(self.root / "observe"):
                fail("OUTSIDE_WORKSPACE", "只能讀取 observe/ 下的分析圖")
            return FileResponse(str(p), media_type="image/jpeg")

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
            # 覆寫只限「儲存目前開啟的專案」：編輯器明確帶 overwrite，且目標確實是專案資料夾
            overwrite = target.exists()
            if overwrite and not (body.get('overwrite') is True and (target / 'project.json').is_file()):
                fail('DESTINATION_EXISTS', '已有同名專案；請換一個檔名，或開啟它後再按「儲存」', 409)
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
                if overwrite:
                    # 先把舊專案移開再換上新的；任何一步失敗都還原舊專案（Windows rename 不能直接蓋過）
                    backup = self.root / ('.replaced-' + uuid.uuid4().hex)
                    target.rename(backup)
                    try:
                        staging.rename(target)
                    except Exception:
                        backup.rename(target)
                        raise
                    shutil.rmtree(backup, ignore_errors=True)
                else:
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
            burn_subtitles = body.get('burnSubtitles', False)
            if not isinstance(burn_subtitles, bool):
                fail('INVALID_EXPORT_OPTION', 'burnSubtitles 必須是布林值')
            project = project_payload(body.get('project'))
            medias = {m['id']: self.media_path(m) for m in project.get('mediaItems', [])}
            infos = {mid: await asyncio.to_thread(FFmpegService.get_media_info, str(path)) for mid, path in medias.items()}
            zooms_by_media = {m['id']: m.get('zooms') or [] for m in project.get('mediaItems', [])}
            overlays_by_media = {m['id']: m.get('overlays') or [] for m in project.get('mediaItems', [])}
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
                if end > info.get('duration', 0) + .001 or not info.get('width'):
                    fail('UNSUPPORTED_MEDIA', '輸出需包含有效影片畫面')
                length = (end - start) / speed
                if abs(c['duration'] - length) > 1e-6:
                    fail('INVALID_RANGE', '片段長度不一致')
                clips.append({"video_path": str(medias[c['mediaId']]), "trim_start": start,
                              "trim_end": end, "speed": speed, "output_duration": length, "transition_in": c.get('transitionIn'),
                              "zooms": zooms_by_media.get(c['mediaId'], []),
                              "overlays": overlays_by_media.get(c['mediaId'], []), "asset_root": str(self.uploads)})
                subtitle_clips.append({"segments": c['segments'], "trim_start": start, "trim_end": end,
                                       "speed": speed, "time_offset": offset, "bookend": c.get('bookend')})
                offset += length
            if not clips:
                fail('EMPTY_TIMELINE', '時間軸沒有片段')
            jid = uuid.uuid4().hex
            out_dir = self.root / 'exports' / jid
            out_dir.mkdir(parents=True)
            ass = out_dir / 'subtitles.ass'
            main = next((c for c in project['timelineClips'] if not c.get('bookend')), project['timelineClips'][0])
            first = infos[main['mediaId']]
            width, height = first['width'], first['height']
            # Keep source captions in the project and SRT; burn-in is an explicit export choice.
            SubtitleService.multi_clip_segments_to_ass(subtitle_clips if burn_subtitles else [], str(ass),
                style=project.get('subtitleStyle', {}), video_width=width, video_height=height)
            srt_segments = publications.mapped_captions(subtitle_clips)
            srt_path = out_dir / 'subtitles.srt'
            SubtitleService.segments_to_srt(sorted(srt_segments, key=lambda s: s['start']), str(srt_path))
            job = {"id": jid, "status": "queued", "progress": 0, "projectId": project['projectId'],
                   "revision": body.get('revision'), "expectedDuration": offset, "burnSubtitles": burn_subtitles,
                   "outputPath": str(out_dir / 'video.mp4'), "srtPath": str(srt_path), "cancel": threading.Event()}
            self.jobs[jid] = job

            def run():
                job['status'] = 'running'
                try:
                    for ev in FFmpegService.export_timeline_with_progress(clips, str(ass), job['outputPath'],
                            use_nvenc=False, video_width=width, video_height=height, cancel_event=job['cancel']):
                        job.update(ev)
                    publication = publications.record_export(job['outputPath'], subtitle_clips, offset,
                        next(m['filename'] for m in project['mediaItems'] if m['id'] == main['mediaId']))
                    job['publicationId'] = publication['id']
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
