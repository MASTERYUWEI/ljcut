//! AI 生成文案 commands

use crate::services::llm_service;
use std::collections::HashMap;
use tauri::AppHandle;
use tauri::Manager;

/// 讀取 .env 中的 API key
fn get_api_key(app: &AppHandle) -> String {
    // 先從環境變數讀取
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        if !key.is_empty() {
            return key;
        }
    }
    // 再嘗試從 app resource dir 的 .env 讀取
    if let Ok(resource_dir) = app.path().resource_dir() {
        let env_path = resource_dir.join(".env");
        if env_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&env_path) {
                for line in content.lines() {
                    if let Some(key) = line.strip_prefix("GEMINI_API_KEY=") {
                        return key.trim().to_string();
                    }
                }
            }
        }
    }
    String::new()
}

/// AI 狀態檢查
#[tauri::command]
pub async fn ai_status(app: AppHandle) -> llm_service::AiStatusResult {
    let api_key = get_api_key(&app);
    llm_service::check_status(&api_key).await
}

/// AI 生成文案
#[tauri::command]
pub async fn ai_generate(
    segments: Vec<HashMap<String, serde_json::Value>>,
    prompt_type: String,
    app: AppHandle,
) -> Result<String, String> {
    let api_key = get_api_key(&app);
    if api_key.is_empty() {
        return Err("未設定 GEMINI_API_KEY".into());
    }
    llm_service::generate(&api_key, &segments, &prompt_type).await
}
