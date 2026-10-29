# LJ Cut MCP：讓 Claude / Codex 直接操作剪輯器

`scripts/ljcut_mcp.py` 把 LJ Cut 本機控制（`/api/control/*`）包成 MCP 工具（stdio、只用 Python 標準庫）。
AI 可以「看」影片（拼圖截圖、靜音、場景、音量）、試算剪輯、經使用者確認後套用、檢查接縫、匯出。
仍遵守既有規則：工作區相對路徑、dry-run → 使用者確認 → apply、共用 undo/redo、預設乾淨影片＋SRT。

## 啟用

1. 用本機控制模式開 LJ Cut：`scripts/start-control.ps1`（桌面版）或 `start-control.ps1 -BrowserOnly` ＋ `npm run dev`。
   工作區預設 `app_data/control`，素材要放在工作區內才能匯入。
2. 連接 MCP：
   - **Claude Code**：專案根目錄已有 `.mcp.json`，在此資料夾開 Claude Code 會詢問是否啟用 `ljcut`。
   - **Claude Desktop**：在 `claude_desktop_config.json` 的 `mcpServers` 加入（路徑用絕對路徑）：
     ```json
     "ljcut": {
       "command": "D:\\BIM\\07_開發\\LJCUT\\backend\\venv\\Scripts\\python.exe",
       "args": ["D:\\BIM\\07_開發\\LJCUT\\scripts\\ljcut_mcp.py", "--workspace", "D:\\BIM\\07_開發\\LJCUT\\app_data\\control"],
       "env": { "PYTHONIOENCODING": "utf-8" }
     }
     ```
   - **Codex**：`~/.codex/config.toml` 加 `[mcp_servers.ljcut]`，command / args 同上。

MCP 每次呼叫都重新讀取工作區的 `.ljcut-control.json`（含 session token，**不要分享或提交**），
LJ Cut 重開後不必重啟 MCP。

## 工具

| 工具 | 用途 |
|---|---|
| `ljcut_status` | 素材、片段（clipId、tl/src 範圍、倍速）、辨識狀態、undo/redo |
| `ljcut_transcript` | 時間軸逐字稿：每行含成品時間 tl、clip、seg、來源時間 src |
| `ljcut_overview` | 整支素材平均取樣 N 格的縮圖拼圖（回傳圖片） |
| `ljcut_frames` | 指定時間點各抓一格拼圖；`domain` 可選 timeline／source |
| `ljcut_silences` / `ljcut_scenes` / `ljcut_audio_levels` | 靜音區間、畫面變化點、每 N 秒音量（來源秒數） |
| `ljcut_transcribe` | 語音辨識並寫入該素材所有片段；`fast=true` 用批次推論（約 4 倍速，專有名詞略不準） |
| `ljcut_plan` | dry-run 一批操作，回傳 changes 與 dryRunId，不改專案 |
| `ljcut_apply` | 套用 dryRunId；`userConfirmed` 必須是使用者明確同意後才填 true |
| `ljcut_check_cuts` | 每個接縫前後 0.4 秒各取一格，檢查接得順不順 |
| `ljcut_undo` / `ljcut_redo` | 與 UI 共用 Ctrl+Z 堆疊 |
| `ljcut_preview` / `ljcut_import` / `ljcut_save` / `ljcut_open` | 跳到某秒、匯入工作區檔案、另存／開啟 `.ljcut` |
| `ljcut_export` / `ljcut_job` | 匯出（`wait=true` 等到完成）／查詢工作 |

### 剪輯操作（`ljcut_plan.operations`，時間皆為來源秒數）

`ripple_delete {start,end}`、`set_speed {start,end,speed 1–5}`、`split {at}`、`add_subtitle {start,end,text}`
可省略 `clipId`：編輯器依來源時間找唯一包含它的片段，同一批前面的操作切開過也能定位（多素材可加 `mediaId`）。
`move_clip {clipId,toIndex}`、`delete_clip {clipId}`、`edit_subtitle {clipId,segmentId,text}`、`delete_subtitle {clipId,segmentId}` 需 `clipId`。
片頭片尾位置固定（`BOOKEND_LOCKED`）。螢幕教學中的安靜段常是操作過程，優先考慮 `set_speed` 而非刪除。

## 畫面縮放（zoom in／平移）

- **資料**：縮放區段存在素材上（`MediaItem.zooms`，來源秒數）：`{id, start, end, x, y, scale, ease?}`，
  x/y 為放大中心（畫面比例 0–1）、倍率 1.1–4、進出場緩動預設 0.4 秒；同一素材不可重疊。
  剪掉或加速片段時縮放跟著內容走，存檔／復原／版本號沿用既有機制。
- **剪輯指令**：`add_zoom`（省略 mediaId 時依 start 所在片段決定素材）、`edit_zoom`、`delete_zoom`，走同一條 dry-run → 確認 → apply。
- **預覽**：常駐迴圈依每個 `<video>` 的素材與 currentTime 套 CSS transform，並以 clip-path 只顯示原畫面範圍。
- **匯出**：`backend/services/zoom.py` 產生 `scale(eval=frame)` → `crop` 濾鏡，從原檔解析度放大（小字清楚），
  以 `-filter_script:v` 讀入，區段再多也不受命令列長度限制。公式與 `frontend/src/zoom.ts` 相同；數值在後端重新驗證。
- **游標軌跡**：LJ Cut 錄影會在影片旁寫 `<影片>.cursor.json`（每 0.1 秒游標位置、每次點擊；錄影範圍內的實際像素）。
  錄影匯入時複製到 `uploads/cursor/{id}.json`；從工作區匯入（`ljcut_import`）時若旁邊有同名軌跡檔也會帶入。
  自動縮放建議：時間相近（2.5 秒內）且位置接近的點擊歸一組，區段 = 第一次點擊前 0.8 秒到最後一次後 1.6 秒，
  中心取平均位置，倍率依點擊分佈 1.5–2.2 倍。
- **MCP**：`ljcut_cursor`（點擊＋建議，輸出可直接當 `ljcut_plan` 的 operations）、`ljcut_check_zooms`（原畫面紅框＋放大後畫面）、
  `ljcut_frames grid=true`（0.1 格線，給沒有游標紀錄的素材判斷位置）。
- **介面**：時間軸「🔍 縮放」軌：＋ 在播放頭加 3 秒 2 倍、✨ 依滑鼠點擊自動加入；點選區段後 −／+ 調倍率、× 刪除，
  Shift+點預覽畫面設定放大中心（已放大時會換算回原畫面座標）。

## 相關改動

- **長輪詢**：編輯器以 `/poll {wait:8}` 等待命令，後端有命令立即回應。過去靠 300ms 計時器，
  視窗最小化或背景分頁被瀏覽器節流到約每分鐘一次，每個命令要等近一分鐘；改後 import＋plan 約 3 秒。
  重新整理頁面時舊連線不會刷新在線時間，新頁面會重試約 15 秒後接手。
- **預覽代理檔**：5 分鐘以上或高度超過 1080 的影片，首次預覽時後端背景轉 720p（每 30 幀一個關鍵幀，
  NVENC 失敗退 libx264）到 `uploads/proxies/{id}.mp4`。只換預覽 `<video>` 來源，專案檔與匯出仍用原檔；
  就緒後在下次切片段／跳點時才換源，不打斷播放。代理檔隨 14 天自動清理。
- **快速辨識**：UI 勾選「快速辨識」或 MCP `fast=true`。3 分鐘實測：精準 16.5 秒、快速 3.9 秒，
  句子依字詞間隔 0.6 秒、最長 8 秒、句末標點重新切分。預設仍為精準模式。
- `get_media_info` 改以 UTF-8 解碼 ffprobe 輸出：先前未設 `PYTHONUTF8` 時中文檔名會讀不到影片資訊。

## 驗證（2026-10-29）

瀏覽器模式（隔離工作區、背景分頁），透過 MCP stdio 實跑：匯入中文檔名 6 分鐘 1080p 測試片 →
overview／silences（18 段，與產生時的 8–11 秒靜音完全吻合）／scenes（180.0）／audio levels →
不帶 clipId 的 4 個操作 dry-run → apply → check_cuts（接縫 4 的換色正好在 src 180）→ undo／redo →
transcribe fast → save → export（355.000 秒，與計畫一致）。前端 `npm test` 10 項、後端 unittest 24 項通過。

**桌面版（Tauri，`scripts/launch-current.ps1`，工作區 `app_data/control`）**：匯入 Revit 教學前 2 分鐘（2656×1440，
會產生 720p 預覽代理檔）＋色塊測試片後，**把視窗最小化**再透過 MCP 操作：精準辨識 2 分鐘真人語音 12.6 秒（43 句，
與成品燒錄字幕一致）、改 2 句字幕＋刪開場靜音＋區間 2 倍速 dry-run／apply 各 0.7 秒、check_cuts 1.6 秒、
undo／redo 各 1 秒、preview 0.6 秒、另存、匯出 475.838 秒（與試算一致，原解析度、SRT 含修正字幕）。
還原視窗後介面狀態與 MCP 一致。兩支素材來源時間重疊時不帶 mediaId 會回 `CLIP_AMBIGUOUS` 並列出候選，不會猜。
