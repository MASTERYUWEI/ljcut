import type { Segment } from './types';
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

// ── 超長字幕依標點/空白/斷點分段（手動辨識與 AI 控制辨識共用）──
export function splitLongCues(segs: Segment[], maxChars: number): Segment[] {
    if (maxChars <= 0) return segs;
    const result: Segment[] = [];
    const punctuation = /[，。！？；：、,.!?;:]/;
    // 中文助詞/介詞/連詞 — 在這些字「前面」斷句最自然
    const breakBefore = new Set(
        '的了在是把被跟和與或但而也都就會要能可讓給對向從到為那這有不很'
            .split('')
    );

    // 容忍區間：maxChars ~ hardLimit 之間只在有好斷點時才切
    const hardLimit = maxChars + 5;

    for (const seg of segs) {
        if (seg.text.length <= maxChars) {
            result.push({ ...seg, id: result.length });
            continue;
        }

        // 在容忍區間內（maxChars < len <= hardLimit）：
        // 只在有語意斷點時才切，否則保留完整不切
        const len = seg.text.length;
        const isInTolerance = len <= hardLimit;

        // 找最佳切割點
        let splitIdx = -1;
        const mid = Math.floor(len / 2);
        // 搜尋範圍：確保兩半都不超過 maxChars
        const lo = Math.max(1, len - maxChars);
        const hi = Math.min(len - 1, maxChars);

        // P1: 標點符號（在標點後面切）
        for (let d = 0; splitIdx < 0; d++) {
            const r = mid + d, l = mid - d;
            if (r > hi && l < lo) break;
            if (r <= hi && r < len && punctuation.test(seg.text[r])) { splitIdx = r + 1; }
            else if (l >= lo && l >= 0 && punctuation.test(seg.text[l])) { splitIdx = l + 1; }
        }

        // P2: 空格（混合語言內容）
        if (splitIdx <= 0 || splitIdx >= len) {
            for (let d = 0; splitIdx < 0; d++) {
                const r = mid + d, l = mid - d;
                if (r > hi && l < lo) break;
                if (r <= hi && r < len && seg.text[r] === ' ') { splitIdx = r + 1; }
                else if (l >= lo && l >= 0 && seg.text[l] === ' ') { splitIdx = l + 1; }
            }
        }

        // P3: 中文助詞/介詞前斷句（保持詞語完整）
        if (splitIdx <= 0 || splitIdx >= len) {
            for (let d = 0; splitIdx < 0; d++) {
                const r = mid + d, l = mid - d;
                if (r > hi && l < lo) break;
                if (r <= hi && r < len && breakBefore.has(seg.text[r])) { splitIdx = r; }
                else if (l >= lo && l > 0 && breakBefore.has(seg.text[l])) { splitIdx = l; }
            }
        }

        // P4: 容忍區間內找不到好斷點 → 不切，保留完整
        if ((splitIdx <= 0 || splitIdx >= len) && isInTolerance) {
            result.push({ ...seg, id: result.length });
            continue;
        }

        // P5: 超出硬上限且找不到好斷點 → 最後手段從中間硬切
        if (splitIdx <= 0 || splitIdx >= len) splitIdx = mid;

        const ratio = splitIdx / len;
        const midTime = seg.start + (seg.end - seg.start) * ratio;
        result.push({ ...seg, id: result.length, text: seg.text.slice(0, splitIdx).trim(), end: midTime });
        result.push({ ...seg, id: result.length + 1, text: seg.text.slice(splitIdx).trim(), start: midTime });
        result[result.length - 1].id = result.length - 1;
    }
    return result;
}
