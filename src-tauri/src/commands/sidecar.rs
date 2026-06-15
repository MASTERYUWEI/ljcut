//! Python sidecar 生命週期管理
//!
//! Tauri 啟動時拉起 FastAPI（uvicorn）子進程、結束時收掉，
//! 取代舊的「.bat 開三個 cmd 視窗 + taskkill」做法。
//! 前端透過 `get_backend_port` 取得實際 port，直連 127.0.0.1:<port>。

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 由 Tauri 管理的 sidecar 狀態
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    /// Windows Job Object handle（以 isize 保存以符合 Send）；存活於 app 生命週期，
    /// app 結束/當機/被強制 kill 時 handle 隨之關閉 → KILL_ON_JOB_CLOSE 終止 sidecar。
    #[allow(dead_code)]
    job: Mutex<Option<isize>>,
}

/// 前端查詢後端 port（啟動後即可取得）
#[tauri::command]
pub fn get_backend_port(state: State<SidecarState>) -> Option<u16> {
    *state.port.lock().unwrap()
}

/// 挑一個空閒的本機 port
fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8000)
}

/// 找到 backend/ 目錄（dev：從 exe 往上找；再退回 cwd）
fn find_backend_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(d) = &dir {
                let candidate = d.join("backend");
                if candidate.join("main.py").exists() {
                    return candidate;
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("backend");
        if candidate.join("main.py").exists() {
            return candidate;
        }
    }
    PathBuf::from("backend")
}

/// 取得 backend venv 的 python（找不到就退回系統 python）
fn venv_python(backend_dir: &PathBuf) -> PathBuf {
    let venv = if cfg!(windows) {
        backend_dir.join("venv").join("Scripts").join("python.exe")
    } else {
        backend_dir.join("venv").join("bin").join("python")
    };
    if venv.exists() {
        venv
    } else {
        PathBuf::from("python")
    }
}

/// Windows：把子進程放進「父進程一死就連帶終止」的 Job Object。
///
/// 回傳 job handle（以 isize 保存）。**故意不關閉**這個 handle：它會一直開著直到本 app
/// 進程結束（不論正常關閉、當機、或被強制 kill）；屆時 OS 關閉該 handle → 因設了
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，job 內的 sidecar 連同其子進程會被 OS 一併終止，
/// 不會留下孤兒吃 VRAM。比輪詢父 PID 的看門狗可靠（無 PID 重用問題、無延遲）。
#[cfg(windows)]
fn assign_kill_on_close_job(pid: u32) -> Option<isize> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_err()
        {
            let _ = CloseHandle(job);
            return None;
        }
        let proc = match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseHandle(job);
                return None;
            }
        };
        let assigned = AssignProcessToJobObject(job, proc);
        let _ = CloseHandle(proc);
        if assigned.is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(job.0 as isize) // 故意保持開啟到 app 結束
    }
}

/// 啟動 sidecar（在 setup 階段呼叫）
pub fn start_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();

    // 已在執行就不重複啟動
    if state.child.lock().unwrap().is_some() {
        return;
    }

    let backend_dir = find_backend_dir();
    let python = venv_python(&backend_dir);
    let port = pick_free_port();

    log::info!(
        "🐍 啟動 sidecar: {} -m uvicorn main:app --port {} (cwd={})",
        python.display(),
        port,
        backend_dir.display()
    );

    let mut cmd = Command::new(&python);
    cmd.current_dir(&backend_dir)
        .env("LJCUT_PARENT_PID", std::process::id().to_string())
        // 強制 Python 以 UTF-8 輸出：stdout 被導向 pipe 時 Python 預設用系統編碼(cp950)，
        // 會讓含 emoji/中文的 print 觸發 UnicodeEncodeError，連帶使模型載入執行緒崩潰。
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .args([
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--log-level",
            "info",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows：不要彈出 console 視窗
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            // 綁定 kill-on-close Job Object：app 一旦消失（含當機/強制 kill），OS 連帶終止 sidecar，
            // 不再依賴會被 PID 重用騙過的輪詢看門狗（Python 端看門狗仍保留作為備援）。
            #[cfg(windows)]
            {
                let pid = child.id();
                match assign_kill_on_close_job(pid) {
                    Some(h) => {
                        *state.job.lock().unwrap() = Some(h);
                        log::info!("🛡️ sidecar 已綁定 kill-on-close job (pid={pid})");
                    }
                    None => log::warn!("⚠️ sidecar job 綁定失敗，改靠 Python 父進程看門狗"),
                }
            }

            // 背景排空 stdout/stderr，避免 pipe 滿造成阻塞，同時把日誌轉到 log
            if let Some(out) = child.stdout.take() {
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        log::info!("[sidecar] {line}");
                    }
                });
            }
            if let Some(err) = child.stderr.take() {
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(err).lines().map_while(Result::ok) {
                        log::info!("[sidecar] {line}");
                    }
                });
            }
            *state.child.lock().unwrap() = Some(child);
            *state.port.lock().unwrap() = Some(port);
            log::info!("✅ sidecar 已啟動，port={port}");
        }
        Err(e) => {
            log::error!("❌ 啟動 sidecar 失敗: {e}（python={}）", python.display());
        }
    }
}

/// 關閉 sidecar（在 app 結束時呼叫）
pub fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(mut child) = state.child.lock().unwrap().take() {
        log::info!("🛑 關閉 sidecar (pid={})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.port.lock().unwrap() = None;
}
