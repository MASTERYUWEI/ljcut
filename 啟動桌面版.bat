@echo off
chcp 65001 >nul
title LJCUT Desktop

echo [LJCUT] Setting up environment...

REM Add Rust + Node to PATH
set PATH=%USERPROFILE%\.cargo\bin;%PATH%

REM Load MSVC build environment
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

REM Go to project root
cd /d "%~dp0"

REM First run only: install frontend dependencies
if not exist "frontend\node_modules" (
    echo [LJCUT] Installing frontend deps, first run...
    cmd /c "cd frontend && npm install"
)

REM Build the screen-recorder helper exe (tauri dev does not build extra bins)
echo [LJCUT] Building screen recorder helper...
cargo build --manifest-path src-tauri\Cargo.toml --bin ljcut-recorder

REM Start the Tauri desktop app.
REM   - Frontend Vite dev server is auto-started via tauri.conf.json beforeDevCommand
REM   - Python sidecar is auto-started by Rust on launch and stopped on exit
echo [LJCUT] Starting desktop app...
echo.
npx -y @tauri-apps/cli dev

echo.
echo === Tauri exited. Press any key to close. ===
pause
