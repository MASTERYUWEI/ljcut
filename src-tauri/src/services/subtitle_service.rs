//! 字幕服務 — SRT 生成/解析

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordInfo {
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub probability: f64,
}

/// 秒數轉 SRT 時間格式 (HH:MM:SS,mmm)
fn format_timestamp(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let millis = total_ms % 1000;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

/// SRT 時間格式轉秒數
fn parse_timestamp(ts: &str) -> f64 {
    let ts = ts.replace(',', ".");
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() != 3 {
        return 0.0;
    }
    let hours: f64 = parts[0].parse().unwrap_or(0.0);
    let minutes: f64 = parts[1].parse().unwrap_or(0.0);
    let seconds: f64 = parts[2].parse().unwrap_or(0.0);
    hours * 3600.0 + minutes * 60.0 + seconds
}

/// 將 segments 轉為 SRT 格式並寫入檔案
pub fn segments_to_srt(segments: &[Segment], output_path: &str) -> Result<String, String> {
    let mut lines = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        let start = format_timestamp(seg.start);
        let end = format_timestamp(seg.end);
        let text = seg.text.trim();
        lines.push(format!("{}", i + 1));
        lines.push(format!("{start} --> {end}"));
        lines.push(text.to_string());
        lines.push(String::new());
    }

    let srt_content = lines.join("\n");

    if let Some(parent) = Path::new(output_path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建立目錄失敗: {e}"))?;
    }
    fs::write(output_path, &srt_content).map_err(|e| format!("寫入 SRT 失敗: {e}"))?;

    Ok(srt_content)
}

/// 解析 SRT 檔案為 segments
pub fn parse_srt(srt_path: &str) -> Result<Vec<Segment>, String> {
    let content = fs::read_to_string(srt_path).map_err(|e| format!("讀取 SRT 失敗: {e}"))?;
    let mut segments = Vec::new();

    for block in content.trim().split("\n\n") {
        let lines: Vec<&str> = block.trim().split('\n').collect();
        if lines.len() < 3 {
            continue;
        }

        let time_line = lines[1];
        let parts: Vec<&str> = time_line.split(" --> ").collect();
        if parts.len() != 2 {
            continue;
        }

        let start = parse_timestamp(parts[0].trim());
        let end = parse_timestamp(parts[1].trim());
        let text = lines[2..].join("\n");

        segments.push(Segment {
            id: segments.len() as u32,
            start,
            end,
            text,
            words: None,
        });
    }

    Ok(segments)
}
