# Blender 3D 動畫

AI 用 Python 在 Blender 搭場景、做動畫，背景渲染成 MP4，再匯入 LJCUT 當片段或子母畫面素材。
適合：BIM 模型環繞展示、構件逐步長出、管線動線、立體標題片頭、產品展示。

## 安裝（可攜版，不需系統管理員權限）

1. 官方下載 `blender-4.5.15-windows-x64.zip`（4.5 LTS，約 399 MB）：
   <https://download.blender.org/release/Blender4.5/>，SHA256 對照同資料夾的 `blender-4.5.15.sha256`。
2. 解壓到 `D:\Tools\Blender\`（執行器會自動找 `D:\Tools\Blender\*\blender.exe`）。
   放別處就在 `backend/.env` 設 `BLENDER_PATH=...\blender.exe`。
3. 驗證：`backend\venv\Scripts\python.exe scripts\blender_run.py find`。

選 4.5 LTS 而不是 5.x：API 穩定、支援到 2027 年；`blender_kit` 已對 5.x 的改名（EEVEE、天空、分層動畫）做相容處理。

## 架構

| 檔案 | 在哪執行 | 用途 |
|---|---|---|
| `scripts/blender_kit.py` | Blender 內 | 場景小工具 `kit.*`：材質、方塊／圓柱／圓管／立體中文字、匯入 FBX／OBJ／glTF、天空與打光、相機路徑與環繞、關鍵影格、長出效果 |
| `scripts/blender_entry.py` | Blender 內 | 清空場景 → 執行場景腳本 → 沒相機自動補 → 渲染預覽格或整段 PNG |
| `scripts/blender_run.py` | 一般 Python | 找 Blender、低優先權背景執行、預覽拼圖、背景正式渲染、ffmpeg 合成 H.264 |
| `scripts/blender_examples/` | | 範例場景（`bim_intro.py`：柱網長出＋管線＋標題＋環繞） |

工作資料夾在 LJCUT 工作區 `3D/<name>/`：`scene.py`、`scene.blend`（可用 Blender 開啟手動微調）、
`preview.jpg`、`frames/`、`<name>.mp4`、`status.json`、`blender.log`。

## MCP 流程

1. `ljcut_blender_guide`：讀 kit 函式清單與這台的 Blender 路徑。
2. `ljcut_blender_preview {name, script}`：渲染 6 格半解析度預覽，回傳編號拼圖（每格標秒數）。
3. 給使用者看預覽，確認後才 `ljcut_blender_render {name, engine?}`：背景渲染，立刻回傳。
4. `ljcut_blender_job {name}` 查進度；完成後 `importAs=clip`（接到主時間軸）或 `asset`（子母畫面）。

## 規則

- 先預覽、使用者確認，才正式渲染；改場景就重新預覽。
- 渲染一律低優先權（BELOW_NORMAL）；Revit 匯出或重建在跑時，Revit 優先。同一時間只跑一個正式渲染。
- 預設 EEVEE（快）；要寫實光影才用 `engine=cycles`（3090 OptiX）。
- 中斷可續算：重新 `ljcut_blender_render` 會從缺的影格接著算。
- 第一版輸出不透明 MP4；透明背景疊加（WebM VP9 alpha）要先實測 LJCUT 預覽與匯出才開放。
- Revit 模型：在 3D 視圖匯出 FBX，放進工作區後用 `kit.import_model("<絕對路徑>.fbx")`。單位換算尚未實測：匯入後用 `kit.bounds()` 印出尺寸，跟模型實際大小不符再調 `scale`。

## 實測（2026-11-02，Blender 4.5.15 LTS 可攜版，RTX 3090）

- 安裝：官方 zip 398,649,826 bytes，SHA256 與官方 `.sha256` 相符，解壓到 `D:\Tools\Blender\blender-4.5.15-windows-x64\`。
- `bim_intro` 範例（6 秒、180 格、1920x1080）：
  - EEVEE 預覽 6 格半解析度：第一次 21.6 秒（編譯著色器），之後約 3 秒。
  - EEVEE 正式渲染＋H.264 合成：約 59 秒（約 3 格／秒），成品 2.1 MB。
  - Cycles：OptiX 啟用成功；半解析度 64 取樣一格約 4 秒（含啟動）。同樣燈光在 Cycles 比 EEVEE 亮，換引擎要重調燈光。
- 中文立體字（微軟正黑體 ttc）正常；EEVEE 引擎名 `BLENDER_EEVEE_NEXT`；天空節點 Nishita 正常。
- 修過的坑：`transform_apply()` 預設連位置一起套用，會把物件位置烘進網格（樓板被墊高一倍）；只套用縮放要明寫 `location=False, rotation=False`。
- 場景腳本或引擎改過後重新正式渲染，舊影格會依雜湊自動清掉，不會混用。

## Revit 模型 → 4D 工序動畫（2026-11-03 實測：中科宿舍建築模型）

1. 複製 RVT 到工作區 `3D/<name>/_src/`（原檔不碰）。
2. 用林境族群引擎開自己的測試 Revit（`scripts\job.ps1 -Year 2024 -Cmd ping`，記下 PID），再以 HotHost 跑匯出燈泡：
   `hothost\hot.ps1 -Name Export4D -SrcDir D:\BIM\07_開發\LJCUT\scripts\revit\Export4D -Pid <PID> -TimeoutSeconds 1500 -ArgsText "<rvt>|<輸出資料夾>"`。
   燈泡建一個新 3D 視圖，用 CustomExporter 逐元件寫 OBJ（物件名 `E<元素ID>`、公尺、Z 朝上）、`elements.jsonl`（類別、樓層、上下緣高程、類型、是否結構）、`levels.json`；不存檔關閉。
3. `python scripts\revit\build_4d.py <輸出資料夾> --cycle 1.0 --lag 3`：濾掉衛工、家具、天花板、設備，依「底部所在層的柱／結構牆 → 頂部所在層的梁／樓板，建築牆門窗落後 3 層」排出每件出現秒數（`schedule.json`，含每輪樓層里程碑，可做 LJCUT 疊字）。
4. 場景腳本讀 `model_4d.obj`＋`schedule.json`：構件落下＋橘光退色、開挖坑、相機隨高度升起環繞。範例在工作區 `3D/zk4d/scene_src.py`。
5. 結束只關自己的測試 Revit PID。

實測數據：開檔 10 秒、匯出 135 秒；29,265 元件／1,148 萬三角面（衛工裝置佔 930 萬）→ 過濾後 19,378 件／221 萬頂點、OBJ 88 MB；
Blender 匯入 4.5 秒、打關鍵影格 45 秒；預覽 6 格約 90 秒；正式 817 格約 79 格／分鐘。

注意：
- 全域 HotHost.dll 曾是 10/18 舊版（共用 root），新版 hot.ps1 要 PID 子目錄心跳；2026-11-03 已執行 `build-hothost.ps1` 安裝新版（使用者開著的 Revit 要重開才換新版，執行中不受影響）。
- 不可對舊版 HotHost 的共用 root 寫觸發檔：使用者開著的 Revit 也會撿走執行。
- 包圍盒會被基地邊界的長條構件撐大（255 m），相機距離要用塔樓構件算。

### 局部放大分段示意與完整版（2026-11-03）

- `3D/zk4d_detail/scene_src.py`：同一份匯出，切出 6F 靠外牆 24×16.5 m，依工種配色（結構灰藍、建築米色、裝修淺藍），
  結構（柱→梁→樓板）1–8 秒 → 掀開上層樓板 → 建築牆 8.4–11 秒 → 門窗 11–13 秒，相機後段拉成俯角看室內。480 格渲染約 5 分鐘。
- `3D/zk4d/compose.py`：ffmpeg 加中文字幕（全棟段右上角依 schedule 里程碑切換「結構 xF／裝修 yF」、局部段三階段標題與工種說明、右下圖例），
  0.6 秒淡接成 `zk4d_完整版.mp4`（42.6 秒），合成約 18 秒。
- 坑：逐輪切換的進度字卡不要加淡入淡出（每輪交界會閃）；抽格驗證別剛好取在交界秒數。
