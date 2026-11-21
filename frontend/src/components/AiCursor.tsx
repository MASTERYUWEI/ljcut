/* AI 幽靈游標：AI 改了專案時，在 LJ Cut 畫面裡演出「改在哪」。只是畫面上的動畫，不會動到真實滑鼠。 */
import { useEffect, useRef, useState } from 'react';

export interface AiCursorStep {
    x: number;              // 視窗座標（px）
    y: number;
    click?: boolean;        // 到達後點一下（擴散漣漪）
    label?: string;         // 游標旁的小字
    then?: () => void;      // 到達後執行（例如選取、跳播放頭）
}

const MOVE_MS = 650;
const PAUSE_MS = 350;

/** 讓幽靈游標依序走過這些點 */
export function playAiCursor(steps: AiCursorStep[]) {
    window.dispatchEvent(new CustomEvent('ljcut-ai-cursor', { detail: steps }));
}

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function AiCursor() {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const [visible, setVisible] = useState(false);
    const [label, setLabel] = useState('');
    const [ripple, setRipple] = useState(0);
    const timers = useRef<number[]>([]);
    const last = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => {
        const clear = () => { timers.current.forEach(t => clearTimeout(t)); timers.current = []; };
        const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
        const onPlay = (e: Event) => {
            const steps = (e as CustomEvent<AiCursorStep[]>).detail;
            if (!Array.isArray(steps) || !steps.length) return;
            clear();
            if (reducedMotion()) { steps.forEach(s => s.then?.()); return; }
            // 起點：上一次停的位置，沒有就從標題列的 AI 狀態出發
            const pill = document.querySelector('.ai-status')?.getBoundingClientRect();
            const start = last.current ?? (pill ? { x: pill.left + 16, y: pill.bottom } : { x: steps[0].x, y: steps[0].y - 80 });
            setPos(start);
            setLabel('');
            setVisible(true);
            let t = 60;
            for (const s of steps) {
                later(() => { setPos({ x: s.x, y: s.y }); setLabel(s.label ?? ''); }, t);
                t += MOVE_MS;
                later(() => {
                    if (s.click) setRipple(n => n + 1);
                    try { s.then?.(); } catch { /* 播放頭超出範圍等，不影響動畫 */ }
                }, t);
                t += PAUSE_MS;
                last.current = { x: s.x, y: s.y };
            }
            later(() => setVisible(false), t + 900);
        };
        window.addEventListener('ljcut-ai-cursor', onPlay);
        return () => { window.removeEventListener('ljcut-ai-cursor', onPlay); clear(); };
    }, []);

    if (!pos) return null;
    return (
        <div className={`ai-cursor ${visible ? 'on' : ''}`} style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }} aria-hidden="true">
            {ripple > 0 && <span key={ripple} className="ai-cursor-ripple" />}
            <svg width="22" height="26" viewBox="0 0 22 26">
                <path d="M2 2 L2 20 L7 15.5 L10.5 23.5 L14 22 L10.6 14.2 L17.5 14.2 Z" fill="var(--accent-amber, #f5a524)" stroke="#1b1b24" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            <span className="ai-cursor-tag">AI{label ? ` · ${label}` : ''}</span>
        </div>
    );
}
