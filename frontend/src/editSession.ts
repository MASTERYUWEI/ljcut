import { useStore } from './store';
import { durationOf, evaluateBookends, evaluatePlan, evaluateTransitions, requireEdit, TRACKS, validateProject } from './editCore';
import type { TransitionKind } from './transitions';
import type { MediaItem } from './types';
import type { EditPlan, ProjectData } from './editCore';

let revision = 0;
const sessionId = crypto.randomUUID();
let projectId: string = crypto.randomUUID();
let restoring = false;
type Snapshot = { project: ProjectData; activeClipId: string | null };
const past: Snapshot[] = [];
const future: Snapshot[] = [];
const drafts = new Map<string, ReturnType<typeof evaluatePlan> & { revision: number; projectId: string }>();
export function projectData(): ProjectData {
    const s = useStore.getState();
    return structuredClone({ schemaVersion: 1, projectId, mediaItems: s.mediaItems,
        timelineClips: s.timelineClips, subtitleStyle: s.subtitleStyle, language: s.language });
}
/** 專案內容的比對鍵（同一版本只算一次）：復原回到存檔時的內容時可判定為「已儲存」 */
let keyCache = { revision: -1, key: '' };
export function contentKey() {
    if (keyCache.revision !== revision) {
        const { projectId: _id, ...rest } = projectData();
        keyCache = { revision, key: JSON.stringify(rest) };
    }
    return keyCache.key;
}
/** 目前內容是否和某個時間點（版本＋比對鍵）相同 */
export function sameContent(mark: { revision: number; key: string }) {
    return mark.revision === revision || (!!mark.key && mark.key === contentKey());
}
export function readState() {
    const s = useStore.getState();
    return { ...projectData(), sessionId, revision, tracks: TRACKS, timeUnit: 'seconds',
        subtitleTimeDomain: 'source', timelineDuration: durationOf(s.timelineClips),
        currentTime: s.currentTime, isPlaying: s.isPlaying, canUndo: past.length > 0, canRedo: future.length > 0,
        transcripts: s.mediaItems.map(m => ({ mediaId: m.id, timeDomain: 'source',
            precisionSeconds: 0.001, result: m.transcript ?? null })) };
}
useStore.subscribe((s, prev) => {
    if (s.timelineClips !== prev.timelineClips || s.mediaItems !== prev.mediaItems
        || s.subtitleStyle !== prev.subtitleStyle || s.language !== prev.language) {
        revision++;
        drafts.clear();
        if (!restoring) future.length = 0;
    }
});
const snapshot = (): Snapshot => ({ project: projectData(), activeClipId: useStore.getState().activeClipId });
export function pushUndo() { past.push(snapshot()); if (past.length > 50) past.shift(); future.length = 0; notifyHistory(); }
export interface ExpectedVersion { sessionId: string; projectId: string; expectedRevision: number }
export function checkVersion(args: ExpectedVersion) {
    requireEdit(args.sessionId === sessionId && args.projectId === projectId && args.expectedRevision === revision,
        'STALE_PROJECT', '專案或工作階段已變更，請重新取得狀態');
}
function restore(snap: Snapshot, keepTime = false) {
    const p = structuredClone(snap.project);
    const prevActive = useStore.getState().activeClipId;
    // 復原／重做時盡量留在原本選取的片段，不跳走
    const active = (keepTime && prevActive ? p.timelineClips.find(c => c.id === prevActive) : undefined)
        ?? (snap.activeClipId ? p.timelineClips.find(c => c.id === snap.activeClipId) : undefined);
    projectId = p.projectId;
    const time = keepTime ? Math.min(useStore.getState().currentTime, durationOf(p.timelineClips)) : 0;
    useStore.setState({ mediaItems: p.mediaItems, timelineClips: p.timelineClips, subtitleStyle: p.subtitleStyle,
        language: p.language, activeClipId: active?.id ?? null, segments: active?.segments ?? [],
        activeSegmentId: null, isPlaying: false, currentTime: time });
    requestPreview(time);
    notifyHistory();
}
/** 復原／重做狀態變化時通知介面（按鈕停用狀態） */
function notifyHistory() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('ljcut-history')); }
export const history = () => ({ canUndo: past.length > 0, canRedo: future.length > 0, depth: past.length });
const count = (p: ProjectData, k: 'zooms' | 'overlays') => p.mediaItems.reduce((n, m) => n + (m[k]?.length ?? 0), 0);
const subs = (p: ProjectData) => p.timelineClips.reduce((n, c) => n + c.segments.length, 0);
/** 用白話描述兩個專案狀態的差異（給「已復原：…」提示用） */
export function describeChange(from: ProjectData, to: ProjectData): string {
    const parts: string[] = [];
    const dc = to.timelineClips.length - from.timelineClips.length;
    if (dc) parts.push(dc > 0 ? `片段 +${dc}` : `片段 −${-dc}`);
    const dz = count(to, 'zooms') - count(from, 'zooms');
    if (dz) parts.push(dz > 0 ? `縮放 +${dz}` : `縮放 −${-dz}`);
    const dov = count(to, 'overlays') - count(from, 'overlays');
    if (dov) parts.push(dov > 0 ? `標註 +${dov}` : `標註 −${-dov}`);
    const ds = subs(to) - subs(from);
    if (ds) parts.push(ds > 0 ? `字幕 +${ds} 句` : `字幕 −${-ds} 句`);
    if (!parts.length) {
        const dd = durationOf(to.timelineClips) - durationOf(from.timelineClips);
        parts.push(Math.abs(dd) >= 0.05 ? `長度 ${dd > 0 ? '+' : '−'}${Math.abs(dd).toFixed(1)} 秒` : '內容調整');
    }
    return parts.join('，');
}
export function undo() {
    const snap = past.pop();
    requireEdit(snap, 'NOTHING_TO_UNDO', '沒有可撤銷的操作');
    const before = snapshot();
    future.push(before); restoring = true;
    try { restore(snap, true); } finally { restoring = false; }
    return { ...readState(), change: describeChange(before.project, snap.project) };
}
export function redo() {
    const snap = future.pop();
    requireEdit(snap, 'NOTHING_TO_REDO', '沒有可重做的操作');
    const before = snapshot();
    past.push(before); restoring = true;
    try { restore(snap, true); } finally { restoring = false; }
    return { ...readState(), change: describeChange(before.project, snap.project) };
}
export function replaceProject(p: ProjectData, expected: ExpectedVersion) {
    validateProject(p);
    checkVersion(expected);
    pushUndo(); restore({ project: p, activeClipId: p.timelineClips[0]?.id ?? null });
    return readState();
}
/** 開啟專案：換上新專案並清空復原／重做歷史 */
export function loadProject(p: ProjectData, expected: ExpectedVersion) {
    validateProject(p);
    checkVersion(expected);
    restore({ project: p, activeClipId: p.timelineClips[0]?.id ?? null });
    past.length = 0; future.length = 0; notifyHistory();
    return readState();
}
export function dryRun(plan: EditPlan) {
    checkVersion(plan);
    const result = evaluatePlan(projectData(), revision, plan, () => crypto.randomUUID());
    return rememberDraft(result);
}
export function dryRunBookends(expected: ExpectedVersion, intro?: MediaItem, outro?: MediaItem, transitionMode?: TransitionKind | 'random' | 'none', transitionDuration = 0.6) {
    checkVersion(expected);
    const result = evaluateBookends(projectData(), intro, outro, () => crypto.randomUUID());
    if (transitionMode && transitionMode !== 'none') {
        const transitions = evaluateTransitions(result.next, transitionMode, transitionDuration);
        result.next = transitions.next;
        result.changes.push(...transitions.changes);
    }
    return rememberDraft(result);
}
function rememberDraft(result: ReturnType<typeof evaluatePlan>) {
    const dryRunId = crypto.randomUUID();
    // Only plans at the current revision survive; bound memory for repeated proposals.
    if (drafts.size >= 20) drafts.delete(drafts.keys().next().value!);
    drafts.set(dryRunId, { ...result, revision, projectId });
    return { dryRunId, sessionId, projectId, revision, changes: result.changes,
        beforeDuration: result.beforeDuration, afterDuration: result.afterDuration,
        proposedClips: result.next.timelineClips, requiresConfirmation: true };
}
export function dryRunTransitions(expected: ExpectedVersion, mode: TransitionKind | 'random' | 'none', duration: number) {
    checkVersion(expected);
    return rememberDraft(evaluateTransitions(projectData(), mode, duration));
}
export function draftProject(args: ExpectedVersion & { dryRunId: string }) {
    checkVersion(args);
    const draft = drafts.get(args.dryRunId);
    requireEdit(draft && draft.revision === revision && draft.projectId === projectId, 'STALE_DRY_RUN', 'dry-run 已過期，請重新驗證');
    return structuredClone(draft.next);
}
export function applyPlan(args: ExpectedVersion & { dryRunId: string; confirmed: boolean }) {
    checkVersion(args);
    requireEdit(args.confirmed === true, 'CONFIRMATION_REQUIRED', '需確認 dry-run 內容後才能套用');
    const draft = drafts.get(args.dryRunId);
    requireEdit(draft && draft.revision === revision && draft.projectId === projectId, 'STALE_DRY_RUN', 'dry-run 已過期，請重新驗證');
    requireEdit(!useStore.getState().isTranscribing && !useStore.getState().isUploading,
        'EDITOR_BUSY', '匯入／辨識尚未完成，請稍後重試');
    pushUndo(); restore({ project: draft.next, activeClipId: useStore.getState().activeClipId }, true);   // 套用後播放頭留在原處
    return { changes: draft.changes, state: readState() };
}
export function requestPreview(time: number) {
    requireEdit(Number.isFinite(time) && time >= 0 && time <= useStore.getState().getDuration(), 'INVALID_RANGE', '預覽時間超出時間軸');
    useStore.setState({ isPlaying: false, currentTime: time,
        previewRequest: { time, serial: useStore.getState().previewRequest.serial + 1 } });
}
