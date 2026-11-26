"""逐格驗證的測試案例。每個案例只描述「時間軸怎麼排」，正確答案由片段設定推算：
成品第 k 格（時間 t＝k/fps）落在哪個片段，就該顯示那個素材的 floor((trimStart + (t−start)×speed) × 素材fps) 格；
每個素材秒數開頭的嗶，該出現在 start + (秒 − trimStart)/speed。

欄位：
  media   {名稱: {tag, seconds, fps}}
  clips   [{media, trim:[起,迄], speed?, bookend?, transition?: {kind, duration}}]   依序首尾相接
  twins   {名稱: clips}       換一種做法、成品必須逐格相同
  reopen  True                存檔→重開→再匯出，必須逐格相同
  tol     容許差幾格（預設 0；不同 fps 混用時要換算，給 1）
"""

CASES = [
    {
        "name": "split",
        "about": "A 在 1.5 秒切成兩段再接 B：切點兩側必須是 A 的第 44、45 格，A→B 接縫必須是 A 最後一格接 B 第 0 格；和不切的做法逐格相同；存檔重開後也相同。",
        "media": {"a": {"tag": 1, "seconds": 4}, "b": {"tag": 2, "seconds": 3}},
        "clips": [{"media": "a", "trim": [0, 1.5]}, {"media": "a", "trim": [1.5, 4]}, {"media": "b", "trim": [0, 3]}],
        "twins": {"不切": [{"media": "a", "trim": [0, 4]}, {"media": "b", "trim": [0, 3]}]},
        "reopen": True,
    },
    {
        "name": "ripple",
        "about": "剪掉 A 的 1–2 秒（左右兩段接起來）：第 30 格要直接跳到 A 的第 60 格，不能有黑格、重複格；嗶的位置也要跟著往前 1 秒。",
        "media": {"a": {"tag": 1, "seconds": 4}},
        "clips": [{"media": "a", "trim": [0, 1]}, {"media": "a", "trim": [2, 4]}],
    },
    {
        "name": "odd-trim",
        "about": "裁切點不在整格上（0.517、2.21 秒）：檢查四捨五入有沒有差一格。",
        "media": {"a": {"tag": 3, "seconds": 4}, "b": {"tag": 4, "seconds": 3}},
        "clips": [{"media": "a", "trim": [0.517, 2.21]}, {"media": "b", "trim": [0.4, 2.9]}],
    },
    {
        "name": "speed-odd",
        "about": "裁切點不在整格上（0.517 秒）又是 1.5 倍速：每格要對到預覽同一格，不能偶爾差一格。",
        "media": {"a": {"tag": 2, "seconds": 5}, "b": {"tag": 3, "seconds": 2}},
        "clips": [{"media": "a", "trim": [0.517, 4.3], "speed": 1.5}, {"media": "b", "trim": [0.25, 2]}],
    },
    {
        "name": "speed",
        "about": "A 兩倍速接 B 原速：A 段每格跳兩格、長度減半；B 從正確的時間點開始；嗶的間隔在 A 段變 0.5 秒。",
        "media": {"a": {"tag": 1, "seconds": 4}, "b": {"tag": 2, "seconds": 2}},
        "clips": [{"media": "a", "trim": [0, 4], "speed": 2}, {"media": "b", "trim": [0, 2]}],
    },
    {
        "name": "bookend",
        "about": "片頭 C（2 秒）接主片 A，主片帶 0.6 秒淡入：淡入期間的混合格可以讀不出來，其餘每格都要對。",
        "media": {"c": {"tag": 5, "seconds": 2}, "a": {"tag": 1, "seconds": 3}},
        "clips": [{"media": "c", "trim": [0, 2], "bookend": "intro"},
                  {"media": "a", "trim": [0, 3], "transition": {"kind": "fade-black", "duration": 0.6}}],
    },
    {
        "name": "mixed-fps",
        "about": "25fps 的素材接 30fps 的素材：成品統一成 30fps，25fps 那段要對到最接近的來源格（容許差 1 格）。",
        "media": {"d": {"tag": 6, "seconds": 3, "fps": 25}, "a": {"tag": 1, "seconds": 2}},
        "clips": [{"media": "d", "trim": [0, 3]}, {"media": "a", "trim": [0, 2]}],
        "tol": 1,
    },
    {
        "name": "many-cuts",
        "about": "12 段各 0.517 秒（不是整格長）的短片段接在一起：每段的畫面若進位成整格、聲音卻照實長度，接越多段音畫就錯開越多；最後一段的嗶和畫面都要準。",
        "media": {"a": {"tag": 1, "seconds": 12}},
        "clips": [{"media": "a", "trim": [round(i * 0.9 + 0.7, 3), round(i * 0.9 + 1.217, 3)]} for i in range(12)],
    },
    {
        "name": "audio-longer-tail",
        "about": "配音比畫面長、片段剪到聲音尾端（露營片的做法），而且前一段長度不是整格：每段都要補滿自己的長度，後面的聲音不能往前擠（修正前實測片尾早 106ms）。",
        "media": {"c": {"tag": 5, "seconds": 2}, "a": {"tag": 1, "seconds": 3, "audio_seconds": 3.317},
                  "b": {"tag": 2, "seconds": 3, "audio_seconds": 2.548}},
        "clips": [{"media": "c", "trim": [0, 1.517]}, {"media": "a", "trim": [0, 3.317]},
                  {"media": "b", "trim": [0, 2.548]}, {"media": "a", "trim": [0.4, 3.317]}, {"media": "c", "trim": [0, 2]}],
    },
]
