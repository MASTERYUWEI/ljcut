//! 字幕匯出 / 字幕燒入 commands

use crate::services::{ffmpeg_service, subtitle_service};
use serde::Serialize;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 找到上傳檔案
fn find_upload(app: &AppHandle, file_id: &str) -> Result<PathBuf, String> {
    let upload_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?
        .join("uploads");
    for entry in std::fs::read_dir(&upload_dir).map_err(|e| format!("{e}"))? {
        if let Ok(entry) = entry {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(file_id) && !name.ends_with(".wav") {
                return Ok(entry.path());
            }
        }
    }
    Err(format!("找不到檔案: {file_id}"))
}

#[derive(Debug, Serialize)]
pub struct BurnResult {
    pub success: bool,
    pub output_path: String,
}

/// 匯出 SRT 字幕檔 — 返回檔案路徑
#[tauri::command]
pub async fn export_srt(
    file_id: String,
    segments: Vec<subtitle_service::Segment>,
    app: AppHandle,
) -> Result<String, String> {
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?
        .join("outputs");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("{e}"))?;

    let srt_path = output_dir.join(format!("{file_id}.srt"));
    let srt_str = srt_path.to_string_lossy().to_string();

    subtitle_service::segments_to_srt(&segments, &srt_str)?;
    Ok(srt_str)
}

/// 字幕燒入影片
#[tauri::command]
pub async fn burn_subtitle(
    file_id: String,
    segments: Vec<subtitle_service::Segment>,
    style: ffmpeg_service::BurnStyle,
    app: AppHandle,
) -> Result<BurnResult, String> {
    let video_path = find_upload(&app, &file_id)?;
    let video_str = video_path.to_string_lossy().to_string();

    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?
        .join("outputs");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("{e}"))?;

    // 先產生 SRT
    let srt_path = output_dir.join(format!("{file_id}.srt"));
    let srt_str = srt_path.to_string_lossy().to_string();
    subtitle_service::segments_to_srt(&segments, &srt_str)?;

    // 燒入
    let output_path = output_dir.join(format!("{file_id}_subtitled.mp4"));
    let output_str = output_path.to_string_lossy().to_string();
    ffmpeg_service::burn_subtitles(&video_str, &srt_str, &output_str, &style)?;

    Ok(BurnResult {
        success: true,
        output_path: output_str,
    })
}
