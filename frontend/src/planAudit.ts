/* 套用前自動審核（借鏡 Editkin 的 prepare → audit → apply）。
   dry-run 時對「改之前／改之後」兩份專案跑一次，列出會出事的地方：
   - block：幾乎一定是錯（把一個詞剪成兩半、剪完剩不到 0.3 秒的碎片）→ 套用時要逐條 acknowledge
   - warn ：要人看一眼（剪掉有旁白的地方、字幕被切半、刪太多、旁白被加速）→ 不擋，但會列在試算結果
   純函式；時間全用來源秒數，和 evaluatePlan 相同。 */
import type { ProjectData } from './editCore';
import type { MediaItem, Segment, TimelineClip, WordInfo } from './types';

export type AuditLevel = 'block' | 'warn';
export interface AuditItem {
    id: string;            // 同一份試算內唯一，套用時用來 acknowledge
    level: AuditLevel;
    code: 'CUT_MID_WORD' | 'TINY_CLIP' | 'CUTS_SPEECH' | 'SPLITS_SUBTITLE' | 'LARGE_DELETE' | 'FAST_SPEECH';
    message: string;
    clipId?: string;
    /** 來源秒數，方便跳過去看 */
    source?: [number, number] | number;
}

const TINY = 0.3;            // 剪完剩下的片段短於這個秒數 → 幾乎一定是誤剪
const WORD_EDGE = 0.03;      // 剪點離詞的邊界超過這個秒數才算剪在詞中間
const SPEECH_MIN = 0.15;     // 被剪掉的旁白要超過這個秒數才提醒
const HALF_MIN = 0.1;        // 字幕被切掉與留下的部分都要超過這個秒數才算「切半」
const LARGE_RATIO = 0.4;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const excerpt = (t: string) => t.length > 18 ? t.slice(0, 18) + '…' : t;

function wordsOf(clip: TimelineClip, media: MediaItem | undefined): WordInfo[] {
    const fromClip = clip.segments.flatMap(s => s.words ?? []);
    if (fromClip.length) return fromClip;
    return (media?.transcript?.segments ?? []).flatMap(s => s.words ?? []);
}
function speechOf(clip: TimelineClip, media: MediaItem | undefined): Segment[] {
    return clip.segments.length ? clip.segments : (media?.transcript?.segments ?? []);
}

/** 對一份試算結果做審核。changes 是 evaluatePlan 回傳的變更清單。 */
export function auditPlan(before: ProjectData, after: ProjectData, changes: object[]): AuditItem[] {
    const items: AuditItem[] = [];
    let n = 0;
    const push = (i: Omit<AuditItem, 'id'>) => items.push({ id: `a${++n}`, ...i });
    const clipById = new Map(before.timelineClips.map(c => [c.id, c]));
    const mediaById = new Map(before.mediaItems.map(m => [m.id, m]));
    let removed = 0;

    for (const raw of changes) {
        const ch = raw as { type?: string; clipId?: string; source?: unknown; removedSeconds?: number; speed?: number };
        const clip = ch.clipId ? clipById.get(ch.clipId) : undefined;
        if (!clip) continue;
        const media = mediaById.get(clip.mediaId);
        if (ch.type === 'delete_clip') {
            removed += ch.removedSeconds ?? clip.duration;
            const spoken = speechOf(clip, media).filter(s => s.end > clip.trimStart && s.start < clip.trimEnd);
            if (spoken.length && !clip.bookend)
                push({ level: 'warn', code: 'CUTS_SPEECH', clipId: clip.id, source: [clip.trimStart, clip.trimEnd],
                    message: `整段刪除的片段裡有 ${spoken.length} 句旁白（例如「${excerpt(spoken[0].text)}」）` });
            continue;
        }
        if (!Array.isArray(ch.source)) continue;
        const [s, e] = ch.source as [number, number];
        if (ch.type === 'ripple_delete') {
            removed += ch.removedSeconds ?? (e - s) / clip.speed;
            // 剪在詞中間
            for (const at of [s, e]) {
                if (at <= clip.trimStart + 1e-6 || at >= clip.trimEnd - 1e-6) continue;   // 片段邊界不算剪點
                const w = wordsOf(clip, media).find(w => w.start + WORD_EDGE < at && at < w.end - WORD_EDGE);
                if (w) push({ level: 'block', code: 'CUT_MID_WORD', clipId: clip.id, source: at,
                    message: `剪點 ${fmt(at)} 落在「${w.word.trim()}」中間（${fmt(w.start)}–${fmt(w.end)}），會剪出半個字` });
            }
            // 被剪掉的旁白、被切半的字幕
            const segs = speechOf(clip, media);
            const cut = segs.filter(g => Math.min(g.end, e) - Math.max(g.start, s) >= SPEECH_MIN);
            if (cut.length) push({ level: 'warn', code: 'CUTS_SPEECH', clipId: clip.id, source: [s, e],
                message: `${fmt(s)}–${fmt(e)} 剪掉 ${cut.length} 句旁白：${cut.slice(0, 3).map(g => `「${excerpt(g.text)}」`).join('、')}${cut.length > 3 ? '…' : ''}` });
            for (const g of segs) {
                const inside = Math.min(g.end, e) - Math.max(g.start, s);
                const outside = (g.end - g.start) - Math.max(0, inside);
                if (inside >= HALF_MIN && outside >= HALF_MIN)
                    push({ level: 'warn', code: 'SPLITS_SUBTITLE', clipId: clip.id, source: [g.start, g.end],
                        message: `字幕「${excerpt(g.text)}」（${fmt(g.start)}–${fmt(g.end)}）只剪掉一部分，剩下的字幕可能講不完整` });
            }
        } else if (ch.type === 'set_speed' && (ch.speed ?? 1) > 1.5) {
            const fast = speechOf(clip, media).filter(g => Math.min(g.end, e) - Math.max(g.start, s) >= SPEECH_MIN);
            if (fast.length) push({ level: 'warn', code: 'FAST_SPEECH', clipId: clip.id, source: [s, e],
                message: `${fmt(s)}–${fmt(e)} 加速到 ${ch.speed} 倍，裡面有 ${fast.length} 句旁白會聽不清楚` });
        }
    }

    // 剪完新出現的碎片（改之前就已經很短的片段不算）
    const beforeShort = new Set(before.timelineClips.filter(c => c.duration < TINY).map(c => c.id));
    for (const c of after.timelineClips) {
        if (c.bookend || c.duration >= TINY || beforeShort.has(c.id)) continue;
        push({ level: 'block', code: 'TINY_CLIP', clipId: c.id, source: [c.trimStart, c.trimEnd],
            message: `剪完剩下一段只有 ${c.duration.toFixed(2)} 秒的碎片（來源 ${fmt(c.trimStart)}–${fmt(c.trimEnd)}），通常是剪點差一點` });
    }

    const total = before.timelineClips.reduce((a, c) => a + (c.bookend ? 0 : c.duration), 0);
    if (total > 0 && removed / total > LARGE_RATIO)
        push({ level: 'warn', code: 'LARGE_DELETE',
            message: `這批一次刪掉 ${(removed / total * 100).toFixed(0)}%（${removed.toFixed(1)} 秒／${total.toFixed(1)} 秒），請確認不是區間寫錯` });
    return items;
}

/** 套用前檢查：所有 block 都要在 acknowledge 裡。回傳沒被確認的 block。 */
export function unacknowledged(items: AuditItem[], acknowledge: unknown): AuditItem[] {
    const ok = new Set(Array.isArray(acknowledge) ? acknowledge.filter(x => typeof x === 'string') : []);
    return items.filter(i => i.level === 'block' && !ok.has(i.id));
}
