# ── LJCUT 發行打包腳本 ──
# 用法（在專案根目錄）:
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1              # 完整打包
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -SkipBackend # 跳過 PyInstaller（後端沒改時）
#
# 產物: src-tauri\target\release\bundle\nsis\*.exe(+.sig) 與 bundle\msi\*.msi(+.sig)
# 發佈: 上傳 installer + .sig + latest.json 到 GitHub Releases（見 scripts\make-latest-json.py）
#
# 前置需求:
#   - 簽章私鑰 C:\Users\<you>\.tauri\ljcut_updater.key（遺失 = 永遠無法再發更新，務必備份）
#   - chocolatey ffmpeg（或自行調整 $FfmpegBin）

param(
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$FfmpegBin = "C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin"

Write-Host "=== [1/5] 編譯 ljcut-recorder (release) ===" -ForegroundColor Cyan
Push-Location "$Root\src-tauri"
cargo build --release --bin ljcut-recorder
if ($LASTEXITCODE -ne 0) { throw "recorder 編譯失敗" }
New-Item -ItemType Directory -Force "$Root\src-tauri\binaries" | Out-Null
Copy-Item "$Root\src-tauri\target\release\ljcut-recorder.exe" `
          "$Root\src-tauri\binaries\ljcut-recorder-x86_64-pc-windows-msvc.exe" -Force
Pop-Location

Write-Host "=== [2/5] PyInstaller 凍結後端（CPU 版，排除 CUDA）===" -ForegroundColor Cyan
if (-not $SkipBackend) {
    Push-Location "$Root\backend"
    & .\venv\Scripts\python.exe -m PyInstaller --noconfirm --onedir --name ljcut-backend `
        --distpath dist --workpath build `
        --collect-all faster_whisper --collect-all ctranslate2 --collect-all av `
        --collect-all onnxruntime --collect-all tokenizers --collect-all huggingface_hub `
        --exclude-module nvidia --exclude-module torch --exclude-module matplotlib `
        --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan.on `
        server_entry.py
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失敗" }
    Pop-Location
}

Write-Host "=== [3/5] 佈署 bundle-res（backend + ffmpeg）===" -ForegroundColor Cyan
$Res = "$Root\src-tauri\bundle-res"
if (Test-Path "$Res\backend") { Remove-Item -Recurse -Force "$Res\backend" }
New-Item -ItemType Directory -Force $Res | Out-Null
Copy-Item -Recurse "$Root\backend\dist\ljcut-backend" "$Res\backend"
Copy-Item "$FfmpegBin\ffmpeg.exe"  "$Res\ffmpeg.exe"  -Force
Copy-Item "$FfmpegBin\ffprobe.exe" "$Res\ffprobe.exe" -Force
Remove-Item "$Res\.keep" -ErrorAction SilentlyContinue

Write-Host "=== [4/5] tauri build（NSIS + MSI，含更新簽章）===" -ForegroundColor Cyan
# 注意：PowerShell 無法把環境變數設成「空字串」($env:X="" 等於刪除)，
# 而簽章金鑰無密碼需要 PASSWORD 存在且為空 → 改經 Git Bash 執行 build。
Push-Location $Root
& "C:/Program Files/Git/bin/bash.exe" -c 'TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ljcut_updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx -y @tauri-apps/cli build'
if ($LASTEXITCODE -ne 0) { throw "tauri build 失敗" }
Pop-Location

Write-Host "=== [5/5] 產出 ===" -ForegroundColor Cyan
Get-ChildItem "$Root\src-tauri\target\release\bundle\nsis", "$Root\src-tauri\target\release\bundle\msi" -ErrorAction SilentlyContinue |
    Format-Table Name, @{n="MB";e={[math]::Round($_.Length/1MB,1)}} -AutoSize
Write-Host "接著執行: python scripts\make-latest-json.py <version>  然後 gh release create" -ForegroundColor Yellow
