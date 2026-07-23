mod commands;
mod services;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 嘗試載入 .env
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // F10（錄影時才會註冊）→ 通知前端停止錄影
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("hotkey_stop", ());
                    }
                })
                .build(),
        )
        .manage(commands::sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            commands::sidecar::get_backend_port,
            commands::recorder::list_audio_devices,
            commands::recorder::set_rec_options,
            commands::recorder::start_region_select,
            commands::recorder::start_recording,
            commands::recorder::stop_recording,
            commands::recorder::enter_window_pick,
            commands::recorder::hover_window_rect,
            commands::recorder::snap_overlay_to_window,
            commands::recorder::get_encoder_info,
            commands::recorder::reveal_media,
        ])
        .setup(|app| {
            // 確保 uploads 和 outputs 目錄存在
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("uploads")).ok();
            std::fs::create_dir_all(data_dir.join("outputs")).ok();

            // 啟動 Python sidecar（FastAPI）
            let handle = app.handle().clone();
            commands::sidecar::start_sidecar(&handle);

            // 自動清理逾期暫存/工作檔（>14 天），背景執行不阻塞啟動。
            // 只清暫存目錄；使用者匯出的成品在自選資料夾，不會被碰到。
            let cleanup_handle = handle.clone();
            std::thread::spawn(move || {
                commands::recorder::cleanup_old_files(&cleanup_handle, 14);
            });

            log::info!("✅ LJCUT 已啟動 — data dir: {}", data_dir.display());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // app 結束時收掉 sidecar
            if let tauri::RunEvent::ExitRequested { .. } = event {
                commands::sidecar::stop_sidecar(app_handle);
            }
        });
}
