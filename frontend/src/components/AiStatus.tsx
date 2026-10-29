/* 標題列：AI 助理連線狀態＋最近一次動作（常駐，讓人隨時知道 AI 做過什麼） */
import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { aiActivity } from '../controlClient';
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
    useEffect(() => {
        const update = () => tick(n => n + 1);
        const onActivity = () => { update(); setTimeout(update, 10500); };   // 10 秒後取消「剛修改」的醒目樣式
        window.addEventListener('ljcut-ai-activity', onActivity);
        const timer = setInterval(update, 30000);
        return () => { window.removeEventListener('ljcut-ai-activity', onActivity); clearInterval(timer); };
    }, []);
    if (!workspace) return null;
    const recent = aiActivity.at && Date.now() - aiActivity.at < 10000;
    return <span className={`ai-status ${recent ? 'recent' : ''}`} role="status"
        title={aiActivity.text ? `最近一次：${aiActivity.text}（${ago(Date.now() - aiActivity.at)}）。AI 的每個修改都可按 Ctrl+Z 復原。` : 'AI 助理可以透過本機控制剪輯這個專案；修改後會在這裡顯示，並可用 Ctrl+Z 復原。'}>
        <span className="ai-dot" aria-hidden /><Bot aria-hidden />
        {aiActivity.text ? <span className="ai-status-text">{aiActivity.text} · {ago(Date.now() - aiActivity.at)}</span> : <span className="ai-status-text">AI 助理已連線</span>}
    </span>;
}
