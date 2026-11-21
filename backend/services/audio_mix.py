"""配樂、自動壓低（ducking）、平台響度、節拍偵測（借鏡 Editkin 的聲音功能，做法自寫）。

- 壓低包絡由前端 audioMix.ts 依字幕（旁白）算好成 [[時間軸秒, dB], ...] 傳來；預覽播放與這裡的匯出
  用同一組關鍵點做線性內插，所以聽到的和成品一致。
- 平台響度用 ffmpeg loudnorm 兩階段：先量測，再以 linear=true 套用量到的數值（不做動態壓縮）。
- 節拍偵測只用 numpy：頻譜通量 → 自相關估 BPM → 找最佳相位 → 每拍在 ±60ms 內對齊到通量峰值。
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
_FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
LOUDNESS_PRESETS = {"youtube": -14.0, "teaching": -16.0}
TRUE_PEAK = -1.5
LRA = 11.0
BEAT_BIAS = 0.0715   # 通量峰值比起音早約 72ms（分析窗涵蓋到起音就跳），以 97／120 BPM 節拍器測試音校正


def _run(cmd: list[str], timeout=1800, cancel_event=None) -> subprocess.CompletedProcess:
    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError("Export cancelled")
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=_FLAGS)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 失敗（exit {proc.returncode}）：{proc.stderr.decode('utf-8', 'replace')[-1500:]}")
    return proc


def decode(path: str, sr: int = SR, channels: int = 2) -> np.ndarray:
    """解碼成 float32，形狀 (樣本數, 聲道)。"""
    proc = _run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", str(channels), "-ar", str(sr), "pipe:1"])
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    return data.reshape(-1, channels) if channels > 1 else data


def write_wav(path: str, samples: np.ndarray, sr: int = SR) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(samples.shape[1] if samples.ndim > 1 else 1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def sanitize_music(m: dict | None, total: float) -> dict | None:
    """驗證前端送來的配樂設定（不信任外部輸入）。"""
    if not m:
        return None
    if not isinstance(m, dict):
        raise ValueError("配樂設定格式無效")
    try:
        volume = float(m.get("volume", 0.3))
        offset = float(m.get("offset", 0))
        fade_out = float(m.get("fadeOut", 2))
        fade_in = float(m.get("fadeIn", 0.5))
    except (TypeError, ValueError):
        raise ValueError("配樂數值無效") from None
    if not (0 <= volume <= 2 and offset >= 0 and 0 <= fade_out <= 30 and 0 <= fade_in <= 30):
        raise ValueError("配樂音量需 0–2、起播秒數 ≥ 0、淡入淡出 0–30 秒")
    env = m.get("envelope") or []
    if not isinstance(env, list) or len(env) > 50000:
        raise ValueError("壓低包絡格式無效")
    points = []
    for p in env:
        if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in p)):
            raise ValueError("壓低包絡需為 [秒, dB] 陣列")
        if not (-60 <= p[1] <= 6):
            raise ValueError("壓低量需在 -60–6 dB")
        points.append((float(p[0]), float(p[1])))
    if any(b[0] < a[0] for a, b in zip(points, points[1:])):
        raise ValueError("壓低包絡時間需遞增")
    return {"volume": volume, "offset": offset, "loop": bool(m.get("loop", True)), "fadeOut": fade_out, "fadeIn": fade_in,
            "envelope": points, "total": float(total)}


def gain_curve(points: list[tuple[float, float]], n: int, sr: int = SR) -> np.ndarray:
    """關鍵點（秒, dB）線性內插成每個樣本的線性增益；沒有關鍵點＝0 dB。和前端 envelopeAt 相同公式。"""
    if not points:
        return np.ones(n, dtype=np.float32)
    t = np.arange(n, dtype=np.float64) / sr
    xs = np.array([p[0] for p in points]); ys = np.array([p[1] for p in points])
    db = np.interp(t, xs, ys)
    return np.power(10.0, db / 20.0).astype(np.float32)


def render_music(src: str, music: dict, out_wav: str) -> None:
    """把配樂排到整條時間軸長度：起播秒數、循環、音量、壓低包絡、淡入淡出。"""
    total_n = max(1, int(round(music["total"] * SR)))
    raw = decode(src)
    if raw.shape[0] == 0:
        raise ValueError("配樂沒有聲音")
    start = min(int(round(music["offset"] * SR)), raw.shape[0] - 1)
    body = raw[start:]
    if music["loop"] and body.shape[0] < total_n:
        reps = math.ceil(total_n / raw.shape[0]) + 1
        body = np.concatenate([body] + [raw] * reps)
    out = np.zeros((total_n, 2), dtype=np.float32)
    k = min(total_n, body.shape[0])
    out[:k] = body[:k]
    g = gain_curve(music["envelope"], total_n) * music["volume"]
    fi, fo = int(music["fadeIn"] * SR), int(music["fadeOut"] * SR)
    if fi > 0:
        g[:fi] *= np.linspace(0, 1, min(fi, total_n), dtype=np.float32)[: min(fi, total_n)]
    end = min(k, total_n)   # 不循環時配樂可能比影片短，淡出放在配樂結尾
    if fo > 0 and end > 0:
        a = max(0, end - fo)
        g[a:end] *= np.linspace(1, 0, end - a, dtype=np.float32)
    out *= g[:, None]
    write_wav(out_wav, out)


def mix(main_wav: str, music_wav: str, out_wav: str, cancel_event=None) -> None:
    _run(["ffmpeg", "-y", "-v", "error", "-i", main_wav, "-i", music_wav, "-filter_complex",
          "[0:a][1:a]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[a]", "-map", "[a]",
          "-c:a", "pcm_s16le", "-ar", str(SR), "-ac", "2", out_wav], cancel_event=cancel_event)


def _loudnorm_json(stderr: str) -> dict:
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not m:
        raise RuntimeError("讀不到 loudnorm 量測結果")
    return json.loads(m.group(0))


def measure(path: str, target: float = -14.0, cancel_event=None) -> dict:
    p = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af",
              f"loudnorm=I={target}:TP={TRUE_PEAK}:LRA={LRA}:print_format=json", "-f", "null", "-"], cancel_event=cancel_event)
    return _loudnorm_json(p.stderr.decode("utf-8", "replace"))


def normalize(in_wav: str, out_wav: str, target: float, cancel_event=None) -> dict:
    """兩階段 loudnorm；回傳 {before, after, truePeak, target}（LUFS／dBTP）。"""
    m = measure(in_wav, target, cancel_event)
    if not math.isfinite(float(m["input_i"])) or float(m["input_i"]) < -70:
        # 幾乎無聲：不放大雜訊，直接照抄
        _run(["ffmpeg", "-y", "-v", "error", "-i", in_wav, "-c:a", "pcm_s16le", out_wav], cancel_event=cancel_event)
        return {"before": None, "after": None, "truePeak": None, "target": target, "skipped": "幾乎無聲"}
    af = (f"loudnorm=I={target}:TP={TRUE_PEAK}:LRA={LRA}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
          f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}"
          f":linear=true:print_format=json,aresample={SR}")
    p = _run(["ffmpeg", "-y", "-hide_banner", "-nostats", "-i", in_wav, "-af", af, "-c:a", "pcm_s16le", "-ar", str(SR), out_wav],
             cancel_event=cancel_event)
    r = _loudnorm_json(p.stderr.decode("utf-8", "replace"))
    return {"before": round(float(m["input_i"]), 1), "after": round(float(r["output_i"]), 1),
            "truePeak": round(float(r["output_tp"]), 1), "target": target, "mode": r.get("normalization_type")}


def beats(path: str, max_seconds: float = 900) -> dict:
    """配樂節拍點（素材秒數）。回傳 {bpm, beats:[秒...], confidence}。"""
    sr, hop, nfft = 22050, 512, 2048
    x = decode(path, sr, 1)[: int(max_seconds * sr)].astype(np.float64)
    if x.size < nfft * 4:
        return {"bpm": None, "beats": [], "confidence": 0.0}
    frames = 1 + (x.size - nfft) // hop
    idx = np.arange(nfft)[None, :] + hop * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(nfft)[None, :], axis=1))
    logspec = np.log1p(100 * spec)
    flux = np.maximum(0, np.diff(logspec, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")   # 去掉緩慢起伏，只留起音
    flux = np.maximum(flux, 0)
    if flux.max() <= 0:
        return {"bpm": None, "beats": [], "confidence": 0.0}
    flux /= flux.max()
    fps = sr / hop
    # 自相關找節拍週期（60–180 BPM），偏好 120 附近（避免抓到半拍／倍拍）
    ac = np.correlate(flux, flux, mode="full")[flux.size - 1:]
    lags = np.arange(ac.size)
    lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)
    cand = lags[lo:hi + 1]
    bpm_c = 60 * fps / cand
    weight = np.exp(-0.5 * (np.log2(bpm_c / 120) / 0.9) ** 2)
    score = ac[lo:hi + 1] * weight
    period = int(cand[int(np.argmax(score))])
    # 拋物線內插讓週期有小數，長曲目才不會累積誤差
    i = period
    if 1 <= i < ac.size - 1:
        a, b, c = ac[i - 1], ac[i], ac[i + 1]
        d = (a - 2 * b + c)
        period_f = i + (0.5 * (a - c) / d if d != 0 else 0)
    else:
        period_f = float(i)
    # 最佳相位
    phases = np.arange(int(period_f) + 1)
    sums = [flux[np.round(np.arange(p, flux.size, period_f)).astype(int).clip(0, flux.size - 1)].sum() for p in phases]
    phase = float(phases[int(np.argmax(sums))])
    win = max(1, int(0.07 * fps))

    def track(start: float, per: float) -> list[int]:
        """沿著預測的拍點走，每拍在 ±70ms 內找通量峰值；太弱就照預測（不讓雜訊把節拍拉走）"""
        ks, t = [], start
        while t < flux.size:
            a, b = max(0, int(round(t)) - win), min(flux.size, int(round(t)) + win + 1)
            k = a + int(np.argmax(flux[a:b]))
            ks.append(k if flux[k] >= 0.15 else int(round(t)))
            t = ks[-1] + per if flux[k] >= 0.15 else t + per
        return ks
    ks = track(phase, period_f)
    # 用實際對齊到的拍點回歸出週期，再追一次（長曲目不累積誤差）
    if len(ks) >= 8:
        slope, icpt = np.polyfit(np.arange(len(ks)), np.array(ks, dtype=float), 1)
        if 0.9 * period_f < slope < 1.1 * period_f:
            period_f = float(slope)
            ks = track(icpt % period_f if icpt > period_f else max(icpt, 0.0), period_f)
    out = [round(k / fps + BEAT_BIAS, 3) for k in ks]
    on_grid = float(np.mean([flux[k] for k in ks])) if ks else 0.0
    return {"bpm": round(60 * fps / period_f, 1), "beats": out, "confidence": round(on_grid, 2)}


def resolve(raw, total: float, uploads: Path):
    """匯出用：驗證前端的配樂／響度設定（{loudness, music}），找回配樂檔案路徑；都沒有回傳 None。"""
    from . import asset as asset_service
    if not raw:
        return None
    if not isinstance(raw, dict):
        raise ValueError("audioMix 格式無效")
    loud = raw.get("loudness")
    if loud not in (None, "off", "youtube", "teaching"):
        raise ValueError("平台響度需為 off／youtube／teaching")
    out = {"loudness": LOUDNESS_PRESETS.get(loud) if loud else None, "music": None}
    m = raw.get("music")
    if m:
        aid = (m.get("asset") or {}).get("id") if isinstance(m, dict) else None
        path = asset_service.find(uploads, aid) if aid else None
        if not path or path.suffix.lower() not in asset_service.AUDIO_EXT:
            raise ValueError("找不到配樂檔案，請重新選擇配樂")
        out["music"] = {**sanitize_music(m, total), "path": str(path)}
    return out if (out["music"] or out["loudness"]) else None
