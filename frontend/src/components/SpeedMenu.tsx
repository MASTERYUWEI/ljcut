/* ── 片段右鍵選單（分割 / 刪除 / 倍速）── */
import { Scissors, Trash2, Gauge } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
    const boxRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const prev = document.activeElement as HTMLElement | null;
        boxRef.current?.querySelector<HTMLElement>('button:not([disabled]), input')?.focus();
        return () => { if (prev?.isConnected) prev.focus(); };       // 關閉後焦點回到片段
    }, []);
    return (
        <div className="speed-menu-backdrop" onClick={onClose}>
            <div
                className="speed-menu"
                ref={boxRef}
                role="dialog"
                aria-label="片段選單：分割、刪除、速度"
                onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
                    if (e.key !== 'Tab') return;                       // Tab 只在選單內循環
                    const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input') ?? []);
                    if (!items.length) return;
                    const i = items.indexOf(document.activeElement as HTMLElement);
                    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
                    e.preventDefault(); items[next].focus();
                }}
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
                    <Scissors aria-hidden /> {canSplit ? `在播放線分割（${formatTimestamp(splitTime)}）　S` : '分割（播放線不在此片段）'}
                </button>
                <button
                    className="speed-preset-btn"
                    style={{ width: '100%', marginBottom: 10, color: 'var(--danger)' }}
                    onClick={onDelete}
                    title="從時間軸刪除此片段"
                >
                    <Trash2 aria-hidden /> 刪除片段　Delete
                </button>
                <div className="speed-menu-title"><Gauge aria-hidden /> 影片速度</div>
                <div className="speed-menu-value">{clip.speed.toFixed(1)}x</div>
                <input type="range" className="speed-slider" aria-label="影片速度"
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
