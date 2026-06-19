/* ── 片段右鍵選單（分割 / 刪除 / 倍速）── */
import type { TimelineClip } from '../types';
import { formatTimestamp } from '../utils';

interface Props {
    clip: TimelineClip;
    x: number;
    y: number;
    canSplit: boolean;
    splitTime: number;
    onSplit: () => void;
    onDelete: () => void;
    onSetSpeed: (clipId: string, speed: number) => void;
    onClose: () => void;
}

export function SpeedMenu({ clip, x, y, canSplit, splitTime, onSplit, onDelete, onSetSpeed, onClose }: Props) {
    return (
        <div className="speed-menu-backdrop" onClick={onClose}>
            <div
                className="speed-menu"
                style={{
                    left: Math.min(x, window.innerWidth - 220),
                    top: Math.min(y, window.innerHeight - 200),
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    className="speed-preset-btn"
                    style={{ width: '100%', marginBottom: 10, opacity: canSplit ? 1 : 0.4, cursor: canSplit ? 'pointer' : 'not-allowed' }}
                    disabled={!canSplit}
                    title={canSplit ? '在播放線位置把此片段切成兩段' : '請先把播放線(時間軸游標)移到此片段中間'}
                    onClick={onSplit}
                >
                    {canSplit ? `✂️ 在播放線分割 (${formatTimestamp(splitTime)})` : '✂️ 分割（播放線不在此片段）'}
                </button>
                <button
                    className="speed-preset-btn"
                    style={{ width: '100%', marginBottom: 10, color: '#ff6b6b' }}
                    onClick={onDelete}
                    title="從時間軸刪除此片段"
                >
                    🗑️ 刪除片段
                </button>
                <div className="speed-menu-title">⚡ 影片速度</div>
                <div className="speed-menu-value">{clip.speed.toFixed(1)}x</div>
                <input type="range" className="speed-slider"
                    min={1} max={5} step={0.1}
                    value={clip.speed}
                    onChange={(e) => onSetSpeed(clip.id, parseFloat(e.target.value))} />
                <div className="speed-menu-labels">
                    <span>1x</span><span>2x</span><span>3x</span><span>4x</span><span>5x</span>
                </div>
                <div className="speed-menu-presets">
                    {[1, 1.5, 2, 3, 5].map(s => (
                        <button key={s}
                            className={`speed-preset-btn ${clip.speed === s ? 'active' : ''}`}
                            onClick={() => onSetSpeed(clip.id, s)}>{s}x</button>
                    ))}
                </div>
            </div>
        </div>
    );
}
