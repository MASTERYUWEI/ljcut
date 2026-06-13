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

:: 先清掉可能佔 port 的舊程序
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im python.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: 1. 啟動 Python 後端 (port 8000)
echo [1/3] Starting Python backend on port 8000...
start /min "LJCUT-Backend" cmd /c "cd /d "%~dp0backend" && venv\Scripts\python.exe -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"

:: 2. 啟動前端 dev server (port 5173)
echo [2/3] Starting Frontend on port 5173...
start /min "LJCUT-Frontend" cmd /c "cd /d "%~dp0frontend" && npm run dev"

:: 3. 等待服務啟動
echo [3/3] Waiting 8 seconds for services to start...
timeout /t 8 /nobreak >nul

:: 4. 啟動 Tauri 桌面應用（從專案根目錄執行）
echo Starting Tauri Desktop App...
echo.
npx -y @tauri-apps/cli dev 2>&1

:: 如果出錯會停在這裡讓你看到
echo.
echo === Tauri exited. Press any key to close. ===
taskkill /fi "WINDOWTITLE eq LJCUT-Backend" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq LJCUT-Frontend" /f >nul 2>&1
pause
