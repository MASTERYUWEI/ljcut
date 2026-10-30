/* 標題列：AI 助理連線狀態＋最近動作；點開看本次的 AI 修改紀錄 */
import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { aiActivity } from '../controlClient';
import { history, requestPreview, undo } from '../editSession';
import { toast } from '../toast';
import { useControlWorkspace } from './ProjectControl';

function ago(ms: number) {
    const s = Math.round(ms / 1000);
    if (s < 60) return '剛剛';
    if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
    return `${Math.floor(s / 3600)} 小時前`;
}

export function AiStatus() {
    const workspace = useControlWorkspace();
    const [, tick] = useState(0);
    const [open, setOpen] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const update = () => tick(n => n + 1);
        const onActivity = () => { update(); setTimeout(update, 10500); };   // 10 秒後取消「剛修改」的醒目樣式
        window.addEventListener('ljcut-ai-activity', onActivity);
        const timer = setInterval(update, 30000);
        return () => { window.removeEventListener('ljcut-ai-activity', onActivity); clearInterval(timer); };
    }, []);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey, true);
        return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
    }, [open]);
    if (!workspace) return null;
    const recent = aiActivity.at && Date.now() - aiActivity.at < 10000;
    const active = aiActivity.lastCommandAt && Date.now() - aiActivity.lastCommandAt < 5 * 60000;   // 5 分鐘內有收到 AI 命令
    const summary = aiActivity.text ? `${aiActivity.text} · ${ago(Date.now() - aiActivity.at)}` : 'AI 助理待命中';
    return <div className="ai-status-wrap" ref={boxRef}>
        <button className={`ai-status ${recent ? 'recent' : ''} ${active ? 'active' : ''}`} aria-expanded={open} onClick={() => setOpen(o => !o)}
            title="AI 助理的修改紀錄（每個修改都可按 Ctrl+Z 復原）">
            <span className="ai-dot" aria-hidden /><Bot aria-hidden />
            <span className="ai-status-text">{summary}</span>
            <span className="ai-status-short" aria-hidden>{aiActivity.edits ? `AI 改了 ${aiActivity.edits} 次` : active ? 'AI 連線中' : 'AI 待命'}</span>
        </button>
        <span className="sr-only" role="status">{aiActivity.text ? summary : ''}</span>
        {open && <div className="ai-log" role="dialog" aria-label="AI 助理修改紀錄">
            <p className="ai-log-head">{active ? 'AI 助理最近有在操作這個專案。' : '目前沒有 AI 助理在操作（在 AI 助理的對話裡請它剪輯就會連上）。'}每個修改都是一筆復原，按 Ctrl+Z 可退回。</p>
            {aiActivity.log.length === 0 ? <p className="ai-log-empty">這次開啟後，AI 還沒有修改過專案。</p>
                : <ol className="ai-log-list">{aiActivity.log.map(item => (
                    <li key={item.at}>
                        <div className="ai-log-row"><strong>{item.text}</strong><span>{ago(Date.now() - item.at)}</span></div>
                        {item.details.length > 0 && <ul>{item.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
                        {(item.jump !== undefined || item.depth) && <div className="ai-log-actions">
                            {item.jump !== undefined && <button className="btn btn-sm" onClick={() => { try { requestPreview(Math.max(0, item.jump!)); } catch { /* 超出範圍 */ } }}>跳到這裡</button>}
                            {item.depth !== undefined && (() => {
                                const steps = history().depth - item.depth + 1;
                                if (item.depth > history().depth || steps < 1) return <span className="ai-log-undone">已復原</span>;
                                return <button className="btn btn-sm" title={`連按 ${steps} 次 Ctrl+Z，回到 AI 做這步之前（之後的修改也會一起退回，可再重做）`}
                                    onClick={() => { for (let i = 0; i < steps; i++) undo(); toast('info', `已退回 ${steps} 步，回到「${item.text}」之前；可按 Ctrl+Shift+Z 重做`, undefined, { key: 'history' }); tick(n => n + 1); }}>
                                    退回到這步之前{steps > 1 ? `（${steps} 步）` : ''}</button>;
                            })()}
                        </div>}
                    </li>
                ))}</ol>}
        </div>}
    </div>;
}
