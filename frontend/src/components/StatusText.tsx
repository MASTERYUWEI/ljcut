/* 狀態訊息：把舊訊息開頭的 ✅／❌／⚠️ 等 emoji 換成一致的圖示與狀態色（文案不變） */
import { CircleCheck, CircleAlert, TriangleAlert, Info } from 'lucide-react';

type Kind = 'ok' | 'error' | 'warn' | 'info';
const LEAD = /^\s*(✅|❌|⚠️|⚠|🎉|🔗|🎚️|✨|🔄)\s*/u;

export function statusKind(text: string): Kind {
    const m = text.match(LEAD)?.[1];
    if (m === '✅' || m === '🎉') return 'ok';
    if (m === '❌') return 'error';
    if (m === '⚠️' || m === '⚠') return 'warn';
    return 'info';
}

const ICON = { ok: CircleCheck, error: CircleAlert, warn: TriangleAlert, info: Info } as const;

export function StatusText({ text, kind, className = '' }: { text: string; kind?: Kind; className?: string }) {
    if (!text) return null;
    const k = kind ?? statusKind(text);
    const Icon = ICON[k];
    return <div className={`status-text status-${k} ${className}`} role={k === 'error' ? 'alert' : 'status'}>
        <Icon aria-hidden /><span>{text.replace(LEAD, '')}</span>
    </div>;
}
