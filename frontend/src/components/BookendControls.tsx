import { useEffect, useRef, useState } from 'react';
import { executeCommand, uploadBookend } from '../controlClient';
import { readState } from '../editSession';

export function BookendControls() {
    const [settings, setSettings] = useState({ revision: 0, introPath: '', outroPath: '', useIntro: false, useOutro: false, transitionMode: 'random', transitionDuration: 0.6 });
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [draft, setDraft] = useState<any>(null);
    const introFileRef = useRef<HTMLInputElement>(null);
    const outroFileRef = useRef<HTMLInputElement>(null);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); } catch (e) { setMessage(String(e)); } finally { setBusy(false); }
    };
    const load = async () => {
        const s = await executeCommand('production_settings');
        setSettings(s); setLoaded(true); setDraft(null); setMessage('已讀取製作預設');
    };
    useEffect(() => { void run(load); }, []);
    return <fieldset className="bookend-settings" disabled={busy}>
        <legend>錄影後製作：片頭與片尾</legend>
        <small>按「選擇影片」從任意資料夾挑選檔案。儲存預設後，下次可直接使用。</small>
        {(['intro', 'outro'] as const).map(role => {
            const label = role === 'intro' ? '片頭' : '片尾';
            const pathKey = role === 'intro' ? 'introPath' : 'outroPath';
            const useKey = role === 'intro' ? 'useIntro' : 'useOutro';
            const fileRef = role === 'intro' ? introFileRef : outroFileRef;
            return <div key={role} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label><input type="checkbox" checked={settings[useKey]} onChange={e => {
                    setSettings({ ...settings, [useKey]: e.target.checked }); setDraft(null);
                }} />加入{label}</label>
                <input aria-label={`${label}影片`} style={{ flex: 1 }} readOnly
                    value={settings[pathKey].replace(/\\/g, '/').split('/').pop() || ''} placeholder={`尚未選擇${label}影片`} />
                <input ref={fileRef} type="file" hidden aria-label={`選取${label}檔案`}
                    accept=".mp4,.mkv,.mov,.webm,.avi,.wmv" onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        void run(async () => {
                            setMessage(`正在準備${label}影片…`);
                            const selected = await uploadBookend(file);
                            setSettings(s => ({ ...s, [pathKey]: selected.path, [useKey]: true }));
                            setDraft(null);
                            setMessage(`已選擇「${selected.filename}」。按「儲存預設」即可保留這次選擇。`);
                        });
                    }} />
                <button className="btn" disabled={!loaded} aria-label={`選擇${label}影片`}
                    onClick={() => fileRef.current?.click()}>選擇影片…</button>
            </div>;
        })}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label>銜接轉場 <select aria-label="轉場類型" value={settings.transitionMode} onChange={e => {
                setSettings({ ...settings, transitionMode: e.target.value }); setDraft(null);
            }}>
                <option value="random">隨機挑選柔和轉場</option><option value="fade-black">淡黑</option>
                <option value="fade-gray">柔灰</option><option value="fade-white">淡白</option><option value="none">直接切換</option>
            </select></label>
            <label>時間 <input aria-label="轉場秒數" type="number" min="0.2" max="1.5" step="0.1" style={{ width: 72 }}
                value={settings.transitionDuration} onChange={e => { setSettings({ ...settings, transitionDuration: Number(e.target.value) }); setDraft(null); }} /> 秒</label>
            <button className="btn" disabled={!loaded} onClick={() => run(async () => {
                setDraft(null); const s = readState();
                const d = await executeCommand('prepare_transitions', { sessionId: s.sessionId, projectId: s.projectId,
                    expectedRevision: s.revision, mode: settings.transitionMode, duration: settings.transitionDuration });
                setDraft(d); setMessage('已選定本次轉場，確認後套用；影片總長與字幕時間不變。');
            })}>檢查現有片頭片尾轉場</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={!loaded} onClick={() => run(async () => {
                const saved = await executeCommand('set_production_settings', { ...settings, expectedSettingsRevision: settings.revision });
                setSettings(saved); setMessage('已儲存為下次可用的預設，時間軸未變更');
            })}>儲存預設</button>
            <button className="btn" onClick={() => run(load)}>重新讀取</button>
            <button className="btn" disabled={!loaded} onClick={() => run(async () => {
                setDraft(null);
                const s = readState();
                const d = await executeCommand('prepare_bookends', { ...settings, sessionId: s.sessionId, projectId: s.projectId, expectedRevision: s.revision });
                setDraft(d);
                setMessage(`預計從 ${d.beforeDuration.toFixed(3)} 秒變成 ${d.afterDuration.toFixed(3)} 秒。字幕隨主影片移動；尚未套用。`);
            })}>檢查加入結果</button>
            <button className="btn btn-accent" disabled={!draft} onClick={() => run(async () => {
                await executeCommand('apply', { sessionId: draft.sessionId, projectId: draft.projectId,
                    expectedRevision: draft.revision, dryRunId: draft.dryRunId, confirmed: true });
                setDraft(null); setMessage('已加入時間軸，可預覽、手動調整或整批復原');
            })}>確認套用</button>
        </div>
        {draft && <ul>{draft.changes.map((c: any) => <li key={`${c.type}-${c.clipId}`}>
            {c.type === 'bookend_transition' ? `${c.at.toFixed(3)} 秒：${c.label}，${c.duration} 秒`
                : `${c.role === 'intro' ? '片頭' : '片尾'}：${c.filename}（${c.timeline[0].toFixed(3)}–${c.timeline[1].toFixed(3)} 秒）`}
        </li>)}</ul>}
        <small role="status">{message}</small>
    </fieldset>;
}
