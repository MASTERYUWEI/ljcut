/* ── 片段倍速右鍵選單 ── */
import type { TimelineClip } from '../types';

interface Props {
    clip: TimelineClip;
    x: number;
    y: number;
    onSetSpeed: (clipId: string, speed: number) => void;
    onClose: () => void;
}

export function SpeedMenu({ clip, x, y, onSetSpeed, onClose }: Props) {
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
