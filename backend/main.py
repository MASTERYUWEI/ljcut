"""LJCUT — 本地 AI 字幕剪輯工具後端"""

# ── 修正 NVIDIA DLL 路徑（必須在 import faster_whisper 之前）──
import os
import sys
import glob

# 自動搜尋 venv 內的 NVIDIA DLL 路徑並加到 PATH
_venv_site = os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages")
for _nvidia_dir in glob.glob(os.path.join(_venv_site, "nvidia", "*", "bin")):
    os.environ["PATH"] = _nvidia_dir + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(_nvidia_dir)

import json
import uuid
import shutil
import threading
import subprocess
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, HTTPException, Form, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from services.transcribe import TranscribeService
from services.subtitle import SubtitleService
from services.ffmpeg_service import FFmpegService
from services.llm_service import LLMService
from services.youtube_service import YouTubeService
from services.thumb_service import ThumbService

# ---------- 設定 ----------
UPLOAD_DIR = Path("./uploads")
OUTPUT_DIR = Path("./outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

transcribe_svc: TranscribeService | None = None
_model_lock = threading.Lock()


def _ensure_model() -> TranscribeService:
    """惰性載入 Whisper 模型（thread-safe）。首次呼叫會阻塞直到載入完成。"""
    global transcribe_svc
    if transcribe_svc is None:
        with _model_lock:
            if transcribe_svc is None:
                print("🔄 載入 faster-whisper 模型（首次需要下載）...", flush=True)
                transcribe_svc = TranscribeService()
                print("✅ 模型已就緒", flush=True)
    return transcribe_svc


def _pid_alive(pid: int) -> bool:
    """跨平台檢查 pid 是否存活"""
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _start_parent_watchdog():
    """父進程（Tauri）消失時自我終止，避免 dev 重建留下孤兒 sidecar"""
    ppid_str = os.environ.get("LJCUT_PARENT_PID")
    if not ppid_str:
        return
    try:
        ppid = int(ppid_str)
    except ValueError:
        return
    import time

    def _watch():
        while True:
            if not _pid_alive(ppid):
                print("🔌 父進程已結束，sidecar 自我終止", flush=True)
                os._exit(0)
            time.sleep(2)

    threading.Thread(target=_watch, daemon=True).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 父進程看門狗：Tauri 關閉/重建時自動收掉自己
    _start_parent_watchdog()
    # 背景預熱模型，不阻塞 HTTP 服務啟動 → 前端可立即連線（顯示載入中）
    threading.Thread(target=_ensure_model, daemon=True).start()
    yield
    print("👋 關閉服務")


app = FastAPI(title="LJCUT API", version="0.1.0", lifespan=lifespan)

# CORS — 允許前端 dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 靜態檔案 — 上傳的影片可直接存取
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")


# ---------- API ----------

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": transcribe_svc is not None}


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    """上傳影片檔"""
    if not file.filename:
        raise HTTPException(400, "缺少檔案名")

    ext = Path(file.filename).suffix.lower()
    if ext not in {".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv", ".mp3", ".wav", ".m4a"}:
        raise HTTPException(400, f"不支援的檔案格式: {ext}")

    file_id = uuid.uuid4().hex[:12]
    save_path = UPLOAD_DIR / f"{file_id}{ext}"

    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # 取得影片資訊
    info = FFmpegService.get_media_info(str(save_path))

    return {
        "file_id": file_id,
        "filename": file.filename,
        "path": str(save_path),
        "url": f"/uploads/{file_id}{ext}",
        "info": info,
    }


@app.post("/api/transcribe/{file_id}")
async def transcribe(file_id: str, language: str = Form(default="zh")):
    """語音辨識 — SSE 串流進度（辨識在背景執行緒跑，避免凍結事件迴圈）"""
    svc = _ensure_model()  # 惰性載入；模型還沒好時會在此阻塞直到就緒

    # 找上傳的檔案（排除殘留的 .wav）
    matches = [m for m in UPLOAD_DIR.glob(f"{file_id}.*") if not m.name.endswith(".wav")]
    if not matches:
        raise HTTPException(404, f"找不到檔案: {file_id}")
    video_path = str(matches[0])

    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()

    def push(ev):
        loop.call_soon_threadsafe(q.put_nowait, ev)

    def on_progress(current: float, total: float):
        pct = int(min(99, max(0, (current / total * 100) if total else 0)))
        push({"progress": pct, "current": round(current, 1), "total": round(total, 1)})

    def run():
        audio_path = str(UPLOAD_DIR / f"{file_id}.wav")
        try:
            push({"progress": 0, "stage": "extract"})  # 抽取音訊中
            FFmpegService.extract_audio(video_path, audio_path)
            result = svc.transcribe(audio_path, language=language, on_progress=on_progress)
            push({"progress": 100, "done": True, "result": result})
        except Exception as e:
            push({"error": str(e)})
        finally:
            if os.path.exists(audio_path) and not video_path.endswith(".wav"):
                try:
                    os.remove(audio_path)
                except Exception:
                    pass
            push(None)  # 結束哨兵

    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        while True:
            ev = await q.get()
            if ev is None:
                break
            yield f"data: {json.dumps(ev)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/export/srt/{file_id}")
async def export_srt(file_id: str, segments: list = Body(default=[])):
    """匯出 SRT 字幕檔"""
    srt_path = OUTPUT_DIR / f"{file_id}.srt"
    SubtitleService.segments_to_srt(segments, str(srt_path))
    return FileResponse(str(srt_path), filename=f"{file_id}.srt", media_type="text/plain")


@app.post("/api/export-video/{file_id}")
async def export_video_with_progress(file_id: str, body: dict = Body(default={})):
    """匯出影片（含字幕）— SSE 串流進度"""
    segments = body.get("segments", [])
    style = body.get("style", {})
    speed = float(body.get("speed", 1.0))
    total_duration = float(body.get("duration", 0))
    output_path = body.get("output_path", "")
    trim_start = float(body.get("trim_start", 0))
    trim_end = float(body.get("trim_end", 0))
    video_width = int(body.get("video_width", 1920))
    video_height = int(body.get("video_height", 1080))

    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    matches = [m for m in matches if not m.name.endswith(".wav")]
    if not matches:
        raise HTTPException(404, f"找不到檔案: {file_id}")

    video_path = str(matches[0])
    ass_path = str(OUTPUT_DIR / f"{file_id}.ass")

    # 產生 ASS（含完整樣式 + PlayResY，考慮 trimStart 偏移 + 倍速縮放）
    if segments:
        # 將 media time 偏移 trimStart，使字幕時間對齊裁切後的影片
        offset_segments = []
        for seg in segments:
            s = seg["start"] - trim_start
            e = seg["end"] - trim_start
            if e <= 0:
                continue
            s = max(s, 0)
            offset_segments.append({**seg, "start": s, "end": e})

        print(f"📝 匯出 ASS — 共 {len(offset_segments)} 段字幕 (trimStart={trim_start})")
        for i, seg in enumerate(offset_segments[:3]):
            print(f"   段 {i}: start={seg.get('start'):.2f}, end={seg.get('end'):.2f}, text={seg.get('text', '')[:20]}")
        print(f"📐 字幕樣式: {style}")
        print(f"📏 影片解析度: {video_width}x{video_height}")
        print(f"⚡ 速度: {speed}")

        if speed != 1.0:
            scaled = [{**seg, "start": seg["start"] / speed, "end": seg["end"] / speed} for seg in offset_segments]
            SubtitleService.segments_to_ass(scaled, ass_path, style=style, video_width=video_width, video_height=video_height)
        else:
            SubtitleService.segments_to_ass(offset_segments, ass_path, style=style, video_width=video_width, video_height=video_height)

    # 決定輸出路徑
    if not output_path:
        output_path = str(OUTPUT_DIR / f"{file_id}_subtitled.mp4")

    def generate():
        try:
            for event in FFmpegService.burn_subtitles_with_progress(
                video_path, ass_path, output_path,
                speed=speed, total_duration=total_duration,
                trim_start=trim_start, trim_end=trim_end,
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'progress': 100, 'done': True, 'output_path': output_path})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/export-timeline")
async def export_timeline(body: dict = Body(default={})):
    """多 clip 串接匯出 — SSE 串流進度"""
    clips_input = body.get("clips", [])
    style = body.get("style", {})
    output_path = body.get("output_path", "")
    video_width = int(body.get("video_width", 1920))
    video_height = int(body.get("video_height", 1080))

    if not clips_input:
        raise HTTPException(400, "沒有 clip 資料")

    # 解析每個 clip，找到對應的影片檔案
    ffmpeg_clips = []
    ass_clips_data = []
    cumulative_offset = 0.0

    for clip in clips_input:
        file_id = clip.get("file_id", "")
        trim_start = float(clip.get("trim_start", 0))
        trim_end = float(clip.get("trim_end", 0))
        speed = float(clip.get("speed", 1.0))
        segments = clip.get("segments", [])

        # 找影片檔
        matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
        matches = [m for m in matches if not m.name.endswith(".wav")]
        if not matches:
            raise HTTPException(404, f"找不到檔案: {file_id}")

        video_path = str(matches[0])
        clip_dur = trim_end - trim_start
        output_duration = clip_dur / speed if speed != 1.0 else clip_dur

        ffmpeg_clips.append({
            "video_path": video_path,
            "trim_start": trim_start,
            "trim_end": trim_end,
            "speed": speed,
            "output_duration": output_duration,
        })

        # 字幕資訊（含時間偏移）
        ass_clips_data.append({
            "segments": segments,
            "time_offset": cumulative_offset,
            "speed": speed,
            "trim_start": trim_start,
        })

        cumulative_offset += output_duration

    print(f"📋 匯出時間軸: {len(ffmpeg_clips)} clip(s), 總長 {cumulative_offset:.1f}s")

    # 產生合併 ASS
    ass_path = str(OUTPUT_DIR / "timeline_merged.ass")
    SubtitleService.multi_clip_segments_to_ass(
        ass_clips_data, ass_path, style=style,
        video_width=video_width, video_height=video_height,
    )

    # 決定輸出路徑
    if not output_path:
        output_path = str(OUTPUT_DIR / "timeline_output.mp4")

    def generate():
        try:
            for event in FFmpegService.export_timeline_with_progress(
                ffmpeg_clips, ass_path, output_path,
                video_width=video_width, video_height=video_height,
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'progress': 100, 'done': True, 'output_path': output_path})}\n\n"
        except Exception as e:
            print(f"❌ 匯出失敗: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.get("/api/download/{file_id}")
async def download_subtitled(file_id: str):
    """下載燒入字幕後的影片 — 強制瀏覽器下載"""
    output_path = OUTPUT_DIR / f"{file_id}_subtitled.mp4"
    if not output_path.exists():
        raise HTTPException(404, "找不到燒入後的影片，請先執行燒入")

    # 取得原始檔名
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    matches = [m for m in matches if not m.name.endswith(".wav")]
    original_name = matches[0].stem if matches else file_id

    return FileResponse(
        str(output_path),
        filename=f"{original_name}_subtitled.mp4",
        media_type="application/octet-stream",  # 強制下載而非播放
        headers={
            "Content-Disposition": f'attachment; filename="{original_name}_subtitled.mp4"'
        },
    )

# ── 波形數據 ──

@app.get("/api/waveform/{file_id}")
async def get_waveform(file_id: str):
    """產生音頻波形峰值數據供前端 canvas 繪製"""
    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    matches = [m for m in matches if not m.name.endswith(".wav")]
    if not matches:
        raise HTTPException(404, f"找不到檔案: {file_id}")

    file_path = str(matches[0])
    try:
        peaks = FFmpegService.generate_waveform(file_path, samples_per_second=50)
    except Exception as e:
        raise HTTPException(500, f"波形生成失敗: {e}")

    return JSONResponse({"peaks": peaks})


# ── 影片縮圖 ──

@app.get("/api/thumbnail/{file_id}")
async def get_thumbnail(file_id: str):
    """產生影片首幀縮圖（JPEG）"""
    thumb_path = OUTPUT_DIR / f"{file_id}_thumb.jpg"

    # 快取：已產生就直接返回
    if thumb_path.exists():
        return FileResponse(str(thumb_path), media_type="image/jpeg")

    matches = list(UPLOAD_DIR.glob(f"{file_id}.*"))
    matches = [m for m in matches if not m.name.endswith(".wav")]
    if not matches:
        raise HTTPException(404, f"找不到檔案: {file_id}")

    file_path = str(matches[0])
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", file_path,
                "-vf", "thumbnail,scale=160:-1",
                "-frames:v", "1",
                str(thumb_path),
            ],
            capture_output=True, check=True,
        )
    except subprocess.CalledProcessError:
        # 音頻檔無法產生縮圖，返回 204
        return JSONResponse(status_code=204, content=None)

    return FileResponse(str(thumb_path), media_type="image/jpeg")


# ── AI 助手 ──

@app.get("/api/ai/status")
async def ai_status():
    """檢查 Gemini API 是否可用"""
    return await LLMService.check_status()


@app.get("/api/ai/key")
async def ai_get_key():
    """取得目前金鑰狀態（遮罩顯示）"""
    return JSONResponse(LLMService.key_info())


@app.post("/api/ai/key")
async def ai_set_key(body: dict = Body(...)):
    """設定 Gemini API Key（寫回 .env 並即時生效）"""
    key = (body.get("key") or "").strip()
    if not key:
        raise HTTPException(400, "金鑰不可為空")
    result = await LLMService.set_api_key(key)
    print(f"🔑 已更新 GEMINI_API_KEY，可用={result.get('status', {}).get('available')}", flush=True)
    return JSONResponse(result)


# ── YouTube 上傳 ──
# 這些端點刻意用同步 def（FastAPI 丟 threadpool），避免網路呼叫卡住事件迴圈


@app.post("/api/ai/titles")
async def ai_generate_titles(body: dict = Body(default={})):
    """依逐字稿/大綱產 5 個 YouTube 標題候選"""
    return await LLMService.generate_titles(body.get("texts", []))


@app.post("/api/yt/thumbnails")
async def yt_generate_thumbnails(body: dict = Body(default={})):
    """AI 生成 N 款 16:9 封面候選（2.5D 像素風 + 本地標題合成）"""
    return await ThumbService.generate_candidates(
        body.get("title", ""), int(body.get("count", 5)),
        transcript=body.get("transcript", ""),
    )


@app.post("/api/yt/credentials")
def yt_set_credentials(body: dict = Body(default={})):
    """儲存 YouTube OAuth 用戶端憑證（空字串 = 清除）"""
    return YouTubeService.set_credentials(body.get("client_id", ""), body.get("client_secret", ""))


@app.get("/api/yt/status")
def yt_status():
    """YouTube 連結狀態"""
    return YouTubeService.status()


@app.post("/api/yt/auth/start")
def yt_auth_start():
    """啟動 OAuth loopback 授權，回傳要開的網址"""
    return YouTubeService.start_auth()


@app.post("/api/yt/disconnect")
def yt_disconnect():
    """解除 YouTube 連結"""
    return YouTubeService.disconnect()


@app.post("/api/yt/upload")
def yt_upload(body: dict = Body(default={})):
    """上傳影片到 YouTube（+ 縮圖 + SRT 字幕）— SSE 進度"""
    video_path = body.get("video_path", "")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(404, f"找不到影片檔: {video_path}")

    # SRT：前端傳入已映射到成品時間軸的 segments
    segments = body.get("segments") or []
    srt_path = None
    if segments:
        srt_path = str(OUTPUT_DIR / "yt_upload.srt")
        SubtitleService.segments_to_srt(segments, srt_path)

    # 縮圖：優先用 AI 生成封面檔（outputs/ 內、防路徑跳脫）；否則從成品影片抓幀
    thumb_path = None
    tp = body.get("thumbnail_path", "")
    if tp:
        cand = (OUTPUT_DIR / Path(tp).name).resolve()
        if cand.exists() and cand.suffix.lower() in (".jpg", ".jpeg", ".png"):
            thumb_path = str(cand)
    t = body.get("thumbnail_time", None)
    if thumb_path is None and isinstance(t, (int, float)):
        thumb_path = str(OUTPUT_DIR / "yt_thumb.jpg")
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(max(0.0, float(t))), "-i", video_path,
             "-frames:v", "1", "-q:v", "2", thumb_path],
            capture_output=True,
        )
        if not os.path.exists(thumb_path):
            thumb_path = None

    def generate():
        try:
            for ev in YouTubeService.upload_with_progress(
                video_path,
                title=body.get("title", ""),
                description=body.get("description", ""),
                tags=body.get("tags") or [],
                privacy=body.get("privacy", "private"),
                thumbnail_path=thumb_path,
                srt_path=srt_path,
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/ai/suspicious")
async def ai_scan_suspicious(body: dict = Body(default={})):
    """AI 掃描語意不通順/疑似辨識錯誤的句子"""
    return await LLMService.scan_suspicious(body.get("texts", []))


@app.post("/api/ai/typos")
async def ai_scan_typos(body: dict = Body(default={})):
    """AI 掃描字幕錯字，回傳建議取代清單"""
    return await LLMService.scan_typos(body.get("texts", []))


@app.post("/api/ai/health")
async def ai_health():
    """金鑰健康度實測：真的敲一次 Gemini generateContent"""
    return await LLMService.health_check()


@app.get("/api/ai/model")
async def get_ai_model():
    """目前使用的 Gemini 模型 + 是否有新版 Flash 可用"""
    return await LLMService.model_info()


@app.post("/api/ai/model")
async def set_ai_model(body: dict = Body(default={})):
    """切換 Gemini 模型（model 留空 = 自動選最新 Flash）"""
    return await LLMService.set_model(body.get("model", ""))


@app.post("/api/ai/generate")
async def ai_generate(body: dict = Body(...)):
    """AI 生成文案 — Gemini API"""
    segments = body.get("segments", [])
    prompt_type = body.get("prompt_type", "summary")

    print(f"🤖 AI Generate: type={prompt_type}, segments={len(segments)}", flush=True)

    if not segments:
        raise HTTPException(400, "沒有字幕資料")

    result = await LLMService.generate(segments, prompt_type)

    print(f"✅ AI Done: type={prompt_type}, result_len={len(result)}", flush=True)
    return JSONResponse({"result": result, "prompt_type": prompt_type})


@app.post("/api/calibrate-audio")
async def calibrate_audio(body: dict = Body(...)):
    """音訊同步校正：同時錄系統+麥克風幾秒，互相關算出麥克風超前 ms"""
    import asyncio

    from services.audio_calibrate import calibrate

    sys_device = (body.get("sys_device") or "").strip()
    mic_device = (body.get("mic_device") or "").strip()
    seconds = int(body.get("seconds", 5))
    if not sys_device or not mic_device:
        raise HTTPException(400, "需要同時提供系統與麥克風裝置")

    print(f"🎚️ 音訊校正: sys={sys_device}, mic={mic_device}, {seconds}s", flush=True)
    result = await asyncio.to_thread(calibrate, sys_device, mic_device, seconds)
    print(f"🎚️ 校正結果: {result}", flush=True)
    return JSONResponse(result)


@app.post("/api/ai/polish")
async def ai_polish(body: dict = Body(...)):
    """逐句潤飾字幕（修錯字／去贅字／補標點），時間碼不變 — Gemini API"""
    segments = body.get("segments", [])
    if not segments:
        raise HTTPException(400, "沒有字幕資料")

    print(f"✨ AI Polish: segments={len(segments)}", flush=True)
    polished = await LLMService.polish_subtitles(segments)
    return JSONResponse({"segments": polished})

