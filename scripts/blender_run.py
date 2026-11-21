"""從外部呼叫 Blender（背景、低優先權）渲染 3D 動畫，給 LJCUT 當素材。只用標準函式庫。

工作資料夾：<LJCUT 工作區>/3D/<name>/
    scene.py      AI 寫的場景腳本（用 blender_kit 的 kit.*）
    scene.blend   場景檔，可用 Blender 開啟手動微調
    p_*.png       預覽影格；preview.jpg 編號對照表
    frames/       正式渲染影格（中斷可續算）
    <name>.mp4    成品（H.264，可直接匯入 LJCUT）
    status.json   正式渲染進度
    blender.log   最近一次 Blender 輸出

命令列：
    python scripts/blender_run.py find
    python scripts/blender_run.py preview <name> <scene.py>
    python scripts/blender_run.py final <name> [--engine cycles --samples 128]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BELOW_NORMAL = 0x00004000
NO_WINDOW = 0x08000000


def env(name: str) -> str:
    if os.getenv(name):
        return os.environ[name]
    f = REPO / "backend" / ".env"
    if f.is_file():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"')
    return ""


def find_blender() -> Path | None:
    cands = [env("BLENDER_PATH")]
    for pat in (r"D:\Tools\Blender\*\blender.exe", r"C:\Program Files\Blender Foundation\*\blender.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\Blender*\*\blender.exe")):
        cands += sorted(glob.glob(pat), reverse=True)
    cands.append(shutil.which("blender") or "")
    for c in cands:
        if c and Path(c).is_file():
            return Path(c)
    return None


def workspace_root() -> Path:
    cfg = REPO / "app_data" / "control" / ".ljcut-control.json"
    if cfg.is_file():
        ws = json.loads(cfg.read_text(encoding="utf-8")).get("workspace")
        if ws:
            return Path(ws)
    return Path.home() / "Documents" / "LJCUT 專案"


def job_dir(root: Path, name: str) -> Path:
    if not re.fullmatch(r"[\w\-\u4e00-\u9fff]{1,60}", name):
        raise ValueError("name 只能用中英文、數字、-、_（60 字內）")
    d = root / "3D" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _blender_cmd(blender: Path, d: Path, mode: str, extra: dict) -> list[str]:
    cmd = [str(blender), "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(HERE / "blender_entry.py"), "--",
           "--scene", str(d / "scene.py"), "--out", str(d), "--mode", mode]
    for k, v in extra.items():
        if v not in (None, ""):
            cmd += [f"--{k}", str(v)]
    return cmd


def _flags():
    return BELOW_NORMAL | NO_WINDOW if os.name == "nt" else 0


def _tail(text: str, n=40) -> str:
    keep = [l for l in text.splitlines() if l.strip()]
    return "\n".join(keep[-n:])


def preview(name: str, scene_code: str | None, root: Path, frames="auto", scale=50, engine=None, samples=None,
            timeout=900) -> dict:
    blender = find_blender()
    if not blender:
        raise RuntimeError("找不到 Blender：請安裝或在 backend/.env 設 BLENDER_PATH（見 docs/blender.md）")
    d = job_dir(root, name)
    if scene_code is not None:
        (d / "scene.py").write_text(scene_code, encoding="utf-8")
    if not (d / "scene.py").is_file():
        raise RuntimeError(f"{d / 'scene.py'} 不存在")
    for old in d.glob("p_*.png"):
        old.unlink()
    t0 = time.time()
    p = subprocess.run(_blender_cmd(blender, d, "preview", {"frames": frames, "scale": scale, "engine": engine, "samples": samples}),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       creationflags=_flags())
    log = (p.stdout or "") + "\n" + (p.stderr or "")
    (d / "blender.log").write_text(log, encoding="utf-8")
    pngs = sorted(d.glob("p_*.png"))
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8")) if (d / "meta.json").is_file() else {}
    ok = p.returncode == 0 and "LJKIT render=OK" in log and pngs
    sheet = _sheet(pngs, d / "preview.jpg", meta.get("fps", 30)) if pngs else None
    return {"ok": bool(ok), "seconds": round(time.time() - t0, 1), "frames": [int(x.stem[2:]) for x in pngs],
            "sheet": sheet.relative_to(root).as_posix() if sheet else None, "meta": meta,
            "log": "" if ok else _tail(log), "gpu": next((l for l in log.splitlines() if l.startswith("LJKIT gpu=")), "")}


def _sheet(pngs, out: Path, fps) -> Path | None:
    cols = 3 if len(pngs) > 4 else 2 if len(pngs) > 1 else 1
    font = "C\\:/Windows/Fonts/msjhbd.ttc" if os.name == "nt" else "DejaVuSans-Bold.ttf"
    # 每格標「編號 秒數」
    secs = [f"{(int(p.stem[2:]) - 1) / fps:.1f}s" for p in pngs]
    tiles = []
    for i, p in enumerate(pngs):
        tiles.append(f"[{i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=644:364:2:2:color=0x111111,"
                     f"drawbox=x=2:y=2:w=170:h=40:color=black@0.7:t=fill,"
                     f"drawtext=fontfile='{font}':text='#{i + 1} {secs[i]}':x=10:y=8:fontsize=26:fontcolor=yellow[t{i}]")
    inputs = []
    for p in pngs:
        inputs += ["-i", str(p)]
    layout = "|".join(f"{(i % cols) * 644}_{(i // cols) * 364}" for i in range(len(pngs)))
    graph = ";".join(tiles) + ";" + "".join(f"[t{i}]" for i in range(len(pngs)))
    graph += f"xstack=inputs={len(pngs)}:layout={layout}:fill=0x111111" if len(pngs) > 1 else "null"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", str(out)],
                       capture_output=True, text=True, creationflags=_flags())
    return out if r.returncode == 0 else None


# ───────────────────────── 正式渲染（背景） ─────────────────────────
def status(root: Path, name: str) -> dict:
    d = root / "3D" / name
    st = json.loads((d / "status.json").read_text(encoding="utf-8")) if (d / "status.json").is_file() else {"state": "none"}
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8")) if (d / "meta.json").is_file() else {}
    total = meta.get("frameEnd", 0) - meta.get("frameStart", 1) + 1 if meta else 0
    done = sum(1 for f in (d / "frames").glob("f_*.png") if f.stat().st_size > 0) if (d / "frames").is_dir() else 0
    st.update(framesDone=done, framesTotal=total)
    if st.get("state") == "running" and st.get("pid") and not _alive(st["pid"]):
        st["state"] = "failed"
        st.setdefault("error", "渲染程序已結束但沒有回報完成（可能被關掉）；重新開始會從缺的影格續算")
    return st


def _alive(pid: int) -> bool:
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True, creationflags=NO_WINDOW)
        return str(pid) in r.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start_final(root: Path, name: str, engine=None, samples=None) -> dict:
    d = root / "3D" / name
    if not (d / "scene.py").is_file():
        raise RuntimeError("先用 preview 建立場景並確認畫面")
    st = status(root, name)
    if st.get("state") == "running":
        return st
    args = [sys.executable, str(Path(__file__).resolve()), "final", name, "--root", str(root)]
    if engine:
        args += ["--engine", engine]
    if samples:
        args += ["--samples", str(samples)]
    proc = subprocess.Popen(args, creationflags=_flags() | (0x00000008 if os.name == "nt" else 0),  # DETACHED_PROCESS
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    (d / "status.json").write_text(json.dumps({"state": "running", "pid": proc.pid, "startedAt": time.time()}), encoding="utf-8")
    return status(root, name)


def run_final(root: Path, name: str, engine=None, samples=None):
    d = root / "3D" / name
    stf = d / "status.json"

    def put(**kw):
        cur = json.loads(stf.read_text(encoding="utf-8")) if stf.is_file() else {}
        cur.update(kw, pid=os.getpid())
        stf.write_text(json.dumps(cur, ensure_ascii=False), encoding="utf-8")

    put(state="running", startedAt=time.time(), error="")
    try:
        if os.name == "nt":   # 本程序也降優先權（CLAUDE.md CPU 預算）
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(-1), BELOW_NORMAL)
        blender = find_blender()
        if not blender:
            raise RuntimeError("找不到 Blender")
        fdir = d / "frames"
        import hashlib
        digest = hashlib.sha256((d / "scene.py").read_bytes() + f"{engine}|{samples}".encode()).hexdigest()
        stamp = fdir / ".scene-hash"
        if fdir.is_dir() and (not stamp.is_file() or stamp.read_text() != digest):
            shutil.rmtree(fdir)          # 場景或引擎改過：舊影格不能續用
        fdir.mkdir(parents=True, exist_ok=True)
        stamp.write_text(digest)
        for f in fdir.glob("f_*.png"):   # 上次中斷留下的 0 位元組佔位檔要刪，否則會被當成已完成
            if f.stat().st_size == 0:
                f.unlink()
        (d / f"{name}.mp4").unlink(missing_ok=True)
        with open(d / "blender.log", "w", encoding="utf-8", errors="replace") as log:
            p = subprocess.run(_blender_cmd(blender, d, "final", {"engine": engine, "samples": samples}),
                               stdout=log, stderr=subprocess.STDOUT, creationflags=_flags())
        text = (d / "blender.log").read_text(encoding="utf-8", errors="replace")
        if p.returncode != 0 or "LJKIT render=OK" not in text:
            raise RuntimeError("Blender 渲染失敗：\n" + _tail(text, 25))
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        out = d / f"{name}.mp4"
        put(state="encoding")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(meta["fps"]), "-start_number", str(meta["frameStart"]),
                            "-i", str(fdir / "f_%05d.png"), "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
                           capture_output=True, text=True, creationflags=_flags())
        if r.returncode != 0:
            raise RuntimeError("ffmpeg 合成失敗：" + r.stderr[-800:])
        put(state="done", output=out.relative_to(root).as_posix(), finishedAt=time.time(),
            seconds=round((meta["frameEnd"] - meta["frameStart"] + 1) / meta["fps"], 2))
    except Exception as e:  # noqa: BLE001
        put(state="failed", error=str(e)[:2000])


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["find", "preview", "final", "start", "status"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("scene", nargs="?")
    ap.add_argument("--root")
    ap.add_argument("--engine", choices=["eevee", "cycles"])
    ap.add_argument("--samples", type=int)
    ap.add_argument("--frames", default="auto")
    a = ap.parse_args()
    root = Path(a.root) if a.root else workspace_root()
    if a.cmd == "find":
        b = find_blender()
        print(b or "找不到 Blender")
        if b:
            r = subprocess.run([str(b), "-b", "--factory-startup", "--version"], capture_output=True, text=True, timeout=120)
            print(r.stdout.splitlines()[0] if r.stdout else r.stderr[-300:])
    elif a.cmd == "preview":
        code = Path(a.scene).read_text(encoding="utf-8") if a.scene else None
        print(json.dumps(preview(a.name, code, root, a.frames, engine=a.engine, samples=a.samples), ensure_ascii=False, indent=1))
    elif a.cmd == "start":
        print(json.dumps(start_final(root, a.name, a.engine, a.samples), ensure_ascii=False))
    elif a.cmd == "final":
        run_final(root, a.name, a.engine, a.samples)
    else:
        print(json.dumps(status(root, a.name), ensure_ascii=False))


if __name__ == "__main__":
    main()
