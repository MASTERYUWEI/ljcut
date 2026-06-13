"""字幕服務 — SRT 生成/解析"""

from pathlib import Path


class SubtitleService:
    @staticmethod
    def format_timestamp(seconds: float) -> str:
        """秒數轉 SRT 時間格式 (HH:MM:SS,mmm)"""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        millis = int((seconds % 1) * 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

    @staticmethod
    def segments_to_srt(segments: list[dict], output_path: str) -> str:
        """
        將辨識結果轉為 SRT 格式

        Args:
            segments: [{"id": 0, "start": 0.0, "end": 2.5, "text": "你好"}, ...]
            output_path: 輸出路徑

        Returns:
            SRT 內容字串
        """
        lines = []
        for i, seg in enumerate(segments, 1):
            start = SubtitleService.format_timestamp(seg["start"])
            end = SubtitleService.format_timestamp(seg["end"])
            text = seg.get("text", "").strip()
            lines.append(f"{i}")
            lines.append(f"{start} --> {end}")
            lines.append(text)
            lines.append("")  # 空行分隔

        srt_content = "\n".join(lines)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(srt_content)

        return srt_content

    @staticmethod
    def format_ass_timestamp(seconds: float) -> str:
        """秒數轉 ASS 時間格式 (H:MM:SS.cc)"""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        centis = int((seconds % 1) * 100)
        return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"

    @staticmethod
    def segments_to_ass(
        segments: list[dict],
        output_path: str,
        style: dict | None = None,
        video_width: int = 1920,
        video_height: int = 1080,
    ) -> str:
        """
        將辨識結果轉為 ASS 格式（含完整樣式，不需 force_style）

        PlayResX/PlayResY 直接設為影片解析度，
        FontSize 等數值即為實際像素。
        """
        if style is None:
            style = {}

        font_name = style.get("fontName", "Microsoft JhengHei")
        font_size = int(style.get("fontSize", 20))
        outline_w = int(style.get("outlineWidth", 2))
        bg_enabled = bool(style.get("bgEnabled", False))
        bg_opacity = int(style.get("bgOpacity", 60))
        pos_y = int(style.get("posY", 90))

        # libass FontSize 用 ascender+descender 度量，≠ CSS em-square
        # CJK 字體（微軟正黑體等）需要 ×1.25 來匹配 CSS font-size
        ass_font_size = int(font_size * 1.25)
        ass_outline_w = int(outline_w * 1.25)

        # ASS 顏色格式: &HAABBGGRR
        primary_colour = "&H00FFFFFF"  # 白色
        outline_colour = "&H00000000"  # 黑色
        shadow_colour = "&H80000000"

        # MarginV: 從底部算的距離（像素）
        # CSS 用 transform: translate(-50%, -50%) 做中心對齊
        # ASS Alignment=2 是底邊對齊，所以要扣掉半個字高
        margin_v = max(0, int((100 - pos_y) / 100 * video_height - ass_font_size / 2))

        border_style = 1  # 預設有 outline
        back_colour = "&H00000000"
        shadow_val = 1

        if bg_enabled:
            alpha = int(255 * (1 - bg_opacity / 100))
            alpha_hex = f"{alpha:02X}"
            border_style = 4  # 背景框
            back_colour = f"&H{alpha_hex}000000"
            shadow_val = 0

        # ASS 檔案內容
        ass_content = f"""[Script Info]
Title: LJCUT Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font_name},{ass_font_size},{primary_colour},&H000000FF,{outline_colour},{back_colour},0,0,0,0,100,100,0,0,{border_style},{ass_outline_w},{shadow_val},2,10,10,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
        for seg in segments:
            start = SubtitleService.format_ass_timestamp(seg["start"])
            end = SubtitleService.format_ass_timestamp(seg["end"])
            text = seg.get("text", "").strip().replace("\n", "\\N")
            ass_content += f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8-sig") as f:
            f.write(ass_content)

        return ass_content

    @staticmethod
    def multi_clip_segments_to_ass(
        clips_data: list[dict],
        output_path: str,
        style: dict | None = None,
        video_width: int = 1920,
        video_height: int = 1080,
    ) -> str:
        """
        多 clip 合併字幕 → 單一 ASS 檔案

        Args:
            clips_data: [{"segments": [...], "time_offset": 0.0, "speed": 1.0}, ...]
                time_offset: 該 clip 在最終影片中的起始秒數
                speed: 該 clip 的播放倍速
            output_path: ASS 輸出路徑
            style: 字幕樣式
            video_width/video_height: 影片解析度
        """
        if style is None:
            style = {}

        font_name = style.get("fontName", "Microsoft JhengHei")
        font_size = int(style.get("fontSize", 20))
        outline_w = int(style.get("outlineWidth", 2))
        bg_enabled = bool(style.get("bgEnabled", False))
        bg_opacity = int(style.get("bgOpacity", 60))
        pos_y = int(style.get("posY", 90))

        ass_font_size = int(font_size * 1.25)
        ass_outline_w = int(outline_w * 1.25)

        primary_colour = "&H00FFFFFF"
        outline_colour = "&H00000000"

        margin_v = max(0, int((100 - pos_y) / 100 * video_height - ass_font_size / 2))

        border_style = 1
        back_colour = "&H00000000"
        shadow_val = 1

        if bg_enabled:
            alpha = int(255 * (1 - bg_opacity / 100))
            alpha_hex = f"{alpha:02X}"
            border_style = 4
            back_colour = f"&H{alpha_hex}000000"
            shadow_val = 0

        ass_content = f"""[Script Info]
Title: LJCUT Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font_name},{ass_font_size},{primary_colour},&H000000FF,{outline_colour},{back_colour},0,0,0,0,100,100,0,0,{border_style},{ass_outline_w},{shadow_val},2,10,10,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
        for clip_info in clips_data:
            segs = clip_info.get("segments", [])
            offset = float(clip_info.get("time_offset", 0))
            speed = float(clip_info.get("speed", 1.0))
            trim_start = float(clip_info.get("trim_start", 0))

            for seg in segs:
                # 字幕時間 = (媒體時間 - trimStart) / speed + 累計偏移
                s = (seg["start"] - trim_start) / speed + offset
                e = (seg["end"] - trim_start) / speed + offset
                if e <= 0:
                    continue
                s = max(s, 0)

                start_ts = SubtitleService.format_ass_timestamp(s)
                end_ts = SubtitleService.format_ass_timestamp(e)
                text = seg.get("text", "").strip().replace("\n", "\\N")
                ass_content += f"Dialogue: 0,{start_ts},{end_ts},Default,,0,0,0,,{text}\n"

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8-sig") as f:
            f.write(ass_content)

        return ass_content

    @staticmethod
    def parse_srt(srt_path: str) -> list[dict]:
        """
        解析 SRT 檔案為 segments

        Returns:
            [{"id": 0, "start": 0.0, "end": 2.5, "text": "你好"}, ...]
        """
        segments = []
        with open(srt_path, "r", encoding="utf-8") as f:
            content = f.read()

        blocks = content.strip().split("\n\n")
        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) < 3:
                continue

            # 解析時間
            time_line = lines[1]
            start_str, end_str = time_line.split(" --> ")
            start = SubtitleService._parse_timestamp(start_str.strip())
            end = SubtitleService._parse_timestamp(end_str.strip())
            text = "\n".join(lines[2:])

            segments.append({
                "id": len(segments),
                "start": start,
                "end": end,
                "text": text,
            })

        return segments

    @staticmethod
    def _parse_timestamp(ts: str) -> float:
        """SRT 時間格式轉秒數"""
        ts = ts.replace(",", ".")
        parts = ts.split(":")
        hours = float(parts[0])
        minutes = float(parts[1])
        seconds = float(parts[2])
        return hours * 3600 + minutes * 60 + seconds
