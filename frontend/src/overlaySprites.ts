import { getBase } from './api';
import type { Overlay } from './overlay';

/* 預覽用貼圖快取：向後端要「與匯出同一個繪製程式」畫出的透明 PNG 與位置（原解析度像素）。
   外觀參數相同就共用同一張；改文字、位置、顏色才會重畫。 */

export interface Sprite { url: string; left: number; top: number; width: number; height: number }

const RENDER_FIELDS = ['kind', 'x', 'y', 'w', 'h', 'text', 'sub', 'color', 'from', 'position'] as const;
const cache = new Map<string, Sprite | 'loading' | 'error'>();

function key(o: Overlay, w: number, h: number) {
    return JSON.stringify([w, h, ...RENDER_FIELDS.map(k => o[k] ?? null)]);
}

export interface HtmlDoc { doc: string; width: number; height: number }
const docs = new Map<string, HtmlDoc | 'loading' | 'error'>();
/** HTML 動畫外殼文件（與匯出同一份）；就緒前回 null */
export function getHtmlDoc(html: string, srcW: number, srcH: number): HtmlDoc | null {
    const k = JSON.stringify([srcW, srcH, html]);
    const hit = docs.get(k);
    if (hit && hit !== 'loading' && hit !== 'error') return hit;
    if (!hit) {
        docs.set(k, 'loading');
        fetch(`${getBase()}/api/overlay/html-doc`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html, width: srcW, height: srcH }),
        }).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
            .then(d => docs.set(k, d))
            .catch(() => docs.set(k, 'error'));
    }
    return null;
}

/** 已就緒回傳貼圖；否則在背景請求並回 null（下一格再試） */
export function getSprite(o: Overlay, srcW: number, srcH: number): Sprite | null {
    const k = key(o, srcW, srcH);
    const hit = cache.get(k);
    if (hit && hit !== 'loading' && hit !== 'error') return hit;
    if (!hit) {
        cache.set(k, 'loading');
        fetch(`${getBase()}/api/overlay/render`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overlay: o, width: srcW, height: srcH }),
        }).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
            .then(s => {
                cache.set(k, { ...s, url: `${getBase()}${s.url}` });
            })
            .catch(() => cache.set(k, 'error'));
    }
    return null;
}
