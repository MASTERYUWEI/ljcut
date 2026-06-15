/* ── 匯出進度框 ── */
interface Props {
    progress: number;
}

export function ExportProgress({ progress }: Props) {
    return (
        <div className="export-progress-backdrop">
            <div className="export-progress-modal">
                <div className="export-progress-title">🎬 匯出影片中...</div>
                <div className="export-progress-bar-track">
                    <div className="export-progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="export-progress-pct">{progress}%</div>
                {progress >= 100 && <div className="export-progress-done">✅ 完成！</div>}
            </div>
        </div>
    );
}
