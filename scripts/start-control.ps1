param([string]$Workspace = 'app_data/control', [switch]$BrowserOnly)
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path $PSScriptRoot -Parent
if (-not [IO.Path]::IsPathRooted($Workspace)) { $Workspace = Join-Path $repoDir $Workspace }
$controlDir = [IO.Path]::GetFullPath($Workspace)
New-Item -ItemType Directory -Path $controlDir -Force | Out-Null
$env:LJCUT_CONTROL_WORKSPACE = $controlDir
$env:PYTHONUTF8 = '1'
Write-Host "LJ Cut 本機控制工作區：$controlDir"
if ($BrowserOnly) {
    Write-Host '瀏覽器模式：此視窗啟動後端；另一視窗在 frontend 執行 npm run dev，再開 http://localhost:5173'
    Push-Location (Join-Path $repoDir 'backend')
    try { & './venv/Scripts/python.exe' -m uvicorn main:app --host 127.0.0.1 --port 8000 }
    finally { Pop-Location }
} else {
    Push-Location $repoDir
    try { & './啟動桌面版.bat' }
    finally { Pop-Location }
}
