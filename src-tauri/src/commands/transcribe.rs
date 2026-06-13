//! 語音辨識 command — 調用 faster-whisper sidecar

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use tauri::Manager;

use crate::services::ffmpeg_service;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResult {
    pub language: String,
    pub language_probability: f64,
    pub duration: f64,
    pub segments: Vec<TranscribeSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeSegment {
    pub id: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscribeWord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub probability: f64,
}

/// 找到上傳檔案
fn find_upload(app: &AppHandle, file_id: &str) -> Result<PathBuf, String> {
    let upload_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得 app data dir 失敗: {e}"))?
        .join("uploads");

    for entry in std::fs::read_dir(&upload_dir).map_err(|e| format!("讀取 uploads 失敗: {e}"))? {
        if let Ok(entry) = entry {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(file_id) && !name.ends_with(".wav") {
                return Ok(entry.path());
            }
        }
    }
    Err(format!("找不到檔案: {file_id}"))
}

#[tauri::command]
pub async fn transcribe(
    file_id: String,
    language: String,
    app: AppHandle,
) -> Result<TranscribeResult, String> {
    let video_path = find_upload(&app, &file_id)?;
    let video_str = video_path.to_string_lossy().to_string();

    // 抽取音頻
    let upload_dir = video_path.parent().unwrap();
    let audio_path = upload_dir.join(format!("{file_id}.wav"));
    let audio_str = audio_path.to_string_lossy().to_string();
    ffmpeg_service::extract_audio(&video_str, &audio_str)?;

    // 調用 faster-whisper sidecar
    // 使用 Python script 作為 sidecar
    let sidecar_script = app
        .path()
        .resource_dir()
        .map_err(|e| format!("取得 resource dir 失敗: {e}"))?
        .join("sidecar")
        .join("transcribe_worker.py");

    let output = Command::new("python")
        .args([
            sidecar_script.to_string_lossy().as_ref(),
            &audio_str,
            &language,
        ])
        .output()
        .map_err(|e| format!("sidecar 執行失敗: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("辨識失敗: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: TranscribeResult =
        serde_json::from_str(&stdout).map_err(|e| format!("解析辨識結果失敗: {e}"))?;

    // 清理暫存音頻
    if !video_str.ends_with(".wav") {
        let _ = std::fs::remove_file(&audio_path);
    }

    Ok(result)
}
