param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$appExe = Join-Path $projectRoot 'src-tauri\target\debug\ljcut.exe'
$workspace = Join-Path $projectRoot 'app_data\control'
foreach ($required in @($appExe, (Join-Path $projectRoot 'backend\venv\Scripts\python.exe'), (Join-Path $projectRoot 'src-tauri\target\debug\ljcut-recorder.exe'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file missing: $required"
    }
}
if ($CheckOnly) {
    [pscustomobject]@{ Executable = $appExe; Workspace = $workspace; WorkingDirectory = $projectRoot }
    return
}
$env:LJCUT_CONTROL_WORKSPACE = $workspace
$env:PYTHONUTF8 = '1'
# A user-clicked shortcut opens the editor; the wrapper and backend stay hidden.
Start-Process -FilePath $appExe -WorkingDirectory $projectRoot -WindowStyle Normal
