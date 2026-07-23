"""FFmpeg 服務 — 影片處理（含 NVENC 硬體加速）"""

import json
import subprocess
from fractions import Fraction
from pathlib import Path


def _parse_frame_rate(fr: str) -> float:
    """安全解析 ffprobe 的 r_frame_rate（如 '30000/1001'），取代不安全的 eval()"""
    try:
        if "/" in fr:
            return round(float(Fraction(fr)), 3)
        return round(float(fr), 3)
    except (ValueError, ZeroDivisionError):
        return 0.0


class FFmpegService:
    @staticmethod
    def get_media_info(file_path: str) -> dict:
        """取得影片/音頻的基本資訊"""
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            file_path,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            data = json.loads(result.stdout)

            info = {
                "duration": float(data.get("format", {}).get("duration", 0)),
                "size_mb": round(int(data.get("format", {}).get("size", 0)) / 1024 / 1024, 2),
            }

            for stream in data.get("streams", []):
                if stream["codec_type"] == "video":
                    info["width"] = stream.get("width", 0)
                    info["height"] = stream.get("height", 0)
                    info["fps"] = _parse_frame_rate(stream.get("r_frame_rate", "0/1"))
                    info["video_codec"] = stream.get("codec_name", "")
                elif stream["codec_type"] == "audio":
                    info["audio_codec"] = stream.get("codec_name", "")
                    info["sample_rate"] = int(stream.get("sample_rate", 0))

            return info
        except Exception as e:
            return {"error": str(e)}

    @staticmethod
    def extract_audio(
        video_path: str,
        output_path: str,
        sample_rate: int = 16000,
    ) -> str:
        """
        從影片中抽取音頻（WAV 16kHz mono，Whisper 最佳輸入格式）

        關鍵：aresample=async=1 確保 FFmpeg 解碼 AAC 時用靜音填充音頻空隙，
        保留原始時間戳。否則螢幕錄影等 VFR 來源的音頻會被壓縮
        （例如 770s 的 audio stream 只輸出 738s 的 PCM）。
        apad=pad_dur=1 再多補 1 秒靜音給 VAD 偵測尾音。
        """
        cmd = [
            "ffmpeg",
            "-y",
            "-i", video_path,
            "-vn",                    # 無影像
            "-acodec", "pcm_s16le",   # 16-bit PCM
            "-ar", str(sample_rate),  # 16kHz
            "-ac", "1",               # mono
            "-af", "aresample=async=1,apad=pad_dur=1",  # 填充空隙 + 尾音 padding
            output_path,
        ]
        subprocess.run(cmd, capture_output=True, timeout=300, check=True)
        return output_path

    @staticmethod
    def burn_subtitles_with_progress(
        video_path: str,
        srt_path: str,
        output_path: str,
        use_nvenc: bool = True,
        speed: float = 1.0,
        total_duration: float = 0,
        trim_start: float = 0,
        trim_end: float = 0,
    ):
        """
        帶進度回報的字幕燒入 — yield 進度 dict
        用法: for progress in burn_subtitles_with_progress(...): ...
        srt_path 可以是 .srt 或 .ass 檔
        """

        # 沒有字幕檔（例：使用者未辨識字幕，純剪輯匯出）→ 不套字幕濾鏡，否則 ffmpeg 會因
        # 開不了不存在的 .ass 而失敗。
        sub_path = Path(srt_path) if srt_path else None
        has_subs = sub_path is not None and sub_path.exists() and sub_path.stat().st_size > 0
        if has_subs:
            srt_abs = str(sub_path.resolve())
            srt_escaped = srt_abs.replace("\\", "/").replace(":", "\\:")
            # ASS 檔案已包含完整樣式，不需要 force_style
            sub_vf = f"subtitles='{srt_escaped}'"
        else:
            sub_vf = None

        codec_args = []
        if use_nvenc:
            codec_args = ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "8M"]
        else:
            codec_args = ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]

        cmd = [
            "ffmpeg",
            "-y",
        ]
        # 裁切：-ss 放在 -i 之前做 input seeking——解碼時間戳歸零後才進字幕濾鏡，
        # 與「以裁切點為 0 起算」的 ASS 對齊（output seeking 會讓字幕整體提前 trimStart 秒）；
        # 也不用解碼被丟棄的前段，大檔裁頭時匯出快很多。
        if trim_start > 0:
            cmd += ["-ss", str(trim_start)]
        cmd += ["-i", video_path]
        # 只要有有效裁切區間就限制輸出長度（含「只裁尾不裁頭」的情況）
        trim_dur = trim_end - trim_start if (trim_end > 0 and trim_end > trim_start) else 0
        if trim_dur > 0:
            # -to 是輸出時間，需考慮倍速
            output_dur = trim_dur / speed if speed != 1.0 else trim_dur
            cmd += ["-to", str(output_dur)]
        cmd += [
            "-progress", "pipe:1",
            "-nostats",
            "-avoid_negative_ts", "make_zero",
        ]

        if speed != 1.0:
            v_filters = f"setpts=PTS/{speed}" + (f",{sub_vf}" if sub_vf else "")
            vf_speed = f"[0:v]{v_filters}[v]"
            atempo_parts = []
            remaining = speed
            while remaining > 2.0:
                atempo_parts.append("atempo=2.0")
                remaining /= 2.0
            if remaining < 0.5:
                remaining = 0.5
            atempo_parts.append(f"atempo={remaining:.4f}")
            af = ",".join(atempo_parts)
            cmd += ["-filter_complex", f"{vf_speed};[0:a]{af}[a]", "-map", "[v]", "-map", "[a]"]
        elif sub_vf:
            cmd += ["-vf", sub_vf]
        # 無字幕且無變速 → 不加任何 -vf（純剪輯/重編碼）

        cmd += [
            *codec_args,
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "48000",
            output_path,
        ]

        print(f"🎬 FFmpeg 燒入指令: {' '.join(cmd)}")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        # 計算預期輸出時長（用於進度百分比）
        expected_output_dur = total_duration / speed if speed != 1.0 else total_duration

        # 用 Popen 啟動，即時讀取 progress
        import threading

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, encoding="utf-8", errors="replace",
        )

        # 另開 thread 排空 stderr，避免 pipe buffer 滿造成 deadlock
        stderr_data: list[str] = []
        def _drain_stderr():
            if proc.stderr:
                stderr_data.append(proc.stderr.read())
        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()

        # 解析 -progress pipe:1 輸出（用 readline 避免緩衝延遲）
        last_pct = 0
        for line in iter(proc.stdout.readline, ''):
            line = line.strip()
            if line.startswith("out_time_us="):
                try:
                    us = int(line.split("=")[1])
                    if expected_output_dur > 0:
                        pct = min(int(us / (expected_output_dur * 1_000_000) * 100), 99)
                        if pct > last_pct:
                            last_pct = pct
                            yield {"progress": pct}
                except ValueError:
                    pass
            elif line == "progress=end":
                break

        proc.wait()
        stderr_thread.join(timeout=5)
        if proc.returncode != 0:
            err_msg = stderr_data[0] if stderr_data else ""
            print(f"❌ FFmpeg 錯誤:\n{err_msg}")
            raise subprocess.CalledProcessError(proc.returncode, cmd)

        yield {"progress": 100}
        print(f"✅ 燒入完成: {output_path}")

    @staticmethod
    def export_timeline_with_progress(
        clips: list[dict],
        ass_path: str,
        output_path: str,
        use_nvenc: bool = True,
        video_width: int = 1920,
        video_height: int = 1080,
    ):
        """
        多 clip 串接匯出 — yield 進度 dict

        Args:
            clips: [{"video_path": str, "trim_start": float, "trim_end": float,
                     "speed": float, "output_duration": float}, ...]
                output_duration = (trimEnd - trimStart) / speed
            ass_path: 合併 ASS 字幕路徑
            output_path: 最終輸出路徑
        """
        import tempfile
        import threading
        import time

        temp_dir = Path(output_path).parent / "_temp_concat"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_files: list[str] = []
        total_clips = len(clips)
        total_duration = sum(c.get("output_duration", 0) for c in clips)

        # 目標 fps：取各段來源最高 fps（避免把 60fps 錄影降成 30 變頓），夾 24~60
        target_fps = 30
        try:
            fps_list = []
            for c in clips:
                pr = subprocess.run(
                    ["ffprobe", "-v", "error", "-select_streams", "v:0",
                     "-show_entries", "stream=avg_frame_rate", "-of", "default=nk=1:nw=1",
                     c["video_path"]],
                    capture_output=True, timeout=30)
                raw = pr.stdout.decode("utf-8", "ignore").strip()
                if "/" in raw:
                    n, d = raw.split("/")
                    if float(d) > 0:
                        fps_list.append(float(n) / float(d))
            if fps_list:
                target_fps = max(24, min(60, round(max(fps_list))))
        except Exception as e:
            print(f"⚠️ fps 偵測失敗，用預設 {target_fps}: {e}")
        print(f"🎞️ 匯出統一 fps = {target_fps}")

        # ETA：以「已處理輸出秒數 / 總工作量」估算（編碼為主；有字幕再加一輪燒錄）
        t0 = time.monotonic()
        _ass_pre = Path(ass_path)
        _pre_has_subs = _ass_pre.exists() and "Dialogue:" in _ass_pre.read_text(encoding="utf-8-sig", errors="ignore")
        total_work = (total_duration * (2 if _pre_has_subs else 1)) or 1.0
        processed = 0.0  # 已處理的輸出秒數

        def calc_eta(done_sec):
            frac = max(0.0, min(1.0, done_sec / total_work))
            el = time.monotonic() - t0
            if frac <= 0.02 or el < 1.5:
                return None  # 還估不準
            return int(max(0, el * (1 - frac) / frac))

        try:
            # ── Step 1: 逐 clip 產生標準化暫存檔 ──
            for idx, clip in enumerate(clips):
                video_path = clip["video_path"]
                trim_start = float(clip.get("trim_start", 0))
                trim_end = float(clip.get("trim_end", 0))
                speed = float(clip.get("speed", 1.0))
                clip_dur = trim_end - trim_start

                temp_out = str(temp_dir / f"clip_{idx}.mp4")
                temp_files.append(temp_out)

                cmd = ["ffmpeg", "-y"]
                # 裁切
                if trim_start > 0:
                    cmd += ["-ss", str(trim_start)]
                cmd += ["-i", video_path]
                if clip_dur > 0:
                    cmd += ["-t", str(clip_dur)]

                # 統一解析度 + 變速 + 重置 PTS + 統一 fps（concat 要求各段參數一致，
                # 否則 fps/timebase 不同會造成影像錯位、白畫面凍結直到時間戳追上）
                # setpts=(PTS-STARTPTS)/speed：把每段起點歸零，順便套變速（speed=1 即純歸零）
                speed_expr = f"(PTS-STARTPTS)/{speed}" if speed != 1.0 else "PTS-STARTPTS"
                vf_parts = [
                    f"setpts={speed_expr}",
                    f"scale={video_width}:{video_height}:force_original_aspect_ratio=decrease",
                    f"pad={video_width}:{video_height}:(ow-iw)/2:(oh-ih)/2:black",
                    "setsar=1",
                    f"fps={target_fps}",  # 統一影格率 → 強制 CFR
                ]
                cmd += ["-vf", ",".join(vf_parts)]

                # 音訊：重置 PTS（+ 變速）並統一格式
                af_parts = ["asetpts=PTS-STARTPTS"]
                if speed != 1.0:
                    remaining = speed
                    while remaining > 2.0:
                        af_parts.append("atempo=2.0")
                        remaining /= 2.0
                    if remaining < 0.5:
                        remaining = 0.5
                    af_parts.append(f"atempo={remaining:.4f}")
                cmd += ["-af", ",".join(af_parts)]

                cmd += [
                    "-r", str(target_fps),
                    "-fps_mode", "cfr",  # 強制固定影格率輸出
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                    "-pix_fmt", "yuv420p",
                    "-video_track_timescale", "90000",  # 統一時間基，concat 才不會錯位
                    "-avoid_negative_ts", "make_zero",
                    temp_out,
                ]

                # 段內即時進度：用 -progress 串流回 out_time（這段佔整體 0~60% 的對應區間）
                out_dur = (clip_dur / speed) if speed else clip_dur
                cmd_run = cmd[:2] + ["-progress", "pipe:1", "-nostats"] + cmd[2:]
                print(f"📦 Clip {idx+1}/{total_clips}: {' '.join(cmd_run)}")
                band_start = 60.0 * idx / total_clips
                band_end = 60.0 * (idx + 1) / total_clips
                proc = subprocess.Popen(
                    cmd_run, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    universal_newlines=True, encoding="utf-8", errors="replace",
                )
                cerr: list[str] = []
                cth = threading.Thread(
                    target=lambda: cerr.append(proc.stderr.read()) if proc.stderr else None,
                    daemon=True,
                )
                cth.start()
                last = -1
                for line in iter(proc.stdout.readline, ''):
                    line = line.strip()
                    if line.startswith("out_time_us="):
                        try:
                            cur = max(0.0, int(line.split("=")[1]) / 1_000_000)
                        except ValueError:
                            continue
                        intra = min(1.0, cur / out_dur) if out_dur > 0 else 0
                        disp = int(band_start + (band_end - band_start) * intra)
                        if disp != last:
                            last = disp
                            yield {"progress": disp, "stage": f"準備片段 {idx+1}/{total_clips}",
                                   "eta_seconds": calc_eta(processed + cur)}
                    elif line == "progress=end":
                        break
                proc.wait()
                cth.join(timeout=5)
                if proc.returncode != 0:
                    err = cerr[0] if cerr else ""
                    print(f"❌ Clip {idx+1} 失敗:\n{err}")
                    raise subprocess.CalledProcessError(proc.returncode, cmd_run)

                processed += out_dur
                yield {"progress": int(band_end), "stage": f"準備片段 {idx+1}/{total_clips}",
                       "eta_seconds": calc_eta(processed)}

            # ── Step 2: FFmpeg concat demuxer 串接 ──
            concat_list = str(temp_dir / "concat.txt")
            with open(concat_list, "w", encoding="utf-8") as f:
                for tf in temp_files:
                    # concat demuxer 路徑需要轉義單引號
                    escaped = tf.replace("\\", "/").replace("'", "'\\''")
                    f.write(f"file '{escaped}'\n")

            concat_out = str(temp_dir / "concat_merged.mp4")
            cmd_concat = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", concat_list,
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                concat_out,
            ]
            print(f"🔗 Concat: {' '.join(cmd_concat)}")
            result = subprocess.run(cmd_concat, capture_output=True, timeout=600)
            if result.returncode != 0:
                stderr = result.stderr.decode("utf-8", errors="replace")
                print(f"❌ Concat 失敗:\n{stderr}")
                raise subprocess.CalledProcessError(result.returncode, cmd_concat, stderr=result.stderr)

            yield {"progress": 70, "stage": "片段已串接", "eta_seconds": calc_eta(processed)}

            # 無字幕（所有 clip 都沒辨識字幕）→ 直接輸出串接結果，跳過燒字幕步驟
            import shutil as _sh
            ass_p = Path(ass_path)
            has_subs = ass_p.exists() and "Dialogue:" in ass_p.read_text(encoding="utf-8-sig", errors="ignore")
            if not has_subs:
                if Path(output_path).exists():
                    Path(output_path).unlink()
                _sh.move(concat_out, output_path)
                yield {"progress": 100, "eta_seconds": 0}
                print(f"✅ 多 clip 匯出完成（無字幕）: {output_path}")
                return

            # ── Step 3: 燒入字幕 ──
            ass_abs = str(Path(ass_path).resolve())
            ass_escaped = ass_abs.replace("\\", "/").replace(":", "\\:")
            vf_sub = f"subtitles='{ass_escaped}'"

            codec_args = []
            if use_nvenc:
                codec_args = ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "8M"]
            else:
                codec_args = ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]

            cmd_burn = [
                "ffmpeg", "-y",
                "-i", concat_out,
                "-progress", "pipe:1",
                "-nostats",
                "-avoid_negative_ts", "make_zero",
                "-vf", vf_sub,
                *codec_args,
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                output_path,
            ]
            print(f"🎬 Burn: {' '.join(cmd_burn)}")
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)

            proc = subprocess.Popen(
                cmd_burn, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, encoding="utf-8", errors="replace",
            )

            stderr_data: list[str] = []
            def _drain_stderr():
                if proc.stderr:
                    stderr_data.append(proc.stderr.read())
            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_thread.start()

            last_pct = 70
            for line in iter(proc.stdout.readline, ''):
                line = line.strip()
                if line.startswith("out_time_us="):
                    try:
                        us = int(line.split("=")[1])
                        if total_duration > 0:
                            # 燒字幕佔 70-99%
                            pct = 70 + min(int(us / (total_duration * 1_000_000) * 29), 29)
                            if pct > last_pct:
                                last_pct = pct
                                yield {"progress": pct, "stage": "燒入字幕",
                                       "eta_seconds": calc_eta(total_duration + us / 1_000_000)}
                    except ValueError:
                        pass
                elif line == "progress=end":
                    break

            proc.wait()
            stderr_thread.join(timeout=5)
            if proc.returncode != 0:
                err_msg = stderr_data[0] if stderr_data else ""
                print(f"❌ 燒入失敗:\n{err_msg}")
                raise subprocess.CalledProcessError(proc.returncode, cmd_burn)

            yield {"progress": 100, "eta_seconds": 0}
            print(f"✅ 多 clip 匯出完成: {output_path}")

        finally:
            # 清理暫存檔
            import shutil
            if temp_dir.exists():
                try:
                    shutil.rmtree(str(temp_dir))
                    print(f"🧹 已清理暫存: {temp_dir}")
                except Exception as e:
                    print(f"⚠️ 清理暫存失敗: {e}")

    @staticmethod
    def generate_waveform(
        file_path: str,
        samples_per_second: int = 10,
    ) -> list[float]:
        """
        產生音頻波形峰值數據，供前端 canvas 繪製。
        回傳歸一化 0~1 的浮點陣列，每秒 samples_per_second 個取樣。
        """
        import struct

        # Step 1: 取得影片長度
        probe_cmd = [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            file_path,
        ]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        duration = float(probe_result.stdout.strip())
        total_samples = int(duration * samples_per_second)
        if total_samples <= 0:
            return []

        # Step 2: FFmpeg 輸出原始 PCM (16-bit signed LE, mono, 8kHz)
        sample_rate = 8000
        cmd = [
            "ffmpeg", "-y",
            "-i", file_path,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", str(sample_rate),
            "-ac", "1",
            "-f", "s16le",
            "pipe:1",
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        raw = result.stdout

        # Step 3: 解析 PCM 並計算 peak（用浮點比例映射，避免整數除法累積誤差）
        num_pcm_samples = len(raw) // 2
        if num_pcm_samples == 0:
            return [0.0] * total_samples

        peaks: list[float] = []

        for i in range(total_samples):
            # 每個 peak 對應的 PCM 區間（用浮點比例精確映射）
            start = int(i * num_pcm_samples / total_samples)
            end = int((i + 1) * num_pcm_samples / total_samples)
            end = min(end, num_pcm_samples)
            if start >= num_pcm_samples:
                peaks.append(0.0)
                continue

            chunk = raw[start * 2 : end * 2]
            values = struct.unpack(f"<{len(chunk) // 2}h", chunk)
            peak = max(abs(v) for v in values) if values else 0
            peaks.append(peak / 32768.0)

        # 歸一化到 0~1
        max_peak = max(peaks) if peaks else 1.0
        if max_peak > 0:
            peaks = [p / max_peak for p in peaks]

        return peaks
