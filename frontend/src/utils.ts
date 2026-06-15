/* ── LJCUT 共用工具函式（純函式，無元件狀態） ── */

// ── 軌道標籤寬度 ──
export const LABEL_W = 72;

// ── 格式化時間 m:ss ──
export function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── 格式化時間 m:ss.cc（含百分秒）──
export function formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

// ── 時間刻度 ──
export function generateRulerTicks(duration: number, pps: number) {
    if (duration <= 0) return [];
    const intervals = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let interval = intervals[intervals.length - 1];
    for (const iv of intervals) {
        if (iv * pps >= 60) { interval = iv; break; }
    }
    const ticks: { time: number; label: string }[] = [];
    for (let t = 0; t <= duration; t += interval) {
        ticks.push({ time: t, label: formatTime(t) });
    }
    return ticks;
}

// ── Snap 吸附：找最接近的字幕邊界 ──
export function findSnapTime(time: number, segments: { start: number; end: number }[], threshold: number): number | null {
    let closest: number | null = null;
    let minDist = threshold;
    for (const seg of segments) {
        const dStart = Math.abs(time - seg.start);
        const dEnd = Math.abs(time - seg.end);
        if (dStart < minDist) { minDist = dStart; closest = seg.start; }
        if (dEnd < minDist) { minDist = dEnd; closest = seg.end; }
    }
    return closest;
}
