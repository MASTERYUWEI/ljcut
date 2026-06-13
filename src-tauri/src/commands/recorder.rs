//! 螢幕區域錄影 — 原生 Windows.Graphics.Capture (WGC) + 硬體編碼
//!
//! 影像：windows-capture (WGC) 擷取主螢幕 → buffer_crop 裁成選區 → 硬體 H.264 編碼。
//!       （取代舊的 ffmpeg gdigrab/ddagrab，後者在 WebView2 競爭下會崩到個位數 fps）
//! 音訊：沿用 ffmpeg dshow 並行擷取到暫存檔，停止後與影像合流。

use crate::services::ffmpeg_service;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type RecError = Box<dyn std::error::Error + Send + Sync>;

/// 進行中的 WGC 影像擷取控制
static VIDEO_CONTROL: Mutex<Option<CaptureControl<RecHandler, RecError>>> = Mutex::new(None);
/// 進行中的音訊 ffmpeg 子程序
static AUDIO_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
/// 本次錄影的暫存/輸出路徑
static REC_PATHS: Mutex<Option<RecPaths>> = Mutex::new(None);
/// 錄影選項（由主視窗設定，overlay 使用）
static RECORDING_OPTIONS: Mutex<Option<RecOptions>> = Mutex::new(None);

#[derive(Clone)]
struct RecPaths {
    video: PathBuf,
    audio: Option<PathBuf>,
    final_out: PathBuf,
}

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
    pub mic_vol: f32, // 0.0 ~ 2.0，1.0 = 100%
    #[serde(default = "default_vol")]
    pub sys_vol: f32,
}

fn default_fps() -> u32 {
    60
}
fn default_vol() -> f32 {
    1.0
}

// ── WGC 擷取 handler ──

/// 傳給 handler 的設定：裁切區域 + 編碼參數 + 輸出路徑
#[derive(Clone)]
pub struct RecFlags {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    width: u32,
    height: u32,
    fps: u32,
    out: String,
}

pub struct RecHandler {
    encoder: Option<VideoEncoder>,
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    scratch: Vec<u8>,
}

impl GraphicsCaptureApiHandler for RecHandler {
    type Flags = RecFlags;
    type Error = RecError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let f = ctx.flags;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(f.width, f.height)
                .frame_rate(f.fps)
                .bitrate(12_000_000)
                .sub_type(VideoSettingsSubType::H264),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &f.out,
        )?;
        Ok(Self {
            encoder: Some(encoder),
            left: f.left,
            top: f.top,
            right: f.right,
            bottom: f.bottom,
            scratch: Vec::new(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(enc) = self.encoder.as_mut() {
            let ts = frame.timestamp()?.Duration;
            let fb = frame.buffer_crop(self.left, self.top, self.right, self.bottom)?;
            let bytes = fb.as_nopadding_buffer(&mut self.scratch);
            enc.send_frame_buffer(bytes, ts)?;
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // 若擷取項目意外關閉，盡量收尾 encoder（避免 mp4 不完整）
        if let Some(enc) = self.encoder.take() {
            let _ = enc.finish();
        }
        Ok(())
    }
}

// ── 列出 dshow 音訊裝置 ──

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<String>, String> {
    let output = StdCommand::new("ffmpeg")
        .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("列舉裝置失敗: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut devices = Vec::new();
    for line in stderr.lines() {
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

// ── 0. 設定錄影選項 ──

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
    let opts = RecOptions {
        sys_audio,
        mic,
        mic_device: mic_device.unwrap_or_default(),
        sys_audio_device: sys_audio_device.unwrap_or_default(),
        fps: fps.unwrap_or(60),
        mic_vol: mic_vol.unwrap_or(1.0),
        sys_vol: sys_vol.unwrap_or(1.0),
    };
    log::info!(
        "🎙️ 錄影選項: sys={}({:.0}%), mic={}({:.0}%), fps={}",
        opts.sys_audio,
        opts.sys_vol * 100.0,
        opts.mic,
        opts.mic_vol * 100.0,
        opts.fps
    );
    *RECORDING_OPTIONS.lock().unwrap() = Some(opts);
    Ok(())
}

// ── 1. 開啟選區 overlay ──

#[tauri::command]
pub async fn start_region_select(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.close();
    }

    let (sw, sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.size();
            let scale = m.scale_factor();
            ((s.width as f64 / scale), (s.height as f64 / scale))
        })
        .unwrap_or((1920.0, 1080.0));

    let ow = 800.0_f64;
    let oh = 600.0_f64;
    let ox = (sw - ow) / 2.0;
    let oy = (sh - oh) / 2.0;

    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
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

// ── 音訊擷取（ffmpeg dshow，可選）──

fn start_audio_capture(
    opts: &RecOptions,
    outputs: &Path,
    stamp: &str,
) -> (Option<PathBuf>, Option<Child>) {
    let has_sys = opts.sys_audio && !opts.sys_audio_device.is_empty();
    let has_mic = opts.mic && !opts.mic_device.is_empty();
    if !has_sys && !has_mic {
        return (None, None);
    }

    let audio_path = outputs.join(format!("rec_audio_{stamp}.m4a"));
    let mut args: Vec<String> = vec!["-y".into()];

    if has_sys {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-thread_queue_size".into(),
            "1024".into(),
            "-i".into(),
            format!("audio={}", opts.sys_audio_device),
        ]);
    }
    if has_mic {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-thread_queue_size".into(),
            "1024".into(),
            "-i".into(),
            format!("audio={}", opts.mic_device),
        ]);
    }

    let sys_v = opts.sys_vol;
    let mic_v = opts.mic_vol;
    if has_sys && has_mic {
        // sys=input0, mic=input1
        let fc = if (sys_v - 1.0).abs() < 0.01 && (mic_v - 1.0).abs() < 0.01 {
            "[0:a][1:a]amerge=inputs=2[a]".to_string()
        } else {
            format!("[0:a]volume={sys_v:.2}[s];[1:a]volume={mic_v:.2}[m];[s][m]amerge=inputs=2[a]")
        };
        args.extend([
            "-filter_complex".into(),
            fc,
            "-map".into(),
            "[a]".into(),
            "-ac".into(),
            "2".into(),
        ]);
    } else {
        // 單一來源（input0），需要時調音量
        let vol = if has_sys { sys_v } else { mic_v };
        if (vol - 1.0).abs() >= 0.01 {
            args.extend(["-af".into(), format!("volume={vol:.2}")]);
        }
    }

    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        "48000".into(),
        audio_path.to_string_lossy().to_string(),
    ]);

    match StdCommand::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut c) => {
            if let Some(err) = c.stderr.take() {
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(err).lines().map_while(Result::ok) {
                        log::debug!("[rec-audio] {line}");
                    }
                });
            }
            (Some(audio_path), Some(c))
        }
        Err(e) => {
            log::error!("啟動音訊擷取失敗: {e}");
            (None, None)
        }
    }
}

// ── 2. 開始錄影 ──

#[tauri::command]
pub async fn start_recording(app: AppHandle, fps: Option<u32>) -> Result<String, String> {
    let rec_opts = RECORDING_OPTIONS.lock().unwrap().clone().unwrap_or(RecOptions {
        sys_audio: false,
        mic: false,
        mic_device: String::new(),
        sys_audio_device: String::new(),
        fps: 60,
        mic_vol: 1.0,
        sys_vol: 1.0,
    });
    let fps = if rec_opts.fps > 0 {
        rec_opts.fps
    } else {
        fps.unwrap_or(60)
    };

    // 取得 overlay 視窗座標（物理像素）
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("overlay 視窗不存在")?;
    let position = overlay
        .inner_position()
        .map_err(|e| format!("取得位置失敗: {e}"))?;
    let size = overlay
        .inner_size()
        .map_err(|e| format!("取得大小失敗: {e}"))?;

    // 主螢幕（WGC 以單一顯示器為單位；使用者為單螢幕，主螢幕通常起點 0,0）
    let monitor = Monitor::primary().map_err(|e| format!("取得主螢幕失敗: {e}"))?;
    let mon_w = monitor.width().map_err(|e| format!("取得螢幕寬失敗: {e}"))?;
    let mon_h = monitor.height().map_err(|e| format!("取得螢幕高失敗: {e}"))?;

    let mut x = position.x.max(0) as u32;
    let mut y = position.y.max(0) as u32;
    let mut w = size.width;
    let mut h = size.height;

    // clamp 到螢幕範圍內
    if x >= mon_w {
        x = mon_w.saturating_sub(2);
    }
    if y >= mon_h {
        y = mon_h.saturating_sub(2);
    }
    if x + w > mon_w {
        w = mon_w - x;
    }
    if y + h > mon_h {
        h = mon_h - y;
    }
    // 寬高需為偶數（H.264 要求）且至少 4 像素
    let w = (w - (w % 2)).max(4);
    let h = (h - (h % 2)).max(4);
    let left = x;
    let top = y;
    let right = left + w;
    let bottom = top + h;

    // 關閉 overlay，等它完全消失才開始擷取
    let _ = overlay.close();
    std::thread::sleep(Duration::from_millis(300));

    // 準備輸出路徑
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得 data dir 失敗: {e}"))?;
    let outputs = data_dir.join("outputs");
    std::fs::create_dir_all(&outputs).ok();
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let video_path = outputs.join(format!("rec_video_{stamp}.mp4"));
    let final_path = outputs.join(format!("錄影_{stamp}.mp4"));

    // 啟動音訊擷取（與影像並行）
    let (audio_path, audio_child) = start_audio_capture(&rec_opts, &outputs, &stamp);

    // 啟動 WGC 影像擷取
    let flags = RecFlags {
        left,
        top,
        right,
        bottom,
        width: w,
        height: h,
        fps,
        out: video_path.to_string_lossy().to_string(),
    };
    let interval = Duration::from_nanos(1_000_000_000 / fps.max(1) as u64);
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(interval),
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        flags,
    );

    let control = match RecHandler::start_free_threaded(settings) {
        Ok(c) => c,
        Err(e) => {
            // 影像啟動失敗 → 收掉音訊
            if let Some(mut child) = audio_child {
                let _ = child.kill();
            }
            return Err(format!("啟動螢幕擷取失敗: {e}"));
        }
    };

    *VIDEO_CONTROL.lock().unwrap() = Some(control);
    *AUDIO_PROCESS.lock().unwrap() = audio_child;
    *REC_PATHS.lock().unwrap() = Some(RecPaths {
        video: video_path,
        audio: audio_path,
        final_out: final_path.clone(),
    });

    log::info!("🎬 開始 WGC 錄影: 區域 ({left},{top}) {w}x{h} @ {fps}fps");
    let final_str = final_path.to_string_lossy().to_string();
    let _ = app.emit("recording_started", &final_str);
    Ok(final_str)
}

// ── 影音合流 ──

fn mux_av(video: &Path, audio: Option<&Path>, out: &Path) -> bool {
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), video.to_string_lossy().to_string()];
    if let Some(a) = audio {
        args.extend(["-i".into(), a.to_string_lossy().to_string()]);
    }
    args.extend(["-c".into(), "copy".into()]);
    if audio.is_some() {
        args.push("-shortest".into());
    }
    args.push(out.to_string_lossy().to_string());

    match StdCommand::new("ffmpeg")
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(o) if o.status.success() => true,
        Ok(o) => {
            log::error!("合流失敗:\n{}", String::from_utf8_lossy(&o.stderr));
            false
        }
        Err(e) => {
            log::error!("合流執行失敗: {e}");
            false
        }
    }
}

// ── 3. 停止錄影 ──

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    let paths = REC_PATHS
        .lock()
        .unwrap()
        .take()
        .ok_or("沒有正在進行的錄影")?;

    // 停止影像擷取並收尾 encoder
    if let Some(control) = VIDEO_CONTROL.lock().unwrap().take() {
        let cb = control.callback();
        if let Err(e) = control.stop() {
            log::warn!("停止擷取執行緒: {e:?}");
        }
        // windows-capture 使用 parking_lot::Mutex，.lock() 直接回傳 guard
        let mut handler = cb.lock();
        if let Some(enc) = handler.encoder.take() {
            if let Err(e) = enc.finish() {
                log::error!("encoder 收尾失敗: {e}");
            }
        }
    }

    // 停止音訊 ffmpeg（送 'q' 優雅結束，逾時則強制）
    if let Some(mut child) = AUDIO_PROCESS.lock().unwrap().take() {
        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        std::thread::sleep(Duration::from_millis(200));
        match child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    std::thread::sleep(Duration::from_millis(300));

    // 影音合流（無音訊時等於重新封裝影像）
    let final_path = paths.final_out.clone();
    if !mux_av(&paths.video, paths.audio.as_deref(), &final_path) {
        // 合流失敗 → 退回只用影像
        let _ = std::fs::copy(&paths.video, &final_path);
    }
    // 清理暫存
    let _ = std::fs::remove_file(&paths.video);
    if let Some(a) = &paths.audio {
        let _ = std::fs::remove_file(a);
    }

    if !final_path.exists() {
        log::error!("❌ 錄影輸出不存在: {}", final_path.display());
        let _ = app.emit("recording_stopped", serde_json::json!(null));
        return Err("錄影輸出不存在，擷取可能失敗".into());
    }
    let file_size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    log::info!("📦 錄影檔大小: {file_size} bytes ({})", final_path.display());
    if file_size == 0 {
        let _ = app.emit("recording_stopped", serde_json::json!(null));
        return Err("錄影檔大小為 0，擷取可能失敗".into());
    }

    // ── 後處理：複製到 backend/uploads、取得資訊、產縮圖 ──
    let process_result = (|| -> Result<RecordingResult, String> {
        let file_id = uuid::Uuid::new_v4().to_string()[..12].to_string();
        let filename = final_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recording.mp4")
            .to_string();

        let backend_uploads = find_backend_uploads_dir();
        let backend_outputs = find_backend_outputs_dir();
        std::fs::create_dir_all(&backend_uploads)
            .map_err(|e| format!("建立 backend/uploads 失敗: {e}"))?;
        std::fs::create_dir_all(&backend_outputs)
            .map_err(|e| format!("建立 backend/outputs 失敗: {e}"))?;

        let dest = backend_uploads.join(format!("{file_id}.mp4"));
        std::fs::copy(&final_path, &dest).map_err(|e| format!("複製錄影檔失敗: {e}"))?;
        log::info!("✅ 錄影檔已複製到: {}", dest.display());

        let dest_str = dest.to_string_lossy().to_string();
        let info = ffmpeg_service::get_media_info(&dest_str).unwrap_or_else(|e| {
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
            file_id: file_id.clone(),
            filename,
            url: format!("/uploads/{file_id}.mp4"),
            info,
            thumbnail_url: format!("/api/thumbnail/{file_id}"),
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
            let _ = app.emit("recording_stopped", serde_json::json!(null));
            Err(format!("錄影後處理失敗: {e}"))
        }
    }
}

/// 推算 backend/uploads 目錄的絕對路徑
fn find_backend_uploads_dir() -> PathBuf {
    find_backend_subdir("uploads")
}

/// 推算 backend/outputs 目錄的絕對路徑
fn find_backend_outputs_dir() -> PathBuf {
    find_backend_subdir("outputs")
}

fn find_backend_subdir(sub: &str) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(d) = &dir {
                if d.join("backend").exists() {
                    return d.join("backend").join(sub);
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("backend").exists() {
            return cwd.join("backend").join(sub);
        }
    }
    PathBuf::from("backend").join(sub)
}
