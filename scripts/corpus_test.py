"""逐格驗證匯出（點子來自 Concat 的 corpus；程式為 LJCUT 自寫）。

在暫存資料夾開一個獨立後端（不開桌面程式、不碰使用者的工作區與 .ljcut-control.json），
用 scripts/corpus/framecode.py 產生「每格寫著自己是誰、每秒有一聲嗶」的素材，
依 scripts/corpus/cases.py 的案例排時間軸、走控制 API 匯出，再逐格讀回核對：
  - 每格是不是正確素材的正確那一格（差一格、黑格、重複格、跳格都會抓到）
  - 每聲嗶是不是在正確的時間、正確的素材（音畫不同步、聲音少一段都會抓到）
  - 雙胞胎做法、存檔重開後的成品是否逐格相同
證據在 reports/corpus/<時間>/<案例>/。全部通過結束碼 0，否則 1。

    backend\\venv\\Scripts\\python.exe scripts\\corpus_test.py [案例名 ...]
"""
from __future__ import annotations

import ctypes
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

if sys.platform == "win32":
    ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(-1), 0x4000)   # 低優先權：機器同時跑 Revit
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "corpus"))
import framecode as F  # noqa: E402
from cases import CASES  # noqa: E402

PY = ROOT / "backend" / "venv" / "Scripts" / "python.exe"
FLAGS = F.FLAGS


class Backend:
    """暫存資料夾裡的獨立後端，結束時只關自己開的程序。"""

    def __enter__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ljcut-corpus-"))
        self.ws = self.tmp / "workspace"; self.ws.mkdir()
        (self.tmp / "data").mkdir()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
        env = {**os.environ, "LJCUT_DATA_DIR": str(self.tmp / "data"), "LJCUT_CONTROL_WORKSPACE": str(self.ws), "PYTHONUTF8": "1"}
        self.log = open(self.tmp / "backend.log", "w", encoding="utf-8")
        # LJCUT_CORPUS_BACKEND＝打包後的 ljcut-backend.exe：發版前確認凍結版也帶到這次的修正
        exe = os.environ.get("LJCUT_CORPUS_BACKEND")
        cmd = [exe] if exe else [str(PY), str(ROOT / "backend" / "server_entry.py")]
        self.proc = subprocess.Popen([*cmd, "--port", str(port)], cwd=str(ROOT / "backend"),
                                     env=env, stdout=self.log, stderr=subprocess.STDOUT, creationflags=FLAGS)
        self.base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 90
        while True:
            try:
                urllib.request.urlopen(self.base + "/health", timeout=2); break
            except Exception:
                if self.proc.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("後端沒有起來，見 " + str(self.tmp / "backend.log"))
                time.sleep(0.5)
        req = urllib.request.Request(self.base + "/api/control/connect", method="POST", data=b"{}",
                                     headers={"Origin": "http://localhost:5173", "Content-Type": "application/json"})
        self.token = json.loads(urllib.request.urlopen(req, timeout=10).read())["token"]
        return self

    def api(self, path, body=None):
        req = urllib.request.Request(self.base + "/api/control" + path, method="POST" if body is not None else "GET",
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{path}：{e.code} {e.read().decode('utf-8', 'replace')[:400]}") from None

    def export(self, project) -> Path:
        job = self.api("/export", {"project": project, "revision": 1})
        deadline = time.monotonic() + 300
        while job.get("status") in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.3); job = self.api(f"/jobs/{job['id']}")
        if job.get("status") != "completed":
            raise RuntimeError(f"匯出失敗：{job.get('error')}")
        return Path(job["outputPath"])

    def __exit__(self, *exc):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()
        shutil.rmtree(self.tmp, ignore_errors=True)


def build_project(name, clips, media_items):
    """把案例的片段排成連續時間軸（和 LJ Cut 存的專案同格式）。"""
    tl, out = 0.0, []
    for i, c in enumerate(clips):
        a, b = c["trim"]; sp = c.get("speed", 1)
        clip = {"id": f"{name}-{i}", "mediaId": media_items[c["media"]]["id"], "trackIndex": 0, "startTime": tl,
                "trimStart": a, "trimEnd": b, "speed": sp, "duration": (b - a) / sp, "segments": []}
        if c.get("bookend"):
            clip["bookend"] = c["bookend"]
        if c.get("transition"):
            clip["transitionIn"] = c["transition"]
        out.append(clip); tl += clip["duration"]
    return {"schemaVersion": 1, "projectId": f"corpus-{name}", "language": "zh",
            "subtitleStyle": {"fontName": "Arial", "fontSize": 30, "posY": 90},
            "mediaItems": list({m["id"]: m for m in media_items.values()}.values()), "timelineClips": out}


def expected_frames(clips, specs, fps_out):
    """每一格「應該」是哪個素材的第幾格（以預覽的定義：顯示時間點 ≤ t 的最後一格）。轉場範圍內允許讀不出來。"""
    exp, tl, fuzzy = [], 0.0, set()
    bounds = []
    for c in clips:
        a, b = c["trim"]; sp = c.get("speed", 1); dur = (b - a) / sp
        bounds.append((tl, tl + dur, c))
        if c.get("transition"):
            half = c["transition"]["duration"] / 2
            fuzzy.update(range(math.floor((tl - half) * fps_out) - 1, math.ceil((tl + half) * fps_out) + 1))
        tl += dur
    total = math.ceil(tl * fps_out - 1e-6)   # 起點落在影片長度內的每一格都算（最後一格可能不滿一格）
    for k in range(total):
        t = (k + 1e-6) / fps_out
        for s, e, c in bounds:
            if s - 1e-9 <= t < e:
                spec = specs[c["media"]]; fps_src = spec.get("fps", 30)
                src = c["trim"][0] + (t - s) * c.get("speed", 1)
                last = round(spec["seconds"] * fps_src) - 1   # 超過畫面尾端（聲音比畫面長）時預覽停在最後一格
                exp.append((spec["tag"], min(last, math.floor(src * fps_src + 1e-6))))
                break
        else:
            exp.append(None)
    return exp, fuzzy


def expected_pips(clips, specs):
    out, tl, fuzzy = [], 0.0, []
    for c in clips:
        a, b = c["trim"]; sp = c.get("speed", 1)
        if c.get("transition"):
            half = c["transition"]["duration"] / 2
            fuzzy.append((tl - half - 0.05, tl + half + 0.05))
        for s in range(math.ceil(a - 1e-6), math.ceil(b - 1e-6)):
            out.append((tl + (s - a) / sp, specs[c["media"]]["tag"]))
        tl += (b - a) / sp
    return out, fuzzy


def check_case(be: Backend, case, evidence: Path) -> dict:
    name = case["name"]
    d = evidence / name; d.mkdir(parents=True, exist_ok=True)
    specs = case["media"]
    items = {}
    for key, spec in specs.items():
        p = F.make_media(be.ws / f"{name}-{key}.mp4", spec["tag"], spec["seconds"], spec.get("fps", 30), audio_seconds=spec.get("audio_seconds"))
        items[key] = be.api("/media", {"path": p.name})
    project = build_project(name, case["clips"], items)
    out = be.export(project)
    shutil.copyfile(out, d / "export.mp4")
    codes, fps_out, _ = F.read_video(out)
    exp, fuzzy = expected_frames(case["clips"], specs, fps_out)
    tol = case.get("tol", 0)
    problems = []
    if len(codes) != len(exp):
        problems.append(f"影格數 {len(codes)}，應為 {len(exp)}")
    for k, (got, want) in enumerate(zip(codes, exp)):
        if k in fuzzy and (got is None or got == want or (want and got and got[0] in {s['tag'] for s in specs.values()})):
            continue
        if got == want or (got and want and got[0] == want[0] and abs(got[1] - want[1]) <= tol):
            continue
        problems.append(f"第 {k} 格（{k / fps_out:.3f}s）讀到 {fmt(got)}，應為 {fmt(want)}")
    # 聲音
    pips = F.read_pips(out)
    want_pips, pfuzzy = expected_pips(case["clips"], specs)
    slack = 1.5 / fps_out
    used = set()
    for t, tag in want_pips:
        if any(a <= t <= b for a, b in pfuzzy):
            continue
        hit = next((i for i, (pt, ptag) in enumerate(pips) if i not in used and abs(pt - t) <= slack), None)
        if hit is None:
            near = min(pips, key=lambda p: abs(p[0] - t), default=None)
            problems.append(f"嗶（素材 {tag}）應在 {t:.3f}s，" + (f"最近的在 {near[0]:.3f}s（差 {(near[0] - t) * 1000:+.0f}ms）" if near else "整段沒有聲音"))
        else:
            used.add(hit)
            if pips[hit][1] != tag:
                problems.append(f"{t:.3f}s 的嗶音高是素材 {pips[hit][1]}，應為 {tag}")
    extra = [p for i, p in enumerate(pips) if i not in used and not any(a <= p[0] <= b for a, b in pfuzzy)]
    for pt, ptag in extra:
        problems.append(f"多出一聲嗶：{pt:.3f}s（素材 {ptag}）")
    # 雙胞胎與存檔重開
    for twin, clips in (case.get("twins") or {}).items():
        tout = be.export(build_project(f"{name}-{twin}", clips, items))
        tcodes, _, _ = F.read_video(tout)
        diff = [k for k, (x, y) in enumerate(zip(codes, tcodes)) if x != y] + ([-1] if len(codes) != len(tcodes) else [])
        if diff:
            problems.append(f"和雙胞胎「{twin}」不同：第 {diff[:5]} 格")
    if case.get("reopen"):
        be.api("/save", {"path": f"{name}.ljcut", "project": project})
        reopened = be.api("/open", {"path": f"{name}.ljcut"})
        rcodes, _, _ = F.read_video(be.export(reopened))
        if rcodes != codes:
            problems.append("存檔重開後匯出的成品和原本不同")
    res = {"case": name, "about": case["about"], "fps": fps_out, "frames": len(codes), "pips": len(pips),
           "unreadable": sum(c is None for c in codes), "ok": not problems, "problems": problems[:40], "more": max(0, len(problems) - 40)}
    (d / "result.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    return res


def fmt(c):
    return "讀不出來" if c is None else f"素材{c[0]}第{c[1]}格"


def main():
    only = set(sys.argv[1:])
    evidence = ROOT / "reports" / "corpus" / time.strftime("%Y%m%d-%H%M%S")
    results = []
    with Backend() as be:
        for case in CASES:
            if only and case["name"] not in only:
                continue
            t0 = time.monotonic()
            try:
                r = check_case(be, case, evidence)
            except Exception as e:   # 單一案例壞掉不影響其他案例
                r = {"case": case["name"], "ok": False, "problems": [f"執行失敗：{e}"]}
            r["seconds"] = round(time.monotonic() - t0, 1)
            results.append(r)
            print(("✅ " if r["ok"] else "❌ ") + f"{r['case']}（{r['seconds']}s）")
            for p in r.get("problems", [])[:8]:
                print("     " + p)
    (evidence / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"證據：{evidence}")
    sys.exit(0 if all(r["ok"] for r in results) else 1)


if __name__ == "__main__":
    main()
