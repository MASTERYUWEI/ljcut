# OpenMontage 研讀筆記與 LJCUT 待辦（2026-11-02）

OpenMontage（github.com/calesthio/OpenMontage）是 AGPL-3.0。本文只記做法，用自己的話重寫；
不得把它的程式碼或技能檔原文搬進 LJCUT。出處以檔名標示，需要時再回去讀原文。

## 它的結構

- 三層知識：工具登錄表（每個工具宣告能力、成本、用前要讀的技能）→ `skills/`（專案慣例：core／creative／meta／pipelines）→ `.agents/skills/`（各技術的通用知識）。
- `pipeline_defs/*.yaml` 把一種影片拆成固定階段（idea → script → scene_plan → assets → edit → compose → publish），
  每階段指定導演技能檔、成果檔、可用工具、審查重點、完成標準、要不要人確認。
- LJCUT 的對應：`AGENTS.md`＋`docs/parallel-production.md` 是流程，MCP 工具是能力，但沒有「每階段完成標準」與「階段狀態」。

## 建議落地（依價值排序）

| # | 做法 | 出處 | LJCUT 現況 | 落地方式 |
|---|---|---|---|---|
| 1 | 匯出後對成品本身自檢 | meta/reviewer.md、screen-demo/compose-director | 只檢查時間軸 | 新 MCP `ljcut_verify_export`：ffprobe、LUFS／true peak、blackdetect、silencedetect、成品抽 6 格疊 SRT、字幕每秒字數；寫 `final_review.json`，handoff `finish` 要求 pass |
| 2 | 免費素材與 B-roll 規則 | creative/broll-planning.md、stock-sourcing-usage.md | **已完成**（2026-11-02） | `ljcut_stock_*` 三個工具＋[stock-media.md](stock-media.md) |
| 3 | 聲音規格：螢幕教學約 -16 LUFS、true peak ≤ -1.5 dBTP、80 Hz 高通、配樂低於人聲 15–20 dB、3 倍速以上段落降音 | creative/sound-design.md、screen-recording.md | 無響度正規化、無配樂軌 | export 加 `loudness` 選項（兩段式 loudnorm）；`ljcut_audio_levels` 回報 LUFS |
| 4 | 操作地圖＋分級加速：關鍵點擊與結果原速；例行輸入 1.5–2 倍；載入、重生 3–6 倍或剪掉；結果出現那刻不加速 | pipelines/screen-demo | 素材都有但分散 | 新 MCP `ljcut_action_map`：合併點擊、靜音、畫面變化、逐字稿，輸出可直接餵 `ljcut_plan` 的建議 |
| 5 | 注意力提示節制：同時最多兩個、放大與框選二擇一、步驟間拉回全畫面、放大至少停 3 秒、不超過約 2 倍 | screen-demo/scene-director | 無 | `check_zooms`／`check_overlays` 加警告 |
| 6 | 敏感資料遮罩（客戶專案名、路徑、授權視窗、Email） | screen-demo 各階段 | 無 | 新標註 `kind:'blur'`（矩形馬賽克，跟著縮放）；列入交付必查 |
| 7 | 逐場景確認關卡：每場一格＋場次＋秒數＋旁白首句的聯絡表，逐場確認後才改時間軸 | meta/checkpoint-protocol.md | 部分（userConfirmed） | 新 MCP `ljcut_storyboard` |
| 8 | 先做一場樣本再量產（聲音＋一張卡＋配樂＋字幕樣式 10–15 秒） | meta/voice-performance-director.md | 無（露營片配樂做完才發現太大聲） | 寫進「圖＋旁白＋清單卡」流程 |
| 9 | 審查意見要具體：每條附位置、原文、建議與理由；不確定歸「待查」；最多修兩輪 | meta/reviewer.md | 無明文 | 寫進 AGENTS.md |
| 10 | 製作階段狀態＋只增不改的決策紀錄 | AGENT_GUIDE.md、checkpoint-protocol.md | handoff.json 部分 | `production/<片>/state.json`、`decisions.jsonl`；AI 狀態藥丸顯示停在哪一關 |
| 11 | 參考影片分析：主體、動作、場景、構圖、運鏡逐鏡頭描述 → 2–3 個差異方案 → 樣本 | meta/video-reference-analyst.md | 無 | 新 MCP `ljcut_reference(path)`（只收工作區本機檔，不自動下載網址） |
| 12 | 字幕可讀性：每段 0.5–5 秒、結尾多留約 0.2 秒、不重疊、標出過快段落 | core/subtitle-sync.md | 無 | `ljcut_transcript` 加旗標 |
| 13 | 發布包裝：標題＝工作＋工具＋結果；關鍵字含軟體版本與錯誤訊息原文；章節對成品時間 | screen-demo/publish-director | 已有文案流程 | 寫進 `publication.py` 提示詞與章節驗證 |
| 14 | 長片挑 Shorts 的評分與獨立觀看測試 | pipelines/clip-factory | 無 | 之後做 Shorts 時寫成規則 |

## 不借的部分

- 付費生成與供應商選單、成本追蹤（它的預算上限也沒真正生效，見其 issue #723）：違反不接付費 API 的規則。
- Backlot 看板：LJCUT 的可見時間軸已扮演這個角色。
- CLIP 向量檢索素材：吃 CPU、要下載模型，與 Revit 並行的 CPU 預算衝突。
- 派子 agent 逐階段執行：與單一 agent、單一時間軸寫入者衝突。
- 預設燒字幕、9:16 自動重新取景：前者違反乾淨匯出，後者對密集 UI 不適用。
- 每階段一份 JSON schema 成果檔：太重，LJCUT 只要 state／decisions／final_review 三份輕量檔。
