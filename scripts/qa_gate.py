"""成品出貨前的硬檢查（不過關就不上傳）：python qa_gate.py <video.mp4> [subtitles.srt] [--asr asr.json] [--json out.json]

每一項都對應使用者審片時實際抓到過的錯（來源寫在 CHECKS 說明）。只做程式判斷得了的事，不靠模型自評。
  black      片中黑格（片頭 0.5 秒淡入、片尾 3 秒淡出除外）                    ← EP15 v2「前 20 秒一堆黑色閃爍」
  blank      旁白進行中，畫面卻幾乎是空的（≥0.8 秒）                           ← EP15 v4「提早轉場、畫面空白還在唸」
  level      觀念動畫裡唸到「粗糙／中等／細緻」時，右上角亮的等級不是同一級     ← EP15 v3「唸三級跟背景動畫不一致」
  streams    影格數、影像長度、聲音長度互相對得上                              ← EP13「concat -c copy 掉影像、聲畫不同步」
  terms      （有 --asr 時）字幕裡的專有名詞，反聽有沒有聽到                    ← EP15「線槽唸成線條」、EP11「1F 唸成ㄟ夫」
回傳碼：0 全部通過；1 有不通過；2 檢查本身無法完成（解碼失敗、字幕壞掉，也算不通過）。backend venv 執行（需要 numpy）。
"""
__import__('ctypes').windll.kernel32.SetPriorityClass(__import__('ctypes').c_void_p(-1), 0x4000)
import argparse, json, re, subprocess, sys
from pathlib import Path
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
FPS = 5                      # 取樣頻率（blank、level 用）
W, H = 384, 216              # 取樣解析度（1920x1080 的 1/5）
BG = np.array([244, 243, 239], float)   # 觀念動畫／字卡的米白底 #F4F3EF
LEVELS = ["粗糙", "中等", "細緻"]
CHIP_X = [1519, 1639, 1757]  # 觀念動畫右上角三顆等級標示的中心（1920 座標；bl_build15.py .chips）
CHIP_Y = 92                  # 標示外框約 105×59：外框（含框線）判斷看不看得到，內框判斷亮不亮
TERMS = ["線槽", "電管", "風管", "水管", "彎頭", "粗糙", "中等", "細緻", "可見性", "族群", "品類", "樓層", "視圖樣板"]


TERMS += ["1F", "2F", "3F", "Revit", "BIM", "VG"]
TERMS += ["線架構", "隱藏線", "描影", "擬真", "材質", "篩選器", "機械設定", "領域", "間隙"]   # EP16
CONFUSE = {"線槽": ["線條"], "1F": ["A夫", "欸夫", "ㄟ夫"], "2F": ["2夫"], "族群": ["祖群"], "品類": ["品累"]}   # 聽到這些錯音直接不通過（真的唸錯過的）
LEVEL_RE = re.compile(r"(?:切到|切回|切成|切|現在是|在|先切|改成)?(粗糙|中等|細緻)(?=[、，。：；]|時|的時候|$)[、，。：；]?")


class GateError(Exception):
    pass


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def srt_cues(p):
    out = []
    if not p or not Path(p).is_file(): return out
    if str(p).endswith(".json"):   # 組裝腳本的 cues.json（匯出前先檢查 body.mp4 用）
        return [(q["start"], q["end"], q["text"]) for q in json.loads(Path(p).read_text(encoding="utf-8"))]
    t = lambda s: (lambda h, m, r: int(h) * 3600 + int(m) * 60 + float(r.replace(",", ".")))(*s.strip().split(":"))
    for k, b in enumerate(re.split(r"\n\s*\n", Path(p).read_text(encoding="utf-8-sig").strip()), 1):
        ln = b.strip().splitlines()
        if len(ln) < 3: continue
        try:
            a, e = ln[1].split("-->")
            out.append((t(a), t(e), "".join(ln[2:]).strip()))
        except Exception:
            raise GateError(f"字幕第 {k} 條時間格式壞掉：{ln[1]!r}")
    return out


def probe(video):
    r = run(["ffprobe", "-v", "error", "-count_packets", "-show_entries", "stream=codec_type,duration,nb_read_packets,r_frame_rate,start_time:stream_disposition=attached_pic",
             "-show_entries", "format=duration", "-of", "json", str(video)])
    if r.returncode: raise GateError("ffprobe 失敗：" + r.stderr[-300:])
    return json.loads(r.stdout)


def frames(video, dur):
    """FPS 張/秒的 RGB 縮圖（W×H），回傳 (n,H,W,3) uint8。解碼失敗或格數不足就丟錯（不可以「沒畫面就通過」）。"""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={FPS},scale={W}:{H}:flags=area", "-f", "rawvideo",
                        "-pix_fmt", "rgb24", "-"], capture_output=True)
    if r.returncode: raise GateError("ffmpeg 解碼失敗：" + r.stderr[-300:].decode("utf-8", "replace"))
    a = np.frombuffer(r.stdout, np.uint8)
    fr = a[: a.size // (W * H * 3) * W * H * 3].reshape(-1, H, W, 3)
    if abs(len(fr) - dur * FPS) > max(3, 0.01 * dur * FPS): raise GateError(f"解出 {len(fr)} 格，預期約 {dur * FPS:.0f} 格")
    return fr


def fmt(t):
    return f"{int(t // 60)}:{t % 60:04.1f}"


def check_black(video, dur):
    """片中全黑格。刻意的「淡黑」轉場＝黑格前、後兩邊都已經漸暗；只有一邊暗（硬切接黑格、再淡入）仍算閃爍。"""
    r = run(["ffmpeg", "-v", "info", "-i", str(video), "-vf", "blackdetect=d=0.03:pix_th=0.12", "-an", "-f", "null", "-"])
    bad = []
    def L(t):   # 精確取單格的平均亮度
        p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0, t):.3f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=96:54",
                            "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        return float(np.frombuffer(p, np.uint8).mean()) if p else 0.0
    for m in re.finditer(r"black_start:([\d.]+) black_end:([\d.]+)", r.stderr):
        a, b = float(m.group(1)), float(m.group(2))
        if b <= 0.5 or a >= dur - 3.0: continue
        if L(a - 0.1) < 0.5 * L(a - 1.5) and L(b + 0.1) < 0.5 * L(b + 1.5): continue
        bad.append(f"{fmt(a)}–{fmt(b)}（{b - a:.2f}s）")
    return bad


def detail(fr, chunk=200):
    """畫面細節量：和整張圖中位亮度差 >28 的像素比例（分段算，省記憶體）。空白米白底只有角落小字 ≈0.3%。"""
    out = []
    for i in range(0, len(fr), chunk):
        g = fr[i:i + chunk].mean(axis=3, dtype=np.float32)
        med = np.median(g.reshape(len(g), -1), axis=1)[:, None, None]
        out.append((np.abs(g - med) > 28).reshape(len(g), -1).mean(axis=1))
    return np.concatenate(out) if out else np.zeros(0)


def spans(cues, gap=0.3):
    """把間隔 <gap 秒的字幕合併成連續的旁白區間（字幕切塊很碎，分開算會漏掉跨塊的空白）。"""
    out = []
    for a, b, t in sorted(cues):
        if out and a - out[-1][1] < gap: out[-1] = (out[-1][0], max(out[-1][1], b), out[-1][2] + t)
        else: out.append((a, b, t))
    return out


def check_blank(fr, cues, thr=0.012, need=0.8):
    d = detail(fr); bad = []
    for a, b, txt in spans(cues):
        i0, i1 = int(np.ceil(a * FPS)), int(b * FPS)
        run_start = None
        for i in range(i0, min(i1 + 1, len(d))):
            if d[i] < thr:
                run_start = i if run_start is None else run_start
                if (i - run_start) / FPS >= need:
                    bad.append(f"{fmt(run_start / FPS)} 旁白「{txt[:20]}」時畫面幾乎空白（細節 {d[i] * 100:.1f}%）"); break
            else:
                run_start = None
    return bad


def chips(f):
    """回傳 (是否看得到等級標示, 亮著的等級 set)。f：W×H 的單格。"""
    s = W / 1920; out, vis = set(), 0
    corner = f[int(20 * s):int(40 * s), int(1840 * s):int(1900 * s)].reshape(-1, 3).mean(axis=0)
    if np.abs(corner - BG).max() > 8: return False, out          # 不是觀念動畫的米白底（Revit 畫面、淡化中）
    for k, cx in enumerate(CHIP_X):
        sub = lambda hw, hh: f[int((CHIP_Y - hh) * s):int((CHIP_Y + hh) * s), int((cx - hw) * s):int((cx + hw) * s)].astype(float).mean(axis=2)
        outer, inner = sub(60, 34), sub(36, 16)
        if (outer < 150).mean() > 0.06: vis += 1                     # 框線（或深色底）在
        if inner.mean() < 170: out.add(LEVELS[k])                    # 深色底＝亮著（深底白字縮圖後約 110～150；沒亮的米白底灰字約 225）
    return vis >= 2, out


def said_levels(txt):
    """句首依序唸到的等級（「粗糙、中等…」「切到細緻」「現在是細緻」）。句中其他位置的等級不算（「細緻，牆跟中等一樣」只算細緻）。"""
    said, rest = [], txt
    while True:
        m = LEVEL_RE.match(rest)
        if not m: break
        said.append(m.group(1)); rest = rest[m.end():]
    return said


def check_level(fr, cues):
    """觀念動畫右上角等級標示。回傳 (不通過, 檢查了幾處, 有等級詞但畫面不是觀念動畫、這裡沒檢查的處數)。Revit 段落由 epcheck.tag_level 在組裝時檢查。"""
    bad, n, skip = [], 0, 0
    for a, b, txt in cues:
        said = said_levels(txt)
        if not said: continue
        samples = [int(t * FPS) for t in ((a + b) / 2, b - 0.1) if int(t * FPS) < len(fr)]
        states = [on for vis, on in (chips(fr[i]) for i in samples) if vis]
        if not states: skip += 1; continue
        n += 1
        if not any(set(said) <= on for on in states):
            on = states[0]
            bad.append(f"{fmt((a + b) / 2)} 唸「{txt}」，畫面亮的是「{'、'.join(l for l in LEVELS if l in on) or '無'}」")
    return bad, n, skip


def check_streams(info, dur):
    vs = [s for s in info["streams"] if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")]
    aus = [s for s in info["streams"] if s["codec_type"] == "audio"]
    if not vs or not aus: return ["缺影像或聲音軌"]
    v, a = vs[0], aus[0]; bad = []
    num, den = map(int, v["r_frame_rate"].split("/")); fps = num / den
    vd, ad = float(v.get("duration", dur)), float(a.get("duration", dur)); n = int(v.get("nb_read_packets", 0))
    if abs(n / fps - vd) > 0.25: bad.append(f"影格數 {n}（{n / fps:.2f}s）和影像長度 {vd:.2f}s 對不上")
    if abs(vd - ad) > 0.25: bad.append(f"影像 {vd:.2f}s、聲音 {ad:.2f}s 差 {abs(vd - ad):.2f}s")
    vs0, as0 = float(v.get("start_time", 0) or 0), float(a.get("start_time", 0) or 0)
    if abs(vs0 - as0) > 0.1: bad.append(f"影像起點 {vs0:.2f}s、聲音起點 {as0:.2f}s 不同（整段聲畫偏移）")
    return bad


def check_terms(asr_path, cues):
    """回傳 (確定唸錯〔混淆表裡的錯音〕, 待人工確認)。"""
    words = json.loads(Path(asr_path).read_text(encoding="utf-8"))   # review_video.py 的 asr.json：[[開始, 結束, 字], ...]
    hard, soft = [], []
    for a, b, txt in cues:
        heard = "".join(w[2] for w in words if w[1] > a - 0.4 and w[0] < b + 0.4).replace(" ", "")
        for t in TERMS:
            if t in txt and t not in heard:
                wrong = [x for x in CONFUSE.get(t, []) if x in heard]
                (hard if wrong else soft).append(f"{fmt(a)} 字幕「{txt}」有「{t}」，反聽是「{heard}」" + (f"（聽到錯音「{wrong[0]}」）" if wrong else ""))
    return hard, soft


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("srt", nargs="?"); ap.add_argument("--asr"); ap.add_argument("--json")
    ap.add_argument("--final", action="store_true", help="成品出貨：一定要有 --asr（2026-11-20 EP16 匯出後漏帶反聽，專有名詞沒查）")
    a = ap.parse_args()
    video = Path(a.video)
    if a.srt: srt = Path(a.srt)
    else: srt = next((p for p in (video.with_suffix(".srt"), video.with_name("subtitles.srt")) if p.is_file()), video.with_suffix(".srt"))
    if a.final and not a.asr: raise GateError("成品檢查（--final）一定要帶 --asr 反聽結果，否則專有名詞唸錯查不到")
    cues = srt_cues(srt)
    if not cues: raise GateError(f"讀不到字幕（{srt}）：blank、level 兩項無法檢查")
    info = probe(video); dur = float(info["format"]["duration"])
    fr = frames(video, dur)
    res, warn = {}, {}
    res["black"] = check_black(video, dur)
    res["blank"] = check_blank(fr, cues)
    res["level"], nlev, nskip = check_level(fr, cues)
    res["streams"] = check_streams(info, dur)
    if a.asr: res["terms"], warn["terms"] = check_terms(a.asr, cues)
    print(f"# 出貨檢查：{video.name}（{fmt(dur)}，字幕 {len(cues)} 條；等級對照 {nlev} 處，另 {nskip} 處在 Revit 畫面由組裝時檢查）")
    ok = True
    for k, v in res.items():
        print(f"- {k:8s} {'通過' if not v else '不通過 ' + str(len(v))}")
        for x in v[:12]: print("    " + x)
        ok &= not v
    for k, v in warn.items():
        if v:
            print(f"- {k:8s} 請人工確認 {len(v)}（加速後同音字常聽錯；用原速配音檔再聽一次）")
            for x in v[:12]: print("    " + x)
    if a.json: Path(a.json).write_text(json.dumps({"ok": ok, **res, "warn": warn}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("結果：", "通過" if ok else "不通過")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    try:
        main()
    except GateError as e:
        print("檢查無法完成（當作不通過）：", e); sys.exit(2)
