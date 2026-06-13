mod commands;
mod services;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 嘗試載入 .env
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::upload::upload_file,
            commands::transcribe::transcribe,
            commands::subtitle::export_srt,
            commands::subtitle::burn_subtitle,
            commands::ffmpeg::get_waveform,
            commands::ffmpeg::get_thumbnail,
            commands::ai::ai_status,
            commands::ai::ai_generate,
            commands::recorder::list_audio_devices,
            commands::recorder::set_rec_options,
            commands::recorder::start_region_select,
            commands::recorder::start_recording,
            commands::recorder::stop_recording,
        ])
        .setup(|app| {
            // 確保 uploads 和 outputs 目錄存在
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("uploads")).ok();
            std::fs::create_dir_all(data_dir.join("outputs")).ok();
            log::info!("✅ LJCUT 已啟動 — data dir: {}", data_dir.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
