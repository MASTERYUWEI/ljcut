import { getBase } from './api';
import type { MediaItem } from './types';

/* 預覽代理檔：長片／高解析度素材由後端背景轉 720p。
   只影響預覽 <video> 的 src；專案檔與匯出仍用原檔。
   代理檔就緒後不強制換源，下次切片段/跳點時自然改用，不打斷播放。 */

const ready = new Map<string, string>();
const requested = new Set<string>();

async function ensure(id: string) {
    for (let i = 0; i < 2000; i++) {
        let st: { status: string; url?: string } | null = null;
        try {
            const res = await fetch(`${getBase()}/api/proxy/${id}`, { method: i === 0 ? 'POST' : 'GET' });
            if (res.ok) st = await res.json();
        } catch { /* 後端暫時不可用：稍後再試 */ }
        if (st?.status === 'ready' && st.url) { ready.set(id, `${getBase()}${st.url}`); return; }
        if (st && st.status !== 'pending') return; // skip / failed / none → 用原檔
        await new Promise(r => setTimeout(r, 5000));
    }
}

/** 預覽用來源：代理檔就緒則用代理檔，否則原檔（首次呼叫時在背景要求產生） */
export function previewSrc(media: MediaItem): string {
    const hit = ready.get(media.id);
    if (hit) return hit;
    if (!requested.has(media.id) && /^[0-9a-f-]{12}$/.test(media.id)) {
        requested.add(media.id);
        void ensure(media.id);
    }
    return media.url;
}

/** video 元素目前是否已載入這個素材（原檔或代理檔皆算） */
export function hasSrc(el: HTMLVideoElement, url: string): boolean {
    return el.src === url || el.src.endsWith(url);
}

/** video 元素正在播的是不是這個素材（原檔或代理檔都算；代理檔可能在播放途中才就緒） */
export function isShowing(el: HTMLVideoElement, media: MediaItem): boolean {
    if (!el.src) return false;
    const proxy = ready.get(media.id);
    return hasSrc(el, media.url) || (!!proxy && hasSrc(el, proxy));
}
