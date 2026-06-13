"""語音辨識服務 — 使用 MR Breeze ASR 25（台灣繁體中文優化）"""

from faster_whisper import WhisperModel


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
        self.model_size = model_size

    def transcribe(
        self,
        audio_path: str,
        language: str = "zh",
        word_timestamps: bool = True,
        vad_filter: bool = True,
    ) -> dict:
        """
        執行語音辨識

        保留模型原始的自然斷句（依據換氣/停頓切分），
        MR Breeze ASR 25 直接輸出繁體中文。
        """
        segments_gen, info = self.model.transcribe(
            audio_path,
            language=language if language != "auto" else None,
            word_timestamps=word_timestamps,
            vad_filter=vad_filter,
            vad_parameters=dict(
                threshold=0.5,                  # Silero VAD 預設門檻，保留尾音
                min_silence_duration_ms=500,     # 500ms 靜音才切分（避免思考停頓被拆段）
                min_speech_duration_ms=500,      # 至少 500ms 才算語音（過濾短噪音）
                max_speech_duration_s=10,        # 超過 10 秒強制切分（避免超長段落）
                speech_pad_ms=400,               # 語音前後留白 400ms（Silero 預設），確保字幕覆蓋完整語音
            ),
        )

        segments = []
        for seg in segments_gen:
            text = seg.text.strip()

            segment_data = {
                "id": len(segments),
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": text,
            }

            # 逐字時間戳
            if word_timestamps and seg.words:
                segment_data["words"] = [
                    {
                        "word": w.word.strip(),
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "probability": round(w.probability, 3),
                    }
                    for w in seg.words
                ]

            segments.append(segment_data)

        return {
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 3),
            "segments": segments,
        }
