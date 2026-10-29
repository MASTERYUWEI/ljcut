/* ── 匯出進度框 ── */
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, FolderOpen, Upload } from 'lucide-react';
import { useDialog } from '../useDialog';

interface Props {
    progress: number;
    etaSeconds?: number | null;
    stage?: string;
    onCancel?: () => void;
    /** 匯出完成後的摘要；有值時顯示完成畫面 */
    done?: { path: string; duration: string; subs: number; burned: boolean };
    onClose?: () => void;
    onOpenFolder?: () => void;
    onUpload?: () => void;
}

function fmtEta(s: number): string {
    if (s < 60) return `約 ${s} 秒`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `約 ${m} 分 ${sec.toString().padStart(2, '0')} 秒`;
}

export function ExportProgress({ progress, etaSeconds, stage, onCancel, done, onClose, onOpenFolder, onUpload }: Props) {
    const [cancelling, setCancelling] = useState(false);
    const [copied, setCopied] = useState(false);
    const firstBtn = useRef<HTMLButtonElement>(null);
    const doneRef = useRef<HTMLDivElement>(null);
    useDialog(doneRef, !!done);
    useEffect(() => {
        if (!done) return;
        firstBtn.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [done, onClose]);
    if (done) {
        const name = done.path.replace(/\\/g, '/').split('/').pop();
        return (
            <div className="export-progress-backdrop" onClick={onClose}>
                <div className="export-progress-modal export-done" ref={doneRef} role="dialog" aria-modal="true" aria-labelledby="export-done-title" onClick={e => e.stopPropagation()}>
                    <CircleCheck className="export-done-icon" aria-hidden />
                    <h2 id="export-done-title" className="export-progress-title">影片匯出完成</h2>
                    <p className="export-done-name" title={done.path}>{name}</p>
                    <p className="export-done-meta">長度 {done.duration} · {done.subs ? (done.burned ? `字幕已燒進畫面（${done.subs} 句）` : `另附 SRT 字幕 ${done.subs} 句（同一個資料夾、同檔名）`) : '沒有字幕'}</p>
                    <button className="link-btn export-done-copy" onClick={() => { void navigator.clipboard.writeText(done.path).then(() => setCopied(true)); }}>{copied ? '已複製路徑' : '複製檔案路徑'}</button>
                    <div className="export-done-actions">
                        <button ref={firstBtn} className="btn btn-primary" onClick={onUpload}><Upload aria-hidden />上傳到 YouTube</button>
                        {(window as any).__TAURI_INTERNALS__ && <button className="btn" onClick={onOpenFolder}><FolderOpen aria-hidden />開啟資料夾</button>}
                        <button className="btn" onClick={onClose}>完成</button>
                    </div>
                </div>
            </div>
        );
    }
    return (
        <div className="export-progress-dock" role="region" aria-label="匯出進度">
            <div className="export-progress-modal">
                <div className="export-progress-title" role="status">匯出影片中… <span className="export-dock-note">可以繼續校稿；之後的修改不會進這支成品</span></div>
                <div className="export-progress-bar-track">
                    <div className="export-progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="export-progress-pct">{progress}%</div>
                {progress < 100 && (
                    <div style={{ fontSize: 12, color: 'var(--fg-subtext0)', marginTop: 6, textAlign: 'center' }}>
                        {stage ? `${stage} · ` : ''}
                        {etaSeconds != null ? `預估剩餘 ${fmtEta(etaSeconds)}` : '預估剩餘時間計算中…'}
                    </div>
                )}
                {progress >= 100 && <div className="export-progress-done">完成</div>}
                {progress < 100 && onCancel && (
                    <button className="btn" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }} disabled={cancelling}
                        onClick={() => { setCancelling(true); onCancel(); }}>
                        {cancelling ? '取消中…' : '取消匯出'}
                    </button>
                )}
            </div>
        </div>
    );
}
