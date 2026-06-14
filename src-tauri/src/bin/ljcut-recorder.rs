//! LJCUT 錄影 sidecar — 獨立程式，用 Windows.Graphics.Capture 擷取並硬體編碼。
//!
//! 之所以獨立成一支 exe：在 Tauri 主程式內（有 WebView2）直接呼叫 WGC 會卡死，
//! 但在乾淨的獨立 process 內完全正常。由 Tauri 以子程序方式啟動。
//!
//! 兩種模式（由第 7 參數決定）：
//!   - 螢幕區域：<monitor> = 裝置名(\\.\DISPLAYn) 或 "primary"；裁切 left/top/width/height
//!   - 整個視窗：<monitor> = "window:<視窗標題>"；錄整個視窗（忽略 left/top/w/h）
//! 用法：ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4> <monitor|window:title> [自動停止秒數]
//! 控制：啟動成功印 "READY"；stdin 收到 "q"（或 EOF）即停止收尾。

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
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
use windows_capture::window::Window;

#[derive(Clone)]
struct Flags {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    width: u32,
    height: u32,
    fps: u32,
    out: String,
    window_mode: bool,
}

struct Handler {
    encoder: Option<VideoEncoder>,
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    width: u32,
    height: u32,
    window_mode: bool,
    pack_buf: Vec<u8>,
    flip_buf: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

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
            width: f.width,
            height: f.height,
            window_mode: f.window_mode,
            pack_buf: Vec::new(),
            flip_buf: Vec::new(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.encoder.is_none() {
            return Ok(());
        }

        // 視窗模式：整窗直送（texture path，自動處理色彩/方向，且容忍視窗縮放）
        if self.window_mode {
            if let Some(enc) = self.encoder.as_mut() {
                enc.send_frame(&*frame)?;
            }
            return Ok(());
        }

        // 螢幕區域模式：裁切 → BGRA + bottom-to-top → send_frame_buffer
        let ts = frame.timestamp()?.Duration;
        let fb = frame.buffer_crop(self.left, self.top, self.right, self.bottom)?;
        let row = (self.width * 4) as usize;
        let hh = self.height as usize;
        let mut packed = std::mem::take(&mut self.pack_buf);
        {
            let src = fb.as_nopadding_buffer(&mut packed);
            if self.flip_buf.len() != src.len() {
                self.flip_buf.resize(src.len(), 0);
            }
            if src.len() == row * hh {
                for y in 0..hh {
                    let s = &src[y * row..(y + 1) * row];
                    let dy = hh - 1 - y;
                    self.flip_buf[dy * row..(dy + 1) * row].copy_from_slice(s);
                }
            } else {
                self.flip_buf[..src.len()].copy_from_slice(src);
            }
        }
        self.pack_buf = packed;

        if let Some(enc) = self.encoder.as_mut() {
            enc.send_frame_buffer(&self.flip_buf, ts)?;
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(enc) = self.encoder.take() {
            let _ = enc.finish();
        }
        Ok(())
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("ERROR: {msg}");
    std::process::exit(1);
}

/// 依裝置名稱(\\.\DISPLAYn)選擇螢幕；空字串/"primary"或找不到時退回主螢幕
fn pick_monitor(name: &str) -> Monitor {
    if !name.is_empty() && name != "primary" {
        if let Ok(monitors) = Monitor::enumerate() {
            for m in &monitors {
                if let Ok(dn) = m.device_name() {
                    if dn == name {
                        return *m;
                    }
                }
            }
        }
    }
    Monitor::primary().unwrap_or_else(|e| fail(&format!("取得主螢幕失敗: {e}")))
}

/// 依標題尋找視窗（先精確、再包含）
fn pick_window(title: &str) -> Window {
    if let Ok(w) = Window::from_name(title) {
        return w;
    }
    if let Ok(w) = Window::from_contains_name(title) {
        return w;
    }
    fail(&format!("找不到視窗: {title}"));
}

fn run_stop_loop(
    control: windows_capture::capture::CaptureControl<Handler, Box<dyn std::error::Error + Send + Sync>>,
    auto_stop_secs: Option<u64>,
) {
    println!("READY");
    let _ = std::io::stdout().flush();

    let stop = Arc::new(AtomicBool::new(false));

    // stdin watcher：收到 "q" 或 EOF → 停止
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut line = String::new();
            loop {
                line.clear();
                match stdin.lock().read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.trim() == "q" => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            stop.store(true, Ordering::Relaxed);
        });
    }

    // 可選自動停止（測試用）
    if let Some(secs) = auto_stop_secs {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            stop.store(true, Ordering::Relaxed);
        });
    }

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }

    let cb = control.callback();
    let _ = control.stop();
    {
        let mut h = cb.lock();
        if let Some(enc) = h.encoder.take() {
            if let Err(e) = enc.finish() {
                fail(&format!("encoder 收尾失敗: {e}"));
            }
        }
    }
    println!("DONE");
    let _ = std::io::stdout().flush();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 8 {
        fail("用法: ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4> <monitor|window:title> [自動停止秒數]");
    }
    let parse = |s: &str| -> u32 { s.parse().unwrap_or_else(|_| fail("參數需為整數")) };
    let left = parse(&args[1]);
    let top = parse(&args[2]);
    let width = parse(&args[3]);
    let height = parse(&args[4]);
    let fps = parse(&args[5]).max(1);
    let out = args[6].clone();
    let target = args[7].clone();
    let auto_stop = args.get(8).and_then(|s| s.parse::<u64>().ok());

    // start_free_threaded 對 Window/Monitor 回傳的 CaptureControl<Handler,_> 型別相同
    let control = if let Some(title) = target.strip_prefix("window:") {
        // ── 視窗模式 ──
        let window = pick_window(title);
        let ww = window.width().unwrap_or(width as i32).max(2) as u32;
        let wh = window.height().unwrap_or(height as i32).max(2) as u32;
        let ww = (ww - (ww % 2)).max(2);
        let wh = (wh - (wh % 2)).max(2);
        let flags = Flags {
            left: 0,
            top: 0,
            right: ww,
            bottom: wh,
            width: ww,
            height: wh,
            fps,
            out,
            window_mode: true,
        };
        let settings = Settings::new(
            window,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );
        Handler::start_free_threaded(settings).unwrap_or_else(|e| fail(&format!("啟動視窗擷取失敗: {e}")))
    } else {
        // ── 螢幕區域模式 ──
        let monitor = pick_monitor(&target);
        let flags = Flags {
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            fps,
            out,
            window_mode: false,
        };
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );
        Handler::start_free_threaded(settings).unwrap_or_else(|e| fail(&format!("啟動螢幕擷取失敗: {e}")))
    };

    run_stop_loop(control, auto_stop);
}
