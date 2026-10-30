/* ── 片段右鍵選單（分割 / 刪除 / 倍速）── */
import { Scissors, Trash2, Gauge } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
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
    onlyClip?: boolean;
}

export function SpeedMenu({ clip, x, y, canSplit, splitTime, onSplit, onDelete, onSetSpeed, onClose, onlyClip = false }: Props) {
    const boxRef = useRef<HTMLDivElement>(null);
    // 依實際尺寸放在畫面內（原本假設 220×200，實際較大會跑出畫面）
    useLayoutEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();                     // 繪製前量好再擺，不會閃
        el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
        el.style.top = `${y + r.height + 8 > window.innerHeight ? Math.max(8, y - r.height) : y}px`;
    }, [x, y]);
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
                style={{ left: x, top: y }}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    className="speed-preset-btn"
                    style={{ width: '100%', marginBottom: 10, opacity: canSplit ? 1 : 0.4, cursor: canSplit ? 'pointer' : 'not-allowed' }}
                    disabled={!canSplit}
                    title={canSplit ? '在播放頭位置把此片段切成兩段' : '請先把播放頭移到此片段中間'}
                    onClick={onSplit}
                >
                    <Scissors aria-hidden /> {canSplit ? `在播放頭分割（${formatTimestamp(splitTime)}）` : '分割（播放頭不在此片段）'}{canSplit && <kbd className="menu-kbd">S</kbd>}
                </button>
                <div className="speed-menu-title"><Gauge aria-hidden /> 影片速度</div>
                <div className="speed-menu-value">{clip.speed.toFixed(1)}x</div>
                <input type="range" className="speed-slider" aria-label="影片速度"
                    min={1} max={5} step={0.1}
                    value={clip.speed}
                    onChange={(e) => onSetSpeed(clip.id, parseFloat(e.target.value))} />
                <div className="speed-menu-presets">
                    {[1, 1.5, 2, 3, 5].map(s => (
                        <button key={s}
                            className={`speed-preset-btn ${clip.speed === s ? 'active' : ''}`}
                            onClick={() => onSetSpeed(clip.id, s)}>{s}x</button>
                    ))}
                </div>

                <hr className="menu-sep" />
                <button
                    className="speed-preset-btn"
                    style={{ width: '100%', marginBottom: 0, marginTop: 6, color: 'var(--danger)' }}
                    onClick={onDelete}
                    title={onlyClip ? '這是時間軸上唯一的片段，刪除後時間軸會清空（可 Ctrl+Z 復原）' : '從時間軸刪除此片段（可 Ctrl+Z 復原）'}
                >
                    <Trash2 aria-hidden /> {onlyClip ? '刪除片段（時間軸會清空）' : '刪除片段'}
                </button>
            </div>
        </div>
    );
}
