/* 左欄「配樂」：選一首配樂鋪滿整段影片，有旁白（字幕）時自動壓低。
   每個改動都是一筆可復原的修改（拖拉滑桿時只在按下那一刻記一筆）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Music, X } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { pushUndo } from '../editSession';
import { humanizeError } from '../toast';
import { newMusic, speechSpans, type MusicTrack } from '../audioMix';
import { StatusText } from './StatusText';

const db = (v: number) => v <= 0 ? '靜音' : `${(20 * Math.log10(v)).toFixed(0)} dB`;

export function MusicControls() {
    const mix = useStore(s => s.audioMix);
    const setMix = useStore(s => s.setAudioMix);
    const clips = useStore(s => s.timelineClips);
    const music = mix.music;
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const spans = useMemo(() => speechSpans(clips), [clips]);

    const patch = (p: Partial<MusicTrack>, record = true) => {
        if (!music) return;
        if (record) pushUndo('調整配樂');
        setMix({ music: { ...music, ...p } });
    };
    const pick = async (file: File) => {
        setBusy(true); setMsg({ kind: 'info', text: '正在匯入配樂…' });
        try {
            const a: any = await api.uploadAsset(file);
            if (a.type !== 'audio') throw new Error('請選音樂檔（MP3／WAV／M4A／FLAC／OGG）');
            pushUndo(music ? '更換配樂' : '加入配樂');
            setMix({ music: music ? { ...music, asset: { id: a.id, filename: a.filename, url: a.url, duration: a.duration } }
                : newMusic({ id: a.id, filename: a.filename, url: a.url, duration: a.duration }) });
            setMsg({ kind: 'ok', text: `已加入配樂（${Math.round(a.duration)} 秒）` });
        } catch (e) { setMsg({ kind: 'error', text: humanizeError(String(e instanceof Error ? e.message : e)).message }); }
        finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
    };
    useEffect(() => { if (msg?.kind === 'ok') { const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); } }, [msg]);

    return <div className="music-controls">
        <input ref={fileRef} type="file" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void pick(f); }} />
        {!music ? <>
            <p className="bookends-note">配樂會鋪滿整段影片；有字幕（旁白）的地方自動降低音量，預覽和匯出聽起來一樣。</p>
            <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}><Music aria-hidden />選擇配樂…</button>
        </> : <>
            <div className="music-file">
                <Music aria-hidden /><span title={music.asset.filename}>{music.asset.filename}</span>
                <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>更換</button>
                <button className="btn btn-icon btn-sm" aria-label="移除配樂" title="移除配樂（可 Ctrl+Z 復原）"
                    onClick={() => { pushUndo('移除配樂'); setMix({ music: undefined }); }}><X aria-hidden /></button>
            </div>
            <label className="music-row"><span className="music-key">音量</span>
                <input type="range" min={0} max={1} step={0.01} value={music.volume}
                    onPointerDown={() => pushUndo('調整配樂音量')} onKeyDown={() => pushUndo('調整配樂音量')}
                    onChange={e => patch({ volume: Number(e.target.value) }, false)} />
                <span className="music-val">{db(music.volume)}</span>
            </label>
            <label className="music-row music-check">
                <input type="checkbox" checked={music.duck} onChange={e => patch({ duck: e.target.checked })} />
                <span>旁白時自動降低配樂</span>
            </label>
            {music.duck && <label className="music-row"><span className="music-key">降低</span>
                <input type="range" min={3} max={30} step={1} value={music.duckDb}
                    onPointerDown={() => pushUndo('調整壓低量')} onKeyDown={() => pushUndo('調整壓低量')}
                    onChange={e => patch({ duckDb: Number(e.target.value) }, false)} />
                <span className="music-val">−{music.duckDb} dB</span>
            </label>}
            {music.duck && <p className="bookends-note">{spans.length ? `依字幕找到 ${spans.length} 段旁白，時間軸配樂列的暗色區塊就是會降低的地方。` : '還沒有字幕，所以不會降低；先做語音辨識。'}</p>}
            <label className="music-row music-check">
                <input type="checkbox" checked={music.loop} onChange={e => patch({ loop: e.target.checked })} />
                <span>配樂比影片短時循環播放</span>
            </label>
            <label className="music-row" title="從配樂的第幾秒開始播（可以跳過前奏）"><span className="music-key">開始</span>
                <input className="st-input music-num" type="number" min={0} max={Math.max(0, Math.floor(music.asset.duration - 1))} step={0.5} value={music.offset}
                    onChange={e => patch({ offset: Math.max(0, Number(e.target.value) || 0) })} />
                <span className="music-val">秒</span>
            </label>
            <label className="music-row"><span className="music-key">淡出</span>
                <input className="st-input music-num" type="number" min={0} max={30} step={0.5} value={music.fadeOut}
                    onChange={e => patch({ fadeOut: Math.min(30, Math.max(0, Number(e.target.value) || 0)) })} />
                <span className="music-val">秒</span>
            </label>
        </>}
        {msg && <StatusText kind={msg.kind} text={msg.text} />}
    </div>;
}
