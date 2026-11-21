"""端到端旅程測試（借鏡 Editkin 的 test:journey，自寫）。

在全新的暫存資料夾啟動一個獨立後端（不開桌面程式、不碰使用者的工作區與 .ljcut-control.json），
用合成影片跑完整條路：匯入 → 剪掉一段＋字幕＋審片意見＋配樂 → 存檔 → 重開 → 匯出（含平台響度）→
用 ffprobe／解出畫面核對成品，證據留在 reports/journey/<時間>/。任何一步不對就結束碼 1。

    backend\\venv\\Scripts\\python.exe scripts\\journey_test.py
"""
from __future__ import annotations

import ctypes
import json
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

if sys.platform == "win32":   # 低優先權：這台機器同時跑 Revit
    ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(-1), 0x4000)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / "backend" / "venv" / "Scripts" / "python.exe"
FLAGS = 0x08000000 if os.name == "nt" else 0
FPS = 30
steps: list[dict] = []


def step(name: str, ok: bool, **detail):
    steps.append({"step": name, "ok": bool(ok), **detail})
    print(("✅ " if ok else "❌ ") + name + (f"　{detail}" if detail else ""))
    if not ok:
        raise SystemExit(1)


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, capture_output=True, creationflags=FLAGS)


def probe(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                                   "stream=nb_read_frames:format=duration", "-of", "json", str(path)], creationflags=FLAGS)
    d = json.loads(out)
    return float(d["format"]["duration"]), int(d["streams"][0]["nb_read_frames"])


def luma(path, t):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-vf", "scale=32:18",
                                   "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], creationflags=FLAGS)
    return sum(raw) / len(raw)


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    evidence = ROOT / "reports" / "journey" / stamp
    evidence.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="ljcut-journey-"))
    data, ws = tmp / "data", tmp / "workspace"
    data.mkdir(); ws.mkdir()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    env = {**os.environ, "LJCUT_DATA_DIR": str(data), "LJCUT_CONTROL_WORKSPACE": str(ws), "PYTHONUTF8": "1"}
    log = open(evidence / "backend.log", "w", encoding="utf-8")
    server = subprocess.Popen([str(PY), str(ROOT / "backend" / "server_entry.py"), "--port", str(port)], cwd=str(ROOT / "backend"),
                              env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=FLAGS)
    base = f"http://127.0.0.1:{port}"
    try:
        # ── 0. 後端起來、拿控制憑證 ──
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(base + "/health", timeout=2); break
            except Exception:
                if server.poll() is not None:
                    step("後端啟動", False, exit=server.returncode)
                time.sleep(0.5)
        else:
            step("後端啟動", False, reason="90 秒內沒有回應")
        # 和編輯器啟動時一樣用 /connect 取得憑證（只在這個暫存工作區，不會碰使用者正在用的控制檔）
        req = urllib.request.Request(base + "/api/control/connect", method="POST", data=b"{}",
                                     headers={"Origin": "http://localhost:5173", "Content-Type": "application/json"})
        token = json.loads(urllib.request.urlopen(req, timeout=10).read())["token"]
        step("後端啟動", True, port=port)

        def api(path, body=None, method=None):
            req = urllib.request.Request(base + "/api/control" + path, method=method or ("POST" if body is not None else "GET"),
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                return {"httpError": e.code, **json.loads(e.read() or b"{}")}

        # ── 1. 合成素材：亮度＝來源秒數（16+18×秒），之後用亮度判斷成品每一刻是來源第幾秒 ──
        src = ws / "journey.mp4"
        ff("-f", "lavfi", "-i", f"color=black:s=320x180:r={FPS}:d=12", "-f", "lavfi", "-i",
           "aevalsrc='if(lt(mod(t,4),2.5),0.15*sin(2*PI*330*t),0)':s=48000:d=12",
           "-vf", "geq=lum='16+floor(T)*18':cb=128:cr=128", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src))
        bgm = ws / "bgm.wav"
        ff("-f", "lavfi", "-i", "aevalsrc='0.2*sin(2*PI*110*t)':s=48000:d=5", "-ac", "2", str(bgm))
        media = api("/media", {"path": src.name})
        music = api("/asset", {"path": bgm.name})
        step("匯入素材與配樂", "id" in media and music.get("type") == "audio", mediaId=media.get("id"), musicType=music.get("type"))

        # ── 2. 剪輯：剪掉來源 4–6 秒（兩個片段）、字幕、審片意見、配樂＋平台響度 ──
        def clip(cid, a, b, tl, segs):
            return {"id": cid, "mediaId": media["id"], "trackIndex": 0, "startTime": tl, "trimStart": a, "trimEnd": b,
                    "duration": b - a, "speed": 1, "segments": segs}
        media["reviewNotes"] = [{"id": "n1", "t": 8.0, "cat": "畫面", "text": "旅程測試的審片意見", "status": "open", "createdAt": 1}]
        mix = {"loudness": "youtube", "music": {"asset": {"id": music["id"], "filename": "bgm.wav", "url": music["url"], "duration": music["duration"]},
               "volume": 0.4, "offset": 0, "loop": True, "fadeIn": 0, "fadeOut": 1, "duck": True, "duckDb": 12, "attack": .25, "release": .6,
               "envelope": [[0, 0], [0.75, 0], [1, -12], [2, -12], [2.6, 0]]}}
        project = {"schemaVersion": 1, "projectId": "journey", "language": "zh", "audioMix": mix,
                   "subtitleStyle": {"fontName": "Arial", "fontSize": 30, "posY": 90},
                   "mediaItems": [media],
                   "timelineClips": [clip("a", 0, 4, 0, [{"id": 0, "start": 1, "end": 2, "text": "第一句"}]),
                                     clip("b", 6, 12, 4, [{"id": 1, "start": 8, "end": 9, "text": "剪接後第二句"}])]}

        # ── 3. 存檔 → 重開：內容一致、配樂與審片意見都在 ──
        saved = api("/save", {"path": "journey.ljcut", "project": project})
        step("存檔", saved.get("projectId") == "journey", saved=saved)
        # 模擬換電腦：清掉 uploads 裡的素材，重開要從專案資料夾還原
        for f in (data / "uploads").glob(f"{media['id']}.*"):
            f.unlink()
        for f in (data / "uploads" / "assets").glob(f"{music['id']}.*"):
            f.unlink()
        opened = api("/open", {"path": "journey.ljcut"})
        same = ([c["trimStart"] for c in opened.get("timelineClips", [])] == [0, 6]
                and opened.get("audioMix", {}).get("music", {}).get("asset", {}).get("id") == music["id"]
                and opened["mediaItems"][0].get("reviewNotes", [{}])[0].get("text") == "旅程測試的審片意見"
                and (data / "uploads" / "assets" / Path(music["url"]).name).is_file())
        step("重開專案（素材、配樂、審片意見都還原）", same)

        # ── 4. 匯出（乾淨畫面＋SRT＋配樂＋YouTube 響度） ──
        job = api("/export", {"project": opened, "revision": 1, "audioMix": mix})
        deadline = time.monotonic() + 300
        while job.get("status") in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(1); job = api(f"/jobs/{job['id']}")
        step("匯出完成", job.get("status") == "completed", status=job.get("status"), error=job.get("error"))
        out = Path(job["outputPath"])
        shutil.copyfile(out, evidence / "output.mp4")
        shutil.copyfile(job["srtPath"], evidence / "output.srt")

        # ── 5. 驗收成品 ──
        dur, frames = probe(out)
        step("成品長度＝10 秒（12 秒剪掉 2 秒）", abs(dur - 10) <= 1 / FPS + 0.03, duration=round(dur, 3))
        step("影格數＝300", abs(frames - 10 * FPS) <= 1, frames=frames)
        # 亮度對應來源秒數：成品 2.5→來源 2；成品 4.5→來源 6（剪接後）；成品 9.5→來源 11
        checks = {}
        for t_out, src_sec in ((2.5, 2), (4.5, 6), (9.5, 11)):
            y = luma(out, t_out)
            checks[t_out] = round(y, 1)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t_out), "-i", str(out), "-frames:v", "1", str(evidence / f"frame_{t_out}.png")],
                           check=True, creationflags=FLAGS)
            ref = luma(src, src_sec + 0.5)   # 同一秒在原素材的亮度（每秒差約 21，容許 ±6）
            if abs(y - ref) > 6:
                step(f"成品 {t_out}s 是來源第 {src_sec} 秒", False, luma=y, expected=ref)
        step("畫面對位（剪接點前後的影格都來自正確的來源秒數）", True, luma=checks)
        srt = (evidence / "output.srt").read_text(encoding="utf-8")
        step("SRT 時間已換算到成品", "00:00:01,000 --> 00:00:02,000" in srt and "00:00:06,000 --> 00:00:07,000" in srt)
        loud = job.get("loudness") or {}
        step("平台響度 −14 LUFS ±1", loud.get("after") is not None and abs(loud["after"] + 14) <= 1, loudness=loud)
        step("原素材沒被改動", src.is_file() and probe(src)[1] == 12 * FPS)
    finally:
        server.terminate()   # 只關自己開的後端
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
        (evidence / "report.json").write_text(json.dumps({"steps": steps, "passed": all(s["ok"] for s in steps)}, ensure_ascii=False, indent=2), encoding="utf-8")
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"證據：{evidence}")


if __name__ == "__main__":
    main()
