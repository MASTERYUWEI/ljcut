import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { dismissToast, subscribeToasts, type Toast } from '../toast';

const LABEL: Record<Toast['kind'], string> = { success: '完成', error: '錯誤', info: '提示' };

/** 右下角通知堆疊：成功／提示用 polite 播報，錯誤用 alert 角色立即播報 */
export default function Toaster() {
    const [list, setList] = useState<Toast[]>([]);
    const [copied, setCopied] = useState<number | null>(null);
    useEffect(() => subscribeToasts(setList), []);
    if (!list.length) return null;
    return (
        <div className="toaster" aria-live="polite">
            {list.map(t => (
                <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
                    <span className="toast-mark" aria-hidden="true" />
                    <div className="toast-body">
                        {t.kind !== 'info' && <span className="toast-kind">{LABEL[t.kind]}</span>}
                        <p className="toast-message">{t.message}</p>
                        {(t.actions?.length || t.kind === 'error') && (
                            <div className="toast-actions">
                                {t.actions?.map(a => (
                                    <button key={a.label} className="toast-btn" onClick={() => { a.run(); dismissToast(t.id); }}>{a.label}</button>
                                ))}
                                {t.kind === 'error' && (
                                    <button className="toast-btn" onClick={() => {
                                        void navigator.clipboard?.writeText(t.detail ?? t.message).then(() => { setCopied(t.id); setTimeout(() => setCopied(null), 1500); });
                                    }}>{copied === t.id ? '已複製' : '複製詳情'}</button>
                                )}
                            </div>
                        )}
                    </div>
                    <button className="toast-close" aria-label="關閉通知" onClick={() => dismissToast(t.id)}><X aria-hidden /></button>
                </div>
            ))}
        </div>
    );
}
