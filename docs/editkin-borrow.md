# 借鏡 Editkin 的路線圖（2026-11-21）

參考：https://github.com/Hao0321/Editkin （v0.30.0，2026-11-20）。使用者：「他不錯的地方我們都可以借鏡下來」。

**授權界線**：Editkin 公開原始碼只到 0.15（GPL-3.0），0.16 起是不公開原始碼的免費軟體。LJCUT 會發安裝檔，**只借做法與點子，不複製程式碼**（抄 GPL 程式碼會讓 LJCUT 也必須 GPL 開源）。

## 第一批（2026-11-21 已做進桌面程式；用法見 docs/mcp.md）

| 代號 | Editkin 的做法 | LJCUT 現況 | 要做的事 | 在哪做 |
|---|---|---|---|---|
| A 審片標註 | 0.30 審片表格＋畫筆：在片子上標時間點、寫意見、畫圈 | 使用者用手機看 YouTube 私人片審，意見用打字回傳 | 手機審片頁：輸入時間點＋意見（可附截圖），存在頁面資料庫，Claude 直接讀回；之後可整合進 LJCUT 前端 | ✅ 桌面程式右欄「審片」＋時間尺旗標＋`ljcut_review`；手機頁 https://claude.ai/artifact/GEnYesLvDUkM1y3baFuVtP （集合 `videos` 放審片版、`notes` 放標註；Claude 用 ArtifactData 讀、改完寫 `status`/`reply`） |
| B 端到端旅程測試＋架構守門 | `test:journey`：合成影片跑完匯入→編輯→存檔重開→匯出→解出畫面留證據；`architecture-check` 擋分層互相引用與循環；前端 bundle 大小預算 | 只有 backend 單元測試；App.tsx 單檔兩千多行 | 1) journey 腳本：ffmpeg lavfi 產生測試片→透過 control API 匯入、剪、存、重開、匯出→檢查影格數／時長／解出畫面；2) 前端循環引用與分層檢查；3) bundle 預算 | ✅ `scripts/journey_test.py`、`npm run check`（架構＋bundle 預算；抓到並拆掉 api↔controlClient 舊循環） |
| C 套用前自動審核 | prepare → **audit** → apply：計畫套用前先跑檢查，檢查不過不准套用；套用時核對計畫沒被改過 | `ljcut_plan` 試算 → `ljcut_apply`；`check_cuts` 是套用後才查 | 在 dry_run 回傳加 audit：剪掉的區間有旁白、刪除比例異常、片段太短、字幕被切半等；apply 時核對 dryRunId 對應的計畫雜湊 | ✅ `planAudit.ts`；block 需 acknowledge（dryRunId 本來就綁定計畫） |
| F 聲音 | 平台響度預設、預覽和輸出一致的自動壓低配樂（ducking）、標出配樂節拍 | 響度要匯出後另外跑 ffmpeg loudnorm（export_only.py） | 1) 匯出選項「平台響度」（YouTube −14／教學 −16 LUFS）內建在匯出流程；2) 旁白時自動壓低配樂，預覽與匯出用同一組參數；3) 配樂節拍偵測、時間軸上顯示節拍點 | ✅ 新增配樂軌；`audio_mix.py`＋`audioMix.ts` |

## 第二批（第一批完成後）

| 代號 | Editkin | LJCUT 要做的事 |
|---|---|---|
| E 自動存檔日誌 | 每個操作寫進日誌，當機可找回 | 已有：每分鐘自動存檔＋啟動時提示還原；2026-11-21 加「覆寫前保留上一版」。操作日誌仍未做 |
| G 一鍵路人臉馬賽克 | 偵測臉＋追蹤＋打碼 | 本機臉部偵測模型（需確認授權與 GPU 速度）→ 產生追蹤框 → 套馬賽克 overlay |
| H 簡單模式 | 四個大按鈕、白話用語、大字 | 「匯入 → 自動剪 → 加字幕 → 匯出」四步的簡化介面 |
| J 路徑邊界 | MCP 只能碰工作區，realpath 擋符號連結跳脫 | ✅ 原本就用 `resolve()`；2026-11-21 補測試（目錄連接點跳出工作區會被擋） |

## 不採用

| 項目 | 原因 |
|---|---|
| 更新只通知、不自動安裝 | Editkin 是因為沒有簽章才這樣；LJCUT 已有簽章自動更新，保留 |
| Electron 雙殼、外掛 C ABI、GPU 特效位元碼 | 規模與需求不符 |

## 做法共通要求
每項都照 `Revit教學\_lib\RULES.md` 的原則：新檢查先在真實舊錯上失敗過才算數；能做成結構或機器檢查的不寫成文字規則。
