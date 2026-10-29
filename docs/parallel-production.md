# 同一個 Codex 請求完成剪輯與六張封面

使用者在 LJ Cut 專案說「錄好了，幫我剪輯」即可啟動整體製作。這是對話中 agent 的固定工作流程，不需另外按產生封面；原 UI 按鈕仍供額外刷新使用。未加入付費 API、登入或代理框架。

目前預設為單一 agent，取代先前字幕／文案子 agent 的固定分工；只有使用者針對當次工作明確要求時才派工。保留匯出與內建生圖的工具並行，並沿用既有收尾助手。這是製作規則變更，無須重建或重啟 LJ Cut。

自動匯出預設為乾淨影片，不燒入字幕；LJ Cut 專案仍保留校對字幕，獨立 SRT 綁定成品時間並供 YouTube 原生 CC 使用。`export` 可明確傳 `burnSubtitles: true` 才燒入；省略或 false 均不燒入。手動匯出的既有「燒入字幕」選項保留。已匯出／已上傳的影片不會因改預設而變更。

乾淨匯出變更已驗證：`test_control.py` 7 項及 `test_publication.py` 6 項通過，包含實際 FFmpeg 輸出黑底測試片，有字幕時亮字可見、預設無燒錄時畫面維持純黑，兩者的 SRT 與成品時間一致、原始素材及專案字幕未變。前端與桌面建置成功。修改範圍為 `backend/services/control.py`、`backend/services/ffmpeg_service.py`、`frontend/src/controlClient.ts`、`backend/tests/test_control.py` 及專案流程文件。既有執行中的後端仍須隨 LJ Cut 正常關閉後重開，才載入此預設；沒有代替使用者重啟或更動線上影片。

## 工作順序

| 階段 | 同一個 agent 負責的工作 |
| --- | --- |
| 既有辨識完成 | 看片與剪輯分析、校稿／分句及不確定項、摘要與文案草稿 |
| 提案確認 | dry-run、確認刪除、套用，依保留內容修訂文案 |
| 最終版本固定 | 啟動匯出、預覽與保存；同時呼叫內建生圖工具 |
| 收尾 | 對照成品字幕、綁定候選並檢查六張可讀 |

主 agent 是唯一的時間軸寫入者。前期草稿包含素材／片段／字幕 ID 及來源時間；最終文案的 evidenceStart、章節與 SRT 使用成品秒數。片頭、裁切與速度共同影響時間，片尾不增加正片字幕偏移。

六張圖片可用六個獨立內建工具呼叫，由同一個 agent 處理。可縮短匯出和生圖先後等待，但不能預告固定倍數；ASR、編碼與雲端生成仍各有瓶頸，不因片長或工作量自行派工。

## 收尾助手

`scripts/production_handoff.py` 僅用 Python 標準函式庫及既有 `ljcut.Client`。不啟動模型、不改時間軸、不選用圖片、不上傳影片。

套用確認版本後，由主 agent 執行：

```powershell
python scripts/production_handoff.py --workspace app_data/control --run production/本次影片 start
```

保存 `production/本次影片/handoff.json`，記錄 session、project、revision、片段、素材 ID、成品主片字幕及摘要校驗值，並開始匯出。該快照可供文案最後複核與圖片提示詞使用；不要把尚未確認的剪輯直接交給此命令匯出。

在匯出進行中，由 Codex 使用內建圖片工具生成六張，按 imagegen 技能複製到該工作區，另存符合 `publication.validate_analysis` 的文案 JSON。兩者備妥後：

```powershell
python scripts/production_handoff.py --workspace app_data/control --run production/本次影片 finish --analysis production/本次影片/analysis.json --images production/本次影片/1.png production/本次影片/2.png production/本次影片/3.png production/本次影片/4.png production/本次影片/5.png production/本次影片/6.png
```

尚在匯出會回傳 `waiting_export` 和進度，不先建立空批次。完成後以該 job 的 publication 綁定六張圖片，拒絕專案／版本／長度／字幕不一致。輸出助手保留同一組 request ID、job ID 及 batch ID，短暫中斷可用同一命令重試；若改文案或圖片，會拒絕重用同一份匯入請求。改版應建立新的工作資料夾。

`start` 重試會重用已有工作；不代表重新輸出目前版本。LJ Cut 後端重啟會遺失既有信箱與 job；此助手不提供跨後端重啟的工作續跑，應核對已保存成品後開新工作，不能盲目重送舊 request ID。匯出完成後手動修改時間軸不會改寫舊成品；封面仍只綁定快照所屬的舊成品，不會自動套到新版。

文案語意與中文字品質仍由 agent 複核；校驗值只能保證字幕版本相同，不能代替內容理解。封面由使用者選用；發布仍需明確要求。

## 驗收與限制

- 後端測試 `test_production_handoff.py`：來源裁切／倍速換算與現有映射一致、匯出與匯入重試不建立重複工作、字幕與版本不合拒絕、失敗匯出不建封面批次、工作區路徑限制。
- 前端驗證：空面板取得外部新批次、外部刷新取得下一批且保留選圖、舊匯出不搶回目前成果。具體結果見本次交付。
- 本次修改不重剪上一支影片、不重生已滿意的六張圖。下支影片才能量測新流程端到端耗時；目前沒有加速倍率實測。
- 面板按鈕獨立自動叫醒 Codex、直接訂閱背景生圖、真實 YouTube 上傳／發布不在這次實作內。

## 本次結果（2026-09-13）

後端完整 16 項測試、前端核心 6 項測試、`frontend/tests/parallel-cover-ui.mjs` 隱藏 Chromium 元件／匯出競態檢查均通過。前端正式建置與 `cargo build --bin ljcut --features custom-protocol` 成功。以先前 166.143662 秒、39 段字幕的真實成品做唯讀校驗，助手接受正確版本，未額外匯出或生成圖片。

桌面捷徑沿用 `scripts/launch-current.ps1`，仍指向 `src-tauri/target/debug/ljcut.exe`，該檔已更新；原執行檔保留為 `ljcut-before-parallel-20260913.exe`。沒有終止使用中的 LJ Cut，也沒有彈出視窗。正在執行的程式仍用舊面板，下次由桌面捷徑開啟才載入新版；新版原生視窗尚未實際開啟驗證。

新增收尾助手和專案規則可立即在現有本機控制介面使用；完整並行製作與加速幅度仍待下一支錄影實測。

重現測試（從專案根目錄）：

```powershell
backend/venv/Scripts/python.exe -m unittest discover -s backend/tests -v
npm.cmd test --prefix frontend
npm.cmd run build --prefix frontend
```

隔離面板測試從 `frontend` 目錄執行，使用本機既有 Playwright：

```powershell
$env:NODE_PATH='C:\Users\YUWEI\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:LJCUT_TEST_CHROMIUM='C:\Users\YUWEI\AppData\Local\ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe'
node tests/parallel-cover-ui.mjs
```
