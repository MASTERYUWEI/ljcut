/* ── 配音修正：逐句聽 AI 旁白 → 標記語調錯 → 錄正確版本 ──
   標完、錄完後由 Claude 批次重訓聲音模型、成品改用真人錄音（腳本在 文件\LJCUT 專案\配音\tools\）。 */
import { X, Play, Square, Mic, ThumbsUp, ThumbsDown, Trash2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialog } from '../useDialog';
import { notify } from '../toast';
import { voiceApi, type VoiceItem, type VoiceCounts, type VoiceSessionInfo, type VoiceStatus } from '../voiceApi';

type Filter = 'all' | 'pending' | 'bad' | 'recorded';
const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' }, { key: 'pending', label: '還沒聽' }, { key: 'bad', label: '語調錯' }, { key: 'recorded', label: '已錄' },
];
const MIC_KEY = 'ljcut.voiceMic';
const SESSION_KEY = 'ljcut.voiceSession';
const readLS = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 記不住不影響 */ } };

export function VoiceReviewModal({ onClose }: { onClose: () => void }) {
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialog(dialogRef);

    const [sessions, setSessions] = useState<VoiceSessionInfo[]>([]);
    const [root, setRoot] = useState('');
    const [session, setSession] = useState(readLS(SESSION_KEY));
    const [items, setItems] = useState<VoiceItem[]>([]);
    const [counts, setCounts] = useState<VoiceCounts | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const [devices, setDevices] = useState<string[]>([]);
    const [mic, setMic] = useState(readLS(MIC_KEY));
    const [recId, setRecId] = useState<string | null>(null);
    const [recSec, setRecSec] = useState(0);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [playing, setPlaying] = useState<string | null>(null); // `${kind}:${id}`
    const [ver, setVer] = useState<Record<string, number>>({});
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // ── 載入清單與麥克風 ──
    const loadSessions = useCallback(async () => {
        try {
            const r = await voiceApi.sessions();
            setSessions(r.sessions); setRoot(r.root);
            setSession(cur => (cur && r.sessions.some(s => s.name === cur)) ? cur : (r.sessions[0]?.name ?? ''));
            if (!r.sessions.length) setLoading(false);
        } catch (e) { setError(`讀不到配音清單：${e instanceof Error ? e.message : e}`); setLoading(false); }
    }, []);
    useEffect(() => { loadSessions(); }, [loadSessions]);
    useEffect(() => {
        voiceApi.devices().then(r => {
            setDevices(r.devices);
            setMic(cur => (cur && r.devices.includes(cur)) ? cur : (r.devices[0] ?? ''));
        }).catch(() => setDevices([]));
    }, []);
    useEffect(() => { if (mic) writeLS(MIC_KEY, mic); }, [mic]);

    useEffect(() => {
        if (!session) return;
        writeLS(SESSION_KEY, session);
        setLoading(true); setError('');
        voiceApi.session(session)
            .then(r => { setItems(r.items); setCounts(r.counts); })
            .catch(e => setError(`讀不到這一集：${e instanceof Error ? e.message : e}`))
            .finally(() => setLoading(false));
    }, [session]);

    // ── 播放（同時只播一個）──
    const stopAudio = () => { audioRef.current?.pause(); audioRef.current = null; setPlaying(null); };
    const play = (kind: 'ai' | 'takes', id: string) => {
        const key = `${kind}:${id}`;
        if (playing === key) { stopAudio(); return; }
        stopAudio();
        const a = new Audio(voiceApi.audioUrl(session, kind, id, ver[id] ?? 0));
        a.onended = () => { if (audioRef.current === a) { audioRef.current = null; setPlaying(null); } };
        a.onerror = () => { notify('音檔播放失敗'); setPlaying(null); };
        audioRef.current = a; setPlaying(key);
        a.play().catch(() => setPlaying(null));
    };
    useEffect(() => () => { audioRef.current?.pause(); }, []);

    const applyItem = (it: VoiceItem, c?: VoiceCounts) => {
        setItems(list => list.map(x => x.id === it.id ? it : x));
        if (c) setCounts(c);
    };

    // ── 標記 ──
    const mark = async (it: VoiceItem, status: VoiceStatus) => {
        const next: VoiceStatus = it.status === status ? 'pending' : status;
        try { const r = await voiceApi.mark(session, it.id, next); applyItem(r.item, r.counts); }
        catch (e) { notify(`標記失敗：${e instanceof Error ? e.message : e}`); }
    };
    const saveNote = async (it: VoiceItem, note: string) => {
        if ((it.note ?? '') === note) return;
        try { const r = await voiceApi.mark(session, it.id, it.status, note); applyItem(r.item, r.counts); }
        catch (e) { notify(`說明沒存到：${e instanceof Error ? e.message : e}`); }
    };

    // ── 錄音 ──
    useEffect(() => {
        if (!recId) return;
        const t0 = Date.now();
        const timer = window.setInterval(() => setRecSec((Date.now() - t0) / 1000), 200);
        return () => window.clearInterval(timer);
    }, [recId]);
    const startRec = async (it: VoiceItem) => {
        if (!mic) { notify('請先在上方選麥克風'); return; }
        stopAudio();
        setBusyId(it.id);
        try { await voiceApi.recordStart(session, it.id, mic); setRecSec(0); setRecId(it.id); }
        catch (e) { notify(`開始錄音失敗：${e instanceof Error ? e.message : e}`); }
        finally { setBusyId(null); }
    };
    const stopRec = async (discard = false) => {
        const id = recId;
        if (!id) return;
        setRecId(null); setBusyId(id);
        try {
            const r = await voiceApi.recordStop(discard);
            if (r.item) { applyItem(r.item, r.counts); setVer(v => ({ ...v, [id]: Date.now() })); }
        } catch (e) { notify(`錄音沒存到：${e instanceof Error ? e.message : e}`); }
        finally { setBusyId(null); }
    };
    const deleteTake = async (it: VoiceItem) => {
        try { const r = await voiceApi.deleteTake(session, it.id); applyItem(r.item, r.counts); }
        catch (e) { notify(`刪除失敗：${e instanceof Error ? e.message : e}`); }
    };
    // 關閉視窗時若還在錄，直接丟掉
    const close = () => { if (recId) voiceApi.recordStop(true).catch(() => { }); stopAudio(); onClose(); };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const shown = items.filter(it =>
        filter === 'all' ? true : filter === 'pending' ? it.status === 'pending' : filter === 'bad' ? it.status === 'bad' : !!it.take);
    let lastSeg = '';

    return (
        <div className="modal-overlay" onClick={close}>
            <div className="modal-box voice-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="voice-title" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 id="voice-title">配音修正</h2>
                    <button className="btn" onClick={close} style={{ padding: '4px 6px' }} aria-label="關閉" title="關閉（Esc）"><X aria-hidden /></button>
                </div>

                <div className="voice-toolbar">
                    <label className="voice-field">
                        <span>集數</span>
                        <select value={session} onChange={e => setSession(e.target.value)} disabled={!!recId || !sessions.length}>
                            {!sessions.length && <option value="">（還沒有配音清單）</option>}
                            {sessions.map(s => <option key={s.name} value={s.name}>{s.title}</option>)}
                        </select>
                    </label>
                    <label className="voice-field">
                        <span>麥克風</span>
                        <select value={mic} onChange={e => setMic(e.target.value)} disabled={!!recId}>
                            {!devices.length && <option value="">（找不到麥克風）</option>}
                            {devices.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </label>
                    <button className="btn btn-icon" onClick={loadSessions} disabled={!!recId} title="重新整理清單" aria-label="重新整理清單"><RefreshCw aria-hidden /></button>
                </div>

                {counts && (
                    <div className="voice-filters" role="tablist" aria-label="篩選句子">
                        {FILTERS.map(f => {
                            const n = f.key === 'all' ? counts.total : f.key === 'pending' ? counts.total - counts.ok - counts.bad : f.key === 'bad' ? counts.bad : counts.recorded;
                            return <button key={f.key} role="tab" aria-selected={filter === f.key} className={`voice-chip ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>{f.label} <span className="voice-chip-n">{n}</span></button>;
                        })}
                    </div>
                )}

                {error && <p className="voice-msg voice-error">{error}</p>}
                {!error && !loading && !sessions.length && (
                    <p className="voice-msg">還沒有配音清單。請 Claude 先產生某一集的逐句配音，會放在：<br /><code>{root}</code></p>
                )}
                {loading && sessions.length > 0 && <p className="voice-msg">載入中…</p>}

                {!loading && !error && items.length > 0 && (
                    <ol className="voice-list">
                        {shown.map(it => {
                            const segHead = it.seg !== lastSeg ? (lastSeg = it.seg) : null;
                            const isRec = recId === it.id;
                            return (
                                <li key={it.id} className={`voice-row st-${it.status} ${isRec ? 'recording' : ''}`}>
                                    {segHead && <div className="voice-seg">{segHead}</div>}
                                    <div className="voice-line">
                                        <button className={`voice-play ${playing === `ai:${it.id}` ? 'on' : ''}`} onClick={() => play('ai', it.id)} disabled={!!recId}
                                            aria-label={`播放 AI 版本：${it.text}`} title="播放 AI 版本">{playing === `ai:${it.id}` ? <Square aria-hidden /> : <Play aria-hidden />}</button>
                                        <p className="voice-text">{it.text}</p>
                                        <div className="voice-acts">
                                            <button className={`voice-btn good ${it.status === 'ok' ? 'on' : ''}`} onClick={() => mark(it, 'ok')} disabled={!!recId}
                                                aria-pressed={it.status === 'ok'} title="這句可以"><ThumbsUp aria-hidden /><span>可以</span></button>
                                            <button className={`voice-btn bad ${it.status === 'bad' ? 'on' : ''}`} onClick={() => mark(it, 'bad')} disabled={!!recId}
                                                aria-pressed={it.status === 'bad'} title="語調不對"><ThumbsDown aria-hidden /><span>語調錯</span></button>
                                        </div>
                                    </div>
                                    {(it.status === 'bad' || it.take || isRec) && (
                                        <div className="voice-fix">
                                            <input className="voice-note" defaultValue={it.note ?? ''} placeholder="哪裡不對？例如：句尾要往上、BIM 念錯、太平"
                                                aria-label="說明哪裡不對" onBlur={e => saveNote(it, e.target.value.trim())}
                                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                                            {isRec ? (<>
                                                <button className="voice-btn rec on" onClick={() => stopRec(false)} title="停止並存檔"><Square aria-hidden /><span>停止 {recSec.toFixed(1)}s</span></button>
                                                <button className="voice-btn" onClick={() => stopRec(true)} title="不要這次錄音">取消</button>
                                            </>) : (
                                                <button className="voice-btn rec" onClick={() => startRec(it)} disabled={!!recId || busyId === it.id}
                                                    title={it.take ? '重錄' : '照正確語調念一次'}><Mic aria-hidden /><span>{it.take ? '重錄' : '錄正確版'}</span></button>
                                            )}
                                            {it.take && !isRec && (<>
                                                <button className={`voice-btn ${playing === `takes:${it.id}` ? 'on' : ''}`} onClick={() => play('takes', it.id)} disabled={!!recId}
                                                    title="播放我的錄音">{playing === `takes:${it.id}` ? <Square aria-hidden /> : <Play aria-hidden />}<span>我的 {it.take_seconds?.toFixed(1)}s</span></button>
                                                <button className="voice-btn" onClick={() => deleteTake(it)} disabled={!!recId} title="刪掉我的錄音" aria-label="刪掉我的錄音"><Trash2 aria-hidden /></button>
                                            </>)}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                        {!shown.length && <li className="voice-msg">這個篩選沒有句子。</li>}
                    </ol>
                )}

                <p className="voice-foot">標完、錄完後回到 Claude 說一聲，會用你的錄音重新訓練聲音，再重新生成整集。錄音時用平常錄稿的語氣，頭尾靜音會自動裁掉。</p>
            </div>
        </div>
    );
}
