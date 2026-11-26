"""會自報身分的測試素材（點子來自 Concat 的 corpus 測試；程式為 LJCUT 自寫）。

畫面：每一格左上角畫一排「條碼」——3 列 × 8 塊、每塊 16×16 像素的灰階方塊，只用亮度
（16＝0、235＝1），4:2:0 色度減半碰不到。24 個位元依序為：
    0-1   起始記號 1,0
    2-4   素材代號 1–7
    5-19  素材的第幾格 0–32767
    20-21 檢查碼（位元 2-19 中 1 的個數 mod 4）
    22-23 結束記號 0,1
讀回時每塊取中間 8×8 的平均亮度；平均落在中間三分之一（兩格混合、模糊、縮放）、記號或檢查碼
不對，一律回傳 None——寧可說「讀不出來」也不猜成別格。

聲音：每個素材秒數的開頭放一聲 80ms 的「嗶」，音高代表素材代號；匯出後量每聲的起點與音高，
就知道那一秒的聲音落在成品的哪裡、是不是對的素材。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np

BLOCK, COLS, ROWS = 16, 8, 3
LO, HI = 16, 235
FLAGS = 0x08000000 if sys.platform == "win32" else 0
SR = 48000
PIP_LEN = 0.08
PIP_FREQ = {1: 523.25, 2: 739.99, 3: 1046.5, 4: 1479.98, 5: 2093.0, 6: 2959.96, 7: 4186.0}   # 每個相差半個八度


def _bits(tag: int, frame: int) -> list[int]:
    assert 1 <= tag <= 7 and 0 <= frame < 32768
    body = [(tag >> (2 - i)) & 1 for i in range(3)] + [(frame >> (14 - i)) & 1 for i in range(15)]
    chk = sum(body) % 4
    return [1, 0] + body + [(chk >> 1) & 1, chk & 1] + [0, 1]


def draw(img: np.ndarray, tag: int, frame: int) -> None:
    """在灰階（Y 平面）畫面左上角畫上條碼。"""
    for i, b in enumerate(_bits(tag, frame)):
        r, c = divmod(i, COLS)
        img[r * BLOCK:(r + 1) * BLOCK, c * BLOCK:(c + 1) * BLOCK] = HI if b else LO


def read(img: np.ndarray) -> tuple[int, int] | None:
    """讀條碼 → (素材代號, 第幾格)；讀不出來回傳 None。img 是 Y 平面（uint8）。"""
    bits = []
    for i in range(COLS * ROWS):
        r, c = divmod(i, COLS)
        y0, x0 = r * BLOCK + 4, c * BLOCK + 4
        m = float(img[y0:y0 + 8, x0:x0 + 8].mean())
        third = (HI - LO) / 3
        if LO + third < m < HI - third:
            return None
        bits.append(1 if m > (LO + HI) / 2 else 0)
    if bits[:2] != [1, 0] or bits[22:] != [0, 1]:
        return None
    body = bits[2:20]
    if sum(body) % 4 != bits[20] * 2 + bits[21]:
        return None
    tag = int("".join(map(str, body[:3])), 2)
    frame = int("".join(map(str, body[3:])), 2)
    return (tag, frame) if tag else None


def make_media(path: Path, tag: int, seconds: float, fps: int = 30, size=(320, 180), audio=True, audio_seconds: float | None = None) -> Path:
    """產生測試影片：背景亮度隨秒數變化（方便人眼看），左上角條碼，每秒開頭一聲嗶。
    audio_seconds：聲音和畫面不一樣長（例如配音比畫面長一點），預設同 seconds。"""
    w, h = size
    n = int(round(seconds * fps))
    path.parent.mkdir(parents=True, exist_ok=True)
    wav = path.with_suffix(".wav")
    if audio:
        asec = audio_seconds or seconds
        t = np.arange(int(asec * SR)) / SR
        x = np.zeros_like(t)
        for s in range(int(np.ceil(asec))):
            a, b = int(s * SR), min(int((s + PIP_LEN) * SR), t.size)
            env = np.hanning(b - a) ** 0.25
            x[a:b] = 0.5 * env * np.sin(2 * np.pi * PIP_FREQ[tag] * t[a:b])
        pcm = (np.stack([x, x], 1) * 32767).astype("<i2")
        import wave
        with wave.open(str(wav), "wb") as f:
            f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR); f.writeframes(pcm.tobytes())
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", str(fps), "-i", "pipe:0"]
    if audio:
        cmd += ["-i", str(wav)]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", str(fps), "-pix_fmt", "yuv420p"]
    cmd += (["-c:a", "aac", "-b:a", "192k", *([] if audio_seconds else ["-shortest"])] if audio else []) + [str(path)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, creationflags=FLAGS)
    for i in range(n):
        img = np.full((h, w), 40 + (i // fps) * 15 % 150, np.uint8)
        draw(img, tag, i)
        p.stdin.write(img.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"產生測試素材失敗：{path}")
    wav.unlink(missing_ok=True)
    return path


def read_video(path: Path) -> tuple[list[tuple[int, int] | None], float, tuple[int, int]]:
    """逐格讀回條碼。回傳 (每格的 (代號, 格) 或 None, fps, (寬, 高))。"""
    import json
    info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                               "stream=width,height,r_frame_rate", "-of", "json", str(path)], creationflags=FLAGS))
    st = info["streams"][0]
    w, h = st["width"], st["height"]
    n, d = st["r_frame_rate"].split("/")
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                                  creationflags=FLAGS)
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
    return [read(f) for f in frames], float(n) / float(d), (w, h)


def read_pips(path: Path) -> list[tuple[float, int | None]]:
    """找出每一聲嗶的起點（秒）與它代表的素材代號（音高對不上任何素材時為 None）。"""
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                                  creationflags=FLAGS)
    x = np.frombuffer(raw, np.float32)
    if not x.size:
        return []
    hop = int(0.002 * SR)
    env = np.sqrt(np.convolve(x * x, np.ones(hop) / hop, mode="same"))
    on = env > 0.05
    out, i = [], 0
    while i < on.size:
        if on[i]:
            j = i
            while j < on.size and (on[j] or (j + int(0.02 * SR) < on.size and on[j:j + int(0.02 * SR)].any())):
                j += 1
            seg = x[i:min(j, i + int(PIP_LEN * SR))]
            if seg.size > 256:
                spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size)))
                f = np.fft.rfftfreq(seg.size, 1 / SR)[int(np.argmax(spec))]
                tag = min(PIP_FREQ, key=lambda k: abs(np.log2(PIP_FREQ[k] / f)))
                out.append((i / SR, tag if abs(np.log2(PIP_FREQ[tag] / f)) < 0.15 else None))
            i = j + int(0.2 * SR)   # 嗶與嗶至少隔 1 秒，跳過尾巴
        else:
            i += 1
    return out
