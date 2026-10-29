"""子母畫面素材（疊在主畫面上的圖片／影片）。

存在 uploads/assets/{id}{ext}，與主素材分開（不會被 uploads/{id}.* 的搜尋誤抓，也不佔主時間軸）。
疊加層只記素材的中繼資料 {id, type, filename, url, width, height, duration, hasAudio}，匯出時依 id 找回檔案。
"""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".gif"}
ID_RE = re.compile(r"a_[0-9a-f]{12}")


def asset_dir(uploads: Path) -> Path:
    d = uploads / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def probe(path: Path) -> dict:
    """讀取素材資訊；圖片的 duration 為 0。讀不到畫面時丟 ValueError。"""
    from .ffmpeg_service import FFmpegService
    info = FFmpegService.get_media_info(str(path))
    w, h = int(info.get("width") or 0), int(info.get("height") or 0)
    if not (w and h):
        raise ValueError("讀不到圖片／影片的畫面尺寸")
    ext = path.suffix.lower()
    kind = "image" if ext in IMAGE_EXT else "video"
    duration = 0.0 if kind == "image" else float(info.get("duration") or 0)
    if kind == "video" and duration <= 0:
        raise ValueError("影片長度無效")
    return {"type": kind, "width": w, "height": h, "duration": round(duration, 3),
            "hasAudio": kind == "video" and bool(info.get("audio_codec"))}


def import_file(source: Path, uploads: Path, filename: str | None = None) -> dict:
    """把檔案複製進素材庫，回傳中繼資料。"""
    ext = source.suffix.lower()
    if ext not in IMAGE_EXT | VIDEO_EXT:
        raise ValueError("子母畫面支援 PNG／JPG／WebP／BMP 圖片與 MP4／MOV／MKV／WebM／AVI／WMV／GIF 影片")
    aid = "a_" + uuid.uuid4().hex[:12]
    dest = asset_dir(uploads) / f"{aid}{ext}"
    shutil.copyfile(source, dest)
    try:
        meta = probe(dest)
    except ValueError:
        dest.unlink(missing_ok=True)
        raise
    return {"id": aid, "filename": filename or source.name, "url": f"/uploads/assets/{dest.name}", **meta}


def find(uploads: Path, asset_id: str) -> Path | None:
    if not isinstance(asset_id, str) or not ID_RE.fullmatch(asset_id):
        return None
    for p in (uploads / "assets").glob(f"{asset_id}.*"):
        if p.is_file():
            return p
    return None
