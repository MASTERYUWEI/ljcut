import { useEffect, useState } from 'react';
import { controlWorkspace, executeCommand } from '../controlClient';
import { readState, undo, redo } from '../editSession';
import { BookendControls } from './BookendControls';

export function ProjectControl() {
    const [workspace, setWorkspace] = useState(controlWorkspace);
    const [path, setPath] = useState('教學剪輯.ljcut');
    const [plan, setPlan] = useState('');
    const [report, setReport] = useState('');
    const [draft, setDraft] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const changed = () => setWorkspace(controlWorkspace);
        window.addEventListener('ljcut-control-ready', changed);
        return () => window.removeEventListener('ljcut-control-ready', changed);
    }, []);
    const run = async (action: () => unknown) => {
        setBusy(true);
        try { setReport(JSON.stringify(await action(), null, 2)); }
        catch (e) { setReport(String(e)); }
        finally { setBusy(false); }
    };
    const version = () => { const s = readState(); return { sessionId: s.sessionId, projectId: s.projectId, expectedRevision: s.revision }; };
    return <details style={{ margin: '4px 12px' }}>
        <summary>專案與本機控制{workspace ? ' · 已啟用' : ' · 未啟用'}</summary>
        <div style={{ padding: 8, display: 'grid', gap: 8 }}>
            <small>{workspace || '以 scripts/start-control.ps1 啟動並指定工作區後，可另存／開啟專案及接收外部命令。'}</small>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input aria-label="專案相對路徑" value={path} onChange={e => setPath(e.target.value)} />
                <button className="btn" disabled={!workspace || busy} onClick={() => run(() => executeCommand('save', { ...version(), path }))}>另存專案</button>
                <button className="btn" disabled={!workspace || busy} onClick={() => run(() => executeCommand('open', { ...version(), path }))}>開啟專案</button>
                <button className="btn" disabled={busy} onClick={() => run(undo)}>復原</button>
                <button className="btn" disabled={busy} onClick={() => run(redo)}>重做</button>
            </div>
            {workspace && <>
                <BookendControls />
                <textarea aria-label="結構化剪輯計畫" placeholder="貼上結構化剪輯計畫，先檢查變更" rows={3} value={plan}
                    onChange={e => { setPlan(e.target.value); setDraft(null); }} />
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" disabled={busy} onClick={() => run(async () => {
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
            {report && <details><summary>操作結果</summary><pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{report}</pre></details>}
        </div>
    </details>;
}
