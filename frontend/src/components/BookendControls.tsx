/* 匯出對話框裡的片頭片尾：選檔、轉場，一顆「加入時間軸」完成（可 Ctrl+Z 復原）。
   選擇會自動存成下次的預設，不需要另外按儲存。 */
import { useEffect, useRef, useState } from 'react';
import { executeCommand, uploadBookend } from '../controlClient';
import { readState } from '../editSession';
import { useStore } from '../store';
import { humanizeError } from '../toast';
import { StatusText } from './StatusText';

type Settings = { revision: number; introPath: string; outroPath: string; useIntro: boolean; useOutro: boolean; transitionMode: string; transitionDuration: number };
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || '';
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

export function BookendControls() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
    const fileRefs = { intro: useRef<HTMLInputElement>(null), outro: useRef<HTMLInputElement>(null) };
    const clips = useStore(s => s.timelineClips);
    const present = { intro: clips.some(c => c.bookend === 'intro'), outro: clips.some(c => c.bookend === 'outro') };

    useEffect(() => {
        executeCommand('production_settings').then(setSettings)
            .catch(e => setMessage({ kind: 'error', text: humanizeError(String(e)).message }));
    }, []);
    // 選擇變更後自動存成預設（時間軸不變）
    const persist = async (next: Settings) => {
        setSettings(next);
        try {
            const saved = await executeCommand('set_production_settings', { ...next, expectedSettingsRevision: next.revision });
            setSettings(s => s ? { ...s, revision: saved.revision } : saved);
        } catch (e) { setMessage({ kind: 'error', text: humanizeError(String(e)).message }); }
    };
    if (!settings) return <div className="bookends">{message ? <StatusText kind={message.kind} text={message.text} /> : <p className="bookends-note">正在讀取片頭片尾設定…</p>}</div>;

    const pick = (role: 'intro' | 'outro', file: File) => {
        const label = role === 'intro' ? '片頭' : '片尾';
        setBusy(true); setMessage({ kind: 'info', text: `正在準備${label}影片…` });
        uploadBookend(file)
            .then(sel => { void persist({ ...settings, [`${role}Path`]: sel.path, [role === 'intro' ? 'useIntro' : 'useOutro']: true } as Settings); setMessage(null); })
            .catch(e => setMessage({ kind: 'error', text: humanizeError(String(e)).message }))
            .finally(() => setBusy(false));
    };
    const wanted = (['intro', 'outro'] as const).filter(r => (r === 'intro' ? settings.useIntro && settings.introPath : settings.useOutro && settings.outroPath) && !present[r]);

    const addToTimeline = async () => {
        setBusy(true); setMessage(null);
        try {
            const s = readState();
            const params = { ...settings, useIntro: wanted.includes('intro'), useOutro: wanted.includes('outro'),
                sessionId: s.sessionId, projectId: s.projectId, expectedRevision: s.revision };
            const draft = await executeCommand('prepare_bookends', params);
            await executeCommand('apply', { sessionId: draft.sessionId, projectId: draft.projectId,
                expectedRevision: draft.revision, dryRunId: draft.dryRunId, confirmed: true });
            setMessage({ kind: 'ok', text: `已加入時間軸：${fmt(draft.beforeDuration)} → ${fmt(draft.afterDuration)}，字幕跟著主片移動。按 Ctrl+Z 可整批復原。` });
        } catch (e) { setMessage({ kind: 'error', text: humanizeError(String(e)).message }); }
        finally { setBusy(false); }
    };

    return <div className="bookends" aria-busy={busy}>
        {(['intro', 'outro'] as const).map(role => {
            const label = role === 'intro' ? '片頭' : '片尾';
            const path = role === 'intro' ? settings.introPath : settings.outroPath;
            const use = role === 'intro' ? settings.useIntro : settings.useOutro;
            const useKey = role === 'intro' ? 'useIntro' : 'useOutro';
            return <div key={role} className="bookend-row">
                <label className="bookend-check">
                    <input type="checkbox" checked={use} disabled={busy || !path || present[role]}
                        onChange={e => void persist({ ...settings, [useKey]: e.target.checked } as Settings)} />
                    {label}
                </label>
                <span className="bookend-file" title={path}>{present[role] ? `已在時間軸上` : path ? fileName(path) : `尚未選擇${label}`}</span>
                <input ref={fileRefs[role]} type="file" hidden aria-label={`選擇${label}影片`} accept=".mp4,.mkv,.mov,.webm,.avi,.wmv"
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(role, f); }} />
                <button className="btn btn-sm" disabled={busy} onClick={() => fileRefs[role].current?.click()}>{path ? '更換…' : '選擇…'}</button>
            </div>;
        })}
        <div className="bookend-row">
            <label className="bookend-check" htmlFor="bookend-transition">轉場</label>
            <select id="bookend-transition" value={settings.transitionMode} disabled={busy}
                onChange={e => void persist({ ...settings, transitionMode: e.target.value })}>
                <option value="random">隨機柔和轉場</option><option value="fade-black">淡黑</option>
                <option value="fade-gray">柔灰</option><option value="fade-white">淡白</option><option value="none">直接切換</option>
            </select>
            <input aria-label="轉場秒數" type="number" min="0.2" max="1.5" step="0.1" value={settings.transitionDuration} disabled={busy || settings.transitionMode === 'none'}
                onChange={e => void persist({ ...settings, transitionDuration: Number(e.target.value) })} />
            <span className="bookends-note">秒</span>
        </div>
        <div className="bookend-actions">
            <button className="btn" disabled={busy || wanted.length === 0} onClick={addToTimeline}>
                {busy ? '處理中…' : wanted.length ? `把${wanted.map(r => r === 'intro' ? '片頭' : '片尾').join('和')}加入時間軸` : present.intro || present.outro ? '片頭片尾已在時間軸上' : '先選擇片頭或片尾'}
            </button>
            <span className="bookends-note">選擇會自動記住，下次直接用。</span>
        </div>
        {message && <StatusText kind={message.kind} text={message.text} />}
    </div>;
}
