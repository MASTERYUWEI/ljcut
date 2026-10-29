import type { MediaItem, Segment, TimelineClip } from './types';
import type { SubtitleStyle } from './store';
import { TRANSITIONS, type TransitionKind } from './transitions';

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

export interface EditPlan {
    sessionId: string;
    projectId: string;
    expectedRevision: number;
    timeUnit: 'seconds';
    operations: Array<{
        type: 'ripple_delete' | 'add_subtitle';
        clipId: string;
        trackId: 'video-main';
        timeDomain: 'source';
        start: number;
        end: number;
        text?: string;
        review?: 'confirmed' | 'needs_review';
        reason?: string;
    }>;
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
        const c = next.timelineClips.find(c => c.id === op.clipId);
        requireEdit(c, 'CLIP_NOT_FOUND', `找不到片段 ${op.clipId}`);
        requireEdit(finite(op.start) && finite(op.end) && op.start >= c.trimStart && op.end <= c.trimEnd
            && op.end > op.start, 'INVALID_RANGE', '操作區間必須在該片段的來源裁切範圍內');
        if (op.type === 'add_subtitle') {
            requireEdit(typeof op.text === 'string' && op.text.trim().length > 0 && op.text.length <= 2000,
                'INVALID_SUBTITLE', '字幕文字需為 1–2000 字');
            requireEdit(!/[{}\\\r\n]/.test(op.text), 'UNSUPPORTED_SUBTITLE_TEXT', '第一階段新增字幕僅支援單行純文字，不支援 ASS 標記或反斜線');
            requireEdit(!c.segments.some(s => s.start < op.end && s.end > op.start),
                'SUBTITLE_OVERLAP', '此範圍已有字幕，請先手動整理，避免預覽與燒錄呈現不同');
            c.segments.push({ id: Math.max(-1, ...c.segments.map(s => s.id)) + 1, start: op.start, end: op.end, text: op.text });
            c.segments.sort((a, b) => a.start - b.start);
            changes.push({ type: op.type, clipId: c.id, source: [op.start, op.end],
                timeline: [toTimelineTime(c, op.start), toTimelineTime(c, op.end)], text: op.text });
        } else if (op.type === 'ripple_delete') {
            const delta = (op.end - op.start) / c.speed;
            const kept: TimelineClip[] = [];
            if (op.start > c.trimStart) kept.push(splitClip(c, op.start, id())[0]);
            if (op.end < c.trimEnd) {
                const right = splitClip(c, op.end, kept.length ? id() : c.id)[1];
                kept.push({ ...right, startTime: right.startTime - delta });
            }
            next.timelineClips = next.timelineClips.flatMap(other => other.id === c.id ? kept : [{
                ...other, startTime: other.startTime >= c.startTime + c.duration - 1e-6 ? other.startTime - delta : other.startTime,
            }]);
            changes.push({ type: op.type, clipId: c.id, source: [op.start, op.end],
                timeline: [toTimelineTime(c, op.start), toTimelineTime(c, op.end)], removedSeconds: delta,
                keptClipIds: kept.map(c => c.id), linked: ['video', 'embedded-audio', 'clip-subtitles'] });
        } else throw new EditError('UNSUPPORTED_OPERATION', `不支援的操作 ${op.type}`);
    }
    validateProject(next, true);
    return { next, changes, beforeDuration: durationOf(project.timelineClips), afterDuration: durationOf(next.timelineClips) };
}
