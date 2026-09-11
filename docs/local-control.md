# LJ Cut 第一階段：本機剪輯命令

本次從 `master` 的 `f594dc6` 開始唯讀盤點，確認工作目錄乾淨後建立 `codex/local-edit-control`。沒有替換影音引擎、重寫剪輯器、呼叫付費模型服務或新增套件。先將精確執行剪輯的能力接到現有狀態；內容判斷由外部 Codex 提案，使用者確認後再套用。

## 原始碼盤點（改造前）

以下路徑均相對於 `D:\BIM\07_開發\LJCUT`，依實際函式追蹤，不以按鈕或 README 的敘述判定完成。

| 能力 | 原始實作與現況 |
|---|---|
| UI／語言 | `frontend/package.json`：React 19、TypeScript 5.8、Zustand 5、Vite；`frontend/src/main.tsx` 掛載 `App`。 |
| 桌面外殼 | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs::run`：Rust、Tauri 2；錄影用 `commands/recorder.rs` 及 `bin/ljcut-recorder.rs` 的 DXGI／Media Foundation。 |
| Python 後端 | `backend/main.py::app`：FastAPI；`src-tauri/src/commands/sidecar.rs::start_sidecar` 啟動本機隨機 port、Job Object 管理生命週期。瀏覽器開發代理實際指向 8000，並非 README 的 5000。 |
| 狀態 | `frontend/src/types.ts::MediaItem/TimelineClip/Segment`；`store.ts::useStore`。素材 `id`、片段 UUID 已存在。片段含內嵌音訊與 `segments`，**沒有獨立可剪輯的音訊軌或真正的多軌混合模型**。UI 的字幕軌是片段字幕的另一種呈現。 |
| 時間 | `startTime/duration` 是時間軸秒數；`trimStart/trimEnd` 與字幕 `start/end` 是素材秒數；`duration = (trimEnd-trimStart)/speed`。軌道僅用 `trackIndex:0`，沒有既有 Track 類別。 |
| 匯入 | `App.tsx::handleUpload/handleDropToTimeline` → `api.ts::upload` → `main.py::upload_video`。上傳複製至 `uploads/{file_id}.{ext}`；拖入时间軸才建立片段。錄影完成事件也加入相同媒體庫。 |
| 移動／裁切／刪除 | `App.tsx::handleClipDragStart/resolveOverlaps/handleClipTrim/handleClipDelete` → Zustand actions；包含滑鼠座標換算，操作協調仍綁在 UI。 |
| 分割 | `App.tsx::handleSplitClip` 原本直接呼叫 `updateClip`＋`addClip`，字幕分配也在元件內。 |
| 預覽 | `App.tsx::findClipAtTime/loadClipIntoVideo/goToClip/seekTo`，雙 `<video>`、wall-clock 與媒體時間校正、字幕 overlay。並非 FFmpeg 即時播放引擎。 |
| 字幕 | `setClipSegments/updateClipSegment` 是主儲存位置；全域 `segments` 僅鏡映選中片段。`buildTimelineSegments/handleExportSrt`、`backend/services/subtitle.py::SubtitleService` 做時間轉換與 ASS/SRT。 |
| 語音辨識 | `App.tsx::handleTranscribe` → `api.ts::transcribe` → `main.py::transcribe` → `FFmpegService.extract_audio` → `TranscribeService.transcribe/_transcribe_impl`。既有 Breeze faster-whisper，CUDA 失敗可退 CPU，SSE 回報進度。 |
| 辨識格式 | `{language, language_probability, duration, segments:[{id,start,end,text,words:[{word,start,end,probability}]}]}`，段落及詞時間 `round(...,3)`，相對來源素材。16 kHz mono 抽音保留時間空隙、補 1 秒尾端；毫秒是輸出精度，**不是辨識準確度保證**。原本辨識结果只寫到選中 clip，沒有獨立保留原始逐字稿。 |
| 輸出 | `App.tsx::handleExportVideo` → `api.ts::exportVideo/exportTimeline` → `main.py::export_video_with_progress/export_timeline` → `FFmpegService`。SSE 進度已存在，但没有可查詢／取消的持久工作 ID。多段使用重編碼、concat、燒字幕。 |
| 撤銷 | `App.tsx` 原有 `useRef` 堆疊，最多 50 批；沒有 redo，沒有外部控制入口。 |
| 專案格式 | 搜尋 `frontend/src`、`backend/main.py`、`src-tauri/src` 後未發現剪輯專案存檔／開啟格式。既有存檔指的是影片或 SRT，`localStorage` 存設定，沒有持久剪輯專案。 |
| AI／自動化入口 | FastAPI 的媒體／字幕 API、Tauri 錄影 IPC 已存在。`AiPanel.tsx`／`llm_service.py` 是 Gemini 文案與字幕建議；不是時間軸命令 API。沒有 CLI 或 MCP 編輯目前專案。 |

盤點時執行 `cd frontend; npm run build` 通過；原專案沒有自動測試指令。既有實作中錄影、所有拖曳組合、完整 ASR 推論與發布包，在這次盤點階段都沒有經實測，不列為已驗證穩定功能。

## 最小改造與實際檔案

```
手動 App／專案操作區 ─┐
                      ├→ editCore／editSession → 同一份 useStore
外部 CLI → FastAPI mailbox → 前端事件迴圈 ─┘       ↓
                                             原本預覽／字幕／輸出
```

- `frontend/src/editCore.ts`：純函式時間映射、字幕邊界裁切、共用分割、計畫驗證、ripple delete、新增字幕。
- `frontend/src/editSession.ts`：project ID、session ID、單調 revision、dry-run 收據、一次套用快照、共用 undo/redo。播放與選取不增加 revision；素材、字幕樣式與片段修改會增加。匯入／辨識中拒絕外部破壞狀態的操作。
- `frontend/src/controlClient.ts`：既有 HTTP 連線傳遞命令，**由前端主執行緒呼叫狀態更新**。後端沒有另一份可编辑時間軸。`preview` 會核對實際播放器來源時間、解碼就緒與 overlay 文字，未就緒回報錯誤。
- `backend/services/control.py`：新增 `/api/control/*` router，命令 mailbox、工作區限制、素材複製、專案另存／重開、輸出工作與取消；`main.py` 僅掛載入口。
- `frontend/src/components/ProjectControl.tsx`：小型可收合的專案／計畫檢查區；不含聊天、模型登入或新 AI API。
- `scripts/ljcut.py`：Python 標準函式庫 CLI；`scripts/start-control.ps1` 啟動指定工作區。
- `App.tsx/store.ts/types.ts/main.tsx`：接入共用歷史與命令、保留原始辨識結果在 `MediaItem.transcript`、修正選中片段字幕鏡映。`App` 的拖曳、錄影與辨識原流程保留。
- `subtitle.py/ffmpeg_service.py`：字幕限定在各自片段範圍；中間影片使用 PCM 音訊，避免每個片段加入 AAC 編碼延遲，最後才轉 AAC；修正倍速片段長度、獨立暫存目錄與取消程序樹。Windows 背景處理不開命令視窗。

選擇現有 FastAPI＋小型 CLI 是因為既有程序管理、素材路徑與匯出已在這裡，不需引入另一個 daemon、MCP 框架或第二個專案模型。手動分割與計畫裁切重用純函式；手動拖曳／調速仍用既有 Zustand actions，不在這個階段全面抽離 App。

同時修正實測／追碼發現的問題：裁切外字幕外溢、字幕拖曳漏加 `trimStart`、不同片段的字幕數字 ID 撞號、選中無字幕片段導致後續片段字幕圖層不存在、單段與多段輸出走不同時間處理流程。手動時間軸仍可保留空隙，但第一階段計畫和輸出會明確拒絕空隙／重疊；原本輸出是忽略空隙直接串接，不能稱為一致預覽。

## 開始使用

請在不需要保持目前未儲存剪輯的測試工作階段操作。本次提供的是分支原始碼，沒有更新已安裝的發行版或推送遠端。

從專案根目錄執行：

```powershell
.\scripts\start-control.ps1 -Workspace app_data/control
```

這會走原本的桌面開發啟動流程。前端就緒後在畫面上看到「專案與本機控制 · 已啟用」，工作區產生 `.ljcut-control.json`。該檔含本機工作階段憑證，不要分享或提交。未設定 `LJCUT_CONTROL_WORKSPACE` 時控制介面不啟用，既有手動入口仍可使用。

另開終端讀取現況：

```powershell
.\backend\venv\Scripts\python.exe scripts/ljcut.py --workspace app_data/control state
```

`result` 中讀取 `sessionId`、`projectId`、`revision`、素材 ID、片段 ID、來源 FPS／`frame_rate`／`time_base`、字幕與原始逐字稿。沒有辨識結果時 `transcripts[].result` 為 `null`；不會自動啟動模型或付費服務。舊工作階段的 session ID 一律拒絕。

### 指定工作區與專案

CLI 的 `import`、`save`、`open` 參數都使用工作區相對路徑，拒絕絕對路徑、`..` 越界和符號連結越界。`import` 會複製素材並在時間軸末尾建立完整片段。它不支援任意 shell、遠端 URL 或外部命令執行。

```json
{
  "sessionId": "從 state 取得",
  "projectId": "從 state 取得",
  "expectedRevision": 0,
  "path": "fixture.mp4"
}
```

將參數存成 UTF-8 `import.json` 後：

```powershell
.\backend\venv\Scripts\python.exe scripts/ljcut.py --workspace app_data/control import --params import.json
```

`save` 與 `open` 使用相同版本欄位，`path` 改為例如 `教學剪輯.ljcut`。這是包含 `project.json` 與 `assets/` 的資料夾，素材副本不會受既有 uploads 的 14 天清理影響。另存拒絕覆寫，請用新名稱。跨重啟保留 project ID 與片段／素材 ID，但不保留完整撤銷歷史。

### 計畫與確認

所有操作時間為**來源素材秒數**，區間為左閉右開。操作依陣列順序執行；若分割後還要操作新右段，可在 dry-run 回傳的 `keptClipIds/proposedClips` 檢查 ID。簡單批次建議先新增字幕，再裁掉指定區間，字幕会自動截斷／平移。

```json
{
  "sessionId": "從 state 取得",
  "projectId": "從 state 取得",
  "expectedRevision": 1,
  "timeUnit": "seconds",
  "operations": [
    {
      "type": "add_subtitle", "clipId": "從 state 取得",
      "trackId": "video-main", "timeDomain": "source",
      "start": 4.5, "end": 5.5, "text": "保留操作畫面"
    },
    {
      "type": "ripple_delete", "clipId": "同一片段 ID",
      "trackId": "video-main", "timeDomain": "source",
      "start": 2, "end": 4, "review": "confirmed",
      "reason": "使用者指定刪除的測試區間"
    }
  ]
}
```

```powershell
.\backend\venv\Scripts\python.exe scripts/ljcut.py --workspace app_data/control dry_run --params plan.json
```

dry-run 回傳來源／時間軸區間、前後長度、新片段 ID、受影響的音畫字幕，以及 `dryRunId`，不改動專案。`review: "needs_review"` 會拒絕，不會自動刪除沉默區間。新增字幕限單行純文字；拒絕與既有字幕重疊或 ASS 標記，避免播放器和燒錄不同。

將 dry-run 的實際變更交由使用者確認後，才提交：

```json
{
  "sessionId": "dry-run 的 sessionId",
  "projectId": "dry-run 的 projectId",
  "expectedRevision": 1,
  "dryRunId": "dry-run 的 dryRunId",
  "confirmed": true
}
```

```powershell
.\backend\venv\Scripts\python.exe scripts/ljcut.py --workspace app_data/control apply --params apply.json
```

`confirmed` 是呼叫者已取得使用者確認的明確宣告，CLI 不會替使用者做內容判斷。也可在 LJ Cut 展開專案區、貼上計畫、檢查，再按「確認套用這批變更」。計畫過期、素材消失、無效時間或不支援操作會回傳具名錯誤，失敗不留下部分時間軸。

### 預覽、歷史、輸出

- `preview`：版本欄位加 `time`，這個 `time` 是**時間軸秒數**。會定位並暫停目前 LJ Cut 播放器，回傳預期與實際來源時間和字幕文字；不是另一個影片播放器。
- `undo`／`redo`：傳最新版本欄位。一批 AI 計畫是一筆歷史；UI 的 Ctrl+Z、Ctrl+Shift+Z／Ctrl+Y 與專案區按鈕共用堆疊。手動修改會清除 redo 並使舊計畫失效。
- `export`：傳最新版本欄位，回傳工作 ID、revision、預計長度、進度與唯一輸出路徑 `exports/{job_id}/video.mp4`；背景採現有 CPU libx264，不需新編碼器或 GPU 費用。
- `job --id JOB_ID` 查詢 `queued/running/completed/failed/cancelled`、進度、錯誤；`cancel --id JOB_ID` 取消自有的編碼程序樹，不會停止其他軟體的 FFmpeg。
- CLI 意外中斷時，使用 `result --id REQUEST_ID` 查結果，或用**相同 `--request-id` 與完全相同內容**重試。已完成命令不會重複套用；不要以新 ID 盲目重送修改。超時不是「操作未發生」。
- UI 必須保持開啟。後端只傳遞命令；沒有編輯器時回 `EDITOR_OFFLINE`。同一後端只允許一個編輯器持有工作階段，不自動把未完成命令交給另一個專案。

## 可重現驗收

在**空白測試編輯器**及新的工作區中執行；驗收腳本会拒絕已有時間軸，避免碰到使用者專案：

```powershell
$env:PYTHONUTF8='1'
.\backend\venv\Scripts\python.exe scripts/control_fixture.py app_data/control/fixture.mp4
.\backend\venv\Scripts\python.exe scripts/verify_control.py --workspace app_data/control
.\backend\venv\Scripts\python.exe scripts/verify_media.py --workspace app_data/control
```

素材是 8 秒、640×360、30 fps 色塊與定時聲音標記。刪除來源 2–4 秒，保留 0–2 與 4–8 秒；字幕來源 4.5–5.5 秒應出現在時間軸 2.5–3.5 秒。輸出應為 180 幀、6 秒，聲音頻率為 440／880／1100 Hz，原始素材 SHA-256 不變。

```powershell
cd frontend
npm test
npm run build
cd ..
$env:PYTHONUTF8='1'
.\backend\venv\Scripts\python.exe -m unittest discover -s backend/tests -v
cargo build --manifest-path src-tauri/Cargo.toml --bin ljcut --offline
```

測試碼：`frontend/tests/edit.test.ts`、`backend/tests/test_control.py`。前端測試使用現有 Vite 附帶的 esbuild；後端使用標準 unittest 與已存在的 FastAPI/httpx；媒體量測使用既有 NumPy。沒有新增依賴、授權或訂閱。

## 驗證結果與界線

2026-09-11 的完整測試紀錄在 `app_data/control/verification.json`、`media-verification.json`；測試專案與影片保留在同一工作區。桌面端確實由 CLI 完成匯入、dry-run、套用、undo/redo、定位預覽、另存重開與輸出。播放器來源 5 秒對應時間軸 3 秒，overlay 回傳「保留操作畫面」。媒體量測確認 6 秒、180 幀、六個聲音標記起點無累積延遲，字幕像素僅在指定時間出現。

驗證時間點有區分：上述桌面完整流程跑通後，才補上最後的 `sessionId` 防護、Windows 背景處理與倍速回歸修正。最後一版通過 **4 項前端測試、3 項後端整合測試、前端正式建置**，並從已存專案在背景重新匯出與量測；最新輸出記錄是 `background-export-verification.json`，`media-verification.json` 的 `video` 欄位指向這支重新驗證的影片。最後一版的桌面前景操作沒有重跑，不能宣稱全部人工驗收完成。

**尚未驗證**：整段桌面播放的主觀流暢度／實際喇叭聆聽、全部手動拖曳與鍵盤操作、完整 Breeze GPU/CPU 模型推論、錄影流程與安裝包重新打包。使用者要求背景工作後，已停止前景視窗驗收，不再搶焦點。辨識前處理与保存格式有回歸檢查，但不能據此宣稱完整 ASR 已驗收。

**尚未支援**：多軌疊合／独立音訊編輯、時間軸空隙與重疊的計畫／輸出、轉場、任意移動／倍速的外部命令、跨啟動 undo 歷史、MCP 包裝、語意自動剪輯、雲端或模型帳號整合。新增字幕重疊時先回報，留給使用者整理。現有 Gemini／YouTube 等舊端點未改成本次的安全控制入口，也未作全面安全稽核。

輸出沿用既有 CFR 政策：來源最高平均 FPS 四捨五入並限制 24–60。來源 timebase 原樣提供；秒數端點可能落在影格之間，輸出精度以一影格為界，ASS 為百分秒；VFR、29.97、長片、多解析度混合尚未完整驗證。PCM 中間音訊約增加 0.69 GB／小時（48 kHz、雙聲道、16-bit）的暫存量，換取片段邊界不重複加入 AAC 編碼延遲。

建議下一步先在短篇真實教學專案中完成上述人工回歸，再增加明確需求的命令。沒有說話、等待模型或畫面比較都不構成自動刪除授權。
