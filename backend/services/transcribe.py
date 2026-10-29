"""語音辨識服務 — 使用 MR Breeze ASR 25（台灣繁體中文優化）"""

import os
from pathlib import Path


def _register_cuda_dlls():
    """把 venv 內 nvidia pip 套件的 CUDA DLL 目錄註冊進搜尋路徑。

    ctranslate2 只把自己的套件目錄 add_dll_directory，不會找 pip 裝的
    nvidia-cublas/cudnn（cublas64_12.dll 等），系統 PATH 又沒有 CUDA Toolkit 時，
    模型 init 會成功（懶載入）、但一開始推論就炸
    「Library cublas64_12.dll is not found」。這裡在 import ctranslate2 前補註冊。
    """
    try:
        import nvidia  # nvidia-cublas-cu12 / nvidia-cudnn-cu12 的命名空間套件
        for base in nvidia.__path__:
            for sub in ("cublas", "cudnn"):
                d = Path(base) / sub / "bin"
                if d.is_dir():
                    try:
                        os.add_dll_directory(str(d))
                    except Exception:
                        pass
                    os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
                    print(f"🔗 已註冊 CUDA DLL 目錄: {d}", flush=True)
    except Exception as e:
        print(f"⚠️ CUDA DLL 目錄註冊略過: {e}", flush=True)


_register_cuda_dlls()

from faster_whisper import BatchedInferencePipeline, WhisperModel  # noqa: E402（需在 DLL 註冊後 import）

_VAD = dict(
    threshold=0.5,                  # Silero VAD 預設門檻，保留尾音
    min_silence_duration_ms=500,     # 500ms 靜音才切分（避免思考停頓被拆段）
    min_speech_duration_ms=500,      # 至少 500ms 才算語音（過濾短噪音）
    max_speech_duration_s=10,        # 超過 10 秒強制切分（避免超長段落）
    speech_pad_ms=400,               # 語音前後留白 400ms（Silero 預設），確保字幕覆蓋完整語音
)
_GAP = 0.6       # 快速模式重新切句：詞間停頓超過此秒數就換句
_MAX_LEN = 8.0   # 快速模式單句上限秒數（對齊精準模式實測最長約 8 秒）
_PUNCT = "。！？!?"


def _resegment(words):
    """批次模式會把字幕合成 30 秒以上的大段；改依詞間停頓／句末標點／長度重新切句。"""
    out, cur = [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > _GAP or w["end"] - cur[0]["start"] > _MAX_LEN):
            out.append(cur)
            cur = []
        cur.append(w)
        if w["word"] and w["word"][-1] in _PUNCT:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out



class TranscribeService:
    def __init__(
        self,
        model_size: str = "SoybeanMilk/faster-whisper-Breeze-ASR-25",
        device: str = "cuda",
        compute_type: str = "float16",
    ):
        """
        初始化 ASR 模型

        MR Breeze ASR 25（聯發創新基地 MediaTek Research）
        - 基於 Whisper 架構，針對台灣國語口音和用語優化
        - 精準度比原始 Whisper 提升 ~10%
        - 中英混用辨識能力提升 56%
        - 直接輸出繁體中文，不需要 OpenCC 轉換
        - float16: 3090 支援，省 VRAM
        """
        self.model_size = model_size
        print(f"📦 模型: {model_size}")
        # 優先嘗試 CUDA(float16)，失敗自動退回 CPU(int8)，避免無 GPU/驅動異常時整個服務啟動失敗
        try:
            self.model = WhisperModel(
                model_size,
                device=device,
                compute_type=compute_type,
            )
            self.device = device
            print(f"✅ 使用 {device} ({compute_type})")
        except Exception as e:
            print(f"⚠️ {device} 初始化失敗（{e}），改用 CPU(int8)")
            self.model = WhisperModel(
                model_size,
                device="cpu",
                compute_type="int8",
            )
            self.device = "cpu"

    def transcribe(
        self,
        audio_path: str,
        language: str = "zh",
        word_timestamps: bool = True,
        vad_filter: bool = True,
        on_progress=None,
        fast: bool = False,
    ) -> dict:
        """執行辨識；CUDA 在推論途中掛掉（缺 cublas/cudnn 等）時自動退回 CPU 重試一次。

        fast=True：批次推論（3090 實測約 4 倍速），但專有名詞準確度略降、會吃掉部分口語贅詞；
        預設維持逐句精準模式。
        """
        args = (audio_path, language, word_timestamps, vad_filter, on_progress, fast)
        try:
            return self._transcribe_impl(*args)
        except RuntimeError as e:
            msg = str(e)
            if self.device == "cuda" and any(k in msg.lower() for k in ("cublas", "cudnn", "cuda")):
                print(f"⚠️ CUDA 推論失敗（{msg[:100]}），改用 CPU(int8) 重試", flush=True)
                self.model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
                self.device = "cpu"
                return self._transcribe_impl(*args)
            raise

    def _transcribe_impl(
        self,
        audio_path: str,
        language: str = "zh",
        word_timestamps: bool = True,
        vad_filter: bool = True,
        on_progress=None,
        fast: bool = False,
    ) -> dict:
        """
        執行語音辨識

        精準模式保留模型原始的自然斷句（依據換氣/停頓切分）；
        快速模式以批次推論後，依逐字時間戳重新切句。MR Breeze ASR 25 直接輸出繁體中文。
        """
        lang = language if language != "auto" else None
        batched = fast and self.device == "cuda"   # CPU 上批次沒有加速效果
        if batched:
            segments_gen, info = BatchedInferencePipeline(model=self.model).transcribe(
                audio_path, language=lang, word_timestamps=True,
                vad_filter=True, vad_parameters=_VAD, batch_size=16)
        else:
            segments_gen, info = self.model.transcribe(
                audio_path, language=lang, word_timestamps=word_timestamps,
                vad_filter=vad_filter, vad_parameters=_VAD)

        total = float(getattr(info, "duration", 0) or 0)
        if on_progress:
            try:
                on_progress(0.0, total)
            except Exception:
                pass

        def words_of(seg):
            return [{"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3),
                     "probability": round(w.probability, 3)} for w in (seg.words or [])]

        segments = []
        for seg in segments_gen:
            if batched:
                groups = _resegment([w for w in words_of(seg) if w["word"]])
                pieces = [(g[0]["start"], g[-1]["end"], "".join(w["word"] for w in g), g) for g in groups]
            else:
                pieces = [(round(seg.start, 3), round(seg.end, 3), seg.text.strip(),
                           words_of(seg) if word_timestamps else None)]
            for start, end, text, words in pieces:
                segment_data = {"id": len(segments), "start": start, "end": end, "text": text}
                if words and word_timestamps:
                    segment_data["words"] = words
                segments.append(segment_data)

            if on_progress:
                try:
                    on_progress(float(seg.end), total)
                except Exception:
                    pass

        return {
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 3),
            "segments": segments,
        }
