import { api, getBase } from './api';
import { useStore } from './store';
import { EditError, requireEdit, validateProject, toSourceTime, clippedSegments } from './editCore';
import { splitLongCues } from './utils';
import { toast } from './toast';
import { applyPlan, checkVersion, draftProject, dryRun, dryRunBookends, dryRunTransitions, loadProject, projectData, readState, redo, replaceProject, requestPreview, undo , contentKey , history as editHistory , newProject } from './editSession';
import type { EditPlan, ProjectData } from './editCore';
import type { MediaItem } from './types';

let token = '';
let latestControlExport = 0;
export let controlWorkspace = '';
/** 目前專案檔：路徑與最後存檔時的版本（判斷「未儲存」用）；存檔／開啟成功後更新並發出事件 */
export const projectFile = { path: '', savedRevision: -1, savedKey: '' };
export const AUTOSAVE_PATH = '.autosave.ljcut';
/** 自動存檔到工作區的隱藏專案（不改變「目前專案檔」與未儲存狀態） */
export async function autosaveProject() {
    if (!token || !useStore.getState().timelineClips.length) return;
    const p = projectData();
    validateProject(p);
    await controlRequest('/save', { path: AUTOSAVE_PATH, project: p, revision: readState().revision });
}
/** 開新專案（介面用）：清空編輯器並把「目前專案檔」設為未命名 */
export function startNewProject() {
    newProject();
    markProjectFile('', readState().revision);
}
function markProjectFile(path: string, savedRevision: number) {
    projectFile.path = path; projectFile.savedRevision = savedRevision;
    projectFile.savedKey = savedRevision === readState().revision ? contentKey() : '';
    window.dispatchEvent(new Event('ljcut-project-file'));
}
let previewReader: (() => { sourceTime: number; ready: boolean; subtitle: string; paused: boolean }) | undefined;
export function registerPreviewReader(reader: typeof previewReader) { previewReader = reader; }
export function controlHeaders() {
    requireEdit(token, 'CONTROL_DISABLED', '請先啟用本機控制');
    return { Authorization: `Bearer ${token}` };
}
export async function controlRequest(path: string, body?: unknown): Promise<any> {
    requireEdit(token, 'CONTROL_DISABLED', '請先以指定工作區啟動本機控制');
    const res = await fetch(`${getBase()}/api/control${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await res.json();
    if (!res.ok) throw new EditError(result.detail?.code ?? 'CONTROL_ERROR', result.detail?.message ?? JSON.stringify(result.detail));
    return result;
}
export async function uploadBookend(file: File): Promise<{ path: string; filename: string }> {
    requireEdit(token, 'CONTROL_DISABLED', '請先啟用本機控制');
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${getBase()}/api/control/bookend-file`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
    });
    const result = await res.json();
    if (!res.ok) throw new EditError(result.detail?.code ?? 'IMPORT_FAILED', result.detail?.message ?? '影片匯入失敗');
    return result;
}
export async function executeCommand(method: string, params: any = {}): Promise<any> {
    if (method === 'state') return readState();
    if (method === 'publication') return controlRequest(`/publications/${encodeURIComponent(params.publicationId)}`);
    if (method === 'prepare_covers') return controlRequest('/cover-batches', params);
    if (method === 'cover_batch') return controlRequest(`/cover-batches/${encodeURIComponent(params.batchId)}`);
    if (method === 'complete_covers') return controlRequest(`/cover-batches/${encodeURIComponent(params.batchId)}/complete`, params);
    if (method === 'select_cover') return controlRequest(`/publications/${encodeURIComponent(params.publicationId)}/select-cover`, params);
    if (method === 'production_settings') return controlRequest('/production-settings');
    if (method === 'prepare_transitions') {
        await controlRequest('/validate-media', projectData());
        return dryRunTransitions(params, params.mode ?? 'random', params.duration ?? 0.6);
    }
    if (method === 'set_production_settings') return controlRequest('/production-settings', params);
    if (method === 'dry_run') {
        await controlRequest('/validate-media', projectData());
        return dryRun(params as EditPlan);
    }
    if (method === 'apply') {
        await controlRequest('/validate-media', draftProject(params));
        return applyPlan(params);
    }
    if (method === 'undo' || method === 'redo') {
        checkVersion(params);
        requireEdit(!useStore.getState().isTranscribing && !useStore.getState().isUploading, 'EDITOR_BUSY', '請等待匯入／辨識完成');
        return method === 'undo' ? undo() : redo();
    }
    if (method === 'preview') {
        checkVersion(params);
        requestPreview(params.time);
        const clip = useStore.getState().timelineClips.find(c => params.time >= c.startTime && params.time < c.startTime + c.duration);
        requireEdit(clip, 'NO_CLIP_AT_TIME', '此預覽位置沒有片段，請選擇片段內的時間');
        const expected = toSourceTime(clip, params.time);
        const expectedSubtitle = clip.segments.find(s => expected >= s.start && expected < s.end)?.text ?? '';
        for (let i = 0; i < 150; i++) {
            await new Promise(r => setTimeout(r, 50));
            checkVersion(params);
            const actual = previewReader?.();
            if (actual?.ready && actual.paused && Math.abs(actual.sourceTime - expected) < 0.04 && actual.subtitle === expectedSubtitle) {
                return { timelineTime: params.time, expectedSourceTime: expected, clipId: clip.id,
                    mediaId: clip.mediaId, actual, state: readState() };
            }
        }
        throw new EditError('PREVIEW_NOT_READY', '预覽尚未就緒，請檢查影片載入狀態');
    }
    checkVersion(params);
    requireEdit(!useStore.getState().isTranscribing && !useStore.getState().isUploading, 'EDITOR_BUSY', '請等待匯入／辨識完成');
    if (method === 'prepare_bookends') {
        await controlRequest('/validate-media', projectData());
        const media = await controlRequest('/bookends-media', params);
        for (const m of [media.intro, media.outro]) {
            if (m) { m.url = api.mediaUrl(m.url); m.thumbnailUrl = api.getThumbnailUrl(m.id); }
        }
        const result = dryRunBookends(params, media.intro, media.outro, media.settings.transitionMode ?? 'random', media.settings.transitionDuration ?? 0.6);
        return { ...result, settings: media.settings };
    }
    if (method === 'import') {
        const media: MediaItem = await controlRequest('/media', { path: params.path });
        checkVersion(params);
        media.url = api.mediaUrl(media.url);
        media.thumbnailUrl = api.getThumbnailUrl(media.id);
        const p = projectData();
        const clipId = crypto.randomUUID();
        p.mediaItems.push(media);
        p.timelineClips.push({ id: clipId, mediaId: media.id, trackIndex: 0, startTime: useStore.getState().getDuration(),
            trimStart: 0, trimEnd: media.info.duration, speed: 1, duration: media.info.duration, segments: [] });
        replaceProject(p, params);
        return { mediaId: media.id, clipId, state: readState() };
    }
    if (method === 'transcribe') {
        // 與手動「開始辨識」同一條管線：辨識 → 保留原始逐字稿 → 依每段上限分段 → 寫入該素材所有片段（一筆 undo）
        const s0 = useStore.getState();
        const media = s0.mediaItems.find(m => m.id === params.mediaId);
        requireEdit(media, 'MEDIA_NOT_FOUND', `找不到素材 ${params.mediaId}`);
        useStore.getState().setIsTranscribing(true);
        let result;
        try {
            result = await api.transcribe(media.id, params.language ?? s0.language, undefined, !!params.fast);
        } finally {
            useStore.getState().setIsTranscribing(false);
        }
        // 辨識期間使用者可能改過專案：以「目前」狀態為基底合併，不覆蓋其他修改
        const cur = readState();
        const p = projectData();
        const target = p.mediaItems.find(m => m.id === media.id);
        requireEdit(target, 'MEDIA_NOT_FOUND', '辨識期間素材已被移除');
        target.transcript = structuredClone(result);
        const segs = splitLongCues(result.segments, p.subtitleStyle.maxCharsPerCue).map((s, id) => ({ ...s, id }));
        let clipsUpdated = 0;
        for (const c of p.timelineClips) {
            if (c.mediaId !== media.id) continue;
            c.segments = clippedSegments(segs, c.trimStart, c.trimEnd);
            clipsUpdated++;
        }
        replaceProject(p, { sessionId: cur.sessionId, projectId: cur.projectId, expectedRevision: cur.revision });
        return { mediaId: media.id, segments: segs.length, clipsUpdated, state: readState() };
    }
    if (method === 'save') {
        const p = projectData();
        validateProject(p);
        // 儲存到目前開啟／上次存的同一個檔才允許覆寫；另存成既有檔名仍會被後端拒絕
        const saved = await controlRequest('/save', { path: params.path, project: p, revision: params.expectedRevision,
            overwrite: !!projectFile.path && params.path === projectFile.path });
        markProjectFile(params.path, readState().revision);
        return saved;
    }
    if (method === 'open') {
        const p: ProjectData = await controlRequest('/open', { path: params.path });
        for (const m of p.mediaItems) {
            m.url = api.mediaUrl(m.url);
            m.thumbnailUrl = api.getThumbnailUrl(m.id);
        }
        const opened = loadProject(p, params);
        // 從自動存檔還原時不沿用那個隱藏檔名：之後按「儲存」會請你取名
        if (params.path === AUTOSAVE_PATH) markProjectFile('', -1); else markProjectFile(params.path, readState().revision);
        return opened;
    }
    if (method === 'export') {
        const p = projectData();
        validateProject(p, true);
        const exportSequence = ++latestControlExport;
        const job = await controlRequest('/export', { project: p, revision: params.expectedRevision,
            burnSubtitles: params.burnSubtitles ?? false });
        const watch = async () => {
            try {
                const next = await controlRequest(`/jobs/${job.id}`);
                if (next.status === 'completed') {
                    // The artifact remains queryable, but an old export must not replace the current project's result.
                    checkVersion(params);
                    if (exportSequence === latestControlExport) window.dispatchEvent(new CustomEvent('ljcut-export-ready', { detail: next }));
                }
                else if (['queued','running'].includes(next.status)) setTimeout(watch, 1500);
            } catch { /* Export remains queryable via its job ID. */ }
        };
        void watch();
        return job;
    }
    throw new EditError('UNSUPPORTED_COMMAND', `不支援的命令 ${method}`);
}

let started = false;
// 外部（AI／MCP）改了專案時告訴使用者：改了什麼、可以怎麼復原
const EXTERNAL_LABEL: Record<string, string> = {
    undo: 'AI 復原了上一步', redo: 'AI 重做了一步', open: 'AI 開啟了另一個專案',
    import: 'AI 匯入了素材', transcribe: 'AI 完成字幕辨識',
};
/** 最近一次 AI 動作（標題列常駐顯示，不只 5 秒通知）＋本次開啟以來的紀錄 */
export const aiActivity = { text: '', at: 0, lastCommandAt: 0, edits: 0, log: [] as { text: string; at: number; details: string[]; depth?: number; jump?: number }[] };
const CHANGE_LABEL: Record<string, string> = {
    ripple_delete: '刪除區段並補位', delete_clip: '刪除片段', split: '分割片段', move_clip: '移動片段', set_speed: '調整速度',
    add_subtitle: '新增字幕', delete_subtitle: '刪除字幕',
    add_zoom: '加入縮放', edit_zoom: '修改縮放', delete_zoom: '刪除縮放',
    add_overlay: '加入標註', edit_overlay: '修改標註', delete_overlay: '刪除標註',
    edit_subtitle: '修改字幕', add_bookend: '加入片頭片尾', bookend_transition: '片頭片尾轉場',
};
function describeChange(c: any): string {
    const label = CHANGE_LABEL[c?.type] ?? c?.type ?? '變更';
    const range = Array.isArray(c?.timeline) ? c.timeline : Array.isArray(c?.source) ? c.source : null;
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    return range && typeof range[0] === 'number' ? `${label}（${fmt(range[0])}–${fmt(range[1])}）` : label;
}
function announceExternal(method: string, result: any, params?: any) {
    let text = '';
    if (method === 'apply') {
        const n = Array.isArray(result?.changes) ? result.changes.length : 0;
        text = `AI 修改了時間軸${n ? `（${n} 項變更）` : ''}`;
        aiActivity.edits += 1;
        toast('info', `${text}，可按 Ctrl+Z 復原`);
    } else if (method === 'open' && params?.path) {
        text = `AI 開啟了專案「${String(params.path).replace(/\.ljcut$/i, '')}」`;
        toast('info', text);
    } else if (EXTERNAL_LABEL[method]) {
        text = EXTERNAL_LABEL[method];
        toast('info', text);
    }
    if (text) {
        aiActivity.text = text; aiActivity.at = Date.now();
        const details = method === 'apply' && Array.isArray(result?.changes) ? result.changes.slice(0, 12).map(describeChange) : [];
        if (aiActivity.log[0]?.text === text && !details.length) aiActivity.log[0].at = aiActivity.at;   // 連續相同動作只留一筆
        else {
            // 修改類：記下復原深度（可「退回到這步之前」）與第一個變更的時間軸位置（可「跳到這裡」）
            const first = method === 'apply' && Array.isArray(result?.changes) ? result.changes.find((c: any) => Array.isArray(c?.timeline) || Number.isFinite(c?.at)) : null;
            const jump = first ? (Array.isArray(first.timeline) ? first.timeline[0] : first.at) : undefined;
            aiActivity.log = [{ text, at: aiActivity.at, details, depth: method === 'apply' ? editHistory().depth : undefined, jump }, ...aiActivity.log].slice(0, 20);
        }
        window.dispatchEvent(new Event('ljcut-ai-activity'));
    }
}

export async function startControl() {
    if (started) return;
    started = true;
    const res = await fetch(`${getBase()}/api/control/connect`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) return;
    const config = await res.json();
    token = config.token;
    controlWorkspace = config.workspace;
    window.dispatchEvent(new Event('ljcut-control-ready'));
    const clientId = crypto.randomUUID();
    const replies = new Map<string, Promise<object>>();
    let acknowledging = false;
    let alive = true;
    let conflicts = 0;
    // 回傳 false 表示這輪沒拿到命令
    const tick = async (): Promise<boolean> => {
        try {
            const command = await controlRequest('/poll', { clientId, wait: 8 });
            conflicts = 0;
            if (!command) return false;
            aiActivity.lastCommandAt = Date.now();
            if (!replies.has(command.id)) {
                const method = command.request.method;
                replies.set(command.id, executeCommand(method, command.request.params).then(
                    result => { announceExternal(method, result, command.request.params); return { result }; },
                    error => ({ error: { code: error.code ?? 'EDITOR_ERROR', message: String(error.message ?? error) } })));
            }
            if (!acknowledging) {
                acknowledging = true;
                void replies.get(command.id)!.then(reply => controlRequest(`/ack/${command.id}`, { clientId, ...reply }))
                    .catch(() => { /* same request ID returns the cached result on the next poll */ })
                    .finally(() => { acknowledging = false; });
            }
            return true;
        } catch (error) {
            // 重新整理後舊頁面的連線最多佔用約 10 秒：先重試，持續被佔用才判定另有編輯器
            if (error instanceof EditError && error.code === 'EDITOR_ALREADY_CONNECTED' && ++conflicts > 15) {
                alive = false;
                controlWorkspace = '';
                window.dispatchEvent(new Event('ljcut-control-ready'));
            }
            await new Promise(r => setTimeout(r, 1000));
            return false;
        }
    };
    // 長輪詢迴圈：後端握住請求直到有命令（最多 8 秒），網路回應不受背景計時器節流影響。
    // 立即回空（舊版後端或異常）時稍等，避免空轉。
    import.meta.hot?.dispose(() => { alive = false; });
    void (async () => {
        while (alive) {
            const t0 = performance.now();
            const got = await tick();
            if (!got && performance.now() - t0 < 200) await new Promise(r => setTimeout(r, 300));
        }
    })();
}
