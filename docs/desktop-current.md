# 桌面新版啟動方式

2026-09-12：桌面 `LJCUT.lnk` 已改為透過 `scripts/launch-current.ps1` 啟動目前原始碼建置的 `src-tauri/target/debug/ljcut.exe`。
前端已嵌入執行檔，不需另外啟動 Vite；後端使用本專案既有 Python 環境。
工作區為 `app_data/control`。仍需要保留本專案目錄與 Python 環境。

2026-09-12 後續更新：已嵌入 [Codex 六張封面候選與成品字幕](codex-covers-youtube.md) 面板。從桌面捷徑重開使用；未替使用者開啟新視窗。

使用者點擊捷徑時才開啟編輯器。更新捷徑的過程沒有啟動或關閉任何 LJ Cut 視窗。
已經開著的舊版不會因此變成新版，請先存檔再自行關閉舊版。

若要開啟上次字幕成果，在新版專案控制面板輸入：

`recording-20260912-004552/完整63秒-字幕版.ljcut`

原捷徑備份：`app_data/shortcut-backups/20260912-010728/LJCUT.lnk`。
要復原時，將該檔複製回桌面的同名捷徑即可；舊安裝版沒有修改。

## 模型

`.codex/config.toml` 設定這個專案的預設模型為 `gpt-6-sol`，推理程度 `medium`，使用標準速度（`service_tier = "default"`）。專案明確指定速度，以免繼承使用者層級的 Fast 設定。
這是 Codex 的專案預設，並非 LJ Cut 的語音辨識或 Gemini 模型。
既有任务或明確選定的模型可能優先；本次沒有切換正在執行中的對話模型，也未驗證桌面新任務實際採用值。
若目前對話仍顯示其他模型或速度，請在 Codex 的模型與速度選單選擇 GPT-6 Sol／Medium／標準速度；專案設定只作為新任務預設。

## 維護與驗證

更新前端原始碼後需重新建置，捷徑本身不會每次啟動時編譯：

1. 在 `frontend` 執行 `npm run build`。
2. 在具備 MSVC 工具環境的專案根目錄執行 `cargo build --manifest-path src-tauri/Cargo.toml --bins --features custom-protocol --offline -j 2`。
3. 執行 `powershell -NoProfile -File scripts/launch-current.ps1 -CheckOnly` 檢查必要檔案，這一步不開啟視窗。

本次前端建置、Rust 建置、4 項剪輯核心測試、捷徑存後重讀與啟動路徑檢查通過。
執行檔已確認為 Windows GUI 子系統，不需額外主控台視窗。
為避免打斷使用者，桌面新版實際點擊啟動與原生視窗內操作尚未驗證。
没有新增依賴或外部付費服務。
