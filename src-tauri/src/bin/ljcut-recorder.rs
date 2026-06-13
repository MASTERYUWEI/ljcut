//! LJCUT 錄影 sidecar — 獨立程式，用 Windows.Graphics.Capture 擷取螢幕區域並硬體編碼。
//!
//! 之所以獨立成一支 exe：在 Tauri 主程式內（有 WebView2）直接呼叫 WGC 會卡死，
//! 但在乾淨的獨立 process 內完全正常。由 Tauri 以子程序方式啟動。
//!
//! 用法：ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4>
//! 控制：啟動成功後印出 "READY" 到 stdout；從 stdin 收到一行 "q"（或 stdin 關閉）即停止收尾並結束。

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
}

struct Handler {
    encoder: Option<VideoEncoder>,
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    width: u32,
    height: u32,
    pack_buf: Vec<u8>, // as_nopadding_buffer 的暫存（top-down）
    flip_buf: Vec<u8>, // 翻轉成 bottom-up 後送給編碼器
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
        let ts = frame.timestamp()?.Duration;
        let fb = frame.buffer_crop(self.left, self.top, self.right, self.bottom)?;

        // send_frame_buffer 要求 BGRA + bottom-to-top。as_nopadding_buffer 給的是
        // top-down，這裡逐列翻轉成 bottom-up。
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
                // 尺寸不符（理論上不會），退而求其次直接送（至少不崩）
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 7 {
        fail("用法: ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4> [自動停止秒數]");
    }
    let parse = |s: &str| -> u32 { s.parse().unwrap_or_else(|_| fail("參數需為整數")) };
    let left = parse(&args[1]);
    let top = parse(&args[2]);
    let width = parse(&args[3]);
    let height = parse(&args[4]);
    let fps = parse(&args[5]).max(1);
    let out = args[6].clone();

    let monitor = match Monitor::primary() {
        Ok(m) => m,
        Err(e) => fail(&format!("取得主螢幕失敗: {e}")),
    };

    let flags = Flags {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        fps,
        out,
    };
    // 注意：MinimumUpdateIntervalSettings::Custom 在部分 Windows 10 版本不支援
    // （會回「Setting a minimum update interval is not supported」），用 Default（~60fps）。
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8, // send_frame_buffer 要求 BGRA
        flags,
    );

    let control = match Handler::start_free_threaded(settings) {
        Ok(c) => c,
        Err(e) => fail(&format!("啟動擷取失敗: {e}")),
    };

    // 通知父程序：已開始擷取
    println!("READY");
    let _ = std::io::stdout().flush();

    let stop = Arc::new(AtomicBool::new(false));

    // stdin watcher：收到 "q" 或 stdin 關閉(EOF) → 設定停止旗標
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

    // 可選：自動停止秒數（第 7 個參數，測試用）
    if let Some(secs) = args.get(7).and_then(|s| s.parse::<u64>().ok()) {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            stop.store(true, Ordering::Relaxed);
        });
    }

    // 主執行緒輪詢停止旗標
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }

    // 收尾：停止擷取 + 完成 encoder
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
