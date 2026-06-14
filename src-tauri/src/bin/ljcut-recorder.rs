//! LJCUT 錄影 sidecar — 獨立程式，用 DXGI Desktop Duplication 擷取桌面區域並硬體編碼。
//!
//! 為什麼用 DXGI（而非 WGC）：WGC 在 Windows 10 19045 會強制畫一圈黃色「擷取中」邊框，
//! 而關閉該邊框的 API 在此版本不支援；DXGI 桌面複製天生沒有該邊框（OBS/oCam 等也走這條）。
//! 為什麼獨立成 exe：沿用既有架構（與主程式 WebView2 隔離），且方便獨立測試。
//!
//! 不掉幀策略（固定 CFR）：以固定節拍 1/fps 送影格給編碼器；該 tick 內有新畫面就送新的、
//! 沒有就重送上一張 → 輸出檔每一格都填滿、零空缺。節拍對齊牆鐘時間，使影片長度與並行
//! 錄製的音軌一致（不會 A/V 飄移）。落後時自然以「重送上一張」補滿缺口；只有在系統嚴重
//! 停頓（>1 秒，例如休眠/UAC 安全桌面）才跳過缺口以免記憶體暴漲。
//!
//! 顯示卡：在「擁有目標螢幕的 adapter」上建立 D3D11 裝置（支援 iGPU+dGPU 混合機）。
//! 旋轉螢幕：目前不支援直式(90/270)螢幕，偵測到會明確報錯而非錄出歪斜畫面。
//!
//! 用法：ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4> <monitor> [自動停止秒數]
//!   monitor = 裝置名(\\.\DISPLAYn) 或 "primary"；left/top/width/height 為該螢幕內的本地像素。
//! 控制：啟動成功印 "READY"；stdin 收到 "q"（或 EOF）即停止收尾；完成印 "DONE"。

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Foundation::{E_FAIL, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};

fn fail(msg: &str) -> ! {
    eprintln!("ERROR: {msg}");
    std::process::exit(1);
}

enum GrabErr {
    /// 桌面切換（解析度變更、進入全螢幕、UAC 安全桌面）→ 需重建複製器
    AccessLost,
    Other(windows::core::Error),
}

struct Capturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output: IDXGIOutput1,
    /// Option 以便重建時先設 None（強制 COM 釋放舊的）再重新 DuplicateOutput
    dupl: Option<IDXGIOutputDuplication>,
    staging: ID3D11Texture2D,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    timeout_ms: u32,
}

impl Capturer {
    /// 抓一張：成功把畫面（裁切 + 翻成 bottom-to-top BGRA）寫進 out_buf 回 Ok(true)；
    /// 逾時無新畫面回 Ok(false)。依實際來源尺寸動態裁切，越界部分以黑邊填補（解析度
    /// 中途變更也不會殘留舊畫面或越界讀取）。
    fn grab(&mut self, out_buf: &mut [u8]) -> Result<bool, GrabErr> {
        let dupl = match &self.dupl {
            Some(d) => d.clone(),
            None => return Err(GrabErr::AccessLost),
        };
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match dupl.AcquireNextFrame(self.timeout_ms, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(false),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => return Err(GrabErr::AccessLost),
                Err(e) => return Err(GrabErr::Other(e)),
            }

            let resource = match res {
                Some(r) => r,
                None => {
                    let _ = dupl.ReleaseFrame();
                    return Ok(false);
                }
            };

            // 依實際來源尺寸計算可複製範圍，複製到 CPU 可讀的 staging
            let copy_result = (|| -> windows::core::Result<(u32, u32)> {
                let tex: ID3D11Texture2D = resource.cast()?;
                let mut td = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut td);
                let cw = if self.x < td.Width { self.w.min(td.Width - self.x) } else { 0 };
                let ch = if self.y < td.Height { self.h.min(td.Height - self.y) } else { 0 };
                if cw > 0 && ch > 0 {
                    let src_box = D3D11_BOX {
                        left: self.x,
                        top: self.y,
                        front: 0,
                        right: self.x + cw,
                        bottom: self.y + ch,
                        back: 1,
                    };
                    self.context
                        .CopySubresourceRegion(&self.staging, 0, 0, 0, 0, &tex, 0, Some(&src_box));
                }
                Ok((cw, ch))
            })();
            // 不論成敗，下次 Acquire 前一定要先 Release
            let _ = dupl.ReleaseFrame();
            let (cw, ch) = copy_result.map_err(GrabErr::Other)?;

            let row = (self.w * 4) as usize;
            // 無法覆蓋整個區域（解析度縮小/區域落在畫面外）→ 先清黑避免殘留舊畫面
            if cw < self.w || ch < self.h {
                out_buf.iter_mut().for_each(|b| *b = 0);
            }
            if cw == 0 || ch == 0 {
                return Ok(true);
            }

            // 讀回 staging，逐列翻轉成 bottom-to-top（編碼器 send_frame_buffer 要求）
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(GrabErr::Other)?;
            let pitch = mapped.RowPitch as usize;
            let hh = self.h as usize;
            let cwb = (cw * 4) as usize;
            let chh = ch as usize;
            let src = mapped.pData as *const u8;
            let dst = out_buf.as_mut_ptr();
            for yy in 0..chh {
                let s = src.add(yy * pitch);
                let d = dst.add((hh - 1 - yy) * row);
                std::ptr::copy_nonoverlapping(s, d, cwb);
            }
            self.context.Unmap(&self.staging, 0);
            Ok(true)
        }
    }

    /// 重建複製器。DXGI 規定一個 output 同時只能有一個 duplication，所以**必須先釋放舊的**
    /// （設 None 觸發 COM Release）再 DuplicateOutput，否則新呼叫會回 E_INVALIDARG 而永久失敗。
    fn recreate(&mut self) -> windows::core::Result<()> {
        self.dupl = None;
        let mut last: Option<windows::core::Error> = None;
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(40));
            match unsafe { self.output.DuplicateOutput(&self.device) } {
                Ok(d) => {
                    // 解析度/DPI 可能在 ACCESS_LOST 期間變了，重抓尺寸並夾住裁切原點（w/h 維持
                    // 不變＝編碼器尺寸；越界部分由 grab 以黑邊填補）
                    let desc = unsafe { d.GetDesc() };
                    let sw = desc.ModeDesc.Width;
                    let sh = desc.ModeDesc.Height;
                    if sw > 0 && self.x + self.w > sw {
                        self.x = sw.saturating_sub(self.w);
                    }
                    if sh > 0 && self.y + self.h > sh {
                        self.y = sh.saturating_sub(self.h);
                    }
                    self.dupl = Some(d);
                    return Ok(());
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| E_FAIL.into()))
    }
}

/// 找出「擁有目標螢幕」的 adapter，並在該 adapter 上建立 D3D11 裝置，回傳 (裝置, context, output)。
/// 支援 iGPU+dGPU 混合機；指定螢幕名找不到時明確失敗（絕不退回別的螢幕）。
fn create_device_and_output(
    name: &str,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, IDXGIOutput1)> {
    let want = name.trim();
    let want_primary = want.is_empty() || want == "primary";
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };

    let mut chosen: Option<(IDXGIAdapter1, IDXGIOutput)> = None;
    let mut fallback: Option<(IDXGIAdapter1, IDXGIOutput)> = None;

    let mut ai = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(ai) } {
            Ok(a) => a,
            Err(_) => break, // 列舉結束
        };
        ai += 1;
        let mut oi = 0u32;
        loop {
            let output = match unsafe { adapter.EnumOutputs(oi) } {
                Ok(o) => o,
                Err(_) => break,
            };
            oi += 1;
            let desc = unsafe { output.GetDesc()? };
            if fallback.is_none() {
                fallback = Some((adapter.clone(), output.clone()));
            }
            let dev = String::from_utf16_lossy(&desc.DeviceName);
            let dev = dev.trim_end_matches('\0');
            let hit = if want_primary {
                desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0
            } else {
                dev == want
            };
            if hit {
                chosen = Some((adapter.clone(), output));
                break;
            }
        }
        if chosen.is_some() {
            break;
        }
    }

    // 指定了具體螢幕名卻找不到 → 明確失敗（絕不退回別的螢幕，以免靜默錄錯螢幕）
    let (adapter, output) = match chosen.or(if want_primary { fallback } else { None }) {
        Some(p) => p,
        None => {
            eprintln!("ERROR: 找不到指定螢幕 '{want}'（可用輸出不含此裝置名）");
            return Err(E_FAIL.into());
        }
    };

    // 明確指定 adapter 時，driver type 必須用 UNKNOWN（用 HARDWARE 會回 E_INVALIDARG）
    let adapter: IDXGIAdapter = adapter.cast()?;
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }

    let odesc = unsafe { output.GetDesc()? };
    let oname = String::from_utf16_lossy(&odesc.DeviceName);
    eprintln!(
        "INFO: 選定螢幕 '{}' @ ({},{})",
        oname.trim_end_matches('\0'),
        odesc.DesktopCoordinates.left,
        odesc.DesktopCoordinates.top
    );

    Ok((device.unwrap(), context.unwrap(), output.cast()?))
}

fn create_staging(device: &ID3D11Device, w: u32, h: u32) -> windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex))? };
    Ok(tex.unwrap())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 8 {
        fail("用法: ljcut-recorder <left> <top> <width> <height> <fps> <output.mp4> <monitor> [自動停止秒數]");
    }
    let parse = |s: &str| -> u32 { s.parse().unwrap_or_else(|_| fail("參數需為整數")) };
    let mut x = parse(&args[1]);
    let mut y = parse(&args[2]);
    let mut w = parse(&args[3]).max(2);
    let mut h = parse(&args[4]).max(2);
    let fps = parse(&args[5]).max(1);
    let out = args[6].clone();
    let target = args[7].clone();
    let auto_stop = args.get(8).and_then(|s| s.parse::<u64>().ok());

    // WinRT（VideoEncoder）需要 MTA；建立程序級 MTA 後，編碼器內部的 transcode thread 也能隱式參與
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // ── 建立 DXGI 桌面複製（在擁有目標螢幕的顯示卡上）──
    let (device, context, output) =
        create_device_and_output(&target).unwrap_or_else(|e| fail(&format!("建立裝置/選螢幕失敗: {e}")));
    let dupl = unsafe {
        output
            .DuplicateOutput(&device)
            .unwrap_or_else(|e| fail(&format!("啟動桌面複製失敗: {e}")))
    };

    let dupl_desc = unsafe { dupl.GetDesc() };
    // 旋轉(直式 90/270)螢幕座標系不同，目前不支援 → 明確報錯而非錄出歪斜畫面
    // DXGI_MODE_ROTATION：UNSPECIFIED=0, IDENTITY=1, ROTATE90=2, ROTATE180=3, ROTATE270=4
    if dupl_desc.Rotation.0 > 1 {
        fail("偵測到旋轉(直式)螢幕，目前尚未支援錄製旋轉螢幕");
    }
    let surf_w = dupl_desc.ModeDesc.Width;
    let surf_h = dupl_desc.ModeDesc.Height;
    if surf_w > 0 && surf_h > 0 {
        if x >= surf_w {
            x = surf_w.saturating_sub(2);
        }
        if y >= surf_h {
            y = surf_h.saturating_sub(2);
        }
        if x + w > surf_w {
            w = surf_w - x;
        }
        if y + h > surf_h {
            h = surf_h - y;
        }
    }
    w = (w - (w % 2)).max(2);
    h = (h - (h % 2)).max(2);

    let staging =
        create_staging(&device, w, h).unwrap_or_else(|e| fail(&format!("建立 staging 失敗: {e}")));

    let mut cap = Capturer {
        device,
        context,
        output,
        dupl: Some(dupl),
        staging,
        x,
        y,
        w,
        h,
        timeout_ms: 100,
    };

    // ── 建立編碼器（H.264 / MP4，音訊關閉；沿用 windows-capture 的硬體編碼器）──
    let mut encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(w, h)
            .frame_rate(fps)
            .bitrate(12_000_000)
            .sub_type(VideoSettingsSubType::H264),
        AudioSettingsBuilder::default().disabled(true),
        ContainerSettingsBuilder::default(),
        &out,
    )
    .unwrap_or_else(|e| fail(&format!("建立編碼器失敗: {e}")));

    let mut out_buf = vec![0u8; (w * h * 4) as usize];

    // ── 預熱：抓到第一張真實畫面再宣告 READY（最多等 ~1.5s）──
    {
        let deadline = Instant::now() + Duration::from_millis(1500);
        cap.timeout_ms = 100;
        loop {
            match cap.grab(&mut out_buf) {
                Ok(true) => break,
                Ok(false) => {}
                Err(GrabErr::AccessLost) => {
                    let _ = cap.recreate();
                }
                Err(GrabErr::Other(e)) => fail(&format!("預熱擷取失敗: {e}")),
            }
            if Instant::now() >= deadline {
                break; // 畫面完全靜止；先以黑幀開始，內容一變動就會補上
            }
        }
    }

    println!("READY");
    let _ = std::io::stdout().flush();

    // ── 停止旗標：stdin "q"/EOF，或可選的自動停止秒數 ──
    let stop = Arc::new(AtomicBool::new(false));
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
    if let Some(secs) = auto_stop {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            stop.store(true, Ordering::Relaxed);
        });
    }

    // ── 固定節拍主迴圈（CFR，不掉幀）──
    let frame_ns: u128 = 1_000_000_000u128 / fps as u128;
    let start = Instant::now();
    let mut idx: u64 = 0;

    while !stop.load(Ordering::Relaxed) {
        let target_ns = (idx as u128) * frame_ns;

        // 抽取畫面直到該 tick 的目標時間，期間持續把最新畫面更新進 out_buf
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let elapsed_ns = start.elapsed().as_nanos();
            if elapsed_ns >= target_ns {
                break;
            }
            let remaining_ms = ((target_ns - elapsed_ns) / 1_000_000) as u32;
            cap.timeout_ms = remaining_ms.clamp(1, 15);
            match cap.grab(&mut out_buf) {
                Ok(true) => {}
                Ok(false) => {}
                Err(GrabErr::AccessLost) => {
                    let _ = cap.recreate();
                }
                Err(GrabErr::Other(_)) => {}
            }
        }

        // 送出這一格（新畫面或重送上一張）→ 保證每一格都填滿
        let ts = ((idx as i128) * 10_000_000i128 / fps as i128) as i64;
        if let Err(e) = encoder.send_frame_buffer(&out_buf, ts) {
            fail(&format!("送影格失敗: {e}"));
        }
        idx += 1;

        // 安全閥：系統嚴重停頓（落後 >1 秒）時跳過缺口，避免爆量補幀導致記憶體暴漲
        let want = (start.elapsed().as_nanos() / frame_ns) as u64;
        if want > idx + fps as u64 {
            idx = want;
        }
    }

    // ── 收尾 ──
    encoder
        .finish()
        .unwrap_or_else(|e| fail(&format!("編碼收尾失敗: {e}")));
    println!("DONE");
    let _ = std::io::stdout().flush();
}
