import { useStore } from './store';
import { durationOf, evaluateBookends, evaluatePlan, evaluateTransitions, requireEdit, TRACKS, validateProject } from './editCore';
import type { TransitionKind } from './transitions';
import type { MediaItem } from './types';
import type { EditPlan, ProjectData } from './editCore';

let revision = 0;
const sessionId = crypto.randomUUID();
let projectId: string = crypto.randomUUID();
let restoring = false;
type Snapshot = { project: ProjectData; activeClipId: string | null; label?: string };
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
let nextLabel = '';
/** 下一筆復原的操作名稱（例如「修改醒目框」），沒有結構變化時用它描述 */
export function labelNextUndo(label: string) { nextLabel = label; }
export function pushUndo(label?: string) {
    past.push({ ...snapshot(), label: label ?? (nextLabel || undefined) }); nextLabel = '';
    if (past.length > 50) past.shift(); future.length = 0; notifyHistory();
}
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
    const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    const parts: string[] = [];
    const da = durationOf(from.timelineClips), db = durationOf(to.timelineClips);
    if (Math.abs(db - da) >= 0.05) parts.push(`影片長度 ${mmss(da)} → ${mmss(db)}`);
    const sa = subs(from), sb = subs(to);
    if (sa !== sb) parts.push(`字幕 ${sa} → ${sb} 句`);
    const za = count(from, 'zooms'), zb = count(to, 'zooms');
    if (za !== zb) parts.push(`縮放 ${za} → ${zb} 段`);
    const oa = count(from, 'overlays'), ob = count(to, 'overlays');
    if (oa !== ob) parts.push(`標註 ${oa} → ${ob} 個`);
    if (!parts.length && from.timelineClips.length !== to.timelineClips.length) parts.push(`片段 ${from.timelineClips.length} → ${to.timelineClips.length} 段`);
    return parts.length ? parts.join('，') : '';
}
/** 下一步復原／重做會發生什麼（給按鈕提示用） */
export function peekHistory(which: 'undo' | 'redo') {
    const snap = which === 'undo' ? past[past.length - 1] : future[future.length - 1];
    return snap ? (describeChange(projectData(), snap.project) || snap.label || '上一步的修改') : '';
}
export function undo() {
    const snap = past.pop();
    requireEdit(snap, 'NOTHING_TO_UNDO', '沒有可撤銷的操作');
    const before = snapshot();
    future.push({ ...before, label: snap.label }); restoring = true;
    try { restore(snap, true); } finally { restoring = false; }
    return { ...readState(), change: describeChange(before.project, snap.project) || snap.label || '上一步的修改' };
}
export function redo() {
    const snap = future.pop();
    requireEdit(snap, 'NOTHING_TO_REDO', '沒有可重做的操作');
    const before = snapshot();
    past.push({ ...before, label: snap.label }); restoring = true;
    try { restore(snap, true); } finally { restoring = false; }
    return { ...readState(), change: describeChange(before.project, snap.project) || snap.label || '剛才復原的修改' };
}
export function replaceProject(p: ProjectData, expected: ExpectedVersion) {
    validateProject(p);
    checkVersion(expected);
    pushUndo(); restore({ project: p, activeClipId: p.timelineClips[0]?.id ?? null });
    return readState();
}
/** 新專案：清空素材與時間軸、清空復原歷史（保留字幕樣式與辨識語言等偏好） */
export function newProject() {
    projectId = crypto.randomUUID();
    useStore.setState({ mediaItems: [], timelineClips: [], activeClipId: null, segments: [], activeSegmentId: null,
        isPlaying: false, currentTime: 0 });
    past.length = 0; future.length = 0; notifyHistory();
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
