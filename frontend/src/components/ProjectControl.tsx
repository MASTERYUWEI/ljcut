/* 本機控制相關介面：拆成「頂部專案按鈕」與「設定裡的開發者工具」，不再常駐主畫面 */
import { FolderOpen, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { controlWorkspace, executeCommand } from '../controlClient';
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

/** 頂部：另存／開啟專案（只有啟用本機控制時出現） */
export function ProjectFileButtons() {
    const workspace = useControlWorkspace();
    const [open, setOpen] = useState<null | 'save' | 'open'>(null);
    const [path, setPath] = useState('教學剪輯.ljcut');
    const [busy, setBusy] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(null); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey, true);
        return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
    }, [open]);
    if (!workspace) return null;
    const run = async () => {
        if (!open || !path.trim()) return;
        setBusy(true);
        try {
            await executeCommand(open, { ...version(), path: path.trim() });
            toast('success', open === 'save' ? `已另存「${path.trim()}」` : `已開啟「${path.trim()}」`);
            setOpen(null);
        } catch (e) { toast('error', String(e)); }
        finally { setBusy(false); }
    };
    return <div className="project-file" ref={boxRef}>
        <button className="btn" aria-expanded={open === 'open'} onClick={() => setOpen(open === 'open' ? null : 'open')}><FolderOpen aria-hidden />開啟專案</button>
        <button className="btn" aria-expanded={open === 'save'} onClick={() => setOpen(open === 'save' ? null : 'save')}><Save aria-hidden />另存專案</button>
        {open && <form className="project-file-pop" role="dialog" aria-label={open === 'save' ? '另存專案' : '開啟專案'}
            onSubmit={e => { e.preventDefault(); void run(); }}>
            <label htmlFor="project-path">專案檔（相對於工作區）</label>
            <input id="project-path" ref={inputRef} className="st-input" value={path} onChange={e => setPath(e.target.value)} />
            <small title={workspace}>工作區：{workspace}</small>
            <button className="btn btn-primary" type="submit" disabled={busy || !path.trim()}>
                {busy ? '處理中…' : open === 'save' ? '另存' : '開啟'}
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
