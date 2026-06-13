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
