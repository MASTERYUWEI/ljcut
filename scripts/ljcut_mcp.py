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
                                                    "labels": [p[1] for p in pts], "cols": a.get("cols", 4)})
        blocks += [text_block(f"{media_name(s, mid)}：{len(pts)} 格"), image_block(res["path"])]
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
    for o in ops:
        if "type" not in o and "op" in o:
            o["type"] = o.pop("op")
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
    "需要 clipId 的操作若要指向同批剛分割出的新片段，先 dry-run 一次取得新 clipId。"
)
TOOLS = [
    ("ljcut_status", "讀取目前專案：素材、時間軸片段（clipId、tl/src 範圍、倍速）、辨識狀態、可否 undo。剪輯前先呼叫。",
     {}, [], t_status),
    ("ljcut_transcript", "讀取時間軸上的字幕逐字稿，每行含 tl（成品時間）、clip、seg、src（來源時間）。剪輯判斷的主要依據。",
     {"clipId": {"type": "string", "description": "只看某個片段（選填）"}}, [], t_transcript),
    ("ljcut_frames", "看畫面：指定時間點各抓一格拼成一張圖。domain=timeline 用時間軸秒數（預設），source 用素材秒數。最多 24 點。",
     {"times": {"type": "array", "items": NUM}, "domain": {"type": "string", "enum": ["timeline", "source"]},
      "mediaId": {"type": "string"}, "cols": NUM}, ["times"], t_frames),
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
    ("ljcut_undo", "復原上一批變更（與 LJ Cut 介面共用 Ctrl+Z 堆疊）。", {}, [], t_undo),
    ("ljcut_redo", "重做。", {}, [], t_redo),
    ("ljcut_preview", "讓 LJ Cut 播放器跳到時間軸某秒並暫停（使用者畫面會跟著動）。", {"time": NUM}, ["time"], t_preview),
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
