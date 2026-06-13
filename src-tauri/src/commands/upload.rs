//! 上傳檔案 command

use crate::services::ffmpeg_service;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub file_id: String,
    pub filename: String,
    pub path: String,
    pub url: String,
    pub info: ffmpeg_service::MediaInfo,
}

#[tauri::command]
pub async fn upload_file(path: String, app: AppHandle) -> Result<UploadResult, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("檔案不存在: {path}"));
    }

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let allowed = [
        "mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "mp3", "wav", "m4a",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("不支援的檔案格式: .{ext}"));
    }

    let file_id = uuid::Uuid::new_v4().to_string()[..12].to_string();
    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    // 儲存到 app data dir
    let upload_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得 app data dir 失敗: {e}"))?
        .join("uploads");
    fs::create_dir_all(&upload_dir).map_err(|e| format!("建立 uploads 目錄失敗: {e}"))?;

    let dest = upload_dir.join(format!("{file_id}.{ext}"));
    fs::copy(&src, &dest).map_err(|e| format!("複製檔案失敗: {e}"))?;

    let dest_str = dest.to_string_lossy().to_string();
    let info = ffmpeg_service::get_media_info(&dest_str)?;

    Ok(UploadResult {
        file_id,
        filename,
        path: dest_str.clone(),
        url: dest_str,
        info,
    })
}
