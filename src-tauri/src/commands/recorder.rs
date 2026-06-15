//! 螢幕區域錄影 — 以子程序方式驅動 WGC 擷取
//!
//! 影像：啟動獨立的 `ljcut-recorder.exe`（Windows.Graphics.Capture + 硬體編碼）。
//!       之所以獨立成 exe：在 Tauri 主程式（有 WebView2）內直接呼叫 WGC 會卡死，
//!       但在乾淨的獨立 process 內穩定 60fps。
//! 音訊：ffmpeg dshow 並行擷取到暫存檔，停止後與影像合流。

use crate::services::ffmpeg_service;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Windows：不要為子程序彈出 console 視窗
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 進行中的影像擷取子程序（ljcut-recorder.exe）
static RECORDER_PROC: Mutex<Option<Child>> = Mutex::new(None);
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
    pub mic_vol: f32,
    #[serde(default = "default_vol")]
    pub sys_vol: f32,
    #[serde(default)]
    pub cursor_glow: bool,
    #[serde(default)]
    pub click_effect: bool,
    #[serde(default = "default_glow_color")]
    pub glow_color: String,
    #[serde(default = "default_click_color")]
    pub click_color: String,
    #[serde(default = "default_scale")]
    pub cursor_scale: f32,
    #[serde(default)]
    pub cursor_hidden: bool,
}

fn default_glow_color() -> String {
    "#ffd228".into()
}
fn default_click_color() -> String {
    "#ffe65a".into()
}
fn default_scale() -> f32 {
    1.0
}

fn default_fps() -> u32 {
    60
}
fn default_vol() -> f32 {
    1.0
}

// ── 列出 dshow 音訊裝置 ──

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<String>, String> {
    let output = StdCommand::new("ffmpeg")
        .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .creation_flags(CREATE_NO_WINDOW)
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
    cursor_glow: Option<bool>,
    click_effect: Option<bool>,
    glow_color: Option<String>,
    click_color: Option<String>,
    cursor_scale: Option<f32>,
    cursor_hidden: Option<bool>,
) -> Result<(), String> {
    let opts = RecOptions {
        sys_audio,
        mic,
        mic_device: mic_device.unwrap_or_default(),
        sys_audio_device: sys_audio_device.unwrap_or_default(),
        fps: fps.unwrap_or(60),
        mic_vol: mic_vol.unwrap_or(1.0),
        sys_vol: sys_vol.unwrap_or(1.0),
        cursor_glow: cursor_glow.unwrap_or(false),
        click_effect: click_effect.unwrap_or(false),
        glow_color: glow_color.unwrap_or_else(default_glow_color),
        click_color: click_color.unwrap_or_else(default_click_color),
        cursor_scale: cursor_scale.unwrap_or(1.0),
        cursor_hidden: cursor_hidden.unwrap_or(false),
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
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut c) => {
            if let Some(err) = c.stderr.take() {
                std::thread::spawn(move || {
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

/// 找到 ljcut-recorder.exe（與主程式同目錄）
fn find_recorder_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("ljcut-recorder.exe");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

// ── 錄製中的置頂指示小視窗（最小化主視窗時仍可見；排除於錄影擷取）──

fn show_rec_indicator(app: &AppHandle) {
    if app.get_webview_window("rec-indicator").is_some() {
        return;
    }
    let (mon_w, scale) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.scale_factor()))
        .unwrap_or((1920.0, 1.0));
    let logical_w = mon_w / scale;
    let iw = 240.0;
    let ih = 44.0;
    let x = ((logical_w - iw) / 2.0).max(0.0);

    match WebviewWindowBuilder::new(
        app,
        "rec-indicator",
        WebviewUrl::App("rec-indicator.html".into()),
    )
    .title("LJCUT 錄製中")
    .inner_size(iw, ih)
    .position(x, 10.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .build()
    {
        Ok(win) => {
            // 排除於螢幕擷取：使用者看得到，但不會被錄進影片裡
            // 注意：Tauri 的 hwnd() 來自 windows 0.61，本 crate 的 Win32 呼叫用 0.62，
            // 兩者 HWND 型別不同，用內部指標 .0 橋接。
            if let Ok(hwnd) = win.hwnd() {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
                };
                unsafe {
                    let _ = SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE);
                }
            }
        }
        Err(e) => log::warn!("建立錄製指示視窗失敗: {e}"),
    }
}

fn hide_rec_indicator(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("rec-indicator") {
        let _ = w.close();
    }
}

// ── 2. 開始錄影 ──

fn current_rec_opts() -> RecOptions {
    RECORDING_OPTIONS.lock().unwrap().clone().unwrap_or(RecOptions {
        sys_audio: false,
        mic: false,
        mic_device: String::new(),
        sys_audio_device: String::new(),
        fps: 60,
        mic_vol: 1.0,
        sys_vol: 1.0,
        cursor_glow: false,
        click_effect: false,
        glow_color: default_glow_color(),
        click_color: default_click_color(),
        cursor_scale: 1.0,
        cursor_hidden: false,
    })
}

/// 共用：啟動音訊 + 影像 sidecar、等待就緒、存狀態、發事件。
/// target = 螢幕裝置名(\\.\DISPLAYn)/"primary"，或 "window:<標題>"。
fn begin_recording(
    app: &AppHandle,
    rec_opts: &RecOptions,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    fps: u32,
    target: String,
) -> Result<String, String> {
    let recorder_exe = find_recorder_exe().ok_or("找不到 ljcut-recorder.exe")?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得 data dir 失敗: {e}"))?;
    let outputs = data_dir.join("outputs");
    std::fs::create_dir_all(&outputs).ok();
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let video_path = outputs.join(format!("rec_video_{stamp}.mp4"));
    let final_path = outputs.join(format!("錄影_{stamp}.mp4"));

    let (audio_path, audio_child) = start_audio_capture(rec_opts, &outputs, &stamp);

    let mut child = match StdCommand::new(&recorder_exe)
        .args([
            x.to_string(),
            y.to_string(),
            w.to_string(),
            h.to_string(),
            fps.to_string(),
            video_path.to_string_lossy().to_string(),
            target.clone(),
            if rec_opts.cursor_glow { "1".into() } else { "0".into() },
            if rec_opts.click_effect { "1".into() } else { "0".into() },
            rec_opts.glow_color.clone(),
            rec_opts.click_color.clone(),
            format!("{:.2}", rec_opts.cursor_scale),
            if rec_opts.cursor_hidden { "1".into() } else { "0".into() },
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            if let Some(mut a) = audio_child {
                let _ = a.kill();
            }
            return Err(format!("啟動錄影程式失敗: {e}"));
        }
    };

    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::warn!("[recorder] {line}");
            }
        });
    }

    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim() == "READY" {
                    let _ = ready_tx.send(());
                } else {
                    log::info!("[recorder] {line}");
                }
            }
        });
    }

    if ready_rx.recv_timeout(Duration::from_secs(8)).is_err() {
        let _ = child.kill();
        if let Some(mut a) = audio_child {
            let _ = a.kill();
        }
        return Err("錄影程式未就緒（逾時），請查看日誌".into());
    }

    *RECORDER_PROC.lock().unwrap() = Some(child);
    *AUDIO_PROCESS.lock().unwrap() = audio_child;
    *REC_PATHS.lock().unwrap() = Some(RecPaths {
        video: video_path,
        audio: audio_path,
        final_out: final_path.clone(),
    });

    // 註冊 F10 全域快捷鍵以停止錄影（錄影期間才註冊，避免平時佔用）
    let _ = app.global_shortcut().register("F10");
    // 置頂錄製指示視窗（主視窗最小化時仍看得到狀態）
    show_rec_indicator(app);
    // 把主視窗最小化，讓使用者看到要錄的內容（停止時會自動還原）
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }

    log::info!("🎬 開始錄影: target={target} 區域({x},{y}) {w}x{h} @ {fps}fps");
    let final_str = final_path.to_string_lossy().to_string();
    let _ = app.emit("recording_started", &final_str);
    Ok(final_str)
}

#[tauri::command]
pub async fn start_recording(app: AppHandle, fps: Option<u32>) -> Result<String, String> {
    let rec_opts = current_rec_opts();
    let fps = if rec_opts.fps > 0 { rec_opts.fps } else { fps.unwrap_or(60) };

    // overlay 座標（物理像素）
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("overlay 視窗不存在")?;
    let position = overlay
        .inner_position()
        .map_err(|e| format!("取得位置失敗: {e}"))?;
    let size = overlay
        .inner_size()
        .map_err(|e| format!("取得大小失敗: {e}"))?;

    // 找出選區所在的螢幕：用「與選區重疊面積最大」的螢幕（比中心點判斷穩，避免選區
    // 落在多螢幕排列的空隙時誤判）；若與任何螢幕都不重疊，退回中心最近的螢幕（而非主螢幕）。
    let sel_l = position.x;
    let sel_t = position.y;
    let sel_r = position.x + size.width as i32;
    let sel_b = position.y + size.height as i32;
    let sel_cx = position.x + size.width as i32 / 2;
    let sel_cy = position.y + size.height as i32 / 2;
    let monitors = app.available_monitors().unwrap_or_default();
    let overlap = |m: &tauri::Monitor| -> i64 {
        let mp = m.position();
        let ms = m.size();
        let iw = (sel_r.min(mp.x + ms.width as i32) - sel_l.max(mp.x)).max(0) as i64;
        let ih = (sel_b.min(mp.y + ms.height as i32) - sel_t.max(mp.y)).max(0) as i64;
        iw * ih
    };
    let best = monitors.iter().max_by_key(|m| overlap(m));
    let target = match best {
        Some(m) if overlap(m) > 0 => Some(m),
        _ => monitors.iter().min_by_key(|m| {
            let mp = m.position();
            let ms = m.size();
            let dx = (sel_cx - (mp.x + ms.width as i32 / 2)) as i64;
            let dy = (sel_cy - (mp.y + ms.height as i32 / 2)) as i64;
            dx * dx + dy * dy
        }),
    };

    let (mon_x, mon_y, mon_w, mon_h, mon_name) = match target {
        Some(m) => {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width, s.height, m.name().map(|n| n.to_string()).unwrap_or_default())
        }
        None => (0, 0, 1920u32, 1080u32, String::new()),
    };

    // 轉成該螢幕的本地座標 + clamp
    let mut x = (position.x - mon_x).max(0) as u32;
    let mut y = (position.y - mon_y).max(0) as u32;
    let mut w = size.width;
    let mut h = size.height;
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
    let w = (w - (w % 2)).max(4);
    let h = (h - (h % 2)).max(4);

    let _ = overlay.close();
    std::thread::sleep(Duration::from_millis(300));

    begin_recording(&app, &rec_opts, x, y, w, h, fps, mon_name)
}

fn cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_ok() {
            Some((p.x, p.y))
        } else {
            None
        }
    }
}

/// 找游標正下方、非 overlay 的最上層視窗的「可視範圍」（螢幕座標 x,y,w,h）。
/// 用 EnumWindows(Z-order 由上到下) + DWMWA_EXTENDED_FRAME_BOUNDS，
/// 後者排除 Win10/11 視窗的隱形調整邊框/陰影，框才會貼合肉眼可見範圍。
fn window_rect_under_cursor() -> Option<(i32, i32, i32, i32)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    let (cx, cy) = cursor_pos()?;

    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let v = &mut *(lparam.0 as *mut Vec<HWND>);
        v.push(hwnd);
        BOOL(1)
    }
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize));
    }

    for hwnd in hwnds {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if exstyle & WS_EX_TOOLWINDOW.0 != 0 {
                continue;
            }
            // 跳過 cloaked（UWP 背景視窗）
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
            if cloaked != 0 {
                continue;
            }
            if GetWindowTextLengthW(hwnd) == 0 {
                continue;
            }
            // 跳過 overlay 自己
            let mut buf = [0u16; 128];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if title == "LJCUT 錄影選區" {
                continue;
            }
            // DWM 可視邊界（排除隱形邊框/陰影）
            let mut r = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut r as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                continue;
            }
            if cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom {
                return Some((r.left, r.top, r.right - r.left, r.bottom - r.top));
            }
        }
    }
    None
}

/// 懸停預覽：回傳游標下視窗的螢幕座標範圍（x,y,w,h），給前端畫綠框
#[tauri::command]
pub fn hover_window_rect() -> Option<(i32, i32, i32, i32)> {
    window_rect_under_cursor()
}

/// 進入「點選視窗」模式：把 overlay 撐滿整個虛擬桌面，讓任一螢幕的視窗都能點選
#[tauri::command]
pub async fn enter_window_pick(app: AppHandle) -> Result<(), String> {
    let monitors = app.available_monitors().unwrap_or_default();
    let (mut min_x, mut min_y, mut max_r, mut max_b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x + s.width as i32 > max_r {
            max_r = p.x + s.width as i32;
        }
        if p.y + s.height as i32 > max_b {
            max_b = p.y + s.height as i32;
        }
    }
    if min_x == i32::MAX {
        return Err("找不到螢幕".into());
    }
    if let Some(ov) = app.get_webview_window("overlay") {
        let _ = ov.set_position(tauri::PhysicalPosition::new(min_x, min_y));
        let _ = ov.set_size(tauri::PhysicalSize::new(
            (max_r - min_x) as u32,
            (max_b - min_y) as u32,
        ));
    }
    Ok(())
}

/// 點選視窗後：把 overlay 內框對齊到游標下視窗（之後使用者可微調再錄）
#[tauri::command]
pub async fn snap_overlay_to_window(app: AppHandle) -> Result<(), String> {
    let (rx, ry, rw, rh) = window_rect_under_cursor().ok_or("游標下找不到視窗")?;
    let overlay = app.get_webview_window("overlay").ok_or("overlay 不存在")?;

    // 先直接設成視窗範圍（此時 overlay 不再是滿桌面，邊框值才正常）
    let _ = overlay.set_position(tauri::PhysicalPosition::new(rx, ry));
    let _ = overlay.set_size(tauri::PhysicalSize::new(rw.max(4) as u32, rh.max(4) as u32));
    std::thread::sleep(Duration::from_millis(40));

    // 量測實際內框與目標的誤差（=隱形邊框），再校正一次讓「內框 = 視窗範圍」
    let ip = overlay.inner_position().map_err(|e| e.to_string())?;
    let is = overlay.inner_size().map_err(|e| e.to_string())?;
    let dx = rx - ip.x;
    let dy = ry - ip.y;
    let dw = rw - is.width as i32;
    let dh = rh - is.height as i32;
    let _ = overlay.set_position(tauri::PhysicalPosition::new(rx + dx, ry + dy));
    let _ = overlay.set_size(tauri::PhysicalSize::new(
        (rw + dw).max(4) as u32,
        (rh + dh).max(4) as u32,
    ));
    Ok(())
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
        .creation_flags(CREATE_NO_WINDOW)
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

/// 等待子程序結束（最多 timeout 秒），逾時強制終止
fn wait_or_kill(child: &mut Child, timeout: Duration) {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if waited >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                std::thread::sleep(step);
                waited += step;
            }
            Err(_) => {
                let _ = child.kill();
                return;
            }
        }
    }
}

// ── 3. 停止錄影 ──

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    let _ = app.global_shortcut().unregister("F10");
    hide_rec_indicator(&app);
    // 停止錄影後把主視窗叫回來（還原 + 聚焦），避免結束後找不到 UI
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // 冪等：若已停止（例如 F10 與按鈕、或事件重複觸發），直接回 OK 不報錯
    let paths = match REC_PATHS.lock().unwrap().take() {
        Some(p) => p,
        None => return Ok(String::new()),
    };

    // 停止影像子程序：送 'q' + 關閉 stdin(EOF)，等它收尾 mp4 後結束
    if let Some(mut child) = RECORDER_PROC.lock().unwrap().take() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
            // drop stdin → EOF（雙保險）
        }
        wait_or_kill(&mut child, Duration::from_secs(15));
    }

    // 停止音訊 ffmpeg（送 'q'，逾時強制）
    if let Some(mut child) = AUDIO_PROCESS.lock().unwrap().take() {
        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        wait_or_kill(&mut child, Duration::from_secs(5));
    }

    std::thread::sleep(Duration::from_millis(200));

    // 影音合流（無音訊時等於重新封裝影像）
    let final_path = paths.final_out.clone();
    if !mux_av(&paths.video, paths.audio.as_deref(), &final_path) {
        let _ = std::fs::copy(&paths.video, &final_path);
    }
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

        let backend_uploads = find_backend_subdir("uploads");
        let backend_outputs = find_backend_subdir("outputs");
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

// ── 自動清理逾期暫存/工作檔 ──
//
// 掃描三個目錄、刪除「最後修改超過 max_age_days 天」的檔案：
//   - app_data/outputs   原始錄影(錄影_*.mp4) + 錄影暫存(rec_*) + 音訊(.m4a)
//   - backend/uploads    匯入/錄影的工作副本({id}.mp4) + 辨識用音檔({id}.wav)
//   - backend/outputs    縮圖(.jpg)、字幕中間檔(.ass/.srt)
// 注意：使用者匯出的成品在「自己選的輸出資料夾」，不在這些目錄，永遠不會被碰到。
pub fn cleanup_old_files(app: &AppHandle, max_age_days: u64) {
    let cutoff = match SystemTime::now().checked_sub(Duration::from_secs(max_age_days * 86_400)) {
        Some(t) => t,
        None => return,
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(data_dir) = app.path().app_data_dir() {
        dirs.push(data_dir.join("outputs"));
    }
    dirs.push(find_backend_subdir("uploads"));
    dirs.push(find_backend_subdir("outputs"));

    let mut removed = 0u32;
    let mut freed: u64 = 0;
    for dir in dirs {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() {
                continue;
            }
            let too_old = meta.modified().map(|m| m < cutoff).unwrap_or(false);
            if too_old {
                let sz = meta.len();
                if std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                    freed += sz;
                }
            }
        }
    }

    if removed > 0 {
        log::info!(
            "🧹 自動清理：刪除 {removed} 個逾期暫存檔（>{max_age_days} 天），釋放 {:.1} MB",
            freed as f64 / 1_048_576.0
        );
    } else {
        log::info!("🧹 自動清理：無逾期暫存檔");
    }
}
