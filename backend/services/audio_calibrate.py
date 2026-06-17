"""音訊同步校正 — 同時錄「系統聲音」與「麥克風」幾秒，用互相關算出
麥克風相對系統的超前毫秒數（正值＝麥克風較早＝錄影時需延後麥克風）。

原理：使用喇叭時，喇叭放出的系統音樂也會被麥克風收到，兩條錄音裡有同一段
音樂 → 互相關找出位移量即為兩條擷取路徑的時間差。
"""

import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

CREATE_NO_WINDOW = 0x08000000  # Windows：隱藏 ffmpeg console


def _load_wav_mono(path: Path):
    with wave.open(str(path)) as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float64)
    else:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def measure_mic_ahead_ms(mic, sysd, sr, max_lag_ms=1500):
    """回傳 (麥克風超前毫秒數, 信心值)。正=麥克風較早=需延後麥克風。"""
    a = np.asarray(mic, dtype=np.float64)
    b = np.asarray(sysd, dtype=np.float64)
    a -= a.mean()
    b -= b.mean()
    if len(a) < sr // 2 or len(b) < sr // 2:
        return 0.0, 0.0
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    cc = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    max_lag = min(int(max_lag_ms / 1000 * sr), n // 2 - 1)
    cc2 = np.concatenate((cc[-max_lag:], cc[: max_lag + 1]))
    peak = float(cc2.max())
    lag = int(np.argmax(cc2)) - max_lag  # mic[t] ~ sys[t-lag]
    mic_ahead = -lag / sr * 1000.0       # lag<0（mic 超前）→ 正值
    rms = float(np.sqrt((cc2 ** 2).mean())) + 1e-9
    return float(mic_ahead), float(peak / rms)


def calibrate(sys_device: str, mic_device: str, seconds: int = 5) -> dict:
    """同時錄系統+麥克風到暫存 wav，互相關算出麥克風超前 ms。"""
    seconds = max(3, min(int(seconds), 10))
    tmp = Path(tempfile.gettempdir())
    sys_wav = tmp / "ljcut_cal_sys.wav"
    mic_wav = tmp / "ljcut_cal_mic.wav"
    args = [
        "ffmpeg", "-y",
        "-f", "dshow", "-thread_queue_size", "1024", "-i", f"audio={sys_device}",
        "-f", "dshow", "-thread_queue_size", "1024", "-i", f"audio={mic_device}",
        "-t", str(seconds), "-map", "0:a", "-ac", "1", "-ar", "48000", str(sys_wav),
        "-t", str(seconds), "-map", "1:a", "-ac", "1", "-ar", "48000", str(mic_wav),
    ]
    try:
        proc = subprocess.run(args, capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=seconds + 20)
    except Exception as e:
        return {"ok": False, "error": f"錄音啟動失敗：{e}"}

    if not sys_wav.exists() or not mic_wav.exists():
        tail = proc.stderr.decode("utf-8", "ignore")[-300:]
        return {"ok": False, "error": f"錄音失敗（請確認裝置名稱正確）：{tail}"}

    try:
        sysd, sr = _load_wav_mono(sys_wav)
        mic, sr2 = _load_wav_mono(mic_wav)
    finally:
        for p in (sys_wav, mic_wav):
            try:
                p.unlink()
            except Exception:
                pass

    if sr != sr2:
        return {"ok": False, "error": "兩軌取樣率不一致"}
    if np.abs(sysd).mean() < 5 or np.abs(mic).mean() < 5:
        return {"ok": False, "error": "音量太小：請確認校正期間系統正在播放音樂、且喇叭開著、麥克風有收音"}

    mic_ahead, conf = measure_mic_ahead_ms(mic, sysd, sr)
    return {
        "ok": True,
        "mic_ahead_ms": int(round(mic_ahead)),
        "confidence": round(conf, 1),
        "reliable": conf >= 8.0,
    }
