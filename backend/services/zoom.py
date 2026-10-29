"""畫面縮放（zoom in／平移）的 FFmpeg 濾鏡與自動縮放建議。

縮放區段存在素材上、用來源秒數：{id, start, end, x, y, scale, ease?}，x/y 為放大中心（畫面比例 0–1）。
公式與前端 frontend/src/zoom.ts 相同（smoothstep 緩動、中心夾在畫面內），改一邊要同步改另一邊。

匯出做法：先以「放大後尺寸」從原檔直接縮放（scale eval=frame，保留原檔細節），再裁切回畫面大小。
crop 的 iw 只在設定時算一次，因此裁切位置改用時間 t 重算同一個尺寸公式，不依賴 iw。
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

DEFAULT_EASE = 0.4


def _num(v: float) -> str:
    return f"{float(v):.6f}".rstrip('0').rstrip('.') or '0'


def sanitize(zooms) -> list[dict]:
    """驗證並轉成純數字（數值會寫進 FFmpeg 表達式，不能信任外部輸入）。不合法時丟 ValueError。"""
    if zooms in (None, []):
        return []
    if not isinstance(zooms, list) or len(zooms) > 500:
        raise ValueError('縮放必須為陣列（最多 500 段）')
    out = []
    for z in zooms:
        if not isinstance(z, dict):
            raise ValueError('縮放區段格式無效')
        try:
            c = {k: float(z[k]) for k in ('start', 'end', 'x', 'y', 'scale')}
            c['ease'] = float(z.get('ease', DEFAULT_EASE))
        except (KeyError, TypeError, ValueError):
            raise ValueError('縮放區段需有數字 start/end/x/y/scale') from None
        if not all(math.isfinite(v) for v in c.values()):
            raise ValueError('縮放數值無效')
        if not (0 <= c['start'] and c['end'] - c['start'] >= 0.5 and 0 <= c['x'] <= 1 and 0 <= c['y'] <= 1
                and 1.1 <= c['scale'] <= 4 and 0.1 <= c['ease'] <= 1.5):
            raise ValueError('縮放區段超出範圍（至少 0.5 秒、x/y 0–1、倍率 1.1–4、緩動 0.1–1.5 秒）')
        out.append(c)
    out.sort(key=lambda z: z['start'])
    for a, b in zip(out, out[1:]):
        if b['start'] < a['end'] - 1e-6:
            raise ValueError('同一素材的縮放區段不可重疊')
    return out


def overlapping(zooms, trim_start: float, trim_end: float) -> list[dict]:
    return [z for z in sanitize(zooms) if z['start'] < trim_end and z['end'] > trim_start]


def fit_size(src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    """等比縮進輸出畫面（不放大超出、不變形），回傳偶數寬高。"""
    if src_w / src_h > out_w / out_h:
        w, h = out_w, out_w * src_h / src_w
    else:
        w, h = out_h * src_w / src_h, out_h
    return max(2, int(round(w / 2)) * 2), max(2, int(round(h / 2)) * 2)


def _state(zooms: list[dict], trim_start: float, speed: float) -> str:
    """算出目前縮放狀態的表達式前段：每個量只算一次，存進變數
    ld(0)=來源秒數、ld(2)=倍率、ld(3)/ld(4)=放大中心（未夾限）。區段不重疊，最多只有一段權重非 0。"""
    expr = f"st(0,{_num(trim_start)}+t*{_num(speed)});st(2,1);st(3,0.5);st(4,0.5)"
    for z in zooms:
        e = _num(min(float(z.get('ease', DEFAULT_EASE)), (z['end'] - z['start']) / 2))
        expr += (f";st(1,clip(min((ld(0)-{_num(z['start'])})/{e},({_num(z['end'])}-ld(0))/{e}),0,1))"
                 f";st(1,ld(1)*ld(1)*(3-2*ld(1)))"
                 f";st(2,ld(2)+{_num(z['scale'] - 1)}*ld(1))"
                 f";st(3,ld(3)+{_num(z['x'] - 0.5)}*ld(1))"
                 f";st(4,ld(4)+{_num(z['y'] - 0.5)}*ld(1))")
    return expr


def zoom_filters(zooms: list[dict], trim_start: float, speed: float, fit_w: int, fit_h: int) -> list[str]:
    """回傳取代「縮放到輸出尺寸」那一步的濾鏡（放在 setpts 之後、pad 之前）。

    t 是 setpts 歸零並變速後的輸出秒數，來源秒數 = trim_start + t*speed。
    區段多時表達式很長，呼叫端應以 -filter_script 傳入（不受命令列長度限制）。
    """
    s = _state(zooms, trim_start, speed)
    zw = f"trunc({fit_w}*ld(2)/2)*2"
    zh = f"trunc({fit_h}*ld(2)/2)*2"
    x = f"{s};st(5,{zw});clip(ld(3)*ld(5)-{fit_w / 2},0,ld(5)-{fit_w})"
    y = f"{s};st(5,{zh});clip(ld(4)*ld(5)-{fit_h / 2},0,ld(5)-{fit_h})"
    return [f"scale=w='{s};{zw}':h='{s};{zh}':eval=frame:flags=bicubic",
            f"crop=w={fit_w}:h={fit_h}:x='{x}':y='{y}'"]


def zoom_at(zooms: list[dict] | None, t: float) -> tuple[float, float, float]:
    """Python 版 zoomAt（供測試與觀察工具使用）：回傳 (scale, x, y)，x/y 已夾在畫面內。"""
    scale, x, y = 1.0, 0.5, 0.5
    for z in zooms or []:
        if not (z['start'] <= t < z['end']):
            continue
        e = min(float(z.get('ease', DEFAULT_EASE)), (z['end'] - z['start']) / 2)
        p = max(0.0, min(1.0, min((t - z['start']) / e, (z['end'] - t) / e)))
        k = p * p * (3 - 2 * p)
        scale += (z['scale'] - 1) * k
        x += (z['x'] - 0.5) * k
        y += (z['y'] - 0.5) * k
        break
    half = 0.5 / scale
    return scale, min(1 - half, max(half, x)), min(1 - half, max(half, y))


def suggest_from_cursor(track: dict, duration: float, *, gap: float = 2.5, lead: float = 0.8,
                        tail: float = 1.6, min_len: float = 1.5) -> list[dict]:
    """依錄影時的滑鼠點擊建議縮放區段（來源秒數）。

    把時間相近的點擊歸成一組：區段從第一次點擊前 lead 秒到最後一次點擊後 tail 秒，
    中心取點擊的平均位置，倍率依點擊分佈範圍決定（越集中放越大，1.5–2.2 倍）。
    """
    w, h = track.get('width') or 0, track.get('height') or 0
    clicks = sorted((c for c in track.get('clicks', []) if 0 <= c[0] <= duration), key=lambda c: c[0])
    if not (w and h and clicks):
        return []
    groups: list[list] = [[clicks[0]]]
    for c in clicks[1:]:
        prev = groups[-1][-1]
        far = math.hypot((c[1] - prev[1]) / w, (c[2] - prev[2]) / h) > 0.35
        if c[0] - prev[0] > gap or far:
            groups.append([c])
        else:
            groups[-1].append(c)
    out = []
    for g in groups:
        start = max(0.0, g[0][0] - lead)
        end = min(duration, g[-1][0] + tail)
        if end - start < min_len:
            end = min(duration, start + min_len)
        xs = [c[1] / w for c in g]
        ys = [c[2] / h for c in g]
        spread = max(max(xs) - min(xs), max(ys) - min(ys))
        scale = round(max(1.5, min(2.2, 1 / (spread + 0.4))), 2)
        cx = min(1.0, max(0.0, sum(xs) / len(xs)))
        cy = min(1.0, max(0.0, sum(ys) / len(ys)))
        if out and start < out[-1]['end']:
            # 與前一段重疊（時間相近但位置差很遠才會分組）：在兩組點擊中間切開
            prev = out[-1]
            cut = (prev['_last'] + g[0][0]) / 2
            prev['end'] = round(min(prev['end'], cut), 2)
            start = cut
        out.append({'start': round(start, 2), 'end': round(end, 2), 'x': round(cx, 3), 'y': round(cy, 3),
                    'scale': scale, 'clicks': len(g), '_last': g[-1][0]})
    for z in out:
        z.pop('_last')
    return [z for z in out if z['end'] - z['start'] >= 0.5]


def load_track_file(path: Path) -> dict | None:
    """讀取錄影的 .cursor.json；格式不對回 None。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        w, h = int(data["width"]), int(data["height"])
        clicks = [[float(c[0]), float(c[1]), float(c[2]), int(c[3])] for c in data.get("clicks", [])]
        samples = [[float(s[0]), float(s[1]), float(s[2]), int(s[3])] for s in data.get("samples", [])]
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return None
    if w <= 0 or h <= 0:
        return None
    return {"width": w, "height": h, "clicks": clicks, "samples": samples}


def load_track(uploads: Path, media_id: str) -> dict | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", media_id or ""):
        return None
    p = uploads / "cursor" / f"{media_id}.json"
    return load_track_file(p) if p.is_file() else None


def track_report(track: dict, duration: float) -> dict:
    """給 AI／介面看的摘要：錄影範圍內的點擊（畫面比例座標）與自動縮放建議。"""
    w, h = track["width"], track["height"]
    clicks = [{"t": round(c[0], 2), "x": round(c[1] / w, 3), "y": round(c[2] / h, 3),
               "button": "right" if c[3] == 2 else "left"}
              for c in track["clicks"] if 0 <= c[1] <= w and 0 <= c[2] <= h and 0 <= c[0] <= duration]
    inside = {"width": w, "height": h, "clicks": [c for c in track["clicks"] if 0 <= c[1] <= w and 0 <= c[2] <= h]}
    return {"width": w, "height": h, "duration": duration, "clicks": clicks[:500],
            "suggestions": suggest_from_cursor(inside, duration)}
