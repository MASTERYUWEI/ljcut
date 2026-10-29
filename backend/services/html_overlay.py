"""自訂 HTML 動畫疊加層：AI 寫 HTML/CSS/JS，預覽在沙盒 iframe 播放，匯出由無頭 Edge／Chrome 逐格截成透明 PNG。

- 單一外殼（wrap）：預覽與匯出用同一份 HTML 外殼與時間控制腳本，畫面才會一致。
- 設計畫面：高 1080 CSS px、寬依素材比例（16:9 為 1920）；匯出以 deviceScaleFactor 放大到素材原解析度。
- 時間：外殼把所有 CSS 動畫／Web Animations 暫停並跳到 t 秒；JS 動畫請提供 window.ljcutSeek(t)（可回傳 Promise）。
  依賴 requestAnimationFrame + 時鐘、setTimeout 的動畫無法精準跳轉，不支援。
- 安全：CSP 禁止所有網路請求（只允許內嵌 data:），瀏覽器另以 --host-resolver-rules 讓任何網址都解析失敗；
  預覽 iframe 使用 sandbox="allow-scripts"（不同源、碰不到 LJ Cut 本體）。
- 不新增套件：以 websockets（uvicorn 已內含）直接走 Chrome DevTools Protocol。
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

MAX_HTML = 200_000
MAX_SECONDS = 60
DESIGN_H = 1080

CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
       "img-src data: blob:; font-src data:; media-src data: blob:")

RUNTIME = r"""
(() => {
  // LJ Cut 時間控制：所有動畫暫停，依指定秒數跳轉（預覽與匯出共用）
  let seq = 0;
  window.__ljcutT = 0;
  window.__ljcutSeek = async (t) => {
    const my = ++seq;
    window.__ljcutT = t;
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = Math.max(0, t * 1000); } catch (e) {} }
    if (typeof window.ljcutSeek === 'function') { try { await window.ljcutSeek(t); } catch (e) { console.error(e); } }
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = Math.max(0, t * 1000); } catch (e) {} }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return my === seq;
  };
  addEventListener('message', (e) => {
    if (e.data && typeof e.data.ljcutT === 'number') window.__ljcutSeek(e.data.ljcutT);
  });
  addEventListener('DOMContentLoaded', () => {
    window.__ljcutSeek(0);
    // 通知預覽端「已就緒」，請它重送目前時間（載入前送來的訊息會遺失）
    try { if (parent !== window) parent.postMessage({ ljcutReady: true }, '*'); } catch (e) {}
  });
})();
"""


def design_size(src_w: int, src_h: int) -> tuple[int, int]:
    """設計畫面（CSS px）：高 1080，寬依素材比例。"""
    return max(16, round(DESIGN_H * src_w / src_h)), DESIGN_H


def wrap(html: str, css_w: int, css_h: int) -> str:
    return ("<!doctype html><html><head><meta charset=\"utf-8\">"
            f"<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">"
            f"<style>html,body{{margin:0;padding:0;background:transparent!important;overflow:hidden;"
            f"width:{css_w}px;height:{css_h}px;position:relative}}</style>"
            f"<script>{RUNTIME}</script></head><body>{html}</body></html>")


def check_html(html) -> str:
    if not isinstance(html, str) or not html.strip():
        raise ValueError("HTML 動畫需提供 html 內容")
    if len(html) > MAX_HTML:
        raise ValueError(f"HTML 內容最多 {MAX_HTML // 1000}K 字元")
    return html


# ───────────────────────── 無頭瀏覽器（CDP） ─────────────────────────
def find_browser() -> str | None:
    env = os.environ.get("LJCUT_BROWSER")
    candidates = [env] if env else []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            candidates += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                           os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    candidates += [shutil.which("msedge") or "", shutil.which("chrome") or "", shutil.which("chromium") or ""]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


class Renderer:
    """一個無頭瀏覽器分頁；以 with 使用，結束時關閉瀏覽器並刪除暫存設定檔。"""

    def __init__(self):
        self.proc = None
        self.ws = None
        self.session = None
        self.profile = None
        self._id = 0
        self._doc = None

    def __enter__(self):
        exe = find_browser()
        if not exe:
            raise RuntimeError("找不到 Edge 或 Chrome，無法渲染 HTML 動畫（可用環境變數 LJCUT_BROWSER 指定瀏覽器路徑）")
        from websockets.sync.client import connect
        self.profile = tempfile.mkdtemp(prefix="ljcut-html-")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen([exe, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
                                      "--no-first-run", "--no-default-browser-check", "--mute-audio", "--hide-scrollbars",
                                      "--disable-extensions", "--disable-background-networking", "--disable-sync",
                                      "--host-resolver-rules=MAP * ~NOTFOUND", "--force-color-profile=srgb",
                                      "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        port_file = Path(self.profile) / "DevToolsActivePort"
        deadline = time.monotonic() + 20
        while not port_file.exists() or len(port_file.read_text().splitlines()) < 2:
            if time.monotonic() > deadline or self.proc.poll() is not None:
                self.close()
                raise RuntimeError("無頭瀏覽器啟動失敗")
            time.sleep(0.05)
        port, path = port_file.read_text().splitlines()[:2]
        self.ws = connect(f"ws://127.0.0.1:{port}{path}", max_size=None, open_timeout=10)
        target = self._call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.session = self._call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        self._call("Page.enable")
        self._call("Runtime.enable")
        self._call("Emulation.setDefaultBackgroundColorOverride", {"color": {"r": 0, "g": 0, "b": 0, "a": 0}})
        return self

    def _call(self, method, params=None, timeout=30):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if self.session and not method.startswith("Target."):
            msg["sessionId"] = self.session
        self.ws.send(json.dumps(msg))
        deadline = time.monotonic() + timeout
        while True:
            raw = self.ws.recv(timeout=max(0.1, deadline - time.monotonic()))
            data = json.loads(raw)
            if data.get("id") == self._id:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error'].get('message')}")
                return data.get("result", {})

    def load(self, html: str, src_w: int, src_h: int):
        """載入一份 HTML（已包外殼），畫布設為素材原解析度。"""
        css_w, css_h = design_size(src_w, src_h)
        key = (hashlib.sha1(html.encode()).hexdigest(), src_w, src_h)
        if self._doc == key:
            return
        self._call("Emulation.setDeviceMetricsOverride",
                   {"width": css_w, "height": css_h, "deviceScaleFactor": src_h / css_h, "mobile": False})
        frame = self._call("Page.getFrameTree")["frameTree"]["frame"]["id"]
        self._call("Page.setDocumentContent", {"frameId": frame, "html": wrap(html, css_w, css_h)})
        self._eval("document.fonts ? document.fonts.ready.then(() => true) : true")
        self._doc = key

    def _eval(self, expr):
        res = self._call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        if res.get("exceptionDetails"):
            raise RuntimeError(f"HTML 動畫執行錯誤：{res['exceptionDetails'].get('text')}")
        return res.get("result", {}).get("value")

    def frame(self, t: float) -> bytes:
        """跳到 t 秒並截一張透明 PNG（素材原解析度）。"""
        self._eval(f"window.__ljcutSeek({float(t):.6f})")
        shot = self._call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        return base64.b64decode(shot["data"])

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(5)
            except Exception:
                pass
        if self.profile:
            shutil.rmtree(self.profile, ignore_errors=True)

    def __exit__(self, *exc):
        self.close()


def render_sequence(renderer: Renderer, html: str, src_w: int, src_h: int, times: list[float], out_dir: Path,
                    cache_root: Path | None = None) -> Path:
    """依時間列表逐格截圖成 out_dir/00000.png…；外觀與時間相同時重用快取。"""
    key = hashlib.sha1(json.dumps([html, src_w, src_h, [round(t, 4) for t in times]]).encode()).hexdigest()[:20]
    if cache_root:
        cached = cache_root / key
        if (cached / "done").exists():
            return cached
        out_dir = cached
    out_dir.mkdir(parents=True, exist_ok=True)
    renderer.load(html, src_w, src_h)
    for i, t in enumerate(times):
        (out_dir / f"{i:05d}.png").write_bytes(renderer.frame(t))
    (out_dir / "done").write_text("ok")
    return out_dir


def frame_times(o: dict, trim_start: float, trim_end: float, speed: float, fps: float) -> tuple[float, list[float]]:
    """片段內可見部分的逐格時間：回傳（輸出起始秒數 ta, 每格的 HTML 時間 t）。"""
    a, b = max(o["start"], trim_start), min(o["end"], trim_end)
    n = max(1, math.ceil((b - a) / speed * fps - 1e-6))
    return (a - trim_start) / speed, [a - o["start"] + i / fps * speed for i in range(n)]
