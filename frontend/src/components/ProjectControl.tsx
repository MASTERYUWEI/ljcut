/* 本機控制相關介面：拆成「頂部專案按鈕」與「設定裡的開發者工具」，不再常駐主畫面 */
import { FolderOpen, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { controlWorkspace, executeCommand, projectFile } from '../controlClient';
import { useStore } from '../store';
import { StatusText } from './StatusText';
import { readState } from '../editSession';
import { toast } from '../toast';

/** 本機控制工作區（以 scripts/start-control.ps1 啟動時才有） */
export function useControlWorkspace() {
    const [workspace, setWorkspace] = useState(controlWorkspace);
    useEffect(() => {
        const changed = () => setWorkspace(controlWorkspace);
        window.addEventListener('ljcut-control-ready', changed);
        return () => window.removeEventListener('ljcut-control-ready', changed);
    }, []);
    return workspace;
}

const version = () => { const s = readState(); return { sessionId: s.sessionId, projectId: s.projectId, expectedRevision: s.revision }; };

/** 未儲存狀態：專案版本 ≠ 最後存檔／開啟時的版本 */
function useProjectStatus() {
    const [, bump] = useState(0);
    useEffect(() => {
        const update = () => bump(n => n + 1);
        window.addEventListener('ljcut-project-file', update);
        const unsub = useStore.subscribe((st, prev) => {
            if (st.timelineClips !== prev.timelineClips || st.mediaItems !== prev.mediaItems
                || st.subtitleStyle !== prev.subtitleStyle || st.language !== prev.language) update();
        });
        return () => { window.removeEventListener('ljcut-project-file', update); unsub(); };
    }, []);
    const hasContent = useStore.getState().timelineClips.length > 0;
    const dirty = hasContent && readState().revision !== projectFile.savedRevision;
    const name = projectFile.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.ljcut$/i, '') ?? '';
    return { name, path: projectFile.path, dirty, hasContent };
}

/** 頂部：專案名稱＋未儲存標記、開啟／儲存（只有啟用本機控制時出現）。Ctrl+S 儲存、Ctrl+Shift+S 另存新檔 */
export function ProjectFileButtons() {
    const workspace = useControlWorkspace();
    const status = useProjectStatus();
    const [open, setOpen] = useState<null | 'save' | 'open'>(null);
    const [path, setPath] = useState('教學剪輯.ljcut');
    const [busy, setBusy] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const statusRef = useRef(status);
    statusRef.current = status;
    useEffect(() => {
        document.title = `${status.dirty ? '● ' : ''}${status.name || (status.hasContent ? '未命名專案' : 'LJCUT')}${status.name || status.hasContent ? ' — LJCUT' : ''}`;
    }, [status.dirty, status.name, status.hasContent]);
    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        inputRef.current?.select();
        const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(null); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey, true);
        return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
    }, [open]);
    const doRun = async (method: 'save' | 'open', target: string) => {
        setBusy(true);
        try {
            await executeCommand(method, { ...version(), path: target });
            toast('success', method === 'save' ? `已儲存「${target}」` : `已開啟「${target}」`);
            setOpen(null);
        } catch (e) { toast('error', String(e)); }
        finally { setBusy(false); }
    };
    const save = (saveAs = false) => {
        const st = statusRef.current;
        if (!saveAs && st.path) void doRun('save', st.path);
        else { setPath(st.path || '教學剪輯.ljcut'); setOpen('save'); }
    };
    useEffect(() => {
        if (!workspace) return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace]);
    if (!workspace) return null;
    const target = path.trim();
    const overwrite = open === 'save' && target !== status.path;
    return <div className="project-file" ref={boxRef}>
        <span className="project-name" title={status.path ? `工作區中的 ${status.path}` : '尚未存成專案檔'}>
            {status.name || (status.hasContent ? '未命名專案' : '沒有專案')}
            {status.dirty && <span className="dirty-mark"><span className="dirty-dot" aria-hidden />未儲存</span>}
        </span>
        <button className="btn" aria-expanded={open === 'open'} onClick={() => { setPath(status.path || '教學剪輯.ljcut'); setOpen(open === 'open' ? null : 'open'); }}><FolderOpen aria-hidden />開啟</button>
        <button className="btn" disabled={busy} onClick={() => save(false)} title={status.path ? `儲存到 ${status.path}（Ctrl+S）；另存新檔 Ctrl+Shift+S` : '儲存成專案檔（Ctrl+S）'}>
            <Save aria-hidden />{busy && !open ? '儲存中…' : '儲存'}</button>
        {open && <form className="project-file-pop" role="dialog" aria-label={open === 'save' ? '另存專案' : '開啟專案'}
            onSubmit={e => { e.preventDefault(); if (target) void doRun(open, target); }}>
            <label htmlFor="project-path">{open === 'save' ? '存成（相對於工作區的檔名）' : '要開啟的專案檔（相對於工作區）'}</label>
            <input id="project-path" ref={inputRef} className="st-input" value={path} onChange={e => setPath(e.target.value)} />
            <small title={workspace}>工作區：{workspace}</small>
            {open === 'open' && status.dirty && <StatusText kind="warn" text="目前的修改還沒儲存，開啟後會被取代（可先按「儲存」）。" />}
            {overwrite && status.path && <StatusText kind="info" text={`會另存成新檔；原本的「${status.path}」不變。同名檔案會被覆蓋。`} />}
            <button className="btn btn-primary" type="submit" disabled={busy || !target}>
                {busy ? '處理中…' : open === 'save' ? '儲存' : status.dirty ? '放棄修改並開啟' : '開啟'}
            </button>
        </form>}
    </div>;
}

/** 設定 → 進階：貼上結構化剪輯計畫，先檢查再套用（給開發與外部 agent 除錯用） */
export function DeveloperTools() {
    const workspace = useControlWorkspace();
    const [plan, setPlan] = useState('');
    const [report, setReport] = useState('');
    const [draft, setDraft] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const run = async (action: () => unknown) => {
        setBusy(true);
        try { setReport(JSON.stringify(await action(), null, 2)); }
        catch (e) { setReport(String(e)); }
        finally { setBusy(false); }
    };
    return <details className="dev-tools">
        <summary>進階／開發者：本機控制{workspace ? '（已啟用）' : '（未啟用）'}</summary>
        <div className="dev-tools-body">
            <small>{workspace ? `工作區：${workspace}` : '以 scripts/start-control.ps1 指定工作區啟動後，才能另存／開啟專案及接收外部命令。'}</small>
            {workspace && <>
                <textarea className="st-input" aria-label="結構化剪輯計畫" placeholder="貼上結構化剪輯計畫（JSON），先檢查變更" rows={4} value={plan}
                    onChange={e => { setPlan(e.target.value); setDraft(null); }} />
                <div className="dev-tools-actions">
                    <button className="btn" disabled={busy || !plan.trim()} onClick={() => run(async () => {
                        setDraft(null);
                        const d = await executeCommand('dry_run', JSON.parse(plan)); setDraft(d); return d;
                    })}>檢查計畫（不修改）</button>
                    <button className="btn btn-accent" disabled={!draft || busy} onClick={() => run(async () => {
                        const result = await executeCommand('apply', { dryRunId: draft.dryRunId,
                            sessionId: draft.sessionId, projectId: draft.projectId, expectedRevision: draft.revision, confirmed: true });
                        setDraft(null); return result;
                    })}>確認套用這批變更</button>
                </div>
            </>}
            {report && <pre className="dev-tools-report" aria-label="操作結果">{report}</pre>}
        </div>
    </details>;
}
