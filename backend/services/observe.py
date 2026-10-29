"""給 AI 的「感官」工具：畫面縮圖拼圖、靜音區間、畫面變化點、音量起伏。

全部是唯讀分析，只讀素材、不改專案；時間一律為**來源素材秒數**。
輸出圖片寫在控制工作區的 observe/ 底下（由呼叫端決定路徑）。
"""

import os
import re
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_FONT_CANDIDATES = [r"C:\Windows\Fonts\msjhbd.ttc", r"C:\Windows\Fonts\msjh.ttc", r"C:\Windows\Fonts\arial.ttf"]


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW, **kw)


def _font(size):
    for p in _FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def fmt_time(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:05.2f}"


def contact_sheet(media: Path, times: list[float], out: Path, labels: list[str] | None = None,
                  thumb_width: int = 384, cols: int = 4) -> dict:
    """指定時間點各抓一格，拼成一張附時間標籤的縮圖網格。"""
    if not times:
        raise ValueError("至少需要 1 個時間點")
    if len(times) > 24:
        raise ValueError("一次最多 24 個時間點")
    font = _font(max(14, thumb_width // 18))
    tiles = []
    for i, t in enumerate(times):
        r = _run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(media),
                  "-frames:v", "1", "-vf", f"scale={thumb_width}:-2", "-f", "image2pipe",
                  "-vcodec", "png", "-"])
        if r.returncode != 0 or not r.stdout:
            tile = Image.new("RGB", (thumb_width, thumb_width * 9 // 16), (40, 40, 40))
        else:
            from io import BytesIO
            tile = Image.open(BytesIO(r.stdout)).convert("RGB")
        d = ImageDraw.Draw(tile)
        text = labels[i] if labels and i < len(labels) else fmt_time(t)
        bbox = d.textbbox((0, 0), text, font=font)
        d.rectangle([0, 0, bbox[2] + 12, bbox[3] + 8], fill=(0, 0, 0))
        d.text((6, 3), text, fill=(255, 221, 0), font=font)
        tiles.append(tile)
    cols = max(1, min(cols, len(tiles)))
    rows = (len(tiles) + cols - 1) // cols
    w, h = tiles[0].size
    gap = 4
    sheet = Image.new("RGB", (cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap), (20, 20, 20))
    for i, tile in enumerate(tiles):
        tile = tile.resize((w, h)) if tile.size != (w, h) else tile
        sheet.paste(tile, ((i % cols) * (w + gap), (i // cols) * (h + gap)))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, "JPEG", quality=85)
    return {"path": str(out), "times": [round(t, 3) for t in times], "grid": [rows, cols]}


def silences(media: Path, noise_db: float = -35.0, min_silence: float = 0.8) -> dict:
    """ffmpeg silencedetect：回傳靜音區間（左閉右開，來源秒數）。"""
    r = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(media), "-vn",
              "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"])
    log = r.stderr.decode("utf-8", "replace")
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: (-?[\d.]+)", log)]
    dur = _duration(media)
    out = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else dur
        s = max(0.0, s)
        if e > s:
            out.append({"start": round(s, 3), "end": round(e, 3), "duration": round(e - s, 3)})
    return {"noiseDb": noise_db, "minSilence": min_silence, "mediaDuration": dur,
            "totalSilence": round(sum(x["duration"] for x in out), 3), "silences": out}


def scene_changes(media: Path, threshold: float = 0.3, max_points: int = 200) -> dict:
    """畫面變化點（場景切換、視窗切換、大幅捲動）。threshold 0~1，越小越敏感。"""
    r = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(media), "-an",
              "-vf", f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"])
    log = r.stderr.decode("utf-8", "replace")
    pts = [float(x) for x in re.findall(r"pts_time:([\d.]+)", log)]
    return {"threshold": threshold, "count": len(pts), "changes": [round(p, 3) for p in pts[:max_points]],
            "truncated": len(pts) > max_points}


def audio_levels(media: Path, window: float = 1.0, max_windows: int = 3600) -> dict:
    """每個時間窗的音量 RMS（dBFS），看得出講話、安靜、音樂、爆音。"""
    sr = 8000
    r = _run(["ffmpeg", "-v", "error", "-i", str(media), "-vn", "-ac", "1", "-ar", str(sr),
              "-f", "s16le", "-"])
    if r.returncode != 0:
        raise ValueError("無法讀取音訊（素材可能沒有聲音軌）")
    pcm = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    n = max(1, int(sr * window))
    count = min(max_windows, int(np.ceil(len(pcm) / n)))
    levels = []
    for i in range(count):
        chunk = pcm[i * n:(i + 1) * n]
        rms = float(np.sqrt(np.mean(chunk * chunk))) if len(chunk) else 0.0
        levels.append(round(float(20 * np.log10(max(rms, 1e-6))), 1))
    return {"window": window, "unit": "dBFS", "start": 0.0, "levels": levels,
            "truncated": int(np.ceil(len(pcm) / n)) > max_windows}


def _duration(media: Path) -> float:
    r = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media)])
    try:
        return round(float(r.stdout.decode().strip()), 3)
    except ValueError:
        return 0.0
