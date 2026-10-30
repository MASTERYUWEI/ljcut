/* 本機控制相關介面：拆成「頂部專案按鈕」與「設定裡的開發者工具」，不再常駐主畫面 */
import { FolderOpen, Save, FolderSearch, FilePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AUTOSAVE_PATH, autosaveProject, controlRequest, controlWorkspace, executeCommand, projectFile, startNewProject } from '../controlClient';
import { useStore } from '../store';
import { StatusText } from './StatusText';
import { useDialog } from '../useDialog';
import { readState , sameContent } from '../editSession';
import { toast , dismissToast } from '../toast';

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
    const dirty = hasContent && !sameContent({ revision: projectFile.savedRevision, key: projectFile.savedKey });
    const name = projectFile.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.ljcut$/i, '') ?? '';
    return { name, path: projectFile.path, dirty, hasContent };
}

/** 頂部：專案名稱＋未儲存標記、開啟／儲存（只有啟用本機控制時出現）。Ctrl+S 儲存、Ctrl+Shift+S 另存新檔 */
export function ProjectFileButtons() {
    const workspace = useControlWorkspace();
    const [controlFailed, setControlFailed] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => { if (!controlWorkspace) setControlFailed(true); }, 8000);   // 8 秒還沒連上就說明
        const onReady = () => setControlFailed(!controlWorkspace);
        window.addEventListener('ljcut-control-ready', onReady);
        window.addEventListener('ljcut-control-failed', onReady);
        return () => { clearTimeout(t); window.removeEventListener('ljcut-control-ready', onReady); window.removeEventListener('ljcut-control-failed', onReady); };
    }, []);
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
            if (method === 'save' && closeAfterSave.current) { closeAfterSave.current = false; await closeWindow(); }
        } catch (e) { toast('error', String(e)); }
        finally { setBusy(false); }
    };
    const submitRef = useRef<HTMLButtonElement>(null);
    const saveOpenRef = useRef<HTMLButtonElement>(null);
    // 放棄修改前先留一份自動存檔，開啟後可「回到剛才的進度」
    const discardAndOpen = async (target: string) => {
        try { await autosaveProject(); } catch { /* 備份失敗仍讓使用者決定 */ }
        await doRun('open', target);
        toast('info', '已放棄剛才的修改並開啟新專案。', [{ label: '回到剛才的進度', run: () => { void doRun('open', AUTOSAVE_PATH); } }]);
    };
    const openFromList = (target: string) => {
        if (statusRef.current.dirty) { setPath(target); (saveOpenRef.current ?? submitRef.current)?.focus(); return; }   // 有修改：焦點給「儲存後開啟」
        void doRun('open', target);
    };
    const saveThenOpen = async (target: string) => {
        const st = statusRef.current;
        if (!st.path) { toast('info', '這個專案還沒取名，請先按「儲存」取名後再開啟其他專案。'); return; }
        setBusy(true);
        try {
            await executeCommand('save', { ...version(), path: st.path });
            await executeCommand('open', { ...version(), path: target });
            toast('success', `已儲存「${st.path}」並開啟「${target}」`);
            setOpen(null);
        } catch (e) { toast('error', String(e)); }
        finally { setBusy(false); }
    };
    // 新專案：有未儲存修改時先問（儲存後新建／放棄／取消）
    const [pendingNew, setPendingNew] = useState(false);
    const newBoxRef = useRef<HTMLDivElement>(null);
    useDialog(newBoxRef, pendingNew);
    const doNew = () => {
        const prev = statusRef.current.path;
        startNewProject(); setPendingNew(false); setOpen(null);
        toast('success', '已開新專案：把影片拖進來，或按「匯入影片」開始', prev ? [{ label: `重新開啟「${prev.replace(/\.ljcut$/i, '')}」`, run: () => { void doRun('open', prev); } }] : undefined);
    };
    const askNew = () => { if (statusRef.current.dirty) setPendingNew(true); else doNew(); };
    useEffect(() => {
        if (!pendingNew) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPendingNew(false); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [pendingNew]);
    const save = (saveAs = false) => {
        const st = statusRef.current;
        if (!saveAs && st.path) void doRun('save', st.path);
        else { setPath(st.path || '教學剪輯.ljcut'); setOpen('save'); }
    };
    // 開啟時向後端列出工作區裡的專案（取代手打檔名）
    const [projects, setProjects] = useState<{ path: string; name: string; modified: number; autosave?: boolean }[]>([]);
    useEffect(() => {
        if (!open) return;
        controlRequest('/projects').then(r => {
            if (open === 'save') { setProjects(r.projects ?? []); return; }
            const list = r.projects ?? [];
            const all = r.autosave ? [{ path: r.autosave.path, name: '上次沒儲存的進度（自動存檔）', modified: r.autosave.modified, autosave: true }, ...list] : list;
            setProjects(all);
            setPath(all.find((x: { path: string; autosave?: boolean }) => !x.autosave && x.path !== statusRef.current.path)?.path ?? '');
            // 焦點放到第一個「不是目前專案」的項目（方向鍵可上下選）
            setTimeout(() => (boxRef.current?.querySelector<HTMLElement>('.project-item[aria-selected="true"]') ?? boxRef.current?.querySelector<HTMLElement>('.project-item'))?.focus(), 0);
        }).catch(() => setProjects([]));
    }, [open]);
    // 自動存檔：有未儲存修改時每分鐘存一份隱藏備份（不影響「未儲存」狀態）
    useEffect(() => {
        if (!workspace) return;
        const timer = setInterval(() => {
            if (statusRef.current.dirty) void autosaveProject().then(() => {
                setBackedUp(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
            }).catch(() => { /* 下次再試 */ });
        }, 60000);
        return () => clearInterval(timer);
    }, [workspace]);
    // 啟動時：自動存檔比所有專案都新 → 提供還原
    useEffect(() => {
        if (!workspace) return;
        controlRequest('/projects').then(r => {
            const latest = Math.max(0, ...(r.projects ?? []).map((x: { modified: number }) => x.modified));
            if (!r.autosave || r.autosave.modified <= latest + 5 || useStore.getState().timelineClips.length) return;
            const when = new Date(r.autosave.modified * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const id = toast('info', `找到上次沒儲存的進度（${when} 自動存檔）。也可以之後從「開啟」清單最上面還原。`, [
                { label: '還原', run: () => { void doRun('open', AUTOSAVE_PATH); } },
            ], { sticky: true });
            // 開啟了任何專案後，這則還原提示就不再需要
            window.addEventListener('ljcut-project-file', () => dismissToast(id), { once: true });
        }).catch(() => { });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace]);
    // 關窗保護：有未儲存修改時先問
    const [closing, setClosing] = useState(false);
    const closeAfterSave = useRef(false);
    const closeBoxRef = useRef<HTMLDivElement>(null);
    const [backedUp, setBackedUp] = useState('');
    useDialog(closeBoxRef, closing);
    useEffect(() => {
        if (!closing) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setClosing(false); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [closing]);
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => { if (statusRef.current.dirty) { e.preventDefault(); e.returnValue = ''; } };
        window.addEventListener('beforeunload', onBeforeUnload);
        let unlisten: (() => void) | undefined;
        if ((window as any).__TAURI_INTERNALS__) {
            void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().onCloseRequested(e => {
                if (!statusRef.current.dirty) return;
                e.preventDefault();
                setClosing(true);
            })).then(u => { unlisten = u; });
        }
        return () => { window.removeEventListener('beforeunload', onBeforeUnload); unlisten?.(); };
    }, []);
    const closeWindow = async () => {
        if ((window as any).__TAURI_INTERNALS__) {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().destroy();
        }
    };
    useEffect(() => {
        if (!workspace) return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); }
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); askNew(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace]);
    if (!workspace) return controlFailed ? <div className="project-file">
        <span className="control-down" role="status">無法存檔：本機控制未連線</span>
        <button className="btn btn-sm" onClick={() => location.reload()} title="重新整理畫面並重新連線（未儲存的修改會遺失）">重新連線</button>
    </div> : null;
    const target = path.trim();
    const normalized = /\.ljcut$/i.test(target) ? target : `${target}.ljcut`;
    const nameTaken = open === 'save' && !!target && normalized !== status.path && projects.some(x => !x.autosave && x.path.toLowerCase() === normalized.toLowerCase());
    const overwrite = open === 'save' && target !== status.path;
    return <div className="project-file" ref={boxRef}>
        <span className="project-name" title={status.path ? `工作區中的 ${status.path}` : '尚未存成專案檔'}>
            {status.name || (status.hasContent ? '未命名專案' : '沒有專案')}
            {status.dirty && <span className="dirty-mark" title={backedUp ? `已自動備份（${backedUp}），但還沒存進專案檔` : '有修改還沒存進專案檔（Ctrl+S）'}>
                <span className="dirty-dot" aria-hidden />未儲存{backedUp && <small className="backed-up">· 已備份 {backedUp}</small>}</span>}
        </span>
        <button className="btn" aria-expanded={open === 'open'} aria-label="開啟專案或新專案" title="開啟專案／新專案（Ctrl+N）" onClick={() => { setPath(status.path || '教學剪輯.ljcut'); setOpen(open === 'open' ? null : 'open'); }}><FolderOpen aria-hidden /><span className="btn-label">開啟</span></button>
        <button className="btn" disabled={busy} aria-label="儲存專案" onClick={() => save(false)} title={status.path ? `儲存到 ${status.path}（Ctrl+S）；另存新檔 Ctrl+Shift+S` : '儲存成專案檔（Ctrl+S）'}>
            <Save aria-hidden /><span className="btn-label">{busy && !open ? '儲存中…' : '儲存'}</span></button>
        {open && <form className="project-file-pop" role="dialog" aria-label={open === 'save' ? '另存專案' : '開啟專案'}
            onSubmit={e => {
                e.preventDefault();
                if (!target) return;
                if (open === 'open' && status.dirty) {
                    // 有未儲存修改時，Enter 的預設動作是「儲存後開啟」，永遠不會直接丟掉修改
                    if (status.path) void saveThenOpen(target);
                    else toast('info', '這個專案還沒取名：請先按「儲存」取名，或明確按「放棄修改並開啟」。');
                    return;
                }
                if (open === 'open') { const prev = status.path; void doRun('open', target).then(() => {
                    if (prev && prev !== target) toast('success', `已開啟「${target.replace(/\.ljcut$/i, '')}」`, [{ label: `回到「${prev.replace(/\.ljcut$/i, '')}」`, run: () => { void doRun('open', prev); } }]);
                }); return; }
                void doRun(open, !/\.ljcut$/i.test(target) ? `${target}.ljcut` : target);
            }}>
            {open === 'open' ? <>
                <button type="button" className="btn new-project-btn" onClick={askNew} title="清空編輯器，開始下一支影片（Ctrl+N）"><FilePlus aria-hidden />新專案<kbd>Ctrl N</kbd></button>
                <div className="pop-title">或選擇要開啟的專案</div>
                {projects.length ? <ul className="project-list" role="listbox" aria-label="專案資料夾裡的專案">
                    {projects.map(pr => <li key={pr.path}>
                        <button type="button" role="option" aria-selected={pr.path === path} className={`project-item ${pr.path === path ? 'on' : ''} ${pr.autosave ? 'autosave' : ''}`}
                            onClick={() => setPath(pr.path)} onDoubleClick={() => openFromList(pr.path)} title={status.dirty ? '目前有未儲存的修改：請用下方按鈕選擇儲存或放棄' : '按兩下或 Enter 直接開啟'}
                            onFocus={() => setPath(pr.path)} aria-current={pr.path === status.path ? 'true' : undefined}
                            onKeyDown={e => {
                                const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('.project-item') ?? []);
                                const i = items.indexOf(e.currentTarget);
                                if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
                                else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)]?.focus(); }
                                else if (e.key === 'Enter') { e.preventDefault(); openFromList(pr.path); }
                            }}>
                            <span>{pr.name}{pr.path === status.path && <em className="project-current">目前開啟</em>}</span><small>{new Date(pr.modified * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
                        </button>
                    </li>)}
                </ul> : <p className="bookends-note">專案資料夾裡還沒有專案。</p>}
                <input id="project-path" ref={inputRef} type="hidden" value={path} readOnly />
            </> : <>
                <label htmlFor="project-path">專案名稱</label>
                <input id="project-path" ref={inputRef} className="st-input" value={path} onChange={e => setPath(e.target.value)}
                    aria-invalid={nameTaken || undefined} aria-describedby={nameTaken ? 'name-taken' : undefined} />
                {nameTaken && <StatusText kind="warn" text="已有同名專案，請換一個名稱（不會覆蓋）。" />}
            </>}
            <div className="pop-folder">
                <small title={workspace}>存放位置：{workspace}</small>
                {(window as any).__TAURI_INTERNALS__ && <button type="button" className="btn btn-sm" onClick={() => {
                    void import('@tauri-apps/plugin-shell').then(({ open: openPath }) => openPath(workspace)).catch(e => toast('error', String(e)));
                }}><FolderSearch aria-hidden />開啟資料夾</button>}
            </div>
            {open === 'open' && status.dirty && <StatusText kind="warn" text="目前的修改還沒儲存，開啟後會被取代（可先按「儲存」）。" />}
            {overwrite && status.path && <StatusText kind="info" text={`會另存成新檔；原本的「${status.path}」不變。已有同名專案時會請你換名稱，不會覆蓋。`} />}
            <div className="pop-actions">
                {open === 'open' && status.dirty ? <>
                    <button type="button" className="btn btn-danger-soft" disabled={busy || !target} onClick={() => void discardAndOpen(target)}
                        title="會先自動備份目前的進度，開啟後仍可回到剛才的進度">放棄修改並開啟</button>
                    {status.path && <button ref={saveOpenRef} type="submit" className="btn btn-primary" disabled={busy || !target}>儲存後開啟</button>}
                </> : <button ref={submitRef} className="btn btn-primary" type="submit" disabled={busy || !target || nameTaken || (open === 'open' && target === status.path && !status.dirty)}>
                    {busy ? '處理中…' : open === 'save' ? '儲存' : '開啟'}
                </button>}
            </div>
        </form>}
        {pendingNew && <div className="modal-overlay">
            <div className="modal-box" ref={newBoxRef} role="alertdialog" aria-modal="true" aria-labelledby="new-title" aria-describedby="new-desc" style={{ maxWidth: 400 }}>
                <div className="modal-header"><h2 id="new-title">開新專案前要先儲存嗎？</h2></div>
                <p id="new-desc" className="close-desc">「{status.name || '未命名專案'}」有還沒儲存的修改。</p>
                <div className="close-actions">
                    {status.path && <button className="btn btn-primary" disabled={busy} onClick={async () => {
                        await doRun('save', status.path);
                        if (!statusRef.current.dirty) doNew();
                    }}>儲存後開新專案</button>}
                    {!status.path && <button className="btn btn-primary" onClick={() => { setPendingNew(false); save(true); }}>先取名儲存</button>}
                    <button className="btn" onClick={doNew}>放棄修改</button>
                    <button className="btn" onClick={() => setPendingNew(false)}>取消</button>
                </div>
            </div>
        </div>}
        {closing && <div className="modal-overlay">
            <div className="modal-box" ref={closeBoxRef} role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-desc" style={{ maxWidth: 400 }}>
                <div className="modal-header"><h2 id="close-title">要先儲存再關閉嗎？</h2></div>
                <p id="close-desc" className="close-desc">「{status.name || '未命名專案'}」有還沒儲存的修改。</p>
                <div className="close-actions">
                    <button className="btn btn-primary" autoFocus disabled={busy} onClick={async () => {
                        if (!status.path) { setClosing(false); closeAfterSave.current = true; save(true); return; }      // 還沒取名：先另存，存好再關
                        await doRun('save', status.path);
                        if (!statusRef.current.dirty) await closeWindow();
                    }}>儲存並關閉</button>
                    <button className="btn" onClick={() => void closeWindow()}>不儲存，直接關閉</button>
                    <button className="btn" onClick={() => setClosing(false)}>取消</button>
                </div>
            </div>
        </div>}
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
            <small>{workspace ? `專案資料夾：${workspace}` : '本機控制已關閉（LJCUT_CONTROL_WORKSPACE 設為空白），無法存檔與接收 AI 命令。'}</small>
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
