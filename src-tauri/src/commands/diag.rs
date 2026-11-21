//! 診斷用：讓前端把「AI 控制連線」的重要事件寫進 LJCUT.log，之後才查得到為什麼斷線。

/// 前端呼叫 `invoke('frontend_log', { level, message })`。訊息截到 500 字，避免整份專案被塞進日誌。
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    let message: String = message.chars().take(500).collect();
    match level.as_str() {
        "error" => log::error!(target: "frontend", "{message}"),
        "warn" => log::warn!(target: "frontend", "{message}"),
        _ => log::info!(target: "frontend", "{message}"),
    }
}
