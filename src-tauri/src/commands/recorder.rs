//! 螢幕區域錄影 commands — 透明 overlay + FFmpeg gdigrab

use crate::services::ffmpeg_service;
use serde::{Deserialize, Serialize};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 全域 ffmpeg 子程序（錄影中）
static FFMPEG_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
/// 輸出檔路徑
static OUTPUT_PATH: Mutex<Option<String>> = Mutex::new(None);
/// 錄影選項（由主視窗設定，overlay 使用）
static RECORDING_OPTIONS: Mutex<Option<RecOptions>> = Mutex::new(None);

/// 錄影選項
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecOptions {
    pub sys_audio: bool,
    pub mic: bool,
    #[serde(default)]
    pub mic_device: String,
    #[serde(default)]
    pub sys_audio_device: String,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_vol")]
    pub mic_vol: f32,   // 0.0 ~ 2.0，1.0 = 100%
    #[serde(default = "default_vol")]
    pub sys_vol: f32,
}

fn default_fps() -> u32 { 60 }
fn default_vol() -> f32 { 1.0 }

// ── 列出 dshow 音訊裝置 ──

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<String>, String> {
    let output = StdCommand::new("ffmpeg")
        .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("列舉裝置失敗: {e}"))?;

    // FFmpeg 把 device list 寫在 stderr
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut devices = Vec::new();

    for line in stderr.lines() {
        // 格式: [dshow @ ...] "裝置名" (audio)
        if line.contains("(audio)") {
            if let Some(start) = line.find('"') {
                if let Some(end) = line[start + 1..].find('"') {
                    let name = &line[start + 1..start + 1 + end];
                    devices.push(name.to_string());
                }
            }
        }
    }

    log::info!("🎤 dshow 音訊裝置: {:?}", devices);
    Ok(devices)
}

/// 錄影完成後回傳給前端的完整資訊
#[derive(Debug, Clone, Serialize)]
pub struct RecordingResult {
    pub file_id: String,
    pub filename: String,
    pub url: String,
    pub info: ffmpeg_service::MediaInfo,
    pub thumbnail_url: String,
}

// ── 0. 設定錄影選項（主視窗呼叫，overlay 使用）──

#[tauri::command]
pub async fn set_rec_options(
    sys_audio: bool,
    mic: bool,
    mic_device: Option<String>,
    sys_audio_device: Option<String>,
    fps: Option<u32>,
    mic_vol: Option<f32>,
    sys_vol: Option<f32>,
) -> Result<(), String> {
    let mic_dev = mic_device.unwrap_or_default();
    let sys_dev = sys_audio_device.unwrap_or_default();
    let fps_val = fps.unwrap_or(60);
    let mic_v = mic_vol.unwrap_or(1.0);
    let sys_v = sys_vol.unwrap_or(1.0);
    *RECORDING_OPTIONS.lock().unwrap() = Some(RecOptions {
        sys_audio,
        mic,
        mic_device: mic_dev.clone(),
        sys_audio_device: sys_dev.clone(),
        fps: fps_val,
        mic_vol: mic_v,
        sys_vol: sys_v,
    });
    log::info!("🎙️ 錄影選項: sys={sys_audio}({sys_v:.0}%), mic={mic}({mic_v:.0}%), fps={fps_val}");
    Ok(())
}

// ── 1. 開啟選區 overlay ──

#[tauri::command]
pub async fn start_region_select(app: AppHandle) -> Result<(), String> {
    // 如果已有 overlay 視窗，先關閉
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.close();
    }

    // 取得螢幕大小以置中
    let (sw, sh) = app.primary_monitor()
        .ok().flatten()
        .map(|m| {
            let s = m.size();
            let scale = m.scale_factor();
            ((s.width as f64 / scale) as f64, (s.height as f64 / scale) as f64)
        })
        .unwrap_or((1920.0, 1080.0));

    let ow = 800.0_f64;
    let oh = 600.0_f64;
    let ox = (sw - ow) / 2.0;
    let oy = (sh - oh) / 2.0;

    // 建立透明、無邊框、置頂的 overlay
    let _overlay = WebviewWindowBuilder::new(
        &app,
        "overlay",
        WebviewUrl::App("overlay.html".into()),
    )
    .title("LJCUT 錄影選區")
    .inner_size(ow, oh)
    .position(ox, oy)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| format!("建立 overlay 失敗: {e}"))?;

    Ok(())
}

// ── 2. 開始錄影 ──

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    fps: Option<u32>,
) -> Result<String, String> {
    // 從全域設定讀取音訊選項
    let rec_opts = RECORDING_OPTIONS.lock().unwrap().clone()
        .unwrap_or(RecOptions {
            sys_audio: false, mic: false,
            mic_device: String::new(), sys_audio_device: String::new(),
            fps: 60, mic_vol: 1.0, sys_vol: 1.0,
        });

    // 優先使用全域設定的 fps，overlay 傳入的 fps 只是 fallback
    let fps = if rec_opts.fps > 0 { rec_opts.fps } else { fps.unwrap_or(60) };

    // 取得 overlay 視窗座標
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("overlay 視窗不存在")?;

    // 使用 inner_position/inner_size（不含 Windows DWM 不可見邊框）
    let position = overlay
        .inner_position()
        .map_err(|e| format!("取得位置失敗: {e}"))?;
    let size = overlay
        .inner_size()
        .map_err(|e| format!("取得大小失敗: {e}"))?;

    // 直接使用物理像素座標（gdigrab 使用實際螢幕像素）
    let mut x = position.x;
    let mut y = position.y;
    let mut w = size.width;
    let mut h = size.height;

    // 取得虛擬桌面總範圍（多螢幕合併）
    let (screen_w, screen_h) = app.available_monitors()
        .map(|monitors| {
            let mut max_w: u32 = 0;
            let mut max_h: u32 = 0;
            for m in monitors {
                let pos = m.position();
                let sz = m.size();
                let right = pos.x as u32 + sz.width;
                let bottom = pos.y as u32 + sz.height;
                if right > max_w { max_w = right; }
                if bottom > max_h { max_h = bottom; }
            }
            (max_w, max_h)
        })
        .unwrap_or((4480, 1440));

    // 座標不可為負
    x = std::cmp::max(x, 0);
    y = std::cmp::max(y, 0);

    // Clamp 寬高不超出螢幕邊界
    if (x as u32 + w) > screen_w {
        w = screen_w - x as u32;
    }
    if (y as u32 + h) > screen_h {
        h = screen_h - y as u32;
    }

    // 確保寬高為偶數（libx264 要求）且至少 4 像素
    let w = std::cmp::max(w - (w % 2), 4);
    let h = std::cmp::max(h - (h % 2), 4);

    log::info!("📐 Overlay: pos=({x},{y}), size={w}x{h}, screen={screen_w}x{screen_h}");

    // 關閉 overlay，等待視窗完全消失才開始錄影
    let _ = overlay.close();
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 準備輸出路徑
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得 data dir 失敗: {e}"))?;
    let outputs = data_dir.join("outputs");
    std::fs::create_dir_all(&outputs).ok();

    let now = chrono::Local::now();
    let filename = format!("錄影_{}.mp4", now.format("%Y%m%d_%H%M%S"));
    let output = outputs.join(&filename);
    let output_str = output.to_string_lossy().to_string();

    // 組裝 ffmpeg 命令
    let mut args = vec![
        "-y".to_string(),
        "-f".to_string(),
        "gdigrab".to_string(),
        "-thread_queue_size".to_string(),
        "1024".to_string(),
        "-framerate".to_string(),
        fps.to_string(),
        "-offset_x".to_string(),
        x.to_string(),
        "-offset_y".to_string(),
        y.to_string(),
        "-video_size".to_string(),
        format!("{w}x{h}"),
        "-i".to_string(),
        "desktop".to_string(),
    ];

    // 音訊輸入：系統聲音 + 麥克風
    let has_sys = rec_opts.sys_audio && !rec_opts.sys_audio_device.is_empty();
    let has_mic = rec_opts.mic && !rec_opts.mic_device.is_empty();

    if has_sys {
        // 系統音頻（用戶選擇的 dshow 裝置）
        args.extend_from_slice(&[
            "-f".to_string(),
            "dshow".to_string(),
            "-thread_queue_size".to_string(),
            "1024".to_string(),
            "-i".to_string(),
            format!("audio={}", rec_opts.sys_audio_device),
        ]);
    }

    if has_mic {
        // 麥克風裝置
        args.extend_from_slice(&[
            "-f".to_string(),
            "dshow".to_string(),
            "-thread_queue_size".to_string(),
            "1024".to_string(),
            "-i".to_string(),
            format!("audio={}", rec_opts.mic_device),
        ]);
    }

    // 音訊 mapping + 音量調整
    let sys_v = rec_opts.sys_vol;
    let mic_v = rec_opts.mic_vol;

    if has_sys && has_mic {
        // 同時有系統聲音和麥克風 → amerge（需要時加 volume）
        let filter = if (sys_v - 1.0).abs() < 0.01 && (mic_v - 1.0).abs() < 0.01 {
            // 音量都是 100%，簡單 amerge
            "[1:a][2:a]amerge=inputs=2[a]".to_string()
        } else {
            format!(
                "[1:a]volume={sys_v:.2}[sys];[2:a]volume={mic_v:.2}[mic];[sys][mic]amerge=inputs=2[a]"
            )
        };
        args.extend_from_slice(&[
            "-filter_complex".to_string(),
            filter,
            "-map".to_string(),
            "0:v".to_string(),
            "-map".to_string(),
            "[a]".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ]);
    } else if has_sys || has_mic {
        // 只有一個音訊來源
        let vol = if has_sys { sys_v } else { mic_v };
        if (vol - 1.0).abs() < 0.01 {
            // 音量 100%，直接 map 不加濾鏡
            args.extend_from_slice(&[
                "-map".to_string(),
                "0:v".to_string(),
                "-map".to_string(),
                "1:a".to_string(),
            ]);
        } else {
            // 用簡單的 -af 而非 filter_complex
            args.extend_from_slice(&[
                "-map".to_string(),
                "0:v".to_string(),
                "-map".to_string(),
                "1:a".to_string(),
                "-af".to_string(),
                format!("volume={vol:.2}"),
            ]);
        }
    }

    args.extend_from_slice(&[
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "ultrafast".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-shortest".to_string(),
        output_str.clone(),
    ]);

    log::info!("🎬 開始錄影: ffmpeg {}", args.join(" "));
    log::info!("📍 區域: ({x}, {y}) {w}x{h}");

    let mut child = StdCommand::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())  // 捕獲 stderr 用於除錯
        .spawn()
        .map_err(|e| format!("啟動 ffmpeg 失敗: {e}"))?;

    // 在背景執行緒讀取 stderr，避免管道滿時阻塞 FFmpeg
    if let Some(stderr_pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => log::debug!("[FFmpeg] {l}"),
                    Err(_) => break,
                }
            }
        });
    }

    // 儲存 process handle
    *FFMPEG_PROCESS.lock().unwrap() = Some(child);
    *OUTPUT_PATH.lock().unwrap() = Some(output_str.clone());

    // 通知前端錄影已開始
    let _ = app.emit("recording_started", &output_str);

    Ok(output_str)
}

// ── 3. 停止錄影 ──

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    let output_path = OUTPUT_PATH
        .lock()
        .unwrap()
        .take()
        .ok_or("沒有正在進行的錄影")?;

    // 向 ffmpeg 發送 'q' 讓它正常結束
    let mut child = FFMPEG_PROCESS
        .lock()
        .unwrap()
        .take()
        .ok_or("ffmpeg 程序不存在")?;

    // 寫入 'q' 到 stdin 讓 ffmpeg 優雅結束
    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }

    // 等待 ffmpeg 結束
    match child.wait() {
        Ok(status) => {
            log::info!("🛑 錄影結束: {status}");
            if !status.success() {
                log::warn!("⚠️ FFmpeg 非正常結束");
            }
        }
        Err(e) => {
            log::warn!("等待 ffmpeg 結束失敗: {e}, 強制終止");
            let _ = child.kill();
        }
    }

    // 等待檔案系統同步
    std::thread::sleep(std::time::Duration::from_millis(800));

    // 檢查錄影檔是否存在
    let src = std::path::PathBuf::from(&output_path);
    if !src.exists() {
        log::error!("❌ 錄影檔案不存在: {output_path}");
        let _ = app.emit("recording_stopped", serde_json::json!(null));
        return Err(format!("錄影檔案不存在，FFmpeg 可能失敗"));
    }

    let file_size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    log::info!("📦 錄影檔案大小: {} bytes ({})", file_size, output_path);

    if file_size == 0 {
        log::error!("❌ 錄影檔案大小為 0");
        let _ = app.emit("recording_stopped", serde_json::json!(null));
        return Err("錄影檔案大小為 0，FFmpeg 可能失敗".into());
    }

    // ── 後處理（不讓任何步驟阻止事件發送） ──
    let process_result = (|| -> Result<RecordingResult, String> {
        let file_id = uuid::Uuid::new_v4().to_string()[..12].to_string();
        let filename = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recording.mp4")
            .to_string();

        let backend_uploads = find_backend_uploads_dir();
        let backend_outputs = find_backend_outputs_dir();

        log::info!("📂 Backend uploads: {}", backend_uploads.display());
        log::info!("📂 Backend outputs: {}", backend_outputs.display());

        std::fs::create_dir_all(&backend_uploads)
            .map_err(|e| format!("建立 backend/uploads 失敗: {e}"))?;
        std::fs::create_dir_all(&backend_outputs)
            .map_err(|e| format!("建立 backend/outputs 失敗: {e}"))?;

        let dest = backend_uploads.join(format!("{file_id}.mp4"));
        std::fs::copy(&src, &dest)
            .map_err(|e| format!("複製錄影檔失敗: {e}"))?;
        log::info!("✅ 錄影檔已複製到: {}", dest.display());

        let dest_str = dest.to_string_lossy().to_string();
        let info = ffmpeg_service::get_media_info(&dest_str)
            .unwrap_or_else(|e| {
                log::warn!("取得 media info 失敗: {e}");
                ffmpeg_service::MediaInfo {
                    duration: 0.0,
                    size_mb: 0.0,
                    width: None,
                    height: None,
                    fps: None,
                    video_codec: None,
                    audio_codec: None,
                    sample_rate: None,
                }
            });

        let thumb_path = backend_outputs.join(format!("{file_id}_thumb.jpg"));
        let _ = ffmpeg_service::generate_thumbnail(&dest_str, &thumb_path.to_string_lossy());

        Ok(RecordingResult {
            file_id,
            filename,
            url: format!("/uploads/{}.mp4", &dest.file_stem().unwrap().to_string_lossy()),
            info,
            thumbnail_url: format!("/api/thumbnail/{}", &dest.file_stem().unwrap().to_string_lossy().replace(".mp4", "")),
        })
    })();

    match process_result {
        Ok(result) => {
            let _ = app.emit("recording_stopped", &result);
            log::info!("✅ 錄影完成並匯入: file_id={}", result.file_id);
            Ok(serde_json::to_string(&result).unwrap_or_default())
        }
        Err(e) => {
            log::error!("❌ 錄影後處理失敗: {e}");
            // 仍然嘗試 emit 基本資訊，讓前端至少知道錄影停了
            let _ = app.emit("recording_stopped", serde_json::json!(null));
            Err(format!("錄影後處理失敗: {e}"))
        }
    }
}

/// 推算 backend/uploads 目錄的絕對路徑
fn find_backend_uploads_dir() -> std::path::PathBuf {
    // 優先從 exe 目錄向上找
    if let Ok(exe) = std::env::current_exe() {
        // Dev 模式: exe 在 src-tauri/target/debug/
        // 專案根 = exe/../../../..
        let mut dir = exe.parent().unwrap().to_path_buf();
        for _ in 0..5 {
            let candidate = dir.join("backend").join("uploads");
            if candidate.exists() || dir.join("backend").exists() {
                return candidate;
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    // 嘗試 cwd
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("backend").join("uploads");
        if cwd.join("backend").exists() {
            return candidate;
        }
    }

    // Fallback: 相對路徑
    std::path::PathBuf::from("backend/uploads")
}

/// 推算 backend/outputs 目錄的絕對路徑
fn find_backend_outputs_dir() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().unwrap().to_path_buf();
        for _ in 0..5 {
            let candidate = dir.join("backend").join("outputs");
            if candidate.exists() || dir.join("backend").exists() {
                return candidate;
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("backend").join("outputs");
        if cwd.join("backend").exists() {
            return candidate;
        }
    }

    std::path::PathBuf::from("backend/outputs")
}
