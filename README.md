# LJCUT — 螢幕錄影 + AI 字幕剪輯工具

Tauri 桌面應用（Rust + React），用於**螢幕錄影**、**中文字幕辨識**（faster-whisper）、**非破壞性影片剪輯**與**字幕燒製**。

## 🎯 功能概覽

- **螢幕錄影**：DXGI Desktop Duplication（無 Win10 黃色邊框），支援多螢幕、區域選擇、系統聲音 + 麥克風
- **字幕辨識**：Faster-whisper（台灣繁體中文 MR Breeze 模型，CUDA float16）
- **非破壞性剪輯**：拖拉時間軸、多段片段、逐段調倍速（1–5x）
- **字幕編輯**：所見即所得預覽、匯出 .srt/.ass
- **影片匯出**：FFmpeg 燒字幕、多片段 concat、自選輸出資料夾
- **滑鼠視覺特效**（可選）：光暈、點擊漣漪、放大、自訂顏色
- **AI 文案助手**：與 Gemini API 整合（摘要、行銷文案、YouTube 標題）

## 📋 開發環境需求

### 硬體
- **CPU**：4 核心以上
- **GPU**：Nvidia（推薦 RTX 3090+，需 CUDA compute capability ≥7.0）
- **RAM**：16GB+
- **磁碟**：30GB+（含 Python 虛環境、錄影工作檔）

### 軟體
- **Windows 10/11**（版本 19045+；DXGI 要求）
- **Git**
- **Node.js** 18+（React 開發）
- **Python** 3.10+（FastAPI 後端）
- **Rust** 1.77.2+（Tauri）
- **FFmpeg**（含 libmp3lame, libopus；用於音訊混流、影片匯出）

## 📦 依賴安裝

### 1. Node.js 依賴（前端）
```bash
cd frontend
npm install
```

### 2. Python 虛環境（後端）
```bash
cd backend
python -m venv venv
.\venv\Scripts\activate  # Windows

# 安裝依賴
pip install -r requirements.txt

# GPU 加速（可選，Nvidia 卡專用）
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install faster-whisper pycuda
pip install "google-cloud-generativeai>=0.4.0"
```

### 3. Rust 依賴（Tauri）
```bash
# 已在 Cargo.toml，cargo 自動管理
```

### 4. FFmpeg
下載 ffmpeg-full 版本（含 libmp3lame、libopus）放到 PATH，或到 `backend/bin/` 放 `ffmpeg.exe`。

## 🏗️ 目錄結構

```
LJCUT/
├── frontend/                      # React UI (TypeScript)
│   ├── src/
│   │   ├── App.tsx               # 主應用（播放 + 時間軸 + 設定）
│   │   ├── index.css             # 全局樣式
│   │   ├── types.ts              # 型別定義
│   │   ├── utils.ts              # 工具函式
│   │   └── components/           # UI 元件
│   │       ├── RecordingSettingsModal.tsx    # 錄影設定（含滑鼠特效、顏色）
│   │       ├── SettingsModal.tsx
│   │       ├── SpeedMenu.tsx
│   │       ├── ExportProgress.tsx
│   │       ├── AiPanel.tsx
│   │       └── ...
│   └── package.json
│
├── backend/                       # Python FastAPI 後端（sidecar）
│   ├── main.py                   # FastAPI app 進入點
│   ├── requirements.txt
│   ├── services/
│   │   ├── ffmpeg_service.py     # 影片編碼、字幕燒製
│   │   ├── subtitle.py           # ASS/SRT 生成
│   │   ├── transcribe.py         # Faster-whisper 辨識
│   │   └── ai.py                 # Gemini API 文案
│   └── uploads/, outputs/        # 工作檔目錄（.gitignore）
│
├── src-tauri/                     # Tauri (Rust)
│   ├── Cargo.toml                # Rust 依賴 + 特性
│   ├── src/
│   │   ├── lib.rs                # Tauri 初始化、命令綁定
│   │   ├── commands/
│   │   │   ├── recorder.rs       # 螢幕錄影命令、cleanup、sidecar 生命週期
│   │   │   └── sidecar.rs        # Sidecar 啟動、Job Object watchdog
│   │   └── bin/
│   │       └── ljcut-recorder.rs # 獨立 DXGI 錄影程式（遞迴執行參數）
│   └── tauri.conf.json
│
├── .gitignore
├── README.md                      # 本檔
├── SETUP.md                       # 詳細建置流程（可選）
└── .bat 啟動檔（若有）
```

## 🚀 建置步驟

### 1. 前端
```bash
cd frontend
npm install
npm run build   # 或 npm run dev（開發模式）
```

### 2. 後端
```bash
cd backend
.\venv\Scripts\activate
# requirements.txt 已安裝

# 測試 FastAPI
uvicorn main:app --reload --host 127.0.0.1 --port 5000
```

### 3. Tauri 應用
```bash
cd src-tauri
cargo build --release   # 發佈版（優化）
# 或
cargo tauri build       # 使用 tauri CLI（需 npm i -g @tauri-apps/cli）
```

### 開發模式（邊改邊跑）
```bash
cd 根目錄
# 執行 .bat 啟動檔，或：
npm install && npm run dev   # 前端 hot-reload
# 另開終端：
cd backend && uvicorn main:app --reload
# 另開終端：
cd src-tauri && cargo tauri dev
```

## 🎮 執行

### 開發版
```bash
cd src-tauri
cargo tauri dev
```
前端自動在 `localhost:5173` 起，Tauri 窗口開啟前端。

### 發佈版
```bash
cd src-tauri
cargo tauri build --release
# 輸出到 src-tauri/target/release/bundle/
```

## 🏛️ 架構概述

### 錄影流程
1. **DXGI 擷取** （`ljcut-recorder.exe`）
   - 每幀讀 DXGI Desktop Duplication
   - 合成游標（color/masked/monochrome 格式）
   - 可選：光暈、點擊漣漪、放大、隱藏
   - Windows Media Foundation H.264 硬編（BGRA bottom-to-top）

2. **音訊併軌** （`backend/ffmpeg_service.py`）
   - ffmpeg dshow 並行錄系統聲音 + 麥克風
   - 停止錄影時 mux 合流→ `backend/uploads/{id}.mp4`

### 播放流程
1. **雙緩衝無縫**（`frontend/App.tsx`）
   - 兩個 `<video>` 疊放（活躍 + 待命）
   - 活躍播目前段；待命預載下一段（`seek` 到 `trimStart`）
   - 邊界瞬間交換（無黑閃、無頓、無掉幀）
   - 時間軸位置用牆鐘推算，就緒後用 `v.currentTime` 校正

2. **倍速處理**
   - 每段獨立 `playbackRate`（1–5x），含 `preservesPitch`
   - 先 1x 起播待管線就緒再套速度（避免靜音）

### 字幕辨識 → 燒製
1. **Faster-whisper**（backend `transcribe.py`）
   - CUDA float16、台灣繁中 MR Breeze 模型
   - 回傳分段時間碼（相對於媒體）

2. **ASS 生成**（backend `subtitle.py`）
   - 播放預覽：CSS `WebkitTextStroke` 置中描邊
   - 匯出 ASS：Outline 單位換算（÷2 對齊預覽）、MarginV（螢幕座標）、PlayResX/Y（影片尺寸）

3. **FFmpeg 燒製**（backend `ffmpeg_service.py`）
   - 單片段：`ffmpeg -i input.mp4 -vf subtitles=xxx.ass output.mp4`
   - 多片段：各段 `setpts/atempo` 速度調整 → concat demuxer 串接 → 最後燒字幕

### Sidecar 生命週期
- **Rust** (Tauri app 啟動)
  - 啟動 Python `uvicorn main:app` sidecar（stdin/stdout 管道）
  - 綁進 **Windows Job Object** (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
  - Tauri app 持有 job handle
  - **App 一消失（正常關/當機/強制 kill）→ OS 自動終止 sidecar**（零孤兒）

- **Python** (sidecar 內部)
  - 父進程看門狗（輪詢父 PID，備援）
  - 若 LJCUT 未響應→自行 `os._exit(0)`

### 自動清理
- **背景執行**（app 啟動）
- 清除 `app_data/outputs/`, `backend/uploads/`, `backend/outputs/` 內超過 14 天的檔
- 成品存使用者自選資料夾，不受影響

## ⚙️ 配置

### `.env` (後端敏感資訊)
```bash
GEMINI_API_KEY=your_api_key_here
LJCUT_DEBUG=0   # 1=詳細日誌
```
放在 `backend/.env`（**勿推 GitHub**）

### 錄影設定（UI）
- **系統聲音**：開關 + 音量
- **麥克風**：裝置選擇 + 音量 + 電平表
- **品質**：720p / 1080p / 4K
- **FPS**：24 / 30 / 60
- **滑鼠**：
  - 光暈（開關 + 顏色picker）
  - 點擊特效（開關 + 顏色picker）
  - 游標大小：1x / 1.5x / 2x
  - 隱藏游標

## 🐛 已知限制

- **Windows 專用**（DXGI）
- **Nvidia GPU 推薦**（CUDA 字幕辨識；無 GPU 亦可，但巨慢）
- **旋轉螢幕**：目前不支援（直式 90/270°；偵測到直接報錯）
- **DRM 內容**：DXGI 會黑畫面（Netflix、某些串流平台）
- **隻眼視窗跟隨**：DXGI 只能整螢幕擷取再裁切（但跟隨視窗功能靠 Win32 API 實現，相容）

## 📝 快速開發指南

### 新增 Tauri 命令
1. 編輯 `src-tauri/src/commands/*.rs`，實作函式
2. 在 `src-tauri/src/lib.rs` 用 `#[tauri::command]` 綁定 + `.invoke_handler(tauri::generate_handler![...])`
3. 前端呼叫：`await invoke('command_name', { arg1, arg2 })`

### 新增 Python 端點
1. 編輯 `backend/main.py`，加 `@app.post("/endpoint")` 或 `@app.get(...)`
2. Tauri 端用 `fetch('http://127.0.0.1:5000/endpoint')` 呼叫

### 修改錄影參數
- 遞迴參數在 `src-tauri/src/commands/recorder.rs` 中 `begin_recording()` 的 `StdCommand::new(&recorder_exe).args([...])`
- `ljcut-recorder.exe` 參數：`<left> <top> <w> <h> <fps> <out.mp4> <monitor> [光暈0/1] [點擊0/1] [光暈色#RRGGBB] [點擊色#RRGGBB] [游標倍率] [隱藏游標0/1] [自動停止秒數]`

## 📚 進一步閱讀

- `src-tauri/src/bin/ljcut-recorder.rs`：DXGI + 游標合成 + 特效邏輯
- `frontend/src/App.tsx`：播放核心、時間軸、字幕管理
- `backend/services/*.py`：字幕、FFmpeg、AI 邏輯
- Tauri 文檔：https://tauri.app
- Faster-whisper 文檔：https://github.com/SYSTRAN/faster-whisper

## 📄 授權

MIT License

---

**更新日期**：2026-06-15  
**Tauri 版本**：2.10.0  
**React 版本**：18+  
**Rust 版本**：1.77.2+
