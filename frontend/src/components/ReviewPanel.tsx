import { useEffect, useMemo, useRef, useState } from 'react';
import { Flag, RefreshCw, Trash2 } from 'lucide-react';
import type { MediaItem, TimelineClip } from '../types';
import { flattenNotes, fmtTime, parseTime, REVIEW_CATS, REVIEW_STATUS_LABEL, timelineToSource, type ReviewCat, type ReviewStatus } from '../review';

/** 右欄「審片」分頁：在播放頭記一句要改什麼；清單依時間排序，點時間跳過去。
 *  所有修改走 dry-run → apply（onOps），一次操作＝一筆 undo，AI 也是用同一組操作讀寫。 */
export default function ReviewPanel({ media, clips, currentTime, onSeek, onOps, focusSignal }: {
    media: MediaItem[];
    clips: TimelineClip[];
    currentTime: number;
    onSeek: (t: number) => void;
    onOps: (ops: Record<string, unknown>[], what: string) => unknown;
    /** 每次變動就把焦點移到輸入框（快捷鍵 N） */
    focusSignal: number;
}) {
    const [cat, setCat] = useState<ReviewCat>('畫面');
    const [text, setText] = useState('');
    const [time, setTime] = useState('');
    const [filter, setFilter] = useState<'open' | 'all'>('open');
    const [paste, setPaste] = useState<string | null>(null);
    const [msg, setMsg] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const textRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { if (focusSignal) { setTime(''); textRef.current?.focus(); } }, [focusSignal]);

    const notes = useMemo(() => flattenNotes(media, clips), [media, clips]);
    const open = notes.filter(n => n.status === 'open').length;
    const shown = filter === 'all' ? notes : notes.filter(n => n.status === 'open');

    const add = () => {
        const t = time.trim() ? parseTime(time) : currentTime;
        if (t === null) { setMsg('時間格式像 1:23'); return; }
        if (!text.trim()) { setMsg('寫一句要改什麼'); textRef.current?.focus(); return; }
        if (!timelineToSource(clips, t)) { setMsg('時間軸上還沒有片段'); return; }
        const r = onOps([{ type: 'add_note', timelineTime: t, cat, text: text.trim(), by: 'user' }], '加入審片意見');
        if (r) { setText(''); setTime(''); setMsg(`已記在 ${fmtTime(t)}`); }
    };
    const cycle = (id: string, s: ReviewStatus) => {
        const next: ReviewStatus = s === 'open' ? 'fixed' : s === 'fixed' ? 'skip' : 'open';
        onOps([{ type: 'edit_note', noteId: id, status: next }], `審片意見改成「${REVIEW_STATUS_LABEL[next]}」`);
    };
    /** 一次貼上多行：「1:23 字幕 這裡少一個字」或「1:23 這裡畫面空白」（類型可省略） */
    const importPaste = () => {
        const ops: Record<string, unknown>[] = [];
        const bad: string[] = [];
        for (const line of (paste ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
            const m = line.match(/^(\d{1,2}[:：.]\d{2}(?:[:：.]\d{2})?|\d+)\s*[-–—、,，]?\s*(.+)$/);
            const t = m ? parseTime(m[1]) : null;
            if (!m || t === null || !timelineToSource(clips, t)) { bad.push(line); continue; }
            let body = m[2].trim();
            const c = REVIEW_CATS.find(c => body.startsWith(c));
            if (c) body = body.slice(c.length).replace(/^[\s:：、]+/, '');
            if (body) ops.push({ type: 'add_note', timelineTime: t, cat: c ?? '其他', text: body, by: 'phone' });
        }
        if (!ops.length) { setMsg('沒有讀到「分:秒 意見」格式的行'); return; }
        if (onOps(ops, `匯入 ${ops.length} 條審片意見`)) {
            setPaste(null);
            setMsg(`已匯入 ${ops.length} 條${bad.length ? `，${bad.length} 行看不懂：${bad.slice(0, 2).join('／')}` : ''}`);
        }
    };

    return <div className="review-panel">
        <div className="subtitle-header">
            <h2>審片意見</h2>
            <span className="review-count">{notes.length ? `未處理 ${open}／共 ${notes.length}` : ''}</span>
        </div>
        <div className="review-form">
            <div className="review-form-row">
                <span className="review-label">時間</span>
                <input className="st-input review-time" aria-label="時間（分:秒，空白＝播放頭）" placeholder={`${fmtTime(currentTime)} 播放頭`}
                    value={time} onChange={e => setTime(e.target.value)} inputMode="decimal" />
            </div>
            <div className="review-form-row">
                <span className="review-label">類型</span>
                <div className="review-cats" role="group" aria-label="類型">
                    {REVIEW_CATS.map(c => <button key={c} type="button" className={`review-cat ${c === cat ? 'on' : ''}`} aria-pressed={c === cat} onClick={() => setCat(c)}>{c}</button>)}
                </div>
            </div>
            <textarea ref={textRef} className="st-input" rows={2} aria-label="要改什麼" placeholder="要改什麼（Ctrl+Enter 加入；時間空白就記在播放頭）"
                value={text} onChange={e => setText(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }} />
            <div className="review-form-row">
                <button className="btn btn-accent btn-sm" onClick={add}><Flag aria-hidden />加入</button>
                <button className="btn btn-sm" onClick={() => setPaste(p => p === null ? '' : null)} aria-expanded={paste !== null}>一次貼上多條</button>
                <span className="review-msg" role="status">{msg}</span>
            </div>
            {paste !== null && <div className="review-paste">
                <textarea className="st-input" rows={4} value={paste} onChange={e => setPaste(e.target.value)}
                    onKeyDown={e => e.stopPropagation()}
                    aria-label="一行一條：分:秒 類型 意見" placeholder={'一行一條，例如：\n1:23 字幕 「篩選器」介面上叫「篩選」\n2:05 這裡畫面空白還在唸'} />
                <button className="btn btn-sm" onClick={importPaste} disabled={!paste.trim()}>匯入</button>
            </div>}
        </div>
        <div className="review-filter" role="group" aria-label="篩選">
            <button className={`btn btn-sm ${filter === 'open' ? 'on' : ''}`} aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>未處理</button>
            <button className={`btn btn-sm ${filter === 'all' ? 'on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
        </div>
        <ul className="review-list" aria-label="審片意見清單">
            {!shown.length && <li className="review-empty">{notes.length ? '沒有未處理的意見' : '看片時按 N，在播放頭記一句要改什麼。AI 也能讀這份清單去改。'}</li>}
            {shown.map(n => <li key={n.id} className={`review-item ${n.status}`}>
                <button className="review-tc" disabled={n.tl === null} onClick={() => n.tl !== null && onSeek(n.tl)}
                    title={n.tl === null ? '這個時間點已經被剪掉' : '跳到這裡'}>{n.tl === null ? '已剪掉' : fmtTime(n.tl)}</button>
                <div className="review-body">
                    <div className="review-top">
                        <span className="review-tag">{n.cat}</span>
                        <button className={`review-status ${n.status}`} onClick={() => cycle(n.id, n.status)} title="點一下切換：未處理 → 已改 → 不改" aria-label={`狀態：${REVIEW_STATUS_LABEL[n.status]}，點一下切換`}>{REVIEW_STATUS_LABEL[n.status]}<RefreshCw aria-hidden className="review-cycle" /></button>
                        {n.by === 'ai' && <span className="review-by">AI 記</span>}
                        {n.by === 'phone' && <span className="review-by">手機</span>}
                        <span className="review-spacer" />
                        {confirmId === n.id
                            ? <span className="review-confirm">刪掉？<button className="btn btn-sm" onClick={() => { setConfirmId(null); onOps([{ type: 'delete_note', noteId: n.id }], '刪除審片意見'); }}>刪除</button>
                                <button className="btn btn-sm" onClick={() => setConfirmId(null)}>取消</button></span>
                            : <button className="btn btn-icon btn-sm" aria-label="刪除這條意見" onClick={() => setConfirmId(n.id)}><Trash2 aria-hidden /></button>}
                    </div>
                    <div className="review-text">{n.text}</div>
                    {n.reply && <div className="review-reply">處理：{n.reply}</div>}
                </div>
            </li>)}
        </ul>
    </div>;
}
