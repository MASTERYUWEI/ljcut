"""LJCUT Transcribe Worker — 獨立 Python 辨識腳本（Tauri sidecar 用）

用法: python transcribe_worker.py <audio_path> <language>
輸出: JSON 到 stdout
"""

import sys
import json
import os
import glob

# 自動搜尋 NVIDIA DLL 路徑
_script_dir = os.path.dirname(os.path.abspath(__file__))
_venv_site = os.path.join(_script_dir, "..", "..", "backend", "venv", "Lib", "site-packages")
for _nvidia_dir in glob.glob(os.path.join(_venv_site, "nvidia", "*", "bin")):
    os.environ["PATH"] = _nvidia_dir + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(_nvidia_dir)
    except Exception:
        pass

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: transcribe_worker.py <audio_path> <language>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2]

    # 載入模型
    model = WhisperModel(
        "SoybeanMilk/faster-whisper-Breeze-ASR-25",
        device="cuda",
        compute_type="float16",
    )

    # 執行辨識
    segments_gen, info = model.transcribe(
        audio_path,
        language=language if language != "auto" else None,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(
            threshold=0.6,
            min_silence_duration_ms=300,
            min_speech_duration_ms=500,
            max_speech_duration_s=10,
            speech_pad_ms=150,
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
        if seg.words:
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

    result = {
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "segments": segments,
    }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
