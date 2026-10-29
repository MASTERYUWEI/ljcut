# 片頭片尾轉場（2026-09-12）

在原有共用剪輯命令、React 預覽與 FFmpeg 輸出加入三種淡入淡出式轉場：淡黑、柔灰、淡白。沒有更換引擎或新增依賴／付費服務。

## 操作

先存檔，再自行關閉 LJ Cut，從桌面捷徑重開新版。此次沒有關閉使用者正在操作的程式。

展開「專案與本機控制 → 錄影後製作：片頭與片尾」：

1. 「銜接轉場」可選隨機、淡黑、柔灰、淡白或直接切換。
2. 時間預設 0.6 秒，可設 0.2–1.5 秒；「儲存預設」保留下一次選擇。
3. 新加入片頭片尾：按「檢查加入結果」，檢查每個銜接點的類型，再按「確認套用」。
4. 已有片頭片尾：按「檢查現有片頭片尾轉場」，再「確認套用」。選「直接切換」可清除這些銜接點的轉場。
5. 可用原有復原／重做，另存及重開會保留已選結果。

隨機選擇在提出計畫時只執行一次。預覽、輸出、重開與重做都使用專案內保存的種類，不會重新抽選。重新檢查計畫才會再抽選；可能抽到相同種類。

示範專案：在專案名稱輸入 `transition-validation/柔和轉場版.ljcut`，按「開啟專案」。
示範輸出：`app_data/control/transition-validation/柔和轉場版.mp4`。
示範使用完整 10.183317 秒主片及既有片頭、片尾，時間軸總長 35.326979 秒，輸出容器長 35.335333 秒（差異小於一個 60 fps 影格）。這份示範的兩個銜接點分別為淡黑與淡白，原本片尾的 3 秒音訊淡出仍保留。

## AI 操作

編輯器須保持執行，沿用本機控制信箱。可直接要求 AI「片頭片尾使用隨機柔和轉場，每處 0.6 秒，先讓我看計畫」。

已存在片頭片尾時：

```powershell
backend/venv/Scripts/python.exe scripts/ljcut.py --workspace app_data/control state
backend/venv/Scripts/python.exe scripts/ljcut.py --workspace app_data/control prepare_transitions --params transition-plan.json
```

`transition-plan.json`：

```json
{
  "sessionId": "使用最新 state 回傳值",
  "projectId": "使用最新 state 回傳值",
  "expectedRevision": 1,
  "mode": "random",
  "duration": 0.6
}
```

`mode` 也可為 `fade-black`、`fade-gray`、`fade-white` 或 `none`。`duration` 單位為時間軸秒數。
計畫回傳 `changes`（穩定片段 ID、銜接點時間、實際種類與長度）、`dryRunId` 與版本；確認後沿用 `apply`，傳回同一版本、`dryRunId`、`confirmed: true`。過期專案狀態、非法類型／長度、超出相鄰片段的轉場均拒絕。

`prepare_bookends` 則使用製作預設的 `transitionMode`、`transitionDuration`，也可在本次參數覆寫；未指定時預設隨機 0.6 秒。

## 實作範圍

- `frontend/src/types.ts`、`transitions.ts`：片段保存 `transitionIn`，計算預覽色層與音量。
- `editCore.ts`、`editSession.ts`、`controlClient.ts`：共用驗證、計畫、一次套用、版本檢查與復原；分割不重複產生進場轉場。
- `components/BookendControls.tsx`、`App.tsx`、`index.css`、`api.ts`：手動選擇、預覽與手動匯出使用相同資料。
- `backend/services/transitions.py`、`ffmpeg_service.py`、`control.py`、`backend/main.py`：保存／輸出驗證、FFmpeg 畫面 fade 與音訊 afade；控制與手動輸出共用。
- `scripts/ljcut.py`：開放 `prepare_transitions`。

轉場前半在前片尾端淡至指定顏色，後半從該顏色淡入下一片；音訊同步淡出／淡入。採用相鄰片段原有時間，不重疊、不減少影片長度、不移動字幕。字幕層不跟畫面一起淡出。預覽以主片的輸出畫布呈現不同長寬比素材。

目前只自動處理有 `bookend` 標記的片頭→主片與主片→片尾銜接點，沿用既有無空隙單轨限制。沒有雙畫面交叉溶接、滑動、縮放、閃光或依影片語意挑轉場。舊專案沒有轉場欄位時維持直接切換。這一階段的三種轉場均為同一淡入淡出方式的不同底色。

## 驗證結果

- `frontend` 內執行 `npm test`：6 項通過，含隨機只選一次、字幕與總長不變、版本衝突、整批復原重做、分割。
- PowerShell 設 `$env:PYTHONUTF8='1'`、`$env:PYTHONIOENCODING='utf-8'` 後執行 `backend/venv/Scripts/python.exe -m unittest discover -s backend/tests -p test_control.py`：6 項通過。涵蓋三種轉場真實 FFmpeg 輸出、切點像素顏色、音量漸入、總長、原檔 SHA-256、字幕存檔重開、無音訊素材與輸出取消。UTF-8 設定是此 Windows 終端測試需要，否則既有 FFmpeg 診斷文字可能遭 CP950 編碼阻擋。
- 隱藏瀏覽器使用真實 React 編輯器與獨立工作區：三種 UI 選擇、切點前後色層透明度／音量、外部 dry-run、套用、復原、重做、保存重開與完整輸出通過，無 JavaScript 錯誤。
- 不同比例的片頭與主片：預覽視頻及轉場色層範圍一致。輸出兩個切點取樣符合選定黑／白底色。
- 報告：`app_data/control/transition-validation/report.json`、`preview-layout.json`、`export-checks.json`；截圖 `preview-fixed.png`。
- 前端及嵌入前端的 Rust 桌面版建置成功。舊執行檔備份於 `src-tauri/target/debug/ljcut-before-transitions-20260912.exe`，保留使用者當下程式執行。
- 原生桌面新版啟動及實際聽感、長影片、重新錄影／語音辨識、YouTube 上傳發布：本次尚未驗證。語音辨識實作未修改。
