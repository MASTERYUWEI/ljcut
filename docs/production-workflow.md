# 錄影後製作流程：現況與本階段交付

2026-09-12，沿用 `codex/local-edit-control`，保留先前捷徑、模型設定與轉錄腳本修改。

後續更新：封面已改為 Codex 六張候選、刷新與選用，YouTube 字幕綁定實際匯出；以下早期缺口以 [最新封面與上傳交付](codex-covers-youtube.md) 為準。真實 YouTube 上傳仍尚未驗證。

## 介面與控制方式

現有錄影介面為 React/Tauri，不是 WPF：

- `frontend/src/components/RecordingSettingsModal.tsx`：系統聲音、麥克風、裝置、音量表、同步校正、畫質、FPS、游標尺寸與點擊效果。
- `src-tauri/src/commands/recorder.rs`、`src-tauri/src/bin/ljcut-recorder.rs`：原生錄影控制與助手。
- `frontend/src/App.tsx`：錄影匯入、語音辨識、手動剪輯、預覽及輸出。

錄影面板繼續負責錄製本身。片頭片尾設在「專案與本機控制 → 錄影後製作」，可儲存固定素材與是否選用，但不在錄影結束或辨識完成時自動修改時間軸。
使用者也可以直接告訴 Codex 要不要加入；Codex 使用相同命令提出計畫再套用。
目前已有本機 CLI 和具憑證的 loopback 命令信箱，因此本階段不新增 MCP、聊天面板或 WPF 視窗。MCP 如有需要，只需包裝既有命令。

## 已完成

- 工作區 `production-settings.json` 保存 `introPath`、`outroPath`、`useIntro`、`useOutro`，設定版本檢查防止覆蓋較新的預設。
- `production_settings` / `set_production_settings`：UI 與外部命令共用的讀取／儲存設定。
- `prepare_bookends`：可使用預設或本次覆寫值，檢查影片並產生 dry-run。素材複製到快取，但時間軸、素材庫與復原歷史在確認前均不變更。
- `apply`：同一份提案確認後一次套用。素材／片段有穩定 ID，新增片段標記 `bookend: intro/outro`；重複加入相同用途會拒絕。
- 主片字幕与逐字稿保留來源時間；加入片頭只移動主片的時間軸起點。預覽、輸出 ASS/SRT 均使用成品時間映射。
- 同一工作階段整批復原、重做，另存及重開保留片頭片尾標記。
- 無音訊影片輸出時補靜音，支援以圖片做成的無聲片尾。原始素材不會改寫。
- 輸出尺寸依主影片；手動輸出與控制輸出使用相同主片選擇規則。
- 控制輸出工作回傳獨立 `srtPath`，與影片放在同一工作資料夾。
- 修正開啟專案及展開設定面板後，字幕尺寸與位置未更新的預覽問題；字幕寬度依文字自然延展並限制於畫面內。

原始圖片轉片尾、QR Code 製作不在這一批，片尾先使用使用者提供的影片。
片頭片尾已補上可固定或隨機選擇的淡入淡出轉場，見 [片頭片尾轉場](bookend-transitions.md)。背景音樂混音、批次替換及自動判斷何時刪除仍未包含。

## 已設定與需要使用者提供的內容

- 已找到 `D:\BIM\02_外部參考資料\客戶與同業提供\林境\片頭.mp4`，1920×1080、30 fps、約 15.102 秒、含音訊。
- 已複製到正式工作區 `app_data/control/branding/intro.mp4`，比對 SHA-256 相同，預設勾選片頭。未更動原始檔或先前的 63 秒字幕專案。
- 尚缺片尾影片（或 LINE 社群 QR Code／連結及希望停留秒數）。
- 既有 YouTube OAuth 用戶端與 refresh token 已設定。實際更新 access token、讀取頻道均回傳 HTTP 200，讀到「林境資訊」。沒有上傳或修改任何 YouTube 資料。
- 頻道是否可透過此 API 專案公開影片仍未驗證；需要首次私人測試上傳後確認。公開／排程時間仍待使用者指定。
- 逐支影片的用途、重點與 SRT 是摘要、標題及封面的輸入，仍需指定要製作哪支影片。

## 後續缺口（尚未完成，不代表已可自動發布）

1. `YouTubeUploadModal.tsx` 已有標題、說明、章節及上傳 UI；`youtube_service.py::upload_with_progress` 已有分塊影片上傳、縮圖、SRT，但還不是可持久查詢的完整製作工作。
2. 目前 YouTube 程式依初始公開設定上傳，再補縮圖和字幕；補件失敗僅列 warning。需要改為私人上傳、檢查各項完成、再公開／排程，並加入工作重試、取消、避免重複上傳。
3. 現有 `/api/yt/upload` 使用固定 `yt_upload.srt`，多工作同時執行可能互相覆蓋；後續應使用本次新增的各輸出工作 SRT。
4. `thumb_service.py::generate_candidates` 目前依賴 Gemini API、最多 8 張，候選檔名會重用。尚缺至少 10 種排版、指定母版延伸 10 種、候選歷史、鎖定與最終上傳一致性。
5. Codex 可依影片內容產出摘要／標題並使用可用的圖片工具；現有 Gemini 按鈕不會因為 Codex 訂閱自動換成 GPT。沒有啟用新增付費 AI API 或聲稱現有訂閱抵扣 API 費用。

## 本機操作

本階段修改：`frontend/src/editCore.ts`、`editSession.ts`、`controlClient.ts`、`types.ts`、`App.tsx`、`index.css`、`components/ProjectControl.tsx`；新增 `components/BookendControls.tsx`。
後端修改 `backend/services/control.py`、`ffmpeg_service.py`；命令修改 `scripts/ljcut.py`，新增 `scripts/verify_bookends.py`，並擴充前後端既有測試。
前端及 Rust 建置均成功，桌面捷徑所指向的 `src-tauri/target/debug/ljcut.exe` 已更新；測試用背景服務已停止。

下次由桌面新版捷徑啟動，展開「專案與本機控制」，即可查看已設定的片頭。
片頭與片尾各有「選擇影片…」按鈕，可從任意資料夾選取影片，不必輸入工作區相對路徑或自行搬檔。
選取後顯示檔名並勾選加入；按「儲存預設」保留選擇。取消選檔不會清除原設定。
程式透過既有 WebView 檔案選擇器取得使用者選定的檔案，再自動複製到獨立素材資料夾，同名檔案不互相覆蓋，原檔不變。
本次選檔功能修改 `BookendControls.tsx`、`controlClient.ts`、`backend/services/control.py`，新增 `/api/control/bookend-file`，沿用既有依賴與本機憑證。
5 項前端及 5 項後端測試通過；隱藏瀏覽器已驗證工作區外選檔、取消、儲存讀回與原檔完整性，報告在 `app_data/file-picker-validation/report.json`。
原生 Windows 視窗的實際點選尚未驗證，本次未彈出視窗或操作使用者的專案。
辨識／校稿完成後：選擇片頭、片尾 →「檢查加入結果」→「確認加入」→ 預覽；「復原」會撤銷整批加入。
外部操作不必開啟設定面板，編輯器仍需保持執行。

```powershell
backend/venv/Scripts/python.exe scripts/ljcut.py --workspace app_data/control production_settings
backend/venv/Scripts/python.exe scripts/ljcut.py --workspace app_data/control state
backend/venv/Scripts/python.exe scripts/ljcut.py --workspace app_data/control prepare_bookends --params plan.json
```

`plan.json` 使用最新 state 回傳的 sessionId、projectId、revision：

```json
{
  "sessionId": "從 state 取得",
  "projectId": "從 state 取得",
  "expectedRevision": 1,
  "useIntro": true,
  "useOutro": false
}
```

確認後使用既有 `apply` 命令，傳入 dryRunId、同一版本與 `confirmed: true`。外部 `export` 完成後讀取 `outputPath` 和 `srtPath`。

## 驗證

- `cd frontend; npm test`：5 項通過，包含來源字幕、速度映射、版本過期、重複加入、整批撤銷重做。
- `backend/venv/Scripts/python.exe -m unittest discover -s backend/tests -p test_control.py`：4 項通過，包含工作區限制、設定衝突、無聲影片、存檔重開、FFmpeg 輸出與取消。
- `scripts/verify_bookends.py --workspace app_data/bookends-validation`：透過外部信箱在隱藏的真實 React 編輯器跑完整流程；1 秒片頭＋8 秒主片＋2 秒片尾＝11 秒，SRT 從來源 4.5–5.5 秒移到 5.5–6.5 秒，原檔雜湊不變。
- 輸出抽查：首尾靜音，兩處主片音訊比對相關係數 >0.99999、測得位移 0 ms；成品長度 11.000 秒，640×360。
- 隱藏瀏覽器實測介面「檢查加入結果／確認加入」；重開後字幕位置、面板展開／收合位置均通過，無 JavaScript 錯誤。
- 報告與截圖：`app_data/bookends-validation/verification.json`、`media-checks.json`、`preview-layout.json`、`editor-fixed.png`。
- 新版原生桌面視窗、實際錄影／重新語音辨識、真實片頭與完整 63 秒主片合成、QR Code 可掃描性、YouTube 上傳與發布：本次尚未驗證。

本次沒有新增依賴、模型訂閱或 API 付費服務。測試使用現有 FFmpeg、Python、Node 與既有隱藏瀏覽器。
