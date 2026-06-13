//! FFmpeg 相關 commands（波形、縮圖）

use crate::services::ffmpeg_service;
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

/// 取得波形數據
#[tauri::command]
pub async fn get_waveform(file_id: String, app: AppHandle) -> Result<Vec<f64>, String> {
    let file_path = find_upload(&app, &file_id)?;
    let file_str = file_path.to_string_lossy().to_string();
    ffmpeg_service::generate_waveform(&file_str, 50)
}

/// 取得影片縮圖路徑
#[tauri::command]
pub async fn get_thumbnail(file_id: String, app: AppHandle) -> Result<String, String> {
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?
        .join("outputs");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("{e}"))?;

    let thumb_path = output_dir.join(format!("{file_id}_thumb.jpg"));
    let thumb_str = thumb_path.to_string_lossy().to_string();

    // 快取：已產生就直接返回
    if thumb_path.exists() {
        return Ok(thumb_str);
    }

    let file_path = find_upload(&app, &file_id)?;
    let file_str = file_path.to_string_lossy().to_string();

    ffmpeg_service::generate_thumbnail(&file_str, &thumb_str)?;
    Ok(thumb_str)
}
