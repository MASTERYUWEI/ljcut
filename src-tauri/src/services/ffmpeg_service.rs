//! FFmpeg 服務 — 影片處理（調用系統 ffmpeg CLI）

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

/// 從影片中抽取音頻（WAV 16kHz mono）
pub fn extract_audio(video_path: &str, output_path: &str) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", video_path,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            output_path,
        ])
        .output()
        .map_err(|e| format!("ffmpeg 執行失敗: {e}"))?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        return Err(format!("ffmpeg 抽取音頻失敗: {stderr}"));
    }
    Ok(())
}

/// 字幕燒入影片
pub fn burn_subtitles(
    video_path: &str,
    srt_path: &str,
    output_path: &str,
    style: &BurnStyle,
) -> Result<(), String> {
    // Windows 路徑轉義：C:\Users\... → C\\:/Users/...
    let srt_escaped = srt_path
        .replace('\\', "/")
        .replace(':', "\\:");

    // 動態組合 ASS 字幕樣式
    let (alignment, margin_v) = pos_y_to_ass(style.pos_y);

    let mut parts = vec![
        format!("FontName={}", style.font_name),
        format!("FontSize={}", style.font_size),
        "PrimaryColour=&H00FFFFFF".to_string(),
        "OutlineColour=&H00000000".to_string(),
        format!("Outline={}", style.outline_width),
        "Shadow=1".to_string(),
        format!("Alignment={alignment}"),
        format!("MarginV={margin_v}"),
    ];

    if style.bg_enabled {
        let alpha = (255.0 * (1.0 - style.bg_opacity as f64 / 100.0)) as u8;
        parts.push("BorderStyle=4".to_string());
        parts.push(format!("BackColour=&H{alpha:02X}000000"));
        parts.push("Shadow=0".to_string());
    }

    let subtitle_style = parts.join(",");
    let vf = format!("subtitles='{srt_escaped}':force_style='{subtitle_style}'");

    // NVENC 硬體編碼（fallback 到 libx264）
    let codec_args = ["-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "8M"];

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-i", video_path, "-vf", &vf]);
    cmd.args(codec_args);
    cmd.args(["-c:a", "aac", "-b:a", "192k", output_path]);

    log::info!("🎬 FFmpeg 燒入: {:?}", cmd);

    let output = cmd.output().map_err(|e| format!("ffmpeg 執行失敗: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg 燒入失敗: {stderr}"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnStyle {
    #[serde(default = "default_font")]
    pub font_name: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_outline")]
    pub outline_width: u32,
    #[serde(default)]
    pub bg_enabled: bool,
    #[serde(default = "default_opacity")]
    pub bg_opacity: u32,
    #[serde(default = "default_pos_y")]
    pub pos_y: u32,
}

fn default_font() -> String { "Microsoft JhengHei".into() }
fn default_font_size() -> u32 { 45 }
fn default_outline() -> u32 { 3 }
fn default_opacity() -> u32 { 35 }
fn default_pos_y() -> u32 { 90 }

fn pos_y_to_ass(pos_y: u32) -> (u32, u32) {
    if pos_y <= 33 {
        (8, pos_y * 200 / 33)
    } else if pos_y <= 66 {
        (5, ((pos_y as i32 - 50).unsigned_abs() * 100 / 17))
    } else {
        (2, (100 - pos_y) * 200 / 34)
    }
}

/// 產生音頻波形峰值數據
pub fn generate_waveform(file_path: &str, samples_per_second: u32) -> Result<Vec<f64>, String> {
    // Step 1: 取得影片長度
    let probe = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            file_path,
        ])
        .output()
        .map_err(|e| format!("ffprobe 失敗: {e}"))?;

    let duration: f64 = String::from_utf8_lossy(&probe.stdout)
        .trim()
        .parse()
        .map_err(|_| "無法解析影片長度".to_string())?;

    let total_samples = (duration * samples_per_second as f64) as usize;
    if total_samples == 0 {
        return Ok(vec![]);
    }

    // Step 2: FFmpeg 輸出原始 PCM
    let sample_rate = 8000u32;
    let pcm = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", file_path,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", &sample_rate.to_string(),
            "-ac", "1",
            "-f", "s16le",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("ffmpeg 波形失敗: {e}"))?;

    let raw = &pcm.stdout;
    let num_pcm_samples = raw.len() / 2;
    if num_pcm_samples == 0 {
        return Ok(vec![0.0; total_samples]);
    }

    // Step 3: 計算 peak
    let samples_per_chunk = (num_pcm_samples / total_samples).max(1);
    let mut peaks = Vec::with_capacity(total_samples);

    for i in 0..total_samples {
        let start = i * samples_per_chunk;
        let end = (start + samples_per_chunk).min(num_pcm_samples);
        if start >= num_pcm_samples {
            peaks.push(0.0);
            continue;
        }
        let mut max_val: i16 = 0;
        for j in start..end {
            let bytes = &raw[j * 2..j * 2 + 2];
            let val = i16::from_le_bytes([bytes[0], bytes[1]]);
            if val.abs() > max_val.abs() {
                max_val = val;
            }
        }
        peaks.push(max_val.unsigned_abs() as f64 / 32768.0);
    }

    // 歸一化
    let max_peak = peaks.iter().cloned().fold(0.0f64, f64::max);
    if max_peak > 0.0 {
        for p in &mut peaks {
            *p /= max_peak;
        }
    }

    Ok(peaks)
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
