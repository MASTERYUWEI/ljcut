"""LJ Cut MCP server（stdio）——讓 Claude Desktop / Claude Code / Codex 直接操作 LJ Cut。

只用 Python 標準函式庫；所有動作都經過既有的本機控制 API（/api/control），
沿用同一套安全模型：token、工作區路徑限制、dry-run → 使用者確認 → apply、revision 防撞、共用 undo。

用法（由 MCP 客戶端啟動，不需手動執行）：
    python scripts/ljcut_mcp.py --workspace app_data/control

時間單位一律為秒。工具輸出會同時標示：
    tl  = 時間軸秒數（成品影片上的位置）
    src = 來源素材秒數（剪輯操作用這個）
"""
import argparse
import base64
import json
import sys
import time
import traceback
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ljcut import Client  # noqa: E402

PROTOCOL = "2025-06-18"
WORKSPACE = Path("app_data/control")


# ───────────────────────── 共用 ─────────────────────────
def client() -> Client:
    # 每次呼叫重讀設定：LJ Cut 重開後 token 會換新
    cfg = WORKSPACE / ".ljcut-control.json"
    if not cfg.exists():
        raise RuntimeError("LJ Cut 本機控制未啟用：請用 scripts/launch-current.ps1 或 start-control.ps1 開啟 LJ Cut（工作區 "
                           f"{WORKSPACE}）。")
    return Client(WORKSPACE)


def command(method, params=None, timeout=120):
    res = client().command(method, params or {}, timeout=timeout)
    if res.get("status") == "failed":
        err = res.get("error") or {}
        raise RuntimeError(f"{err.get('code', 'FAILED')}: {err.get('message', err)}")
    if res.get("status") in {"queued", "delivered"}:
        raise RuntimeError(f"LJ Cut 尚未回應（命令 {res.get('id')}）。編輯器是否開著？")
    return res.get("result")


def state():
    return command("state")


def version(s):
    return {"sessionId": s["sessionId"], "projectId": s["projectId"], "expectedRevision": s["revision"]}


def clips_sorted(s):
    return sorted(s["timelineClips"], key=lambda c: c["startTime"])


def to_src(c, t):
    return c["trimStart"] + (t - c["startTime"]) * c["speed"]


def to_tl(c, t):
    return c["startTime"] + (t - c["trimStart"]) / c["speed"]


def clip_at(s, t):
    for c in clips_sorted(s):
        if c["startTime"] <= t < c["startTime"] + c["duration"] + 1e-9:
            return c
    return None


def media_name(s, mid):
    m = next((m for m in s["mediaItems"] if m["id"] == mid), None)
    return m["filename"] if m else mid


def main_media_id(s):
    for c in clips_sorted(s):
        if not c.get("bookend"):
            return c["mediaId"]
    if s["mediaItems"]:
        return s["mediaItems"][0]["id"]
    raise RuntimeError("專案沒有素材")


def r2(x):
    return round(float(x), 2)


def image_block(rel_path):
    data = (WORKSPACE / rel_path).read_bytes()
    return {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"}


def text_block(obj):
    return {"type": "text", "text": obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1)}


# ───────────────────────── 工具實作 ─────────────────────────
def t_status(_):
    s = state()
    lines = [f"專案 {s['projectId']}  revision={s['revision']}  時間軸長度={r2(s['timelineDuration'])}s  "
             f"undo={'可' if s['canUndo'] else '否'} redo={'可' if s['canRedo'] else '否'}",
             "素材："]
    tr = {t["mediaId"]: t["result"] for t in s["transcripts"]}
    for m in s["mediaItems"]:
        info = m.get("info", {})
        res = f"{info.get('width', '-')}x{info.get('height', '-')}" if info.get("width") else "音訊"
        has = f"已辨識 {len(tr[m['id']]['segments'])} 句" if tr.get(m["id"]) else "未辨識"
        lines.append(f"  {m['id']}  {m['filename']}  {r2(info.get('duration', 0))}s  {res}  {has}")
        for z in m.get("zooms") or []:
            lines.append(f"      縮放 {z['id']}  src {r2(z['start'])}–{r2(z['end'])}  中心({z['x']},{z['y']})  {z['scale']}x")
        for i, o in enumerate(m.get("overlays") or []):
            geo = (f"({o['x']},{o['y']}" + (f",w{o['w']}" if o.get("w") is not None else "")
                   + (f",h{o['h']}" if o.get("h") is not None else "") + ")")
            extra = "".join(f" {k}={o[k]}" for k in ("text", "sub", "color", "from", "position", "layer") if o.get(k))
            if o["kind"] == "html":
                extra += f"  html {len(o.get('html') or '')} 字元"
            if o["kind"] == "media":
                a = o.get("asset") or {}
                extra += (f"  子母畫面 {a.get('filename')}（{a.get('type')}）w{o.get('w')} {o.get('shape', 'rounded')}"
                          f" 音量{o.get('volume', 0)}{' 循環' if o.get('loop') else ''} offset{o.get('offset', 0)}")
            lines.append(f"      標註#{i} {o['id']}  {o['kind']}  src {r2(o['start'])}–{r2(o['end'])}  {geo}{extra}")
    lines.append("時間軸片段（依順序）：")
    for i, c in enumerate(clips_sorted(s)):
        tag = f" [{c['bookend']}]" if c.get("bookend") else ""
        lines.append(f"  #{i} clip={c['id']}{tag}  媒體={c['mediaId']}  tl {r2(c['startTime'])}–{r2(c['startTime'] + c['duration'])}  "
                     f"src {r2(c['trimStart'])}–{r2(c['trimEnd'])}  {c['speed']}x  字幕 {len(c['segments'])} 句")
    return [text_block("\n".join(lines))]


def t_transcript(a):
    s = state()
    out = []
    for c in clips_sorted(s):
        if a.get("clipId") and c["id"] != a["clipId"]:
            continue
        for seg in c["segments"]:
            if seg["end"] <= c["trimStart"] or seg["start"] >= c["trimEnd"]:
                continue
            out.append(f"[tl {r2(to_tl(c, seg['start']))}–{r2(to_tl(c, seg['end']))}] clip={c['id']} seg={seg['id']} "
                       f"src={r2(seg['start'])}–{r2(seg['end'])}  {seg['text']}")
    if not out:
        return [text_block("時間軸上沒有字幕。若素材已辨識但未放上時間軸，或尚未辨識，請先用 ljcut_transcribe。")]
    return [text_block("\n".join(out))]


def t_frames(a):
    s = state()
    times = a.get("times") or []
    domain = a.get("domain", "timeline")
    if not times:
        raise ValueError("times 至少一個")
    groups = {}   # mediaId -> [(src, label)]
    if domain == "timeline":
        for t in times:
            c = clip_at(s, t)
            if not c:
                raise ValueError(f"時間軸 {t}s 沒有片段（長度 {r2(s['timelineDuration'])}s）")
            groups.setdefault(c["mediaId"], []).append((to_src(c, t), f"tl {r2(t)}"))
    else:
        mid = a.get("mediaId") or main_media_id(s)
        groups[mid] = [(t, f"src {r2(t)}") for t in times]
    blocks = []
    for mid, pts in groups.items():
        res = client().request("/observe/frames", {"mediaId": mid, "times": [p[0] for p in pts],
                                                    "labels": [p[1] for p in pts], "cols": a.get("cols", 4),
                                                    "grid": bool(a.get("grid", False)),
                                                    **({"thumbWidth": 640} if a.get("grid") else {})})
        note = "（青色格線每格 0.1，左上為 0,0；縮放中心 x/y 直接讀格線）" if a.get("grid") else ""
        blocks += [text_block(f"{media_name(s, mid)}：{len(pts)} 格{note}"), image_block(res["path"])]
    return blocks


def t_overview(a):
    """整支素材平均取樣：快速了解內容。"""
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    m = next(m for m in s["mediaItems"] if m["id"] == mid)
    n = max(4, min(int(a.get("count", 12)), 24))
    dur = m["info"]["duration"]
    times = [dur * (i + 0.5) / n for i in range(n)]
    res = client().request("/observe/frames", {"mediaId": mid, "times": times, "cols": 4})
    return [text_block(f"{m['filename']}（{r2(dur)}s）平均取樣 {n} 格，標籤為來源秒數"), image_block(res["path"])]


def t_silences(a):
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    res = client().request("/observe/silences", {"mediaId": mid, "noiseDb": a.get("noiseDb", -35),
                                                 "minSilence": a.get("minSilence", 0.8)})
    lines = [f"{media_name(s, mid)}：{len(res['silences'])} 段靜音，共 {r2(res['totalSilence'])}s / {r2(res['mediaDuration'])}s "
             f"（門檻 {res['noiseDb']}dB、至少 {res['minSilence']}s；來源秒數）",
             "⚠️ 靜音不等於可刪：螢幕教學中安靜時常是操作過程，請搭配 ljcut_frames / ljcut_scenes 判斷。"]
    lines += [f"  src {r2(x['start'])}–{r2(x['end'])}  ({r2(x['duration'])}s)" for x in res["silences"]]
    return [text_block("\n".join(lines))]


def t_scenes(a):
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    res = client().request("/observe/scenes", {"mediaId": mid, "threshold": a.get("threshold", 0.3)})
    return [text_block(f"{media_name(s, mid)}：{res['count']} 個畫面變化點（來源秒數，threshold={res['threshold']}）\n"
                       + ", ".join(str(r2(x)) for x in res["changes"]))]


def t_audio(a):
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    res = client().request("/observe/audio-levels", {"mediaId": mid, "window": a.get("window", 1.0)})
    w = res["window"]
    bars = []
    for i, db in enumerate(res["levels"]):
        n = max(0, min(30, int((db + 60) / 2)))
        bars.append(f"{r2(i * w):>7}s {db:>6} {'█' * n}")
    return [text_block(f"{media_name(s, mid)} 音量（{w}s 一格，dBFS；約 -60 以下=安靜、-30~-10=講話）\n" + "\n".join(bars))]


def t_plan(a):
    s = state()
    ops = a.get("operations")
    if not isinstance(ops, list) or not ops:
        raise ValueError("operations 至少一個")
    assets = {}
    for o in ops:
        if "type" not in o and "op" in o:
            o["type"] = o.pop("op")
        # 子母畫面：只給 assetId 時自動補上素材資訊
        if o.get("assetId") and not o.get("asset"):
            aid = o.pop("assetId")
            assets[aid] = assets.get(aid) or client().request(f"/asset/{aid}")
            o["asset"] = assets[aid]
        o.setdefault("trackId", "video-main")
        o.setdefault("timeDomain", "source")
    res = command("dry_run", {**version(s), "timeUnit": "seconds", "operations": ops})
    return [text_block({"dryRunId": res.get("dryRunId"), "beforeDuration": res.get("beforeDuration"),
                        "afterDuration": res.get("afterDuration"), "changes": res.get("changes"),
                        "next": "把以上變更摘要給使用者確認後，才呼叫 ljcut_apply(dryRunId, userConfirmed=true)。"})]


def t_apply(a):
    if a.get("userConfirmed") is not True:
        raise ValueError("必須先取得使用者對這批變更的明確確認，再以 userConfirmed=true 呼叫")
    s = state()
    res = command("apply", {**version(s), "dryRunId": a["dryRunId"], "confirmed": True})
    return [text_block({"applied": True, "revision": (res or {}).get("revision", res)})]


def t_undo(_):
    s = state()
    command("undo", version(s))
    return t_status({})


def t_redo(_):
    s = state()
    command("redo", version(s))
    return t_status({})


def t_import_asset(a):
    """匯入子母畫面素材（工作區內的圖片／影片），不會放上主時間軸。"""
    res = client().request("/asset", {"path": a["path"]})
    kind = "圖片" if res["type"] == "image" else f"影片 {res['duration']}s{'（有聲音）' if res.get('hasAudio') else ''}"
    return [text_block(f"已匯入子母畫面素材 {res['filename']}：{kind}，{res['width']}x{res['height']}"),
            text_block({"assetId": res["id"], "next": "用 ljcut_plan 的 add_overlay kind=media，帶 assetId 與位置／寬度"})]


def t_import(a):
    s = state()
    res = command("import", {**version(s), "path": a["path"]})
    return [text_block({"mediaId": res["mediaId"], "clipId": res["clipId"]})]


def t_transcribe(a):
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    res = command("transcribe", {**version(s), "mediaId": mid, "fast": bool(a.get("fast", False)),
                                 "language": a.get("language", "zh")}, timeout=3600)
    return [text_block({"mediaId": mid, "segments": res.get("segments"), "clipsUpdated": res.get("clipsUpdated"),
                        "next": "用 ljcut_transcript 讀取逐字稿。"})]


def t_preview(a):
    s = state()
    res = command("preview", {**version(s), "time": a["time"]})
    return [text_block({"timelineTime": res.get("timelineTime"), "sourceTime": res.get("expectedSourceTime"),
                        "subtitle": (res.get("actual") or {}).get("subtitle")})]


def t_save(a):
    s = state()
    return [text_block(command("save", {**version(s), "path": a["path"]}))]


def t_open(a):
    s = state()
    command("open", {**version(s), "path": a["path"]})
    return t_status({})


def t_export(a):
    s = state()
    job = command("export", {**version(s), "burnSubtitles": bool(a.get("burnSubtitles", False))})
    if not a.get("wait", True):
        return [text_block(job)]
    deadline = time.monotonic() + float(a.get("timeoutSeconds", 1800))
    while job.get("status") in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(2)
        job = client().request(f"/jobs/{job['id']}")
    return [text_block({k: job.get(k) for k in ("id", "status", "progress", "outputPath", "path", "error", "duration")
                        if job.get(k) is not None} | {"raw": job})]


def t_job(a):
    return [text_block(client().request(f"/jobs/{a['jobId']}"))]


def t_check_cuts(a):
    """每個接縫前後各取一格，讓 AI 檢查剪接是否突兀。"""
    s = state()
    cs = clips_sorted(s)
    seams = [c["startTime"] for c in cs[1:]][: int(a.get("max", 6))]
    if not seams:
        return [text_block("只有一個片段，沒有接縫。")]
    gap = float(a.get("offset", 0.4))
    times, labels = [], []
    for i, t in enumerate(seams):
        times += [max(0.0, t - gap), t + gap]
        labels += [f"接縫{i + 1} 前", f"接縫{i + 1} 後"]
    blocks = [text_block(f"{len(seams)} 個接縫（時間軸秒數）：{', '.join(str(r2(t)) for t in seams)}；每列左=接縫前 {gap}s、右=接縫後 {gap}s")]
    by_media = {}
    for t, lab in zip(times, labels):
        c = clip_at(s, t)
        if c:
            by_media.setdefault(c["mediaId"], []).append((to_src(c, t), f"{lab} tl{r2(t)}"))
    for mid, pts in by_media.items():
        res = client().request("/observe/frames", {"mediaId": mid, "times": [p[0] for p in pts],
                                                    "labels": [p[1] for p in pts], "cols": 2, "thumbWidth": 320})
        blocks.append(image_block(res["path"]))
    return blocks


def t_cursor(a):
    """錄影時記下的滑鼠點擊與自動縮放建議（只有 LJ Cut 錄影有）。"""
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    rep_ = client().request("/observe/cursor", {"mediaId": mid})
    sugg = rep_["suggestions"]
    ops = [{"type": "add_zoom", "mediaId": mid, "start": z["start"], "end": z["end"], "x": z["x"], "y": z["y"],
            "scale": z["scale"]} for z in sugg]
    lines = [f"{media_name(s, mid)}：錄影範圍 {rep_['width']}x{rep_['height']}，{len(rep_['clicks'])} 次點擊（來源秒數、畫面比例座標）"]
    lines += [f"  {c['t']}s  ({c['x']},{c['y']})  {c['button']}" for c in rep_["clicks"][:80]]
    if len(rep_["clicks"]) > 80:
        lines.append(f"  …其餘 {len(rep_['clicks']) - 80} 次省略")
    lines.append(f"自動縮放建議 {len(sugg)} 段（依點擊分組；可直接交給 ljcut_plan，或先刪改不需要的段落）：")
    return [text_block("\n".join(lines)), text_block({"operations": ops})]


def zoom_state(zooms, t):
    """與前端 zoomAt / 後端 zoom_at 相同的公式：回傳 (scale, x, y)。"""
    scale, x, y = 1.0, 0.5, 0.5
    for z in zooms or []:
        if not (z["start"] <= t < z["end"]):
            continue
        e = min(float(z.get("ease", 0.4)), (z["end"] - z["start"]) / 2)
        p = max(0.0, min(1.0, min((t - z["start"]) / e, (z["end"] - t) / e)))
        k = p * p * (3 - 2 * p)
        scale, x, y = 1 + (z["scale"] - 1) * k, 0.5 + (z["x"] - 0.5) * k, 0.5 + (z["y"] - 0.5) * k
        break
    return scale, x, y


def t_check_overlays(a):
    """每個標註取一格：疊上當時所有標註（多層）並套用縮放，就是成品看到的畫面。"""
    s = state()
    items = []
    for m in s["mediaItems"]:
        for o in m.get("overlays") or []:
            t = min(o["end"] - 0.01, o["start"] + min(0.6, (o["end"] - o["start"]) / 2))   # 進場動畫結束後
            shown = [c for c in clips_sorted(s) if c["mediaId"] == m["id"] and c["trimStart"] <= t < c["trimEnd"]]
            items.append((m, o, t, f"tl {r2(to_tl(shown[0], t))}" if shown else "已被剪掉"))
    if not items:
        return [text_block("目前沒有標註。")]
    off = int(a.get("offset", 0))
    page = items[off: off + int(a.get("max", 6))]
    blocks = [text_block(f"標註 {off + 1}–{off + len(page)} / {len(items)}（每格疊上當時所有標註並套用縮放 = 成品畫面）")]
    by_media = {}
    for m, o, t, tl in page:
        by_media.setdefault(m["id"], (m, []))[1].append((o, t, tl))
    for mid, (m, pts) in by_media.items():
        times, labels, layers, zooms = [], [], [], []
        for o, t, tl in pts:
            active = [x for x in m.get("overlays") or [] if x["start"] <= t < x["end"]]
            sc, zx, zy = zoom_state(m.get("zooms"), t)
            times.append(t)
            labels.append(f"{o['kind']} {o.get('text') or ''} {tl}".strip())
            layers.append(active)
            zooms.append({"x": zx, "y": zy, "scale": sc} if sc > 1.0005 else None)
        res = client().request("/observe/frames", {"mediaId": mid, "times": times, "labels": labels, "overlays": layers,
                                                    "zooms": zooms, "zoomMode": "crop", "cols": 2, "thumbWidth": 640})
        blocks += [text_block(media_name(s, mid)), image_block(res["path"])]
    return blocks


HTML_GUIDE = """LJ Cut 自訂 HTML 動畫撰寫規則（kind=html）

畫面與座標
- 設計畫面高 1080 px，寬依素材比例：16:9 為 1920×1080（ljcut_status 的素材解析度可推算：寬 = 1080 × 寬/高）。
- 背景必須透明（不要幫 body 上底色），只畫要疊上去的東西；用 position:absolute 定位。
- layer：screen（預設）固定在畫面上，適合片頭字卡、標題；content 會跟著畫面縮放一起放大，適合標在介面元素上的動畫。

時間（最重要）
- 動畫的 0 秒 = 這個疊加層的 start；LJ Cut 會暫停所有動畫並跳到指定秒數逐格截圖，所以必須能「跳到任意時間」：
  1. 優先用 CSS @keyframes / transition（用 animation-delay 排時間），或 Web Animations API（element.animate）。
  2. 需要 JS 計算時（數字跳動、逐字打字），定義 window.ljcutSeek = (t) => { …依 t 直接算出畫面… }，可回傳 Promise。
  3. 不要用 setTimeout / setInterval / requestAnimationFrame 搭配時鐘推進，也不要依賴 Date.now() — 匯出時不會動。
- 進出場自己做（例如最後 0.3 秒淡出）；LJ Cut 不會替 HTML 加淡入淡出。

限制
- 不能載入任何外部資源（網路被封鎖）：圖片請用 data: URI 或 inline SVG；字型用系統字型，中文建議 "Microsoft JhengHei"。
- 每段最多 60 秒、200K 字元；匯出時每秒約需 3–4 秒渲染（原解析度逐格截圖），長段落會讓匯出明顯變慢。
- 風格建議與模板一致：主色 #FF3B30（紅）/#FFCC00（黃）/#0A84FF（藍），深色半透明底 rgba(18,20,28,.88)，圓角 12–16px。

範例（片頭字卡：標題滑入、底線展開、2.6 秒淡出）
<style>
.card{position:absolute;left:120px;bottom:140px;padding:28px 40px;border-radius:16px;background:rgba(18,20,28,.88);
  font-family:"Microsoft JhengHei";color:#fff;animation:in .5s ease-out both, out .4s ease-in 2.6s both}
.card h1{margin:0;font-size:64px}.card .bar{height:8px;background:#FFCC00;border-radius:4px;margin-top:12px;
  transform-origin:left;animation:bar .6s ease-out .3s both}
@keyframes in{from{opacity:0;transform:translateX(-60px)}}@keyframes out{to{opacity:0}}
@keyframes bar{from{transform:scaleX(0)}}
</style>
<div class="card"><h1>共用參數設定</h1><div class="bar"></div></div>
"""


def t_html_guide(_):
    return [text_block(HTML_GUIDE)]


def t_html_preview(a):
    """套用前試看：把一段 HTML 動畫疊在素材上，取幾個時間點（相對動畫起點的秒數）的畫面。"""
    s = state()
    mid = a.get("mediaId") or main_media_id(s)
    m = next(m for m in s["mediaItems"] if m["id"] == mid)
    start = float(a.get("start", 0))
    times = [float(t) for t in (a.get("times") or [0.2, 1, 2])][:8]
    o = {"id": "preview", "kind": "html", "start": start, "end": min(m["info"]["duration"], start + max(times) + 1),
         "html": a["html"], "layer": a.get("layer", "screen")}
    res = client().request("/observe/frames", {"mediaId": mid, "times": [start + t for t in times],
                                                "labels": [f"動畫 {t}s" for t in times], "overlays": [[o]] * len(times),
                                                "cols": 2, "thumbWidth": 640})
    return [text_block(f"{media_name(s, mid)}：HTML 動畫試看（素材 {start}s 起；尚未加入專案）"), image_block(res["path"])]


def t_check_zooms(a):
    """每個縮放區段取中間一格：左=原畫面＋紅框（放大範圍），右=實際放大後的畫面。"""
    s = state()
    items = []
    for m in s["mediaItems"]:
        for z in m.get("zooms") or []:
            mid_t = (z["start"] + z["end"]) / 2
            shown = [c for c in clips_sorted(s) if c["mediaId"] == m["id"] and c["trimStart"] <= mid_t < c["trimEnd"]]
            tl = f"tl {r2(to_tl(shown[0], mid_t))}" if shown else "已被剪掉"
            items.append((m["id"], z, mid_t, tl))
    if not items:
        return [text_block("目前沒有縮放區段。")]
    off = int(a.get("offset", 0))
    page = items[off: off + int(a.get("max", 6))]
    blocks = [text_block(f"縮放 {off + 1}–{off + len(page)} / {len(items)}")]
    by_media = {}
    for mid, z, t, tl in page:
        by_media.setdefault(mid, []).append((t, z, tl))
    for mid, pts in by_media.items():
        times = [t for t, _, _ in pts]
        zooms = [{"x": z["x"], "y": z["y"], "scale": z["scale"]} for _, z, _ in pts]
        # 紅框與放大畫面是不同模式，分兩張拼圖（同順序）
        res_box = client().request("/observe/frames", {"mediaId": mid, "times": times, "zooms": zooms, "zoomMode": "box",
                                                        "labels": [f"{z['id'][:8]} {tl}" for _, z, tl in pts],
                                                        "cols": 3, "thumbWidth": 400})
        res_crop = client().request("/observe/frames", {"mediaId": mid, "times": times, "zooms": zooms, "zoomMode": "crop",
                                                         "labels": [f"{z['id'][:8]} {z['scale']}x" for _, z, _ in pts],
                                                         "cols": 3, "thumbWidth": 400})
        blocks += [text_block(f"{media_name(s, mid)}：原畫面＋紅框（放大範圍）"), image_block(res_box["path"]),
                   text_block("同順序：成品看到的放大畫面"), image_block(res_crop["path"])]
    return blocks


# ───────────────────────── 工具宣告 ─────────────────────────
NUM = {"type": "number"}
OPS_DOC = (
    "剪輯操作陣列（依序執行；時間為來源素材秒數 src，區間左閉右開）。每個操作需 type；\n"
    "有 start/at 的操作可省略 clipId，系統依來源時間自動找片段（多素材時可加 mediaId）。"
    "move_clip / delete_clip / edit_subtitle / delete_subtitle 需 clipId：\n"
    "- ripple_delete {start,end}：刪除區間，後面自動往前補\n"
    "- set_speed {start,end,speed}：區間加速 1–5 倍（螢幕教學的等待/操作過程很適合用加速代替刪除）\n"
    "- split {at}：在來源秒數分割片段\n"
    "- move_clip {toIndex}：把片段移到時間軸第 N 個位置（片頭片尾固定）\n"
    "- delete_clip：刪除整個片段\n"
    "- add_subtitle {start,end,text} / edit_subtitle {segmentId,text} / delete_subtitle {segmentId}\n"
    "- add_zoom {start,end,x,y,scale,ease?}：畫面放大（x/y 為放大中心，畫面比例 0–1；scale 1.1–4，教學常用 1.6–2.2；"
    "ease 進出場秒數預設 0.4）。存在素材上，之後剪片會跟著內容走；同一素材的區段不可重疊\n"
    "- edit_zoom {zoomId, start?,end?,x?,y?,scale?,ease?} / delete_zoom {zoomId}\n"
    "- add_overlay {kind,start,end,...}：標註疊加層，可多層重疊（後加的在上層），存在素材上、跟著剪輯與縮放走。kind：\n"
    "    box {x,y,w,h,text?}=醒目框（x,y 左上角）；spotlight {x,y,w,h,text?}=聚光燈（框外變暗）；"
    "arrow {x,y,from?,text?}=箭頭（x,y 為尖端，from 為箭尾方向 right/left/top/bottom/top-right/top-left/bottom-right/bottom-left，預設 bottom-right）；"
    "step {x,y,text}=步驟編號圓圈（text 最多 3 字）；title {text,sub?,position?}=標題條（bottom-left/bottom-center/top-left/top-center）\n"
    "    共用：color red/yellow/blue/green/white（預設紅，標題預設黃）；座標皆為畫面比例 0–1；text 單行最多 40 字。"
    "一次說明一件事，同時出現的標註別超過 2–3 個\n"
    "- edit_overlay {overlayId, 任一欄位} / delete_overlay {overlayId}\n"
    "- add_overlay kind=media {start,end,assetId,x,y,w?,offset?,loop?,volume?,shape?,border?,shadow?,layer?}：子母畫面（疊圖片或另一支影片）。"
    "先用 ljcut_import_asset 匯入取得 assetId；x,y 為左上角、w 為畫面寬度比例（預設 0.3，高度依素材比例；circle 為正方形）；"
    "offset 影片從第幾秒開始、loop 循環、volume 0–1（預設 0 靜音）；shape rounded（預設）/circle（適合視訊鏡頭）/rect；"
    "border 外框顏色或 none（預設 white）；shadow 預設 true；layer screen（預設，固定）/content（跟著縮放）。影片與主素材 1:1 同步播放\n"
    "- add_overlay kind=html {start,end,html,layer?,text?}：自訂 HTML 動畫（模板做不到時才用，例如片頭字卡、數字跳動、流程圖逐步出現）。"
    "規則見 ljcut_html_guide；套用前可先用 ljcut_html_preview 看幾個時間點的畫面\n"
    "需要 clipId 的操作若要指向同批剛分割出的新片段，先 dry-run 一次取得新 clipId。"
)
TOOLS = [
    ("ljcut_status", "讀取目前專案：素材、時間軸片段（clipId、tl/src 範圍、倍速）、辨識狀態、可否 undo。剪輯前先呼叫。",
     {}, [], t_status),
    ("ljcut_transcript", "讀取時間軸上的字幕逐字稿，每行含 tl（成品時間）、clip、seg、src（來源時間）。剪輯判斷的主要依據。",
     {"clipId": {"type": "string", "description": "只看某個片段（選填）"}}, [], t_transcript),
    ("ljcut_frames", "看畫面：指定時間點各抓一格拼成一張圖。domain=timeline 用時間軸秒數（預設），source 用素材秒數。最多 24 點。",
     {"times": {"type": "array", "items": NUM}, "domain": {"type": "string", "enum": ["timeline", "source"]},
      "mediaId": {"type": "string"}, "cols": NUM,
      "grid": {"type": "boolean", "description": "疊上 0.1 間距座標格線，判斷縮放中心時用"}}, ["times"], t_frames),
    ("ljcut_overview", "整支素材平均取樣 N 格（預設 12）的縮圖拼圖，快速了解影片在做什麼。", {"mediaId": {"type": "string"}, "count": NUM}, [], t_overview),
    ("ljcut_silences", "列出素材的靜音區間（來源秒數）。注意：螢幕教學安靜時常是操作過程，不要直接刪。",
     {"mediaId": {"type": "string"}, "noiseDb": NUM, "minSilence": NUM}, [], t_silences),
    ("ljcut_scenes", "列出畫面明顯變化的時間點（視窗切換、跳轉、大幅捲動），threshold 0.01–0.95 越小越敏感。",
     {"mediaId": {"type": "string"}, "threshold": NUM}, [], t_scenes),
    ("ljcut_audio_levels", "每 N 秒的音量長條圖，看出講話、安靜、音樂段落。", {"mediaId": {"type": "string"}, "window": NUM}, [], t_audio),
    ("ljcut_transcribe", "對素材做語音辨識並把字幕放進時間軸上該素材的片段。fast=true 約 4 倍速但專有名詞較不準。可 undo。",
     {"mediaId": {"type": "string"}, "fast": {"type": "boolean"}, "language": {"type": "string"}}, [], t_transcribe),
    ("ljcut_plan", "試算（dry-run）一批剪輯，不會改動專案；回傳每個變更與 dryRunId。" + OPS_DOC,
     {"operations": {"type": "array", "items": {"type": "object"}}}, ["operations"], t_plan),
    ("ljcut_apply", "套用 ljcut_plan 的結果。必須先把變更摘要給使用者並取得明確同意，userConfirmed 才能填 true。一批 = 一次 undo。",
     {"dryRunId": {"type": "string"}, "userConfirmed": {"type": "boolean"}}, ["dryRunId", "userConfirmed"], t_apply),
    ("ljcut_check_cuts", "檢查剪接：每個片段接縫前後各取一格畫面，看接得順不順。", {"max": NUM, "offset": NUM}, [], t_check_cuts),
    ("ljcut_cursor", "讀取 LJ Cut 錄影時記下的滑鼠點擊（來源秒數、畫面比例座標），並給自動縮放建議（可直接當 ljcut_plan 的 operations）。"
     "沒有游標紀錄的素材請用 ljcut_frames grid=true 自己判斷位置。", {"mediaId": {"type": "string"}}, [], t_cursor),
    ("ljcut_html_guide", "自訂 HTML 動畫（add_overlay kind=html）的撰寫規則與範例：畫面大小、時間控制、限制。寫 HTML 動畫前先讀。",
     {}, [], t_html_guide),
    ("ljcut_html_preview", "套用前試看 HTML 動畫：疊在素材 start 秒起，取 times（相對動畫起點的秒數）幾個時間點的畫面，不會改動專案。",
     {"html": {"type": "string"}, "start": NUM, "times": {"type": "array", "items": NUM}, "mediaId": {"type": "string"},
      "layer": {"type": "string", "enum": ["screen", "content"]}}, ["html"], t_html_preview),
    ("ljcut_check_overlays", "檢查標註：每個標註取一格，疊上當時所有標註並套用縮放（＝成品畫面），確認位置有沒有框對、文字是否清楚、有沒有擋到重點。",
     {"max": NUM, "offset": NUM}, [], t_check_overlays),
    ("ljcut_check_zooms", "檢查縮放：每個縮放區段中間一格：一張原畫面＋紅框、一張放大後實際畫面，確認放大的位置對不對、字看不看得清楚。",
     {"max": NUM, "offset": NUM}, [], t_check_zooms),
    ("ljcut_undo", "復原上一批變更（與 LJ Cut 介面共用 Ctrl+Z 堆疊）。", {}, [], t_undo),
    ("ljcut_redo", "重做。", {}, [], t_redo),
    ("ljcut_preview", "讓 LJ Cut 播放器跳到時間軸某秒並暫停（使用者畫面會跟著動）。", {"time": NUM}, ["time"], t_preview),
    ("ljcut_import_asset", "匯入子母畫面素材：工作區內的圖片（PNG/JPG/WebP/BMP）或影片（MP4/MOV/MKV/WebM/AVI/WMV/GIF），回傳 assetId；不會放上主時間軸。",
     {"path": {"type": "string"}}, ["path"], t_import_asset),
    ("ljcut_import", "匯入工作區內的影片/音訊（相對路徑），接在時間軸最後。", {"path": {"type": "string"}}, ["path"], t_import),
    ("ljcut_save", "另存專案（工作區相對路徑，副檔名 .ljcut，不覆寫）。", {"path": {"type": "string"}}, ["path"], t_save),
    ("ljcut_open", "開啟工作區內的 .ljcut 專案（會取代目前時間軸）。", {"path": {"type": "string"}}, ["path"], t_open),
    ("ljcut_export", "匯出成品影片（預設乾淨畫面不燒字幕）。wait=true 會等到完成並回傳路徑。",
     {"burnSubtitles": {"type": "boolean"}, "wait": {"type": "boolean"}, "timeoutSeconds": NUM}, [], t_export),
    ("ljcut_job", "查詢匯出工作狀態。", {"jobId": {"type": "string"}}, ["jobId"], t_job),
]
HANDLERS = {name: fn for name, _, _, _, fn in TOOLS}


def tool_list():
    return [{"name": n, "description": d, "inputSchema": {"type": "object", "properties": p, "required": r}}
            for n, d, p, r, _ in TOOLS]


# ───────────────────────── JSON-RPC over stdio ─────────────────────────
def reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    msg["error" if error else "result"] = error or result
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:      # notification
        return
    if method == "initialize":
        reply(mid, {"protocolVersion": msg.get("params", {}).get("protocolVersion", PROTOCOL),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "ljcut", "version": "0.3.0"},
                    "instructions": "LJ Cut 影片剪輯器。流程：ljcut_status → ljcut_transcript / ljcut_overview / ljcut_frames 理解內容 → "
                                    "ljcut_plan 試算 → 摘要給使用者確認 → ljcut_apply → ljcut_check_cuts 驗證 → ljcut_export。"
                                    "畫面放大：LJ Cut 錄影先用 ljcut_cursor 取得依點擊的建議，其他素材用 ljcut_frames grid=true 判斷位置；"
                                    "add_zoom 試算套用後用 ljcut_check_zooms 確認位置。"
                                    "標註（醒目框/箭頭/聚光燈/步驟/標題）：先用 ljcut_frames grid=true 找座標（有游標紀錄時可參考 ljcut_cursor 的點擊位置），"
                                    "add_overlay 套用後用 ljcut_check_overlays 確認。"
                                    "刪除與加速都要使用者確認；靜音不等於可刪。"})
    elif method == "ping":
        reply(mid, {})
    elif method == "tools/list":
        reply(mid, {"tools": tool_list()})
    elif method == "tools/call":
        p = msg.get("params", {})
        fn = HANDLERS.get(p.get("name"))
        if not fn:
            reply(mid, error={"code": -32602, "message": f"未知工具 {p.get('name')}"})
            return
        try:
            reply(mid, {"content": fn(p.get("arguments") or {})})
        except Exception as e:  # 工具錯誤回給模型看，不中斷 server
            reply(mid, {"content": [text_block(f"錯誤：{e}")], "isError": True})
    else:
        reply(mid, error={"code": -32601, "message": f"不支援的方法 {method}"})


def main():
    global WORKSPACE
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default=str(Path(__file__).resolve().parent.parent / "app_data" / "control"))
    WORKSPACE = Path(ap.parse_args().workspace).resolve()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception:
            sys.stderr.write(traceback.format_exc())


if __name__ == "__main__":
    _ = uuid  # 保留：請求 ID 由 Client 產生
    main()
