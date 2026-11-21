# 免費素材庫（影片／照片／配樂）

AI 透過 MCP 搜尋、下載可商用的免費素材，放進工作區後用既有的匯入工具上時間軸。
程式在 `scripts/stock_media.py`（只用標準函式庫，MCP 與命令列共用）。

## 來源

| 來源 | 類型 | 金鑰 | 適合 |
|---|---|---|---|
| Pexels | 影片、照片 | `PEXELS_API_KEY`（免費） | 生活、人物、自然 B-roll，品質最好 |
| Pixabay | 影片、照片 | `PIXABAY_API_KEY`（免費） | 同上，另一個大庫 |
| Wikimedia Commons | 影片、照片 | 免 | 地景、建築、城市；影片量少 |
| Openverse | 照片、配樂 | 免 | 配樂（Jamendo、Freesound 等 CC 曲）；回應慢，常要 20–60 秒 |
| NASA | 影片、照片 | 免 | 太空、地球科學；要用 `sources:["nasa"]` 指定 |
| Internet Archive | 影片 | 免 | 1930–70 年代公眾領域老片；下載極慢，要用 `sources:["archive"]` 指定 |

沒有金鑰時，生活類影片 B-roll 幾乎找不到；照片與配樂免金鑰就夠用。

### 申請免費金鑰（要使用者本人註冊）

1. Pexels：登入 <https://www.pexels.com/api/> → Your API Key。
2. Pixabay：登入 <https://pixabay.com/api/docs/>，頁面「Parameters」段落的 `key` 就是你的金鑰。
3. 寫進 `backend/.env`（已在 .gitignore，不會進 git）：

```
PEXELS_API_KEY=...
PIXABAY_API_KEY=...
```

## 授權政策

只收可商用、可改作的素材：CC0、公眾領域、CC BY、CC BY-SA、Pexels 授權、Pixabay 授權、NASA。
NC（禁止商用）與 ND（禁止改作）一律排除；GFDL 也排除。

- 每個下載檔旁有 `<檔名>.license.json`（來源、作者、授權、原始頁面）。
- 同資料夾的 `credits.json` 累積出處；`ljcut_stock_credits` 整理成說明欄段落。
- CC BY／BY-SA 必須在 YouTube 說明欄標註；Pexels／Pixabay 不強制，但一併列出比較好。
- NASA 素材不得暗示 NASA 背書；不要用 NASA 標誌當封面主體。

## MCP 工具

- `ljcut_stock_search {query, kind, sources?, count?, orientation?, minDuration?, maxDuration?}`
  回傳候選清單＋編號縮圖對照表（存在工作區 `observe/`），不下載。查無結果會自動放寬成前兩個字再搜一次。
- `ljcut_stock_fetch {ids, dest?, importAs?, maxMB?}`
  下載到工作區相對路徑（建議 `<專案資料夾>/素材庫`）。`importAs=asset` 匯入成子母畫面素材，`clip` 接到主時間軸最後。
  搜尋結果快取 7 天（`素材庫/.search-cache.json`），所以 fetch 要在 search 之後。
- `ljcut_stock_credits {folder?}` 整理出處。

命令列等價用法見 `scripts/stock_media.py` 開頭說明。

## 挑片規則

- 關鍵字用英文 2–4 個字，主體放前面，可加鏡位詞：aerial、close up、top view、handheld、timelapse、slow motion。
- 每個畫面準備 2–3 組關鍵字（字面、換角度、聯想）；同一組重搜結果一樣，要換字或換來源，不要重試。
- 1080p 以上、無浮水印、構圖完整、鏡位對；鏡位錯比色調錯更難救。
- 素材長度要比需要的長（剪得短，拉不長）；挑片中最好的 3 秒左右，在動作自然結束前切。
- 相鄰兩格不要太像，同一段素材不重複使用。
- 生活類 B-roll 停留：抒情約 4 秒、一般 2–3 秒；教學長片中單段 B-roll 5–8 秒。
- 要像真的（真實場景、人、器材）用素材庫；抽象概念、品牌風格用 Codex 生圖。
- 找不到時依序：換關鍵字 → 換來源 → 改用生圖 → 才問使用者。

## 實測（2026-11-02）

- Wikimedia「waterfall」影片：6 筆橫式，4 筆 1080p；下載 1080p VP9 WebM 30 秒約 42 MB，ffprobe 正常。
- Wikimedia 照片：大於 1920 寬時改抓官方 1920px 級距縮圖（4032 寬原圖 2 MB → 0.9 MB）。
- Openverse 配樂「acoustic guitar」：4 筆 CC BY／BY-SA，mp3 下載正常；API 單次 17–60 秒，偶有 504。
- NASA 影片：manifest 解析出 `~large.mp4`，119 MB 下載正常。
- Internet Archive：約 20 KB/s，整部老片要數小時，只適合指定短片段。
