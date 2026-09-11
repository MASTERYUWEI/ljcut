import type { MediaItem, Segment, TimelineClip } from './types';
import type { SubtitleStyle } from './store';

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
        { ...c, id: rightId, startTime: toTimelineTime(c, sourceTime), trimStart: sourceTime,
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
