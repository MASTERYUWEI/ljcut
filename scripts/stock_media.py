"""免費素材庫：搜尋、下載可商用的影片／照片／配樂，並記錄授權出處。

只用 Python 標準函式庫（MCP 伺服器與命令列共用）。
免金鑰來源：Wikimedia Commons（影片／照片）、NASA（影片／照片）、Internet Archive（影片）、Openverse（照片／音樂）。
免費金鑰來源（有設定才啟用）：Pexels（影片／照片，PEXELS_API_KEY）、Pixabay（影片／照片，PIXABAY_API_KEY）。
金鑰從環境變數或 backend/.env 讀取，申請方式見 docs/stock-media.md。

授權政策：只收「可商用、可改作」的素材（CC0／公眾領域／CC BY／CC BY-SA／Pexels 授權／Pixabay 授權／NASA），
排除 NC（禁止商用）與 ND（禁止改作）。每個下載的檔案旁會寫一份 .license.json，
同資料夾的 credits.json 會累積出處，供 YouTube 說明欄的素材出處使用。

命令列：
    python scripts/stock_media.py search "camping tent" --kind video
    python scripts/stock_media.py fetch pexels-video:12345 --dest 露營準備-20261031/素材庫
    python scripts/stock_media.py credits 露營準備-20261031/素材庫
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UA = "LJCUT/0.2 (local video editor; github.com/MASTERYUWEI)"
TIMEOUT = 20
KINDS = ("video", "image", "audio")

# ───────────────────────── 共用 ─────────────────────────


def env(name: str) -> str:
    if os.getenv(name):
        return os.environ[name].strip()
    f = REPO / "backend" / ".env"
    if f.is_file():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    return ""


def safe_url(url: str) -> str:
    """把路徑裡的空白、非 ASCII 字元編碼（NASA 的檔名常帶空白）；已編碼的 %xx 保留。"""
    u = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(u._replace(path=urllib.parse.quote(u.path, safe="/%:@~!$&'()*+,;=-._")))


def get_json(url: str, headers: dict | None = None, timeout: float = TIMEOUT):
    req = urllib.request.Request(safe_url(url), headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def qs(**params) -> str:
    return urllib.parse.urlencode({k: v for k, v in params.items() if v is not None and v != ""})


def strip_html(s) -> str:
    s = re.sub(r"<[^>]+>", "", str(s or ""))
    return re.sub(r"\s+", " ", s).strip()


def license_ok(text: str) -> bool:
    """可商用＋可改作才收。text 可以是授權代號或網址。"""
    t = (text or "").lower().replace("_", "-").replace(" ", "-")
    if not t:
        return False
    if re.search(r"(^|[-/])(nc|nd)([-/]|$)", t) or "noncommercial" in t or "noderiv" in t:
        return False
    return any(k in t for k in ("cc0", "publicdomain", "public-domain", "pdm", "cc-by", "/by/", "/by-sa/",
                                "by-sa", "pexels", "pixabay", "nasa"))


def norm_license(code: str, version: str = "") -> str:
    c = (code or "").lower()
    if c in ("cc0", "pdm"):
        return "CC0" if c == "cc0" else "Public Domain Mark"
    if c.startswith("by"):
        return f"CC {c.upper()} {version}".strip()
    return code


def cand(**kw) -> dict:
    """統一的候選格式。id 形如 'pexels-video:12345'。"""
    base = dict(id="", source="", kind="", title="", author="", license="", licenseUrl="", pageUrl="",
                thumb="", download="", width=0, height=0, duration=None, ext="", attribution="")
    base.update(kw)
    if not base["attribution"]:
        who = f" by {base['author']}" if base["author"] else ""
        base["attribution"] = f"“{base['title'] or base['id']}”{who}（{base['source']}，{base['license']}）{base['pageUrl']}"
    return base


def pick_by_height(files: list[dict], target=1080) -> dict | None:
    """挑高度 ≤ target 中最大的；都比 target 大就挑最小的。files 需有 height。"""
    ok = [f for f in files if f.get("height") and f["height"] <= target]
    if ok:
        return max(ok, key=lambda f: f["height"])
    return min(files, key=lambda f: f.get("height") or 10**9) if files else None


# ───────────────────────── 各來源 ─────────────────────────


def pexels(query, kind, n, orientation=None):
    key = env("PEXELS_API_KEY")
    if not key or kind == "audio":
        return []
    h = {"Authorization": key}
    if kind == "video":
        d = get_json("https://api.pexels.com/videos/search?" + qs(query=query, per_page=n, orientation=orientation), h)
        out = []
        for v in d.get("videos", []):
            f = pick_by_height([x for x in v.get("video_files", []) if x.get("file_type") == "video/mp4"])
            if not f:
                continue
            out.append(cand(id=f"pexels-video:{v['id']}", source="Pexels", kind="video",
                            title=(v.get("url", "").rstrip("/").split("/")[-1] or str(v["id"])).replace("-", " "),
                            author=(v.get("user") or {}).get("name", ""), license="Pexels License",
                            licenseUrl="https://www.pexels.com/license/", pageUrl=v.get("url", ""),
                            thumb=v.get("image", ""), download=f["link"], width=f.get("width") or v.get("width"),
                            height=f.get("height") or v.get("height"), duration=v.get("duration"), ext="mp4"))
        return out
    d = get_json("https://api.pexels.com/v1/search?" + qs(query=query, per_page=n, orientation=orientation), h)
    return [cand(id=f"pexels-image:{p['id']}", source="Pexels", kind="image", title=p.get("alt") or str(p["id"]),
                 author=p.get("photographer", ""), license="Pexels License", licenseUrl="https://www.pexels.com/license/",
                 pageUrl=p.get("url", ""), thumb=(p.get("src") or {}).get("medium", ""),
                 download=(p.get("src") or {}).get("large2x") or (p.get("src") or {}).get("original", ""),
                 width=p.get("width"), height=p.get("height"), ext="jpg") for p in d.get("photos", [])]


def pixabay(query, kind, n, orientation=None):
    key = env("PIXABAY_API_KEY")
    if not key or kind == "audio":
        return []
    lic = dict(license="Pixabay Content License", licenseUrl="https://pixabay.com/service/license-summary/")
    if kind == "video":
        d = get_json("https://pixabay.com/api/videos/?" + qs(key=key, q=query, per_page=max(3, n), safesearch="true"))
        out = []
        for v in d.get("hits", []):
            vids = v.get("videos") or {}
            f = pick_by_height([dict(vids[k], k=k) for k in ("large", "medium", "small") if (vids.get(k) or {}).get("url")])
            if not f:
                continue
            out.append(cand(id=f"pixabay-video:{v['id']}", source="Pixabay", kind="video", title=v.get("tags", ""),
                            author=v.get("user", ""), pageUrl=v.get("pageURL", ""),
                            thumb=f.get("thumbnail") or (vids.get("tiny") or {}).get("thumbnail", ""),
                            download=f["url"], width=f.get("width"), height=f.get("height"),
                            duration=v.get("duration"), ext="mp4", **lic))
        return out
    d = get_json("https://pixabay.com/api/?" + qs(key=key, q=query, per_page=max(3, n), image_type="photo",
                                                   orientation={"landscape": "horizontal", "portrait": "vertical"}.get(orientation),
                                                   safesearch="true"))
    return [cand(id=f"pixabay-image:{p['id']}", source="Pixabay", kind="image", title=p.get("tags", ""),
                 author=p.get("user", ""), pageUrl=p.get("pageURL", ""), thumb=p.get("webformatURL", ""),
                 download=p.get("largeImageURL") or p.get("webformatURL", ""), width=p.get("imageWidth"),
                 height=p.get("imageHeight"), ext="jpg", **lic) for p in d.get("hits", [])]


def wikimedia(query, kind, n, orientation=None):
    if kind == "audio":
        return []
    ftype = "video" if kind == "video" else "bitmap"
    prop = "videoinfo" if kind == "video" else "imageinfo"
    pre = "vi" if kind == "video" else "ii"
    url = "https://commons.wikimedia.org/w/api.php?" + qs(
        action="query", format="json", generator="search", gsrsearch=f"filetype:{ftype} {query}", gsrnamespace=6,
        gsrlimit=50, prop=prop, **{f"{pre}prop": "url|size|mime|extmetadata" + ("|derivatives" if kind == "video" else ""),
                                               f"{pre}urlwidth": 320})
    d = get_json(url)
    out = []
    pages = sorted((d.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    for p in pages:
        info = (p.get(prop) or [{}])[0]
        meta = info.get("extmetadata") or {}
        lic = strip_html((meta.get("LicenseShortName") or {}).get("value"))
        lic_url = strip_html((meta.get("LicenseUrl") or {}).get("value"))
        if not (license_ok(lic) or license_ok(lic_url)):
            continue
        w, h = info.get("width") or 0, info.get("height") or 0
        if w and h and ((orientation == "landscape" and h > w) or (orientation == "portrait" and w > h)):
            continue
        download = info.get("url", "")
        if kind == "video":
            ders = [dict(x, height=int(re.match(r"(\d+)p", x.get("transcodekey", "0p")).group(1)))
                    for x in info.get("derivatives", []) if re.match(r"\d+p\.(vp9\.webm|mpeg4\.mov)", x.get("transcodekey", ""))]
            f = pick_by_height(ders)
            if f:
                download = f["src"]
                if h:
                    w, h = round(w * f["height"] / h), f["height"]
        thumb = info.get("thumburl", "")
        if kind == "image" and w > 1920 and re.search(r"/\d+px-", thumb):
            # Wikimedia 縮圖只提供固定級距（…960／1280／1920…），1920 是 1080p 用最合適的一級
            download = re.sub(r"/\d+px-", "/1920px-", thumb.split("?")[0]).replace("thumb.wikimedia.org", "upload.wikimedia.org")
            w, h = 1920, round(h * 1920 / w)
        title = re.sub(r"^File:|\.\w+$", "", p.get("title", ""))
        ext = Path(urllib.parse.urlparse(download).path).suffix.lstrip(".").lower() or ("webm" if kind == "video" else "jpg")
        if download.endswith(".webm") or "vp9.webm" in download:
            ext = "webm"
        out.append(cand(id=f"wikimedia-{kind}:{p.get('pageid')}", source="Wikimedia Commons", kind=kind, title=title,
                        author=strip_html((meta.get("Artist") or {}).get("value"))[:80], license=lic, licenseUrl=lic_url,
                        pageUrl=info.get("descriptionurl", ""), thumb=info.get("thumburl", ""), download=download,
                        width=w, height=h, duration=info.get("duration"), ext=ext))
        if len(out) >= n:
            break
    return out


def nasa(query, kind, n, orientation=None):
    if kind == "audio":
        return []
    d = get_json("https://images-api.nasa.gov/search?" + qs(q=query, media_type=kind, page_size=n))
    out = []
    for it in (d.get("collection") or {}).get("items", [])[:n]:
        data = (it.get("data") or [{}])[0]
        nid = data.get("nasa_id", "")
        thumb = next((l.get("href") for l in it.get("links", []) if l.get("render") == "image" or "thumb" in l.get("href", "")), "")
        out.append(cand(id=f"nasa-{kind}:{nid}", source="NASA", kind=kind, title=data.get("title", nid),
                        author=data.get("center", "NASA"), license="NASA Media Usage Guidelines（公眾領域，不得暗示 NASA 背書）",
                        licenseUrl="https://www.nasa.gov/nasa-brand-center/images-and-media/",
                        pageUrl=f"https://images.nasa.gov/details/{urllib.parse.quote(nid)}", thumb=thumb,
                        download=f"nasa-manifest:{it.get('href', '')}", ext="mp4" if kind == "video" else "jpg"))
    return out


def archive(query, kind, n, orientation=None):
    if kind != "video":
        return []
    q = f"({query}) AND mediatype:movies AND (licenseurl:*publicdomain* OR licenseurl:*creativecommons*)"
    d = get_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(
        [("q", q), ("fl[]", "identifier"), ("fl[]", "title"), ("fl[]", "licenseurl"), ("fl[]", "creator"),
         ("fl[]", "runtime"), ("rows", str(n * 4)), ("output", "json"), ("sort[]", "downloads desc")]))
    out = []
    for doc in (d.get("response") or {}).get("docs", []):
        lic = doc.get("licenseurl", "")
        if not license_ok(lic):
            continue
        ident = doc["identifier"]
        creator = doc.get("creator")
        out.append(cand(id=f"archive-video:{ident}", source="Internet Archive", kind="video", title=doc.get("title", ident),
                        author=", ".join(creator) if isinstance(creator, list) else (creator or ""), license=lic,
                        licenseUrl=lic, pageUrl=f"https://archive.org/details/{ident}",
                        thumb=f"https://archive.org/services/img/{ident}", download=f"archive-item:{ident}",
                        duration=doc.get("runtime"), ext="mp4"))
        if len(out) >= n:
            break
    return out


def openverse(query, kind, n, orientation=None):
    if kind == "video":
        return []
    ep = "images" if kind == "image" else "audio"
    extra = {"category": "music"} if kind == "audio" else {"aspect_ratio": {"landscape": "wide", "portrait": "tall"}.get(orientation)}
    d = get_json(f"https://api.openverse.org/v1/{ep}/?" + qs(q=query, license_type="commercial,modification",
                                                              page_size=min(20, n * 2), **extra), timeout=75)
    out = []
    for r in d.get("results", []):
        lic = norm_license(r.get("license", ""), r.get("license_version", ""))
        if not license_ok(r.get("license_url") or lic):
            continue
        ftype = (r.get("filetype") or "").lower()
        ext = "mp3" if kind == "audio" and (not ftype or ftype.startswith("mp3")) else (ftype or ("mp3" if kind == "audio" else "jpg"))
        dur = r.get("duration")
        out.append(cand(id=f"openverse-{kind}:{r['id']}", source=f"Openverse/{r.get('source', '')}", kind=kind,
                        title=r.get("title") or r["id"], author=r.get("creator", ""), license=lic,
                        licenseUrl=r.get("license_url", ""), pageUrl=r.get("foreign_landing_url", ""),
                        thumb=r.get("thumbnail") or "", download=r.get("url", ""), width=r.get("width") or 0,
                        height=r.get("height") or 0, duration=dur / 1000 if dur else None, ext=ext,
                        attribution=r.get("attribution") or ""))
        if len(out) >= n:
            break
    return out


SOURCES = {"pexels": pexels, "pixabay": pixabay, "wikimedia": wikimedia, "nasa": nasa, "archive": archive, "openverse": openverse}
SOURCE_KINDS = {"pexels": ("video", "image"), "pixabay": ("video", "image"), "wikimedia": ("video", "image"),
                "nasa": ("video", "image"), "archive": ("video",), "openverse": ("image", "audio")}
NEEDS_KEY = {"pexels": "PEXELS_API_KEY", "pixabay": "PIXABAY_API_KEY"}
# 只在指定時才搜：NASA 偏太空／地球科學，Internet Archive 多為 1930–70 年代老片，一般生活題材會變成雜訊
OPT_IN = {"nasa", "archive"}


def available_sources(kind: str) -> tuple[list[str], list[str]]:
    on, off = [], []
    for s, ks in SOURCE_KINDS.items():
        if kind not in ks:
            continue
        (off if s in NEEDS_KEY and not env(NEEDS_KEY[s]) else on).append(s)
    return on, off


# ───────────────────────── 搜尋與快取 ─────────────────────────


def cache_file(root: Path) -> Path:
    return root / "素材庫" / ".search-cache.json"


def load_cache(root: Path) -> dict:
    try:
        return json.loads(cache_file(root).read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_cache(root: Path, items: list[dict]):
    c = load_cache(root)
    now = time.time()
    c = {k: v for k, v in c.items() if now - v.get("_at", 0) < 7 * 86400}
    for it in items:
        c[it["id"]] = dict(it, _at=now)
    p = cache_file(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")


def search(query: str, kind="video", sources=None, count=12, orientation="landscape", min_duration=None,
           max_duration=None, root: Path | None = None) -> dict:
    res = _search(query, kind, sources, count, orientation, min_duration, max_duration)
    words = query.split()
    if not res["items"] and len(words) > 2:
        relaxed = " ".join(words[:2])
        res = _search(relaxed, kind, sources, count, orientation, min_duration, max_duration)
        res["relaxedQuery"] = relaxed
    if root:
        save_cache(root, res["items"])
    return res


def _search(query, kind, sources, count, orientation, min_duration, max_duration) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind 只能是 {KINDS}")
    on, off = available_sources(kind)
    use = [s for s in (sources or [s for s in on if s not in OPT_IN]) if s in on]
    if not use:
        use = [s for s in on]
    per = max(2, -(-count // max(1, len(use))) + 2)
    results, errors = {}, {}
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(SOURCES[s], query, kind, per, orientation): s for s in use}
        for f in cf.as_completed(futs):
            s = futs[f]
            try:
                results[s] = f.result()
            except Exception as e:  # 單一來源失敗不影響其他來源
                errors[s] = f"{type(e).__name__}: {e}"[:200]
    items = []
    # 依來源輪流取，讓各來源都有代表；橫式需求時剔除直式
    pools = [results.get(s, []) for s in use]
    while len(items) < count and any(pools):
        for pool in pools:
            while pool:
                it = pool.pop(0)
                d = it.get("duration")
                try:
                    d = float(d) if d is not None else None
                except (TypeError, ValueError):
                    d = None
                if orientation == "landscape" and it["width"] and it["height"] and it["height"] > it["width"]:
                    continue
                if d is not None and ((min_duration and d < min_duration) or (max_duration and d > max_duration)):
                    continue
                items.append(it)
                break
            if len(items) >= count:
                break
    return {"items": items, "errors": errors, "disabled": {s: NEEDS_KEY[s] for s in off}}


def contact_sheet(items: list[dict], out: Path, cols=4) -> Path | None:
    """下載縮圖並用 ffmpeg 拼成編號對照表（號碼＝items 順序）。"""
    if not items or not shutil.which("ffmpeg"):
        return None
    tmp = Path(tempfile.mkdtemp(prefix="ljcut-stock-"))
    try:
        for i, it in enumerate(items):
            dst = tmp / f"{i:03d}.jpg"
            ok = False
            if it.get("thumb"):
                try:
                    req = urllib.request.Request(safe_url(it["thumb"]), headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=15) as r:
                        raw = tmp / f"raw{i:03d}"
                        raw.write_bytes(r.read())
                    ok = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-frames:v", "1",
                                         "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:-1:-1:color=0x222222",
                                         str(dst)], capture_output=True, timeout=30).returncode == 0
                except Exception:
                    ok = False
            if not ok:  # 沒縮圖（例如音樂）→ 灰底
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x333333:s=320x180",
                                "-frames:v", "1", str(dst)], capture_output=True, timeout=30)
        rows = -(-len(items) // cols)
        font = "C\\:/Windows/Fonts/arialbd.ttf" if os.name == "nt" else "DejaVuSans-Bold.ttf"
        label = (f"drawbox=x=0:y=0:w=46:h=34:color=black@0.75:t=fill,"
                 f"drawtext=fontfile='{font}':text='%{{eif\\:n+1\\:d}}':x=8:y=5:fontsize=24:fontcolor=yellow")
        out.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "1", "-i", str(tmp / "%03d.jpg"),
                            "-vf", f"{label},pad=324:184:2:2:color=0x111111,tile={cols}x{rows}", "-frames:v", "1",
                            "-q:v", "4", str(out)], capture_output=True, timeout=60)
        return out if r.returncode == 0 and out.exists() else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ───────────────────────── 下載與出處 ─────────────────────────


def resolve_download(it: dict) -> str:
    url = it["download"]
    if url.startswith("nasa-manifest:"):
        files = [x if isinstance(x, str) else x.get("href", "") for x in get_json(url.split(":", 1)[1])]
        files = [f.replace("http://", "https://") for f in files]
        if it["kind"] == "video":
            prefs = ["~large.mp4", "~medium.mp4", "~orig.mp4", "~mobile.mp4", "~small.mp4"]
        else:
            prefs = ["~large.jpg", "~orig.jpg", "~medium.jpg", "~orig.png"]
        for p in prefs:
            hit = next((f for f in files if f.endswith(p)), None)
            if hit:
                return hit
        hit = next((f for f in files if f.lower().endswith((".mp4", ".mov") if it["kind"] == "video" else (".jpg", ".png"))), None)
        if not hit:
            raise RuntimeError("NASA 這筆沒有可用的檔案")
        return hit
    if url.startswith("archive-item:"):
        ident = url.split(":", 1)[1]
        meta = get_json(f"https://archive.org/metadata/{urllib.parse.quote(ident)}")
        files = [f for f in meta.get("files", []) if f.get("name", "").lower().endswith(".mp4")]
        if not files:
            raise RuntimeError("Internet Archive 這筆沒有 MP4 檔")

        def score(f):
            fmt = (f.get("format") or "").lower()
            h = int(f.get("height") or 0)
            return (h if h <= 1080 else 0, "h.264" in fmt and "512kb" not in fmt, int(f.get("size") or 0) < 2_000_000_000)
        best = max(files, key=score)
        it["width"], it["height"] = int(best.get("width") or 0), int(best.get("height") or 0)
        return f"https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(best['name'])}"
    return url


def slug(s: str, n=40) -> str:
    s = re.sub(r"[\\/:*?\"<>|\s]+", "-", s).strip("-.")
    return s[:n] or "item"


def fetch(item_id: str, dest: Path, root: Path, max_mb=600) -> dict:
    it = load_cache(root).get(item_id)
    if not it:
        raise RuntimeError(f"找不到 {item_id}：請先用搜尋取得候選（快取保留 7 天）")
    url = resolve_download(it)
    ext = (Path(urllib.parse.urlparse(url).path).suffix.lstrip(".").lower() or it.get("ext") or "bin")
    if ext in ("mp32", "mpga"):
        ext = "mp3"
    dest.mkdir(parents=True, exist_ok=True)
    name = f"{item_id.split(':')[0]}-{slug(item_id.split(':', 1)[1], 24)}-{slug(it['title'], 30)}.{ext}"
    out = dest / name
    if not out.exists():
        part = out.with_suffix(out.suffix + ".part")
        req = urllib.request.Request(safe_url(url), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as f:
            total = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_mb * 1_048_576:
                    f.close()
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"{item_id} 超過 {max_mb} MB，已中止")
                f.write(chunk)
        part.replace(out)
    rec = {k: v for k, v in it.items() if not k.startswith("_") and k != "download"}
    rec.update(file=out.name, downloadUrl=url, fetchedAt=time.strftime("%Y-%m-%d %H:%M"))
    probe = probe_media(out)
    if it["kind"] == "image":
        probe.pop("duration", None)
    elif it["kind"] == "audio":   # mp3 內嵌的專輯封面不是畫面尺寸
        probe.pop("width", None)
        probe.pop("height", None)
    rec.update({k: v for k, v in probe.items() if v})
    out.with_name(out.name + ".license.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    credits = dest / "credits.json"
    try:
        allc = json.loads(credits.read_text(encoding="utf-8"))
    except Exception:
        allc = []
    allc = [c for c in allc if c.get("id") != item_id] + [rec]
    credits.write_text(json.dumps(allc, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"path": out.relative_to(root).as_posix(), **{k: rec.get(k) for k in ("id", "kind", "width", "height", "duration", "license", "attribution")}}


def probe_media(p: Path) -> dict:
    if not shutil.which("ffprobe"):
        return {}
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)],
                           capture_output=True, timeout=30, text=True, encoding="utf-8")
        d = json.loads(r.stdout or "{}")
        v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
        dur = float((d.get("format") or {}).get("duration") or 0) or None
        return {"width": v.get("width"), "height": v.get("height"), "duration": round(dur, 2) if dur else None}
    except Exception:
        return {}


def credits_text(folder: Path) -> str:
    """把資料夾（含子資料夾）內所有 credits.json 整理成可貼進 YouTube 說明欄的出處段落。"""
    recs, seen = [], set()
    for f in sorted(folder.rglob("credits.json")):
        try:
            for c in json.loads(f.read_text(encoding="utf-8")):
                if c.get("id") not in seen:
                    seen.add(c.get("id"))
                    recs.append(c)
        except Exception:
            continue
    if not recs:
        return ""
    lines = ["素材出處："]
    for c in recs:
        who = f" / {c['author']}" if c.get("author") else ""
        lines.append(f"・{c.get('title') or c['id']}{who}（{c['source']}，{c['license']}）{c.get('pageUrl', '')}")
    return "\n".join(lines)


# ───────────────────────── 命令列 ─────────────────────────


def workspace_root() -> Path:
    for cfg in (REPO / "app_data" / "control" / ".ljcut-control.json",):
        if cfg.is_file():
            ws = json.loads(cfg.read_text(encoding="utf-8")).get("workspace")
            if ws:
                return Path(ws)
    return Path.home() / "Documents" / "LJCUT 專案"


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--kind", default="video", choices=KINDS)
    s.add_argument("--sources", nargs="*")
    s.add_argument("--count", type=int, default=12)
    s.add_argument("--sheet", help="對照表輸出路徑（jpg）")
    f = sub.add_parser("fetch")
    f.add_argument("ids", nargs="+")
    f.add_argument("--dest", default="素材庫", help="工作區內的相對資料夾")
    c = sub.add_parser("credits")
    c.add_argument("folder", nargs="?", default="素材庫")
    a = ap.parse_args()
    root = workspace_root()
    if a.cmd == "search":
        res = search(a.query, a.kind, a.sources, a.count, root=root)
        for i, it in enumerate(res["items"], 1):
            dur = f"{float(it['duration']):.0f}s" if it.get("duration") not in (None, "") and str(it["duration"]).replace(".", "", 1).isdigit() else "-"
            print(f"{i:2d}. {it['id']}  {it['width']}x{it['height']}  {dur}  {it['license']}  {it['title'][:50]}")
        if res["errors"]:
            print("來源錯誤：", res["errors"])
        if res["disabled"]:
            print("未啟用（缺金鑰）：", res["disabled"])
        if a.sheet:
            print("對照表：", contact_sheet(res["items"], Path(a.sheet)))
    elif a.cmd == "fetch":
        for i in a.ids:
            print(json.dumps(fetch(i, root / a.dest, root), ensure_ascii=False))
    else:
        print(credits_text(root / a.folder) or "（沒有出處紀錄）")


if __name__ == "__main__":
    main()
