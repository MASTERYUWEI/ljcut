import { api, getBase } from './api';
import { useStore } from './store';
import { EditError, requireEdit, validateProject, toSourceTime } from './editCore';
import { applyPlan, checkVersion, dryRun, projectData, readState, redo, replaceProject, requestPreview, undo } from './editSession';
import type { EditPlan, ProjectData } from './editCore';
import type { MediaItem } from './types';

let token = '';
export let controlWorkspace = '';
let previewReader: (() => { sourceTime: number; ready: boolean; subtitle: string; paused: boolean }) | undefined;
export function registerPreviewReader(reader: typeof previewReader) { previewReader = reader; }
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
export async function executeCommand(method: string, params: any = {}): Promise<any> {
    if (method === 'state') return readState();
    if (method === 'dry_run') {
        await controlRequest('/validate-media', projectData());
        return dryRun(params as EditPlan);
    }
    if (method === 'apply') {
        await controlRequest('/validate-media', projectData());
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
    if (method === 'save') {
        const p = projectData();
        validateProject(p);
        return controlRequest('/save', { path: params.path, project: p, revision: params.expectedRevision });
    }
    if (method === 'open') {
        const p: ProjectData = await controlRequest('/open', { path: params.path });
        for (const m of p.mediaItems) {
            m.url = api.mediaUrl(m.url);
            m.thumbnailUrl = api.getThumbnailUrl(m.id);
        }
        return replaceProject(p, params);
    }
    if (method === 'export') {
        const p = projectData();
        validateProject(p, true);
        return controlRequest('/export', { project: p, revision: params.expectedRevision });
    }
    throw new EditError('UNSUPPORTED_COMMAND', `不支援的命令 ${method}`);
}

let started = false;
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
    let polling = false;
    let acknowledging = false;
    const tick = async () => {
        if (polling) return;
        polling = true;
        try {
            const command = await controlRequest('/poll', { clientId });
            if (!command) return;
            if (!replies.has(command.id)) {
                replies.set(command.id, executeCommand(command.request.method, command.request.params).then(
                    result => ({ result }), error => ({ error: { code: error.code ?? 'EDITOR_ERROR', message: String(error.message ?? error) } })));
            }
            if (!acknowledging) {
                acknowledging = true;
                void replies.get(command.id)!.then(reply => controlRequest(`/ack/${command.id}`, { clientId, ...reply }))
                    .catch(() => { /* same request ID returns the cached result on the next poll */ })
                    .finally(() => { acknowledging = false; });
            }
        } catch (error) {
            if (error instanceof EditError && error.code === 'EDITOR_ALREADY_CONNECTED') {
                clearInterval(timer);
                controlWorkspace = '';
                window.dispatchEvent(new Event('ljcut-control-ready'));
            }
        } finally { polling = false; }
    };
    const timer = setInterval(() => { void tick(); }, 300);
    import.meta.hot?.dispose(() => clearInterval(timer));
    void tick();
}
