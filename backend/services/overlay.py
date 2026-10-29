"""標註疊加層（醒目框、箭頭、聚光燈、步驟編號、標題條）。

疊加層存在素材上、用來源秒數（同字幕與縮放），可多層同時出現，陣列順序越後面越上層：
{id, kind, start, end, x, y, w?, h?, text?, sub?, color?, from?, position?}

- 內容層（box / arrow / spotlight / step）：座標是素材畫面比例 0–1，會跟著畫面縮放一起放大，框住的按鈕不會跑掉。
- 畫面層（title）：固定在畫面上，不跟著縮放。

圖案只有一個繪製來源：這裡用 PIL 畫成透明「貼圖」（sprite）。預覽向後端要同一張圖，匯出用 FFmpeg 疊上同一張圖，
所以預覽與成品長得一樣。進出場動畫的公式與 frontend/src/overlay.ts 相同（改一邊要同步改另一邊）。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

KINDS = ("box", "arrow", "spotlight", "step", "title", "html")
CONTENT_KINDS = ("box", "arrow", "spotlight", "step")
COLORS = {
    "red": (255, 59, 48), "yellow": (255, 204, 0), "blue": (10, 132, 255),
    "green": (52, 199, 89), "white": (245, 245, 245),
}
DIRECTIONS = {  # 箭尾相對箭頭尖端的方向（螢幕座標，y 向下）
    "right": (1, 0), "left": (-1, 0), "top": (0, -1), "bottom": (0, 1),
    "top-right": (1, -1), "top-left": (-1, -1), "bottom-right": (1, 1), "bottom-left": (-1, 1),
}
POSITIONS = ("bottom-left", "bottom-center", "top-left", "top-center")
FADE_IN, FADE_OUT = 0.25, 0.2          # 來源秒數
POP_FROM = 0.8                         # 彈出動畫起始比例（box / arrow / step）
SLIDE_PX = 40                          # 標題滑入距離（以 1080p 為基準的像素）
MAX_PER_MEDIA = 200

_FONT_BOLD = [r"C:\Windows\Fonts\msjhbd.ttc", r"C:\Windows\Fonts\msjh.ttc", "/System/Library/Fonts/PingFang.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]
_FONT_REG = [r"C:\Windows\Fonts\msjh.ttc", r"C:\Windows\Fonts\msjhbd.ttc", "/System/Library/Fonts/PingFang.ttc",
             "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]


def _font(size: int, bold=True):
    for p in (_FONT_BOLD if bold else _FONT_REG):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, max(8, int(size)))
            except OSError:
                pass
    return ImageFont.load_default()


# ───────────────────────── 驗證 ─────────────────────────
def _text(v, limit, field):
    if v is None:
        return None
    if not isinstance(v, str) or len(v) > limit or any(ord(c) < 32 for c in v):
        raise ValueError(f"{field} 需為單行文字（最多 {limit} 字）")
    return v.strip() or None


def sanitize(overlays) -> list[dict]:
    """驗證並轉成乾淨的資料（內容會寫進圖片與 FFmpeg 參數，不能信任外部輸入）。不合法丟 ValueError。"""
    if overlays in (None, []):
        return []
    if not isinstance(overlays, list) or len(overlays) > MAX_PER_MEDIA:
        raise ValueError(f"疊加層必須為陣列（每個素材最多 {MAX_PER_MEDIA} 個）")
    out = []
    for o in overlays:
        if not isinstance(o, dict) or o.get("kind") not in KINDS or not isinstance(o.get("id"), str):
            raise ValueError(f"疊加層需有 id 與 kind（{'/'.join(KINDS)}）")
        try:
            c = {"id": o["id"][:80], "kind": o["kind"], "start": float(o["start"]), "end": float(o["end"]),
                 "x": float(o.get("x", 0.5)), "y": float(o.get("y", 0.5))}
            if o["kind"] in ("box", "spotlight"):
                c["w"], c["h"] = float(o["w"]), float(o["h"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("疊加層數值無效（start/end/x/y，框與聚光燈需 w/h）") from None
        if not all(math.isfinite(v) for v in c.values() if isinstance(v, float)):
            raise ValueError("疊加層數值無效")
        if not (c["start"] >= 0 and c["end"] - c["start"] >= 0.3):
            raise ValueError("疊加層至少 0.3 秒")
        if o["kind"] == "html":
            # 自訂 HTML 動畫：外觀由 HTML 決定，只需內容與圖層（content 跟著縮放／screen 固定在畫面上）
            from .html_overlay import check_html, MAX_SECONDS
            if c["end"] - c["start"] > MAX_SECONDS:
                raise ValueError(f"HTML 動畫每段最多 {MAX_SECONDS} 秒")
            layer = o.get("layer", "screen")
            if layer not in ("content", "screen"):
                raise ValueError("HTML 動畫 layer 需為 content 或 screen")
            c.update(html=check_html(o.get("html")), layer=layer)
            name = _text(o.get("text"), 40, "text")   # 只當時間軸上的名稱，不會畫到畫面
            if name:
                c["text"] = name
            out.append(c)
            continue
        if not (0 <= c["x"] <= 1 and 0 <= c["y"] <= 1):
            raise ValueError("疊加層位置 x/y 需為 0–1")
        if "w" in c and not (0.01 <= c["w"] <= 1 and 0.01 <= c["h"] <= 1
                             and c["x"] + c["w"] <= 1.0001 and c["y"] + c["h"] <= 1.0001):
            raise ValueError("框的範圍需在畫面內（x+w、y+h ≤ 1）")
        color = o.get("color", "red" if o["kind"] != "title" else "yellow")
        if color not in COLORS:
            raise ValueError(f"顏色需為 {'/'.join(COLORS)}")
        c["color"] = color
        text = _text(o.get("text"), 3 if o["kind"] == "step" else 40, "text")
        if o["kind"] in ("step", "title") and not text:
            raise ValueError("步驟編號與標題需提供 text")
        if text:
            c["text"] = text
        sub = _text(o.get("sub"), 60, "sub") if o["kind"] == "title" else None
        if sub:
            c["sub"] = sub
        if o["kind"] == "arrow":
            d = o.get("from", "bottom-right")
            if d not in DIRECTIONS:
                raise ValueError(f"箭頭 from 需為 {'/'.join(DIRECTIONS)}")
            c["from"] = d
        if o["kind"] == "title":
            pos = o.get("position", "bottom-left")
            if pos not in POSITIONS:
                raise ValueError(f"標題 position 需為 {'/'.join(POSITIONS)}")
            c["position"] = pos
        out.append(c)
    return out


def is_content(o: dict) -> bool:
    """內容層跟著畫面縮放；標題固定在畫面上；HTML 動畫依 layer 決定。"""
    if o["kind"] == "html":
        return o.get("layer") == "content"
    return o["kind"] in CONTENT_KINDS


def visible(overlays, trim_start: float, trim_end: float) -> list[dict]:
    return [o for o in sanitize(overlays) if o["start"] < trim_end and o["end"] > trim_start]


# ───────────────────────── 繪製 ─────────────────────────
SS = 2  # 先畫 2 倍再縮小（反鋸齒）


def _pill(d: ImageDraw.ImageDraw, xy, text, font, fill, fg=(255, 255, 255), pad=(18, 8)):
    x, y = xy
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    w, h = r - l + pad[0] * 2, b - t + pad[1] * 2
    d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=fill)
    d.text((x + pad[0] - l, y + pad[1] - t), text, font=font, fill=fg)
    return w, h


def _text_size(text, font):
    d = ImageDraw.Draw(Image.new("L", (1, 1)))
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    return r - l, b - t


def render(o: dict, src_w: int, src_h: int) -> tuple[Image.Image, int, int]:
    """把一個疊加層畫成透明貼圖。回傳 (RGBA 圖, left, top)，座標是素材原解析度的像素。"""
    u = src_h / 1080 * SS            # 以 1080p 為基準的單位長度（含超取樣）
    W, H = src_w * SS, src_h * SS
    col = COLORS[o["color"]]
    kind = o["kind"]
    if kind == "spotlight":
        img = Image.new("RGBA", (W, H), (0, 0, 0, 140))
        d = ImageDraw.Draw(img)
        x0, y0, x1, y1 = o["x"] * W, o["y"] * H, (o["x"] + o["w"]) * W, (o["y"] + o["h"]) * H
        d.rounded_rectangle([x0, y0, x1, y1], radius=12 * u, fill=(0, 0, 0, 0))
        d.rounded_rectangle([x0, y0, x1, y1], radius=12 * u, outline=col + (255,), width=round(4 * u))
        if o.get("text"):
            f = _font(30 * u)
            tw, th = _text_size(o["text"], f)
            ty = y1 + 14 * u if y1 + 14 * u + th + 16 * u < H else y0 - th - 30 * u
            _pill(d, (max(0, min(W - tw - 36 * u, x0)), ty), o["text"], f, col + (255,), pad=(round(18 * u), round(8 * u)))
        return img.resize((src_w, src_h), Image.LANCZOS), 0, 0

    # 其他類型：先在足夠大的畫布上畫，再裁出有內容的範圍當貼圖
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    if kind == "box":
        x0, y0, x1, y1 = o["x"] * W, o["y"] * H, (o["x"] + o["w"]) * W, (o["y"] + o["h"]) * H
        stroke = round(6 * u)
        # 深色外框提高在亮色介面上的對比
        d.rounded_rectangle([x0 - stroke, y0 - stroke, x1 + stroke, y1 + stroke], radius=14 * u,
                            outline=(0, 0, 0, 110), width=round(3 * u))
        d.rounded_rectangle([x0, y0, x1, y1], radius=12 * u, fill=col + (28,), outline=col + (255,), width=stroke)
        if o.get("text"):
            f = _font(30 * u)
            tw, th = _text_size(o["text"], f)
            ph = th + 16 * u
            ty = y0 - ph - 10 * u if y0 - ph - 10 * u >= 0 else y1 + 10 * u
            _pill(d, (max(0, min(W - tw - 36 * u, x0)), ty), o["text"], f, col + (255,), pad=(round(18 * u), round(8 * u)))
    elif kind == "step":
        r = 34 * u
        cx, cy = o["x"] * W, o["y"] * H
        d.ellipse([cx - r - 5 * u, cy - r - 5 * u, cx + r + 5 * u, cy + r + 5 * u], fill=(0, 0, 0, 90))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,), outline=(255, 255, 255, 255), width=round(4 * u))
        f = _font(40 * u if len(o["text"]) <= 2 else 30 * u)
        l, t, rr, b = d.textbbox((0, 0), o["text"], font=f)
        fg = (20, 20, 20) if o["color"] in ("yellow", "white") else (255, 255, 255)
        d.text((cx - (rr - l) / 2 - l, cy - (b - t) / 2 - t), o["text"], font=f, fill=fg)
    elif kind == "arrow":
        dx, dy = DIRECTIONS[o["from"]]
        n = math.hypot(dx, dy)
        dx, dy = dx / n, dy / n
        tipx, tipy = o["x"] * W, o["y"] * H
        gap, length, shaft, head = 10 * u, 170 * u, 14 * u, 46 * u
        sx, sy = tipx + dx * gap, tipy + dy * gap                     # 尖端（稍微離開目標）
        ex, ey = sx + dx * length, sy + dy * length                   # 箭尾
        px, py = -dy, dx                                              # 垂直方向
        bx, by = sx + dx * head, sy + dy * head                       # 箭頭底部中心

        def poly(scale_w):
            hw, sw = head * 0.62 * scale_w, shaft / 2 * scale_w
            return [(sx, sy), (bx + px * hw, by + py * hw), (bx + px * sw, by + py * sw), (ex + px * sw, ey + py * sw),
                    (ex - px * sw, ey - py * sw), (bx - px * sw, by - py * sw), (bx - px * hw, by - py * hw)]
        d.polygon(poly(1.35), fill=(255, 255, 255, 255))             # 白邊
        d.polygon(poly(1.0), fill=col + (255,))
        if o.get("text"):
            f = _font(30 * u)
            tw, th = _text_size(o["text"], f)
            pw, ph = tw + 36 * u, th + 16 * u
            lx = ex - pw / 2 + dx * (pw / 2 + 8 * u)
            ly = ey - ph / 2 + dy * (ph / 2 + 8 * u)
            _pill(d, (max(0, min(W - pw, lx)), max(0, min(H - ph, ly))), o["text"], f, col + (255,),
                  pad=(round(18 * u), round(8 * u)))
    elif kind == "title":
        f1, f2 = _font(46 * u), _font(28 * u, bold=False)
        tw, th = _text_size(o["text"], f1)
        sw, sh = _text_size(o["sub"], f2) if o.get("sub") else (0, 0)
        padx, pady, bar = 30 * u, 20 * u, 10 * u
        pw = bar + padx * 2 + max(tw, sw)
        ph = pady * 2 + th + (sh + 12 * u if o.get("sub") else 0)
        margin = 60 * u
        pos = o["position"]
        px0 = margin if pos.endswith("left") else (W - pw) / 2
        py0 = H - margin - ph if pos.startswith("bottom") else margin
        d.rounded_rectangle([px0 + 4 * u, py0 + 6 * u, px0 + pw + 4 * u, py0 + ph + 6 * u], radius=14 * u, fill=(0, 0, 0, 90))
        d.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=14 * u, fill=(18, 20, 28, 225))
        d.rounded_rectangle([px0, py0, px0 + bar + 6 * u, py0 + ph], radius=14 * u, fill=col + (255,))
        d.rectangle([px0 + bar, py0, px0 + bar + 8 * u, py0 + ph], fill=(18, 20, 28, 225))
        l, t, _, _ = d.textbbox((0, 0), o["text"], font=f1)
        d.text((px0 + bar + padx - l, py0 + pady - t), o["text"], font=f1, fill=(255, 255, 255))
        if o.get("sub"):
            l2, t2, _, _ = d.textbbox((0, 0), o["sub"], font=f2)
            d.text((px0 + bar + padx - l2, py0 + pady + th + 12 * u - t2), o["sub"], font=f2, fill=(200, 205, 215))
    bbox = canvas.getbbox()
    if not bbox:
        return Image.new("RGBA", (2, 2), (0, 0, 0, 0)), 0, 0
    # 留一點邊，並對齊到偶數像素（縮小後座標整齊）
    m = round(4 * u)
    l, t = max(0, (bbox[0] - m) // (2 * SS) * 2 * SS), max(0, (bbox[1] - m) // (2 * SS) * 2 * SS)
    r, b = min(W, bbox[2] + m), min(H, bbox[3] + m)
    sprite = canvas.crop((l, t, r, b))
    w, h = max(2, round(sprite.width / SS / 2) * 2), max(2, round(sprite.height / SS / 2) * 2)
    return sprite.resize((w, h), Image.LANCZOS), l // SS, t // SS


RENDER_FIELDS = ("kind", "x", "y", "w", "h", "text", "sub", "color", "from", "position")


def render_key(o: dict, src_w: int, src_h: int) -> str:
    spec = {k: o.get(k) for k in RENDER_FIELDS} | {"W": src_w, "H": src_h, "v": 1}
    return hashlib.sha1(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]


def render_cached(o: dict, src_w: int, src_h: int, cache_dir: Path) -> dict:
    """畫好存成 PNG（以外觀參數雜湊快取），回傳 {path, file, left, top, width, height}。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = render_key(o, src_w, src_h)
    png, meta = cache_dir / f"{key}.png", cache_dir / f"{key}.json"
    if png.exists() and meta.exists():
        info = json.loads(meta.read_text(encoding="utf-8"))
    else:
        img, left, top = render(o, src_w, src_h)
        tmp = png.with_suffix(".tmp.png")
        img.save(tmp, "PNG")
        os.replace(tmp, png)
        info = {"left": left, "top": top, "width": img.width, "height": img.height}
        meta.write_text(json.dumps(info), encoding="utf-8")
    return {"path": str(png), "file": png.name, **info}


# ───────────────────────── 匯出濾鏡 ─────────────────────────
def _num(v: float) -> str:
    return f"{float(v):.6f}".rstrip('0').rstrip('.') or '0'


def anim_filters(o: dict, trim_start: float, speed: float, scale_k: float = 1.0, src_h: int = 1080) -> tuple[str, str, str]:
    """回傳（貼圖串流濾鏡、overlay 的 x 偏移表達式、enable 表達式）。時間 t 為片段輸出秒數。

    進出場在來源秒數定義（與預覽同一公式），換算成輸出秒數要除以倍速。
    """
    ta = (o["start"] - trim_start) / speed
    tb = (o["end"] - trim_start) / speed
    fi, fo = FADE_IN / speed, FADE_OUT / speed
    k_in = f"clip((t-{_num(ta)})/{_num(fi)},0,1)"
    smooth = f"({k_in}*{k_in}*(3-2*{k_in}))"
    chain = [f"format=rgba"]
    if scale_k != 1.0:
        chain.append(f"scale=iw*{_num(scale_k)}:ih*{_num(scale_k)}")
    if o["kind"] in ("box", "arrow", "step"):
        s = f"({_num(POP_FROM)}+{_num(1 - POP_FROM)}*{smooth})"
        chain.append(f"scale=w='max(2,trunc(iw*{s}/2)*2)':h='max(2,trunc(ih*{s}/2)*2)':eval=frame")
    chain.append(f"fade=t=in:st={_num(ta)}:d={_num(fi)}:alpha=1")
    chain.append(f"fade=t=out:st={_num(tb - fo)}:d={_num(fo)}:alpha=1")
    dx = "0"
    if o["kind"] == "title":
        dx = f"(-(1-{smooth})*{_num(SLIDE_PX * src_h / 1080 * scale_k)})"   # 1080p 基準 → 原檔像素 → 輸出像素
    enable = f"between(t,{_num(max(0.0, ta))},{_num(tb)})"
    return ",".join(chain), dx, enable


def anim_state(o: dict, t: float) -> tuple[float, float, float]:
    """Python 版動畫狀態（測試用）：(opacity, scale, slide_px@1080p)。"""
    k = max(0.0, min(1.0, (t - o["start"]) / FADE_IN))
    out = max(0.0, min(1.0, (o["end"] - t) / FADE_OUT))
    smooth = k * k * (3 - 2 * k)
    scale = POP_FROM + (1 - POP_FROM) * smooth if o["kind"] in ("box", "arrow", "step") else 1.0
    slide = -(1 - smooth) * SLIDE_PX if o["kind"] == "title" else 0.0
    return min(k, out), scale, slide
