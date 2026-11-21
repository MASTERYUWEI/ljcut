import { exportAudioMix, type AudioMix } from './audioMix';
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
export async function controlRequest(path: string, body?: unknown, timeoutMs = 0): Promise<any> {
    requireEdit(token, 'CONTROL_DISABLED', '請先以指定工作區啟動本機控制');
    // 有逾時的請求（輪詢、回覆）卡住時自動放棄，避免整個 AI 控制迴圈永遠停在一個不會回來的請求上
    const abort = timeoutMs > 0 ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(new DOMException(`${timeoutMs / 1000} 秒沒有回應`, 'TimeoutError')), timeoutMs) : 0;
    let res: Response, result: any;
    try {
        res = await fetch(`${getBase()}/api/control${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            ...(abort ? { signal: abort.signal } : {}),
        });
        result = await res.json();
    } finally {
        if (timer) clearTimeout(timer);
    }
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
        // 自動存檔與「上一版」開啟後算未儲存（要另存新檔，不覆寫備份本身）
        if (params.path === AUTOSAVE_PATH || /(^|\/)\.上一版-/.test(params.path)) markProjectFile('', -1); else markProjectFile(params.path, readState().revision);
        return opened;
    }
    if (method === 'export') {
        const p = projectData();
        validateProject(p, true);
        const exportSequence = ++latestControlExport;
        // 平台響度：AI 可在 params.loudness 指定，否則用專案設定；配樂壓低包絡在這裡算（和預覽同一份）
        const mix = p.audioMix ? { ...p.audioMix, ...(params.loudness ? { loudness: params.loudness } : {}) } : (params.loudness ? { loudness: params.loudness } : undefined);
        const job = await controlRequest('/export', { project: p, revision: params.expectedRevision,
            burnSubtitles: params.burnSubtitles ?? false, audioMix: exportAudioMix(mix as AudioMix | undefined, p.timelineClips) });
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
/** AI 最近修改的時間軸位置（給時間軸畫標記） */
export const aiMarks: { t: number; text: string; at: number }[] = [];
// 存檔或開啟專案後清除 AI 修改標記（已經看過、存好了）
if (typeof window !== 'undefined') window.addEventListener('ljcut-project-file', () => { aiMarks.length = 0; });
export const aiActivity = { text: '', at: 0, lastCommandAt: 0, edits: 0, log: [] as { text: string; at: number; details: string[]; depth?: number; jump?: number }[] };
const CHANGE_LABEL: Record<string, string> = {
    ripple_delete: '刪除區段並補位', delete_clip: '刪除片段', split: '分割片段', move_clip: '移動片段', set_speed: '調整速度',
    add_subtitle: '新增字幕', delete_subtitle: '刪除字幕',
    add_zoom: '加入縮放', edit_zoom: '修改縮放', delete_zoom: '刪除縮放',
    add_overlay: '加入標註', edit_overlay: '修改標註', delete_overlay: '刪除標註',
    add_note: '加入審片意見', edit_note: '更新審片意見', delete_note: '刪除審片意見',
    edit_subtitle: '修改字幕', add_bookend: '加入片頭片尾', bookend_transition: '片頭片尾轉場',
};
/** AI 此刻正在做的事（標題列進行式）。AI 也可在任何命令的 params.note 帶一句自述，例如「正在看 1:07 的畫面」。 */
export const aiLive = { text: '', until: 0 };
const LIVE_LABEL: Record<string, string> = {
    dry_run: 'AI 正在試算修改…', apply: 'AI 正在套用修改…', undo: 'AI 正在復原…', redo: 'AI 正在重做…',
    preview: 'AI 帶你看畫面…', save: 'AI 正在存檔…', open: 'AI 正在開啟專案…', import: 'AI 正在匯入素材…',
    export: 'AI 開始匯出影片…', transcribe: 'AI 正在辨識字幕…', prepare_bookends: 'AI 正在準備片頭片尾…',
    prepare_transitions: 'AI 正在準備轉場…', prepare_covers: 'AI 正在準備封面…', complete_covers: 'AI 正在回填封面…',
};
function setLive(text: string, ms: number) {
    aiLive.text = text; aiLive.until = text ? Date.now() + ms : 0;
    window.dispatchEvent(new Event('ljcut-ai-live'));
}
/** 變更在時間軸上的範圍。剪接類回傳 [a,b]；縮放／標註回傳多段 [[a,b],...]（剪掉的部分不顯示），取第一段。 */
export function timelineRange(c: any): [number, number] | null {
    const tl = c?.timeline;
    if (!Array.isArray(tl) || tl.length === 0) return null;
    const first = Array.isArray(tl[0]) ? tl[0] : tl;
    return typeof first[0] === 'number' && typeof first[1] === 'number' ? [first[0], first[1]] : null;
}
function describeChange(c: any): string {
    const label = CHANGE_LABEL[c?.type] ?? c?.type ?? '變更';
    const range = timelineRange(c) ?? (Array.isArray(c?.source) && typeof c.source[0] === 'number' ? c.source : null);
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    return range ? `${label}（${fmt(range[0])}–${fmt(range[1])}）` : label;
}
function announceExternal(method: string, result: any, params?: any) {
    let text = '';
    if (method === 'apply') {
        const n = Array.isArray(result?.changes) ? result.changes.length : 0;
        text = `AI 修改了時間軸${n ? `（${n} 項變更）` : ''}`;
        aiActivity.edits += 1;
        toast('info', `${text}，可按 Ctrl+Z 復原`);
    } else if (method === 'dry_run' && Array.isArray(result?.audit) && result.audit.length) {
        // 套用前審核有問題：讓使用者在 LJ Cut 畫面上也看得到，不只 AI 看到
        const blocks = result.audit.filter((i: any) => i.level === 'block').length;
        text = `AI 的試算被審核標出 ${result.audit.length} 項${blocks ? `（${blocks} 項會擋下套用）` : ''}`;
        // 不用 error 樣式：錯誤提示會把內容換成通用說明，審核要原文給使用者看；有擋下項目時不自動消失
        toast('info', `${text}：${result.audit.slice(0, 3).map((i: any) => `${i.level === 'block' ? '【擋下】' : ''}${i.message}`).join('；')}`,
            undefined, blocks ? { sticky: true, key: 'plan-audit' } : { key: 'plan-audit' });
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
            const first = method === 'apply' && Array.isArray(result?.changes) ? result.changes.find((c: any) => timelineRange(c) || Number.isFinite(c?.at)) : null;
            const jump = first ? (timelineRange(first)?.[0] ?? first.at) : undefined;
            aiActivity.log = [{ text, at: aiActivity.at, details, depth: method === 'apply' ? editHistory().depth : undefined, jump }, ...aiActivity.log].slice(0, 20);
            if (method === 'apply' && Array.isArray(result?.changes)) {
                for (const ch of result.changes.slice(0, 30)) {
                    const r = timelineRange(ch);
                    const t = r ? r[0] : Number.isFinite(ch?.at) ? ch.at : undefined;
                    if (t !== undefined) aiMarks.push({ t, text: describeChange(ch), at: Date.now() });
                }
                while (aiMarks.length > 60) aiMarks.shift();
            }
        }
        window.dispatchEvent(new Event('ljcut-ai-activity'));
    }
}

/** 本機控制沒連上時，在背景重試（不重新整理畫面、不丟修改）。回傳是否真的連上；連上後換一個新的輪詢迴圈接手。
 *  另一個視窗在控制時，這也是「改由本視窗接管」：對方若已關閉，約 10 秒內接回；對方還在就會再退回「另一視窗控制中」。 */
export async function retryControl(): Promise<boolean> {
    const ok = await connectControl();
    if (ok) { setHealth({ otherEditor: false, failures: 0, ok: true }); runPollLoop(); }
    return ok;
}

/** AI 控制連線的健康狀態（標題列顯示用）。ok=false 表示輪詢連續失敗或太久沒成功、AI 命令暫時送不進來；otherEditor 表示另一個 LJ Cut 視窗正在控制同一工作區。 */
export const controlHealth = { ok: true, lastPollAt: 0, lastError: '', failures: 0, otherEditor: false };
function setHealth(patch: Partial<typeof controlHealth>) {
    const before = `${controlHealth.ok}|${controlHealth.otherEditor}|${controlHealth.lastError}`;
    Object.assign(controlHealth, patch);
    if (`${controlHealth.ok}|${controlHealth.otherEditor}|${controlHealth.lastError}` !== before) window.dispatchEvent(new Event('ljcut-control-health'));
}
/** 寫進 LJCUT.log（%LOCALAPPDATA%\tw.ljcut.app\logs）：事後才查得到 AI 控制為什麼斷。瀏覽器模式只進 console。 */
export function frontendLog(level: 'info' | 'warn' | 'error', message: string) {
    console[level](`[control] ${message}`);
    if ((window as any).__TAURI_INTERNALS__) {
        import('@tauri-apps/api/core').then(m => m.invoke('frontend_log', { level, message })).catch(() => { /* 舊版主程式沒有這個命令 */ });
    }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let generation = 0;       // 每個輪詢迴圈的世代：換新迴圈時舊的在下一輪自己結束
let loopBeat = 0;         // 目前迴圈最近一次開始跑一輪的時間（看門狗用）
// 這個頁面的編輯器識別碼與已收到的命令：所有迴圈共用。換迴圈不換 id，後端不會把它當成另一個編輯器而把執行中的命令標成失敗；
// 共用 replies 讓舊迴圈即使晚一步醒來拿到同一個命令，也不會重做一次
let clientId = '';
const replies = new Map<string, Promise<object>>();
const ackInFlight = new Set<string>();
let connecting: Promise<boolean> | null = null;
/** 向後端拿控制憑證（token）。後端重啟後 token 會換，所以斷線重試時也會再握手一次；同時只跑一個。 */
function connectControl(): Promise<boolean> {
    if (connecting) return connecting;
    connecting = (async () => {
        try {
            const res = await fetch(`${getBase()}/api/control/connect`, { method: 'POST' }).catch(() => null);
            if (!res?.ok) { window.dispatchEvent(new Event('ljcut-control-failed')); return false; }
            const config = await res.json();
            token = config.token;
            controlWorkspace = config.workspace;
            window.dispatchEvent(new Event('ljcut-control-ready'));
            return true;
        } finally { connecting = null; }
    })();
    return connecting;
}
export async function startControl() {
    if (started) return;
    started = true;
    if (!(await connectControl())) { started = false; return; }
    runPollLoop();
}
if (typeof window !== 'undefined') {
    import.meta.hot?.dispose(() => { generation++; });
    // 看門狗（每 10 秒）：
    // 1) 超過 30 秒沒有一次成功的輪詢 → 標成斷線，標題列變紅（迴圈靜靜停掉、沒有任何失敗事件時也看得到）
    // 2) 迴圈 3 分鐘都沒再跑一輪（某個 await 永遠不回來）→ 換一個新迴圈接手（同一個 clientId、共用 replies，換迴圈沒有副作用）。
    //    門檻要大於「視窗隱藏 5 分鐘後計時器被對齊到整分鐘：15 秒逾時 ＋ 1 秒等待都可能拉到 60 秒」
    setInterval(() => {
        if (!token || !loopBeat) return;
        const sincePoll = Date.now() - controlHealth.lastPollAt;
        if (controlHealth.ok && !controlHealth.otherEditor && controlHealth.lastPollAt && sincePoll > 30000) {
            frontendLog('warn', `AI 控制 ${Math.round(sincePoll / 1000)} 秒沒有成功的輪詢（迴圈距上一輪 ${Math.round((Date.now() - loopBeat) / 1000)} 秒）`);
            setHealth({ ok: false, lastError: `${Math.round(sincePoll / 1000)} 秒沒有收到輪詢回應` });
        }
        if (Date.now() - loopBeat < 180000) return;
        frontendLog('warn', `AI 控制迴圈 ${Math.round((Date.now() - loopBeat) / 1000)} 秒沒有動靜，換新迴圈接手`);
        runPollLoop();
    }, 10000);
}

function runPollLoop() {
    const gen = ++generation;
    clientId ||= crypto.randomUUID();
    let conflicts = 0;
    loopBeat = Date.now();
    if (!controlHealth.lastPollAt) controlHealth.lastPollAt = Date.now();
    frontendLog('info', `AI 控制迴圈啟動（第 ${gen} 代，client ${clientId.slice(0, 8)}）`);
    // 回傳 false 表示這輪沒拿到命令
    const tick = async (): Promise<boolean> => {
        // 另一個視窗在控制：不再去輪詢。若持續輪詢，對方只要有 10 秒沒被後端記到（例如後端短暫卡住），
        // 本視窗就會搶走 owner、害對方執行中的命令被標成失敗、AI 後續命令跑到別的專案。要接回請按「改由本視窗接管」
        if (controlHealth.otherEditor) { await sleep(5000); return false; }
        try {
            // 後端最多握 8 秒；15 秒沒回來就放棄這一次重來，迴圈不會停在一個永遠不回來的請求上
            const command = await controlRequest('/poll', { clientId, wait: 8 }, 15000);
            conflicts = 0;
            if (!controlHealth.ok || controlHealth.failures) frontendLog('info', `AI 控制連線恢復（之前失敗 ${controlHealth.failures} 次：${controlHealth.lastError}）`);
            setHealth({ ok: true, lastPollAt: Date.now(), lastError: '', failures: 0 });
            if (!command) return false;
            aiActivity.lastCommandAt = Date.now();
            if (!replies.has(command.id)) {
                const method = command.request.method;
                const params = command.request.params ?? {};
                const note = typeof params.note === 'string' ? params.note.trim().slice(0, 120) : '';
                const live = note || LIVE_LABEL[method] || '';
                if (live) setLive(live, note ? 8000 : 120000);
                const done = () => { if (!note && aiLive.text === live) setLive('', 0); };
                replies.set(command.id, executeCommand(method, params).then(
                    result => {
                        done();
                        announceExternal(method, result, params);
                        if (method === 'apply' && Array.isArray(result?.changes))
                            window.dispatchEvent(new CustomEvent('ljcut-ai-applied', { detail: result.changes }));
                        return { result };
                    },
                    error => { done(); return { error: { code: error.code ?? 'EDITOR_ERROR', message: String(error.message ?? error) } }; }));
            }
            // 每個命令各自回覆：長命令（辨識、匯出）執行中，後面送進來的短命令做完就能立刻回，不用排在它後面。
            // 回覆失敗時後端會重送同一命令，再回一次
            if (!ackInFlight.has(command.id)) {
                ackInFlight.add(command.id);
                void replies.get(command.id)!.then(reply => controlRequest(`/ack/${command.id}`, { clientId, ...reply }, 15000)
                    // 已回覆：放掉大結果（state 動輒數百 KB）省記憶體。若後端又重送同一命令，只會再回一次空殼，後端已完成會忽略
                    .then(() => { replies.set(command.id, Promise.resolve({ result: null })); }))
                    .catch(() => { /* same request ID returns the cached result on the next poll */ })
                    .finally(() => { ackInFlight.delete(command.id); });
            }
            return true;
        } catch (error) {
            const name = (error as any)?.name;
            const code = error instanceof EditError ? error.code : name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
            const msg = `${code}: ${String((error as any)?.message ?? error).slice(0, 160)}`;
            if (code === 'EDITOR_ALREADY_CONNECTED') {
                // 重新整理後舊頁面的連線最多佔用約 10 秒：先重試，持續被佔用才判定另有編輯器、收起本視窗的存檔介面並停止輪詢。
                // 「改由本視窗接管」（retryControl）會還原介面、換新迴圈重新數
                if (++conflicts > 15) {
                    frontendLog('warn', '另一個 LJ Cut 視窗正在控制此工作區，本視窗停止 AI 控制；要接回請按「改由本視窗接管」');
                    controlWorkspace = '';
                    window.dispatchEvent(new Event('ljcut-control-ready'));
                    setHealth({ otherEditor: true, lastError: msg });
                }
                await sleep(1000);
                return false;
            }
            const failures = controlHealth.failures + 1;
            if (failures === 1 || failures % 30 === 0) frontendLog('warn', `AI 控制輪詢失敗 ${failures} 次：${msg}`);
            // 連續失敗 2 次、或超過 30 秒沒有一次成功的輪詢，才算斷線（單次抖動不變紅；逾時一次要 15 秒，所以不等到第 3 次）
            const stale = controlHealth.lastPollAt > 0 && Date.now() - controlHealth.lastPollAt > 30000;
            setHealth({ failures, lastError: msg, ok: controlHealth.ok && failures < 2 && !stale });
            // 後端重啟後 token 會換（UNAUTHORIZED）；連續失敗也每 5 次重新握手一次，拿到新 token 才接得回去
            if (code === 'UNAUTHORIZED' || failures % 5 === 0) {
                if (await connectControl()) frontendLog('info', '已重新取得本機控制憑證');
            }
            await sleep(1000);
            return false;
        }
    };
    // 長輪詢迴圈：後端握住請求直到有命令（最多 8 秒），網路回應不受背景計時器節流影響。
    // 立即回空（舊版後端或異常）時稍等，避免空轉。
    void (async () => {
        while (gen === generation) {
            loopBeat = Date.now();
            const t0 = performance.now();
            const got = await tick();
            if (!got && performance.now() - t0 < 200) await sleep(300);
        }
        frontendLog('info', `AI 控制迴圈結束（第 ${gen} 代，已由新迴圈接手）`);
    })();
}
