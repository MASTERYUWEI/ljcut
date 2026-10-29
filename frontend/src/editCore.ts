import type { MediaItem, Segment, TimelineClip } from './types';
import type { SubtitleStyle } from './store';
import { TRANSITIONS, type TransitionKind } from './transitions';
import { checkZooms, type ZoomRegion } from './zoom';
import { checkOverlays, OVERLAY_KINDS, type Overlay } from './overlay';

export const TRACKS = [{ id: 'video-main', index: 0, kind: 'video-with-audio' as const },
    { id: 'subtitles-main', index: 1, kind: 'clip-subtitles' as const }];
export interface ProjectData {
    schemaVersion: 1;
    projectId: string;
    mediaItems: MediaItem[];
    timelineClips: TimelineClip[];
    subtitleStyle: SubtitleStyle;
    language: string;
}
export class EditError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
export function requireEdit(ok: unknown, code: string, message: string): asserts ok {
    if (!ok) throw new EditError(code, message);
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export const durationOf = (clips: TimelineClip[]) => Math.max(0, ...clips.map(c => c.startTime + c.duration));
export const toSourceTime = (c: TimelineClip, t: number) => c.trimStart + (t - c.startTime) * c.speed;
export const toTimelineTime = (c: TimelineClip, t: number) => c.startTime + (t - c.trimStart) / c.speed;

/** Clip boundaries are half-open. Raw ASR remains on the media, in source seconds. */
export function clippedSegments(segments: Segment[], start: number, end: number): Segment[] {
    return segments.filter(s => s.end > start && s.start < end).map(s => ({
        ...s, start: Math.max(start, s.start), end: Math.min(end, s.end),
        ...(s.words ? { words: s.words.filter(w => w.end > start && w.start < end).map(w => ({
            ...w, start: Math.max(start, w.start), end: Math.min(end, w.end),
        })) } : {}),
    }));
}
export function timelineSegments(clips: TimelineClip[]): Segment[] {
    return clips.filter(c => c.trackIndex === 0).sort((a, b) => a.startTime - b.startTime)
        .flatMap(c => clippedSegments(c.segments, c.trimStart, c.trimEnd).map(s => ({
            ...s, start: toTimelineTime(c, s.start), end: toTimelineTime(c, s.end),
        }))).map((s, id) => ({ ...s, id }));
}
export function splitClip(c: TimelineClip, sourceTime: number, rightId: string): [TimelineClip, TimelineClip] {
    requireEdit(finite(sourceTime) && sourceTime > c.trimStart && sourceTime < c.trimEnd,
        'INVALID_RANGE', '分割點必須在來源裁切範圍內');
    return [
        { ...c, trimEnd: sourceTime, duration: (sourceTime - c.trimStart) / c.speed,
            segments: clippedSegments(c.segments, c.trimStart, sourceTime) },
        { ...c, transitionIn: undefined, id: rightId, startTime: toTimelineTime(c, sourceTime), trimStart: sourceTime,
            duration: (c.trimEnd - sourceTime) / c.speed,
            segments: clippedSegments(c.segments, sourceTime, c.trimEnd) },
    ];
}
export function validateProject(p: ProjectData, continuous = false): void {
    requireEdit(p && p.schemaVersion === 1 && typeof p.projectId === 'string' && p.projectId.length > 0,
        'INVALID_PROJECT', '不支援的專案格式');
    requireEdit(Array.isArray(p.mediaItems) && Array.isArray(p.timelineClips) && p.subtitleStyle && typeof p.language === 'string',
        'INVALID_PROJECT', '專案缺少素材、片段或字幕設定');
    requireEdit(typeof p.subtitleStyle.fontName === 'string' && p.subtitleStyle.fontName.length > 0
        && !/[\r\n,]/.test(p.subtitleStyle.fontName)
        && [p.subtitleStyle.fontSize, p.subtitleStyle.outlineWidth, p.subtitleStyle.bgOpacity, p.subtitleStyle.posY, p.subtitleStyle.maxCharsPerCue].every(finite)
        && p.subtitleStyle.fontSize > 0 && p.subtitleStyle.outlineWidth >= 0
        && p.subtitleStyle.posY >= 0 && p.subtitleStyle.posY <= 100
        && p.subtitleStyle.bgOpacity >= 0 && p.subtitleStyle.bgOpacity <= 100,
    'INVALID_STYLE', '字幕樣式包含無效數值');
    requireEdit(p.timelineClips.every(c => c && typeof c === 'object'), 'INVALID_CLIP', '片段格式無效');
    const mediaIds = new Set<string>();
    for (const m of p.mediaItems) {
        requireEdit(typeof m.id === 'string' && !mediaIds.has(m.id) && typeof m.url === 'string'
            && typeof m.filename === 'string' && Array.isArray(m.waveformPeaks)
            && m.info && finite(m.info.duration) && m.info.duration > 0, 'INVALID_MEDIA', '素材 ID 或長度無效');
        const zoomError = checkZooms(m.zooms, m.info.duration);
        requireEdit(!zoomError, 'INVALID_ZOOM', zoomError!);
        const overlayError = checkOverlays(m.overlays, m.info.duration);
        requireEdit(!overlayError, 'INVALID_OVERLAY', overlayError!);
        mediaIds.add(m.id);
    }
    const ids = new Set<string>();
    const ordered = [...p.timelineClips].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i], t = c.transitionIn;
        if (!t) continue;
        requireEdit(Object.prototype.hasOwnProperty.call(TRANSITIONS, t.kind) && finite(t.duration) && t.duration >= 0.2 && t.duration <= 1.5,
            'INVALID_TRANSITION', '轉場需為淡黑、柔灰或淡白，長度 0.2–1.5 秒');
        if (continuous) {
            if (i === 0) continue; // Moving/deleting the previous clip leaves no incoming boundary.
            requireEdit(t.duration / 2 <= ordered[i - 1].duration && t.duration / 2 <= c.duration,
                'INVALID_TRANSITION', '轉場必須有前一片段，且不可超出相鄰片段長度');
            const next = ordered[i + 1]?.transitionIn;
            requireEdit(t.duration / 2 + (next?.duration ?? 0) / 2 <= c.duration,
                'INVALID_TRANSITION', '片段太短，轉場範圍重疊');
        }
    }
    let end = 0;
    for (const c of [...p.timelineClips].sort((a, b) => a.startTime - b.startTime)) {
        requireEdit(typeof c.id === 'string' && !ids.has(c.id), 'INVALID_CLIP', '片段 ID 必須唯一');
        ids.add(c.id);
        const m = p.mediaItems.find(m => m.id === c.mediaId);
        requireEdit(m, 'MEDIA_NOT_FOUND', `找不到素材 ${c.mediaId}`);
        requireEdit(c.trackIndex === 0, 'UNSUPPORTED_TRACK', '第一階段僅支援 video-main（內含音訊與片段字幕）');
        requireEdit([c.startTime, c.trimStart, c.trimEnd, c.duration, c.speed].every(finite)
            && c.startTime >= 0 && c.trimStart >= 0 && c.trimEnd > c.trimStart
            && c.trimEnd <= m.info.duration + 0.001 && c.speed >= 1 && c.speed <= 5
            && Math.abs(c.duration - (c.trimEnd - c.trimStart) / c.speed) < 1e-6,
        'INVALID_RANGE', `片段 ${c.id} 時間或速度無效（單位：秒）`);
        if (continuous) {
            requireEdit(Math.abs(c.startTime - end) < 1e-6, 'UNSUPPORTED_LAYOUT', '第一階段計畫與輸出需為從 0 秒開始、無空隙／重疊的單軌');
        }
        end = c.startTime + c.duration;
        requireEdit(Array.isArray(c.segments), 'INVALID_SUBTITLE', '字幕必須為陣列');
        const segIds = new Set<number>();
        for (const s of c.segments) {
            requireEdit(Number.isInteger(s.id) && !segIds.has(s.id) && finite(s.start) && finite(s.end)
                && s.start >= 0 && s.end > s.start && typeof s.text === 'string', 'INVALID_SUBTITLE', '字幕 ID 或來源時間無效');
            segIds.add(s.id);
        }
    }
}

export type EditOperation = {
    type: 'ripple_delete' | 'add_subtitle' | 'split' | 'set_speed' | 'move_clip'
        | 'delete_clip' | 'edit_subtitle' | 'delete_subtitle' | 'add_zoom' | 'edit_zoom' | 'delete_zoom'
        | 'add_overlay' | 'edit_overlay' | 'delete_overlay';
    /** 省略時依來源秒數（start / at）自動找片段；同批前面的操作分割過也能正確定位 */
    clipId?: string;
    /** 省略 clipId 時可指定素材，避免同一來源時間出現在多個片段 */
    mediaId?: string;
    trackId: 'video-main';
    timeDomain: 'source';
    /** ripple_delete / add_subtitle / set_speed：來源秒數區間（左閉右開） */
    start?: number;
    end?: number;
    /** split：來源秒數分割點 */
    at?: number;
    /** set_speed：1–5 倍 */
    speed?: number;
    /** move_clip：移到時間軸第幾個位置（0 起算，依目前順序） */
    toIndex?: number;
    /** edit_subtitle / delete_subtitle：片段內字幕 ID */
    segmentId?: number;
    text?: string;
    /** add_zoom / edit_zoom：放大中心（0–1）、倍率、緩動秒數；edit_zoom / delete_zoom 用 zoomId 指定 */
    x?: number;
    y?: number;
    scale?: number;
    ease?: number;
    zoomId?: string;
    /** add_overlay / edit_overlay：疊加層欄位（見 overlay.ts）；edit / delete 用 overlayId 指定 */
    overlayId?: string;
    kind?: Overlay['kind'];
    w?: number;
    h?: number;
    sub?: string;
    color?: Overlay['color'];
    from?: Overlay['from'];
    position?: Overlay['position'];
    html?: string;
    layer?: Overlay['layer'];
    asset?: Overlay['asset'];
    offset?: number;
    loop?: boolean;
    volume?: number;
    shape?: Overlay['shape'];
    border?: Overlay['border'];
    shadow?: boolean;
    review?: 'confirmed' | 'needs_review';
    reason?: string;
};
export interface EditPlan {
    sessionId: string;
    projectId: string;
    expectedRevision: number;
    timeUnit: 'seconds';
    operations: EditOperation[];
}
/** 依目前順序重新排定片段起點，維持「從 0 開始、無空隙」的單軌。 */
function relayout(clips: TimelineClip[], order?: TimelineClip[]): TimelineClip[] {
    let t = 0;
    return (order ?? [...clips].sort((a, b) => a.startTime - b.startTime)).map(c => {
        const placed = { ...c, startTime: t };
        t += c.duration;
        return placed;
    });
}
function checkSubtitleText(text: unknown): asserts text is string {
    requireEdit(typeof text === 'string' && text.trim().length > 0 && text.length <= 2000,
        'INVALID_SUBTITLE', '字幕文字需為 1–2000 字');
    requireEdit(!/[{}\\\r\n]/.test(text), 'UNSUPPORTED_SUBTITLE_TEXT', '字幕僅支援單行純文字，不支援 ASS 標記或反斜線');
}
export function evaluateTransitions(project: ProjectData, mode: TransitionKind | 'random' | 'none', duration: number, random = Math.random) {
    validateProject(project, true);
    requireEdit(mode === 'random' || mode === 'none' || Object.prototype.hasOwnProperty.call(TRANSITIONS, mode), 'INVALID_TRANSITION', '不支援的轉場');
    requireEdit(finite(duration) && duration >= 0.2 && duration <= 1.5, 'INVALID_TRANSITION', '轉場長度需為 0.2–1.5 秒');
    const next = structuredClone(project);
    next.timelineClips.sort((a, b) => a.startTime - b.startTime);
    const changes: object[] = [];
    const kinds = Object.keys(TRANSITIONS) as TransitionKind[];
    for (let i = 1; i < next.timelineClips.length; i++) {
        const left = next.timelineClips[i - 1], right = next.timelineClips[i];
        if (left.bookend !== 'intro' && right.bookend !== 'outro') continue;
        const kind = mode === 'random' ? kinds[Math.floor(random() * kinds.length)] : mode;
        if (kind === 'none') delete right.transitionIn;
        else right.transitionIn = { kind, duration };
        changes.push({ type: 'bookend_transition', clipId: right.id, fromClipId: left.id,
            kind, label: kind === 'none' ? '直接切換' : TRANSITIONS[kind].label, duration: kind === 'none' ? 0 : duration,
            at: right.startTime });
    }
    requireEdit(changes.length, 'NO_BOOKEND_BOUNDARY', '請先加入片頭或片尾，再設定轉場');
    validateProject(next, true);
    return { next, changes, beforeDuration: durationOf(project.timelineClips), afterDuration: durationOf(next.timelineClips) };
}
/** Bookends keep ASR/subtitle source times intact; only timeline positions move. */
export function evaluateBookends(project: ProjectData, intro: MediaItem | undefined, outro: MediaItem | undefined, id: () => string) {
    validateProject(project, true);
    requireEdit(project.timelineClips.length, 'EMPTY_TIMELINE', '請先加入主影片');
    requireEdit(intro || outro, 'BOOKENDS_REQUIRED', '請至少選擇片頭或片尾');
    requireEdit(!project.timelineClips.some(c => (intro && c.bookend === 'intro') || (outro && c.bookend === 'outro')),
        'BOOKENDS_ALREADY_PRESENT', '已存在相同用途的片頭／片尾，請先復原或移除，避免重複加入');
    const next = structuredClone(project);
    const beforeDuration = durationOf(next.timelineClips);
    const changes: object[] = [];
    for (const [role, media] of [['intro', intro], ['outro', outro]] as const) {
        if (!media) continue;
        requireEdit(media.info.width && media.info.height, 'UNSUPPORTED_MEDIA', '片頭片尾需為影片檔');
        const existing = next.mediaItems.find(m => m.id === media.id);
        requireEdit(!existing || JSON.stringify(existing) === JSON.stringify(media), 'MEDIA_ID_COLLISION', '素材 ID 已存在但內容不同');
        if (!existing) next.mediaItems.push(structuredClone(media));
        const length = media.info.duration;
        const startTime = role === 'intro' ? 0 : durationOf(next.timelineClips);
        if (role === 'intro') next.timelineClips.forEach(c => { c.startTime += length; });
        const clip: TimelineClip = { id: id(), mediaId: media.id, bookend: role, trackIndex: 0,
            startTime, trimStart: 0, trimEnd: length, speed: 1, duration: length, segments: [] };
        next.timelineClips.push(clip);
        changes.push({ type: 'add_bookend', role, clipId: clip.id, mediaId: media.id, filename: media.filename,
            timeline: [startTime, startTime + length], subtitleShiftSeconds: role === 'intro' ? length : 0,
            linked: ['video', 'embedded-audio', 'clip-subtitles'] });
    }
    next.timelineClips.sort((a, b) => a.startTime - b.startTime);
    validateProject(next, true);
    return { next, changes, beforeDuration, afterDuration: durationOf(next.timelineClips) };
}
/** 縮放操作：區段存在素材上（來源秒數）。新增時依 start 所在片段決定素材，可用 mediaId 指定。 */
function applyZoomOp(next: ProjectData, op: EditOperation, id: () => string): object {
    let media: ProjectData['mediaItems'][number] | undefined;
    let zoom: ZoomRegion | undefined;
    if (op.type === 'add_zoom') {
        media = mediaForAdd(next, op);
        zoom = { id: id(), start: op.start!, end: op.end!, x: op.x ?? 0.5, y: op.y ?? 0.5, scale: op.scale ?? 2,
            ...(op.ease !== undefined ? { ease: op.ease } : {}) };
        media.zooms = [...(media.zooms ?? []), zoom].sort((a, b) => a.start - b.start);
    } else {
        requireEdit(typeof op.zoomId === 'string', 'ZOOM_REQUIRED', `${op.type} 需提供 zoomId`);
        media = next.mediaItems.find(m => m.zooms?.some(z => z.id === op.zoomId));
        requireEdit(media, 'ZOOM_NOT_FOUND', `找不到縮放 ${op.zoomId}`);
        const before = media.zooms!.find(z => z.id === op.zoomId)!;
        if (op.type === 'delete_zoom') {
            media.zooms = media.zooms!.filter(z => z.id !== op.zoomId);
            return { type: op.type, zoomId: before.id, mediaId: media.id, removed: before };
        }
        zoom = { ...before };
        for (const k of ['start', 'end', 'x', 'y', 'scale', 'ease'] as const) if (op[k] !== undefined) zoom[k] = op[k];
        media.zooms = media.zooms!.map(z => z.id === zoom!.id ? zoom! : z).sort((a, b) => a.start - b.start);
    }
    const error = checkZooms(media.zooms, media.info.duration);
    requireEdit(!error, 'INVALID_ZOOM', error!);
    const visible = visibleOnTimeline(next, media.id, zoom.start, zoom.end);
    return { type: op.type, zoomId: zoom.id, mediaId: media.id, source: [zoom.start, zoom.end],
        center: [zoom.x, zoom.y], scale: zoom.scale, timeline: visible,
        ...(visible.length ? {} : { warning: '此區段目前不在時間軸上（已被剪掉），不會出現在成品' }) };
}

/** add_zoom / add_overlay：依 start 所在片段決定素材（可用 mediaId 或 clipId 指定）。 */
function mediaForAdd(next: ProjectData, op: EditOperation) {
    requireEdit(finite(op.start) && finite(op.end), 'INVALID_RANGE', `${op.type} 需提供來源秒數 start、end`);
    let mediaId = op.mediaId ?? (op.clipId ? next.timelineClips.find(c => c.id === op.clipId)?.mediaId : undefined);
    if (!mediaId) {
        const ids = [...new Set(next.timelineClips.filter(c => !c.bookend && op.start! >= c.trimStart && op.start! < c.trimEnd)
            .map(c => c.mediaId))];
        requireEdit(ids.length > 0, 'CLIP_NOT_FOUND', `沒有片段包含來源時間 ${op.start}`);
        requireEdit(ids.length === 1, 'CLIP_AMBIGUOUS', `來源時間 ${op.start} 出現在多個素材，請指定 mediaId：${ids.join('、')}`);
        mediaId = ids[0];
    }
    const media = next.mediaItems.find(m => m.id === mediaId);
    requireEdit(media, 'MEDIA_NOT_FOUND', `找不到素材 ${mediaId}`);
    requireEdit(media.info.width && media.info.height, 'UNSUPPORTED_MEDIA', '純音訊素材沒有畫面');
    return media;
}
/** 疊加層在時間軸上實際出現的範圍（剪掉的部分不顯示） */
function visibleOnTimeline(next: ProjectData, mediaId: string, start: number, end: number) {
    return next.timelineClips.filter(c => c.mediaId === mediaId && c.trimStart < end && c.trimEnd > start)
        .map(c => [toTimelineTime(c, Math.max(c.trimStart, start)), toTimelineTime(c, Math.min(c.trimEnd, end))]);
}
const OVERLAY_FIELDS = ['start', 'end', 'x', 'y', 'w', 'h', 'text', 'sub', 'color', 'from', 'position', 'html', 'layer', 'asset', 'offset', 'loop', 'volume', 'shape', 'border', 'shadow'] as const;
function applyOverlayOp(next: ProjectData, op: EditOperation, id: () => string): object {
    let media: ProjectData['mediaItems'][number] | undefined;
    let overlay: Overlay;
    if (op.type === 'add_overlay') {
        requireEdit(op.kind && OVERLAY_KINDS.includes(op.kind), 'INVALID_OVERLAY', `add_overlay 需指定 kind：${OVERLAY_KINDS.join('/')}`);
        media = mediaForAdd(next, op);
        overlay = { id: id(), kind: op.kind, start: op.start!, end: op.end!, x: op.x ?? 0.5, y: op.y ?? 0.5 };
        if (op.kind === 'box' || op.kind === 'spotlight') { overlay.w = op.w ?? 0.2; overlay.h = op.h ?? 0.2; }
        if (op.kind === 'media') overlay.w = op.w ?? 0.3;
        for (const k of ['text', 'sub', 'color', 'from', 'position', 'html', 'layer', 'asset', 'offset', 'loop', 'volume', 'shape', 'border', 'shadow'] as const) if (op[k] !== undefined) (overlay as unknown as Record<string, unknown>)[k] = op[k];
        media.overlays = [...(media.overlays ?? []), overlay];
    } else {
        requireEdit(typeof op.overlayId === 'string', 'OVERLAY_REQUIRED', `${op.type} 需提供 overlayId`);
        media = next.mediaItems.find(m => m.overlays?.some(o => o.id === op.overlayId));
        requireEdit(media, 'OVERLAY_NOT_FOUND', `找不到疊加層 ${op.overlayId}`);
        const before = media.overlays!.find(o => o.id === op.overlayId)!;
        if (op.type === 'delete_overlay') {
            media.overlays = media.overlays!.filter(o => o.id !== op.overlayId);
            return { type: op.type, overlayId: before.id, mediaId: media.id, removed: before };
        }
        overlay = { ...before };
        const fields = overlay as unknown as Record<string, unknown>;
        for (const k of OVERLAY_FIELDS) {
            const v = (op as unknown as Record<string, unknown>)[k];
            if (v === null) delete fields[k];          // null＝清除這個欄位（例如清空說明文字）
            else if (v !== undefined) fields[k] = v;
        }
        media.overlays = media.overlays!.map(o => o.id === overlay.id ? overlay : o);
    }
    const error = checkOverlays(media.overlays, media.info.duration);
    requireEdit(!error, 'INVALID_OVERLAY', error!);
    const timeline = visibleOnTimeline(next, media.id, overlay.start, overlay.end);
    return { type: op.type, overlayId: overlay.id, mediaId: media.id, kind: overlay.kind, source: [overlay.start, overlay.end],
        timeline, ...(timeline.length ? {} : { warning: '此疊加層目前不在時間軸上（已被剪掉），不會出現在成品' }) };
}
/** 依操作的來源時間找出唯一包含它的片段（不含片頭片尾）。 */
function locateClip(clips: TimelineClip[], op: EditOperation): TimelineClip {
    const point = op.type === 'split';
    const t = point ? op.at : op.start;
    requireEdit(finite(t) && (point || finite(op.end)), 'CLIP_REQUIRED',
        `${op.type} 需提供 clipId，或提供來源秒數讓系統自動定位片段`);
    const hits = clips.filter(c => !c.bookend && (!op.mediaId || c.mediaId === op.mediaId)
        && (point ? t > c.trimStart && t < c.trimEnd : t >= c.trimStart && op.end! <= c.trimEnd));
    requireEdit(hits.length > 0, 'CLIP_NOT_FOUND', `沒有片段完整包含來源時間 ${t}${point ? '' : '–' + op.end}（可能已被刪除，或跨越兩個片段）`);
    requireEdit(hits.length === 1, 'CLIP_AMBIGUOUS', `來源時間 ${t} 出現在 ${hits.length} 個片段，請指定 clipId 或 mediaId：`
        + hits.map(c => `clipId=${c.id} mediaId=${c.mediaId}`).join('；'));
    return hits[0];
}
export function evaluatePlan(project: ProjectData, revision: number, plan: EditPlan, id: () => string) {
    requireEdit(plan && plan.projectId === project.projectId && plan.expectedRevision === revision,
        'STALE_PROJECT', '專案已變更，請重新讀取狀態並 dry-run');
    requireEdit(plan.timeUnit === 'seconds' && Array.isArray(plan.operations) && plan.operations.length > 0
        && plan.operations.length <= 100, 'INVALID_PLAN', '計畫需有 1–100 個操作，時間單位必須為 seconds');
    validateProject(project, true);
    const next = structuredClone(project);
    const changes: object[] = [];
    for (const op of plan.operations) {
        requireEdit(op && op.trackId === 'video-main' && op.timeDomain === 'source', 'INVALID_TIME_DOMAIN', '需指定 video-main 與 source 時間');
        requireEdit(op.review !== 'needs_review', 'REVIEW_REQUIRED', '待確認段落不可套用，請先人工確認');
        if (op.type === 'add_zoom' || op.type === 'edit_zoom' || op.type === 'delete_zoom') {
            changes.push(applyZoomOp(next, op, id));
            continue;
        }
        if (op.type === 'add_overlay' || op.type === 'edit_overlay' || op.type === 'delete_overlay') {
            changes.push(applyOverlayOp(next, op, id));
            continue;
        }
        const c = op.clipId ? next.timelineClips.find(c => c.id === op.clipId) : locateClip(next.timelineClips, op);
        requireEdit(c, 'CLIP_NOT_FOUND', `找不到片段 ${op.clipId}`);
        if (op.type === 'split') {
            requireEdit(finite(op.at), 'INVALID_RANGE', 'split 需提供來源秒數 at');
            const [left, right] = splitClip(c, op.at, id());
            next.timelineClips = next.timelineClips.flatMap(o => o.id === c.id ? [left, right] : [o]);
            changes.push({ type: op.type, clipId: c.id, source: op.at, timeline: toTimelineTime(c, op.at),
                keptClipIds: [left.id, right.id] });
            continue;
        }
        if (op.type === 'move_clip') {
            const ordered = [...next.timelineClips].sort((a, b) => a.startTime - b.startTime);
            requireEdit(Number.isInteger(op.toIndex) && op.toIndex! >= 0 && op.toIndex! < ordered.length,
                'INVALID_RANGE', `toIndex 需為 0–${ordered.length - 1}`);
            requireEdit(!c.bookend, 'BOOKEND_LOCKED', '片頭片尾位置固定，不可移動');
            const from = ordered.findIndex(o => o.id === c.id);
            const rest = ordered.filter(o => o.id !== c.id);
            rest.splice(op.toIndex!, 0, c);
            const introAt = rest.findIndex(o => o.bookend === 'intro');
            const outroAt = rest.findIndex(o => o.bookend === 'outro');
            requireEdit((introAt <= 0) && (outroAt < 0 || outroAt === rest.length - 1),
                'BOOKEND_LOCKED', '片段不可移到片頭之前或片尾之後');
            next.timelineClips = relayout(next.timelineClips, rest);
            changes.push({ type: op.type, clipId: c.id, fromIndex: from, toIndex: op.toIndex });
            continue;
        }
        if (op.type === 'delete_clip') {
            const ordered = [...next.timelineClips].sort((a, b) => a.startTime - b.startTime).filter(o => o.id !== c.id);
            next.timelineClips = relayout(next.timelineClips, ordered);
            changes.push({ type: op.type, clipId: c.id, removedSeconds: c.duration,
                timeline: [c.startTime, c.startTime + c.duration], linked: ['video', 'embedded-audio', 'clip-subtitles'] });
            continue;
        }
        if (op.type === 'edit_subtitle' || op.type === 'delete_subtitle') {
            const seg = c.segments.find(s => s.id === op.segmentId);
            requireEdit(seg, 'SUBTITLE_NOT_FOUND', `片段 ${c.id} 找不到字幕 ${op.segmentId}`);
            if (op.type === 'edit_subtitle') {
                checkSubtitleText(op.text);
                changes.push({ type: op.type, clipId: c.id, segmentId: seg.id, before: seg.text, after: op.text });
                seg.text = op.text;
                delete seg.words;   // 文字改了，舊的逐字時間不再對應
            } else {
                c.segments = c.segments.filter(s => s.id !== seg.id);
                changes.push({ type: op.type, clipId: c.id, segmentId: seg.id, text: seg.text });
            }
            continue;
        }
        requireEdit(finite(op.start) && finite(op.end) && op.start >= c.trimStart && op.end <= c.trimEnd
            && op.end > op.start, 'INVALID_RANGE', '操作區間必須在該片段的來源裁切範圍內');
        const start = op.start, end = op.end;
        if (op.type === 'set_speed') {
            requireEdit(finite(op.speed) && op.speed >= 1 && op.speed <= 5, 'INVALID_SPEED', '倍速需為 1–5');
            const parts: TimelineClip[] = [];
            let mid: TimelineClip = c;
            if (start > c.trimStart) { const [l, r] = splitClip(mid, start, id()); parts.push(l); mid = r; }
            let tail: TimelineClip | undefined;
            if (end < mid.trimEnd) { const [l, r] = splitClip(mid, end, id()); mid = l; tail = r; }
            mid = { ...mid, speed: op.speed, duration: (mid.trimEnd - mid.trimStart) / op.speed };
            parts.push(mid);
            if (tail) parts.push(tail);
            const before = c.duration;
            next.timelineClips = relayout(next.timelineClips.flatMap(o => o.id === c.id ? parts : [o]));
            changes.push({ type: op.type, clipId: c.id, source: [start, end], speed: op.speed,
                speedClipId: mid.id, keptClipIds: parts.map(p => p.id),
                savedSeconds: before - parts.reduce((a, p) => a + p.duration, 0) });
            continue;
        }
        if (op.type === 'add_subtitle') {
            checkSubtitleText(op.text);
            requireEdit(!c.segments.some(s => s.start < end && s.end > start),
                'SUBTITLE_OVERLAP', '此範圍已有字幕，請先手動整理，避免預覽與燒錄呈現不同');
            c.segments.push({ id: Math.max(-1, ...c.segments.map(s => s.id)) + 1, start: start, end: end, text: op.text! });
            c.segments.sort((a, b) => a.start - b.start);
            changes.push({ type: op.type, clipId: c.id, source: [start, end],
                timeline: [toTimelineTime(c, start), toTimelineTime(c, end)], text: op.text! });
        } else if (op.type === 'ripple_delete') {
            const delta = (end - start) / c.speed;
            const kept: TimelineClip[] = [];
            if (start > c.trimStart) kept.push(splitClip(c, start, id())[0]);
            if (end < c.trimEnd) {
                const right = splitClip(c, end, kept.length ? id() : c.id)[1];
                kept.push({ ...right, startTime: right.startTime - delta });
            }
            next.timelineClips = next.timelineClips.flatMap(other => other.id === c.id ? kept : [{
                ...other, startTime: other.startTime >= c.startTime + c.duration - 1e-6 ? other.startTime - delta : other.startTime,
            }]);
            changes.push({ type: op.type, clipId: c.id, source: [start, end],
                timeline: [toTimelineTime(c, start), toTimelineTime(c, end)], removedSeconds: delta,
                keptClipIds: kept.map(c => c.id), linked: ['video', 'embedded-audio', 'clip-subtitles'] });
        } else throw new EditError('UNSUPPORTED_OPERATION', `不支援的操作 ${op.type}`);
    }
    validateProject(next, true);
    return { next, changes, beforeDuration: durationOf(project.timelineClips), afterDuration: durationOf(next.timelineClips) };
}
