@echo off
chcp 65001 >nul
title LJCUT Desktop

echo [LJCUT] Setting up environment...

:: 設定 Rust + Node 路徑
set PATH=%USERPROFILE%\.cargo\bin;%PATH%

:: 載入 MSVC 環境
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

:: 切到專案根目錄
cd /d "%~dp0"

:: 首次執行：安裝前端相依
if not exist "frontend\node_modules" (
    echo [LJCUT] Installing frontend deps ^(first run^)...
    cmd /c "cd frontend && npm install"
)

:: 啟動 Tauri 桌面應用
::   - 前端 Vite dev server 由 tauri.conf.json 的 beforeDevCommand 自動帶起
::   - Python sidecar 由 Rust 在啟動時自動拉起、關閉時自動收掉
echo [LJCUT] Starting desktop app...
echo.
npx -y @tauri-apps/cli dev

echo.
echo === Tauri exited. Press any key to close. ===
pause
