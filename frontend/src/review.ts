/* 審片標註（借鏡 Editkin 的審片表格）：看片時在某個時間點記一句要改什麼。
   和縮放、疊加層一樣存在素材上、用來源秒數，所以之後剪接、加片頭都不會讓標註跑位；
   被剪掉的地方標註仍保留，只是時間軸上看不到（清單會標「已剪掉」）。 */
import type { TimelineClip } from './types';

export const REVIEW_CATS = ['畫面', '聲音', '字幕', '觀念', '節奏', '其他'] as const;
export type ReviewCat = typeof REVIEW_CATS[number];
export type ReviewStatus = 'open' | 'fixed' | 'skip';
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = { open: '未處理', fixed: '已改', skip: '不改' };

export interface ReviewNote {
    id: string;
    /** 來源秒數 */
    t: number;
    cat: ReviewCat;
    text: string;
    status: ReviewStatus;
    /** 處理的人（通常是 AI）留的一句回覆 */
    reply?: string;
    /** 誰記的：介面上自己記、AI 記、從手機審片頁匯入 */
    by?: 'user' | 'ai' | 'phone';
    createdAt: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function checkNotes(list: unknown, duration: number): string | null {
    if (list === undefined) return null;
    if (!Array.isArray(list) || list.length > 500) return '審片標註必須為陣列（每個素材最多 500 條）';
    const ids = new Set<string>();
    for (const n of list as ReviewNote[]) {
        if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id)) return '審片標註 ID 必須唯一';
        ids.add(n.id);
        if (!finite(n.t) || n.t < 0 || n.t > duration + 1e-3) return `審片標註時間 ${n.t} 超出素材長度`;
        if (!REVIEW_CATS.includes(n.cat)) return `審片標註類型需為 ${REVIEW_CATS.join('／')}`;
        if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > 2000) return '審片標註文字需為 1–2000 字';
        if (!['open', 'fixed', 'skip'].includes(n.status)) return '審片標註狀態需為 open／fixed／skip';
        if (n.reply !== undefined && (typeof n.reply !== 'string' || n.reply.length > 2000)) return '審片標註回覆最多 2000 字';
        if (n.by !== undefined && !['user', 'ai', 'phone'].includes(n.by)) return '審片標註來源無效';
        if (!finite(n.createdAt)) return '審片標註建立時間無效';
    }
    return null;
}

/** 時間軸秒數 → 素材與來源秒數（片頭片尾上的時間點也能標，記在片頭素材上） */
export function timelineToSource(clips: TimelineClip[], t: number): { mediaId: string; source: number; clipId: string } | null {
    const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
    const c = sorted.find(c => t >= c.startTime && t < c.startTime + c.duration) ?? (t >= 0 ? sorted[sorted.length - 1] : undefined);
    if (!c) return null;
    const local = Math.min(Math.max(t - c.startTime, 0), c.duration);
    return { mediaId: c.mediaId, source: c.trimStart + local * c.speed, clipId: c.id };
}

/** 來源秒數 → 時間軸秒數；那一刻已被剪掉回傳 null */
export function sourceToTimeline(clips: TimelineClip[], mediaId: string, source: number): number | null {
    for (const c of clips) {
        if (c.mediaId === mediaId && source >= c.trimStart - 1e-6 && source < c.trimEnd + 1e-6)
            return c.startTime + (Math.min(source, c.trimEnd) - c.trimStart) / c.speed;
    }
    return null;
}

/** 把所有素材上的標註攤平成清單（附時間軸位置），依時間排序；剪掉的排最後 */
export function flattenNotes(media: { id: string; reviewNotes?: ReviewNote[] }[], clips: TimelineClip[]) {
    return media.flatMap(m => (m.reviewNotes ?? []).map(n => ({ ...n, mediaId: m.id, tl: sourceToTimeline(clips, m.id, n.t) })))
        .sort((a, b) => (a.tl ?? Infinity) - (b.tl ?? Infinity) || a.createdAt - b.createdAt);
}

export const fmtTime = (s: number) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(x).padStart(2, '0');
};
/** 「1:23」「83」「1:02:03」「123（＝1:23）」→ 秒數 */
export function parseTime(v: string): number | null {
    v = (v || '').trim().replace(/[：.．]/g, ':');
    if (!v) return null;
    if (/^\d+$/.test(v)) { const n = +v; return v.length >= 3 ? Math.floor(n / 100) * 60 + n % 100 : n; }
    const p = v.split(':').map(Number);
    if (p.some(x => !Number.isFinite(x))) return null;
    return p.reduce((a, b) => a * 60 + b, 0);
}
