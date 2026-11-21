"""配音修正：逐句聽 AI 旁白、標記語調錯、用麥克風錄正確版本。

資料放在 `文件\\LJCUT 專案\\配音\\修正\\<集名>\\`（可用 LJCUT_VOICE_DIR 覆寫「配音」資料夾）：
    review.json   清單：每句的文字、AI 音檔、狀態（pending/ok/bad）、說明、使用者錄音
    ai/<id>.wav   AI 生成的句子（由配音腳本產生）
    takes/<id>.wav 使用者錄的正確版本（本服務寫入）
訓練與成品組裝由 `配音\\tools\\` 的腳本讀同一份 review.json。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

CREATE_NO_WINDOW = 0x08000000
_SAFE = re.compile(r"^[\w\-一-鿿]+$")

router = APIRouter(prefix="/api/voice")
_lock = threading.Lock()
_rec: dict | None = None  # 錄音中的 ffmpeg 行程 {proc, session, item, tmp, started}


def voice_root() -> Path:
    return Path(os.getenv("LJCUT_VOICE_DIR") or (Path.home() / "Documents" / "LJCUT 專案" / "配音"))


def _review_dir() -> Path:
    return voice_root() / "修正"


def _check(name: str) -> str:
    if not name or not _SAFE.match(name):
        raise HTTPException(400, "名稱只能用中英文、數字、- 和 _")
    return name


def _session_dir(session: str) -> Path:
    d = _review_dir() / _check(session)
    if not (d / "review.json").is_file():
        raise HTTPException(404, f"找不到配音清單：{session}")
    return d


def _load(session: str) -> dict:
    return json.loads((_session_dir(session) / "review.json").read_text(encoding="utf-8"))


def _save(session: str, data: dict) -> None:
    path = _session_dir(session) / "review.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _item(data: dict, item_id: str) -> dict:
    for it in data.get("items", []):
        if it["id"] == item_id:
            return it
    raise HTTPException(404, f"找不到句子：{item_id}")


def _counts(items: list[dict]) -> dict:
    return {
        "total": len(items),
        "ok": sum(1 for i in items if i.get("status") == "ok"),
        "bad": sum(1 for i in items if i.get("status") == "bad"),
        "recorded": sum(1 for i in items if i.get("take")),
    }


@router.get("/sessions")
def list_sessions():
    root = _review_dir()
    out = []
    if root.is_dir():
        for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            f = d / "review.json"
            if not f.is_file():
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            out.append({"name": d.name, "title": data.get("title", d.name), **_counts(data.get("items", []))})
    return {"root": str(root), "sessions": out}


@router.get("/session/{session}")
def get_session(session: str):
    data = _load(session)
    return {**data, "counts": _counts(data.get("items", []))}


@router.get("/audio/{session}/{kind}/{item_id}")
def get_audio(session: str, kind: str, item_id: str):
    if kind not in ("ai", "takes"):
        raise HTTPException(400, "kind 只能是 ai 或 takes")
    path = _session_dir(session) / kind / f"{_check(item_id)}.wav"
    if not path.is_file():
        raise HTTPException(404, "沒有這個音檔")
    # 錄音重錄後檔名不變，關掉快取才不會播到舊的
    return FileResponse(str(path), media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.post("/mark/{session}/{item_id}")
def mark(session: str, item_id: str, body: dict = Body(...)):
    status = body.get("status")
    if status not in ("pending", "ok", "bad"):
        raise HTTPException(400, "status 只能是 pending、ok 或 bad")
    with _lock:
        data = _load(session)
        it = _item(data, item_id)
        it["status"] = status
        if "note" in body:
            it["note"] = str(body.get("note") or "")[:500]
        it["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save(session, data)
    return {"item": it, "counts": _counts(data["items"])}


@router.get("/devices")
def list_devices():
    """列出 dshow 音訊輸入裝置（和錄影用同一套名稱）。"""
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                           capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=15)
    except Exception as e:
        return {"devices": [], "error": f"無法列出裝置：{e}"}
    text = r.stderr.decode("utf-8", "ignore")
    devices = re.findall(r'"([^"]+)"\s*\(audio\)', text)
    return {"devices": devices}


@router.get("/record/status")
def record_status():
    with _lock:
        if not _rec:
            return {"recording": False}
        return {"recording": True, "session": _rec["session"], "item": _rec["item"],
                "seconds": round(time.time() - _rec["started"], 1)}


@router.post("/record/start/{session}/{item_id}")
def record_start(session: str, item_id: str, body: dict = Body(...)):
    global _rec
    device = (body.get("device") or "").strip()
    if not device:
        raise HTTPException(400, "請先選擇麥克風")
    _item(_load(session), item_id)  # 確認句子存在
    with _lock:
        if _rec:
            raise HTTPException(409, "已經在錄音了，請先停止")
        tmp = Path(tempfile.gettempdir()) / f"ljcut_voice_{int(time.time() * 1000)}.wav"
        proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-y", "-f", "dshow", "-audio_buffer_size", "50", "-i", f"audio={device}",
             "-t", "120", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(tmp)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=CREATE_NO_WINDOW)
        time.sleep(0.4)
        if proc.poll() is not None:
            err = proc.stderr.read().decode("utf-8", "ignore")[-300:] if proc.stderr else ""
            raise HTTPException(500, f"麥克風開不起來（裝置名稱對嗎？）：{err}")
        _rec = {"proc": proc, "session": session, "item": item_id, "tmp": tmp, "started": time.time()}
    return {"recording": True}


def _stop_proc(rec: dict) -> None:
    proc = rec["proc"]
    try:
        if proc.poll() is None:
            proc.stdin.write(b"q")
            proc.stdin.flush()
        proc.wait(timeout=8)
    except Exception:
        proc.kill()


@router.post("/record/stop")
def record_stop(body: dict = Body(default={})):
    """停止錄音；discard=true 直接丟掉。否則裁掉頭尾靜音存成 takes/<id>.wav。"""
    global _rec
    with _lock:
        rec, _rec = _rec, None
    if not rec:
        raise HTTPException(409, "目前沒有在錄音")
    _stop_proc(rec)
    tmp: Path = rec["tmp"]
    if body.get("discard"):
        tmp.unlink(missing_ok=True)
        return {"saved": False}
    if not tmp.is_file() or tmp.stat().st_size < 48000:  # 不到 0.5 秒
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "錄音太短或沒有收到聲音")
    d = _session_dir(rec["session"])
    (d / "takes").mkdir(exist_ok=True)
    out = d / "takes" / f"{rec['item']}.wav"
    # 頭尾靜音裁掉、各留約 0.2 秒；-40 dB 以下算靜音（一般房間底噪約 -45 dB，-50 會裁不掉）
    trim = ("silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.2,"
            "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.3,areverse")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-y", "-i", str(tmp), "-af", trim, "-ac", "1", "-ar", "48000",
                        "-c:a", "pcm_s16le", str(out)], capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=60)
    tmp.unlink(missing_ok=True)
    if r.returncode != 0 or not out.is_file():
        raise HTTPException(500, "存檔失敗：" + r.stderr.decode("utf-8", "ignore")[-300:])
    seconds = _wav_seconds(out)
    with _lock:
        data = _load(rec["session"])
        it = _item(data, rec["item"])
        it["take"] = f"takes/{rec['item']}.wav"
        it["take_seconds"] = seconds
        it["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save(rec["session"], data)
    return {"saved": True, "item": it, "counts": _counts(data["items"])}


@router.delete("/take/{session}/{item_id}")
def delete_take(session: str, item_id: str):
    with _lock:
        data = _load(session)
        it = _item(data, item_id)
        if it.get("take"):
            (_session_dir(session) / it["take"]).unlink(missing_ok=True)
        it["take"] = None
        it.pop("take_seconds", None)
        it["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save(session, data)
    return {"item": it, "counts": _counts(data["items"])}


def _wav_seconds(path: Path) -> float:
    import wave
    with wave.open(str(path)) as w:
        return round(w.getnframes() / w.getframerate(), 2)
