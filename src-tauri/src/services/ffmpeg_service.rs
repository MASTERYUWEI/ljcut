//! FFmpeg 服務 — 錄影後處理會用到的最小功能（調用系統 ffmpeg/ffprobe CLI）
//!
//! 其餘影片處理（抽音、燒字幕、波形、匯出）由 Python sidecar 負責，
//! 這裡只保留 recorder 需要的：媒體資訊 + 縮圖。

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub duration: f64,
    pub size_mb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
}

/// ffprobe JSON 解析輔助結構
#[derive(Deserialize)]
struct ProbeResult {
    format: Option<ProbeFormat>,
    streams: Option<Vec<ProbeStream>>,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}
#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    sample_rate: Option<String>,
}

/// 取得影片/音頻的基本資訊
pub fn get_media_info(file_path: &str) -> Result<MediaInfo, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            file_path,
        ])
        .output()
        .map_err(|e| format!("ffprobe 執行失敗: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: ProbeResult =
        serde_json::from_str(&stdout).map_err(|e| format!("ffprobe 解析失敗: {e}"))?;

    let fmt = data.format.unwrap_or(ProbeFormat {
        duration: None,
        size: None,
    });

    let mut info = MediaInfo {
        duration: fmt
            .duration
            .and_then(|d| d.parse::<f64>().ok())
            .unwrap_or(0.0),
        size_mb: fmt
            .size
            .and_then(|s| s.parse::<f64>().ok())
            .map(|s| (s / 1024.0 / 1024.0 * 100.0).round() / 100.0)
            .unwrap_or(0.0),
        width: None,
        height: None,
        fps: None,
        video_codec: None,
        audio_codec: None,
        sample_rate: None,
    };

    if let Some(streams) = data.streams {
        for stream in streams {
            match stream.codec_type.as_deref() {
                Some("video") => {
                    info.width = stream.width;
                    info.height = stream.height;
                    info.video_codec = stream.codec_name;
                    if let Some(fr) = stream.r_frame_rate {
                        info.fps = parse_frame_rate(&fr);
                    }
                }
                Some("audio") => {
                    info.audio_codec = stream.codec_name;
                    info.sample_rate = stream.sample_rate.and_then(|s| s.parse().ok());
                }
                _ => {}
            }
        }
    }

    Ok(info)
}

fn parse_frame_rate(fr: &str) -> Option<f64> {
    if let Some((num, den)) = fr.split_once('/') {
        let n: f64 = num.parse().ok()?;
        let d: f64 = den.parse().ok()?;
        if d > 0.0 {
            return Some((n / d * 100.0).round() / 100.0);
        }
    }
    fr.parse().ok()
}

/// 產生影片首幀縮圖
pub fn generate_thumbnail(file_path: &str, output_path: &str) -> Result<(), String> {
    let output = Command::new("ffmpeg")
        .args([
            "-y", "-i", file_path,
            "-vf", "thumbnail,scale=160:-1",
            "-frames:v", "1",
            output_path,
        ])
        .output()
        .map_err(|e| format!("ffmpeg 縮圖失敗: {e}"))?;

    if !output.status.success() {
        return Err("無法產生縮圖（可能是純音頻檔案）".into());
    }
    Ok(())
}
