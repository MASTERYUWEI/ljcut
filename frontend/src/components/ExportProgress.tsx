/* ── 匯出進度框 ── */
import { useState } from 'react';

interface Props {
    progress: number;
    etaSeconds?: number | null;
    stage?: string;
    onCancel?: () => void;
}

function fmtEta(s: number): string {
    if (s < 60) return `約 ${s} 秒`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `約 ${m} 分 ${sec.toString().padStart(2, '0')} 秒`;
}

export function ExportProgress({ progress, etaSeconds, stage, onCancel }: Props) {
    const [cancelling, setCancelling] = useState(false);
    return (
        <div className="export-progress-backdrop">
            <div className="export-progress-modal">
                <div className="export-progress-title" role="status">匯出影片中…</div>
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
