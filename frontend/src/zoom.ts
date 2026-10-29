/* 畫面縮放（zoom in／平移）
   縮放區段存在素材上、用來源秒數，與字幕相同：剪掉或加速片段時會跟著內容走。
   預覽（CSS transform）與匯出（FFmpeg，backend/services/zoom.py）用同一套公式，改這裡要同步改那邊。 */

export interface ZoomRegion {
    id: string;
    /** 來源秒數，左閉右開 */
    start: number;
    end: number;
    /** 放大中心，相對畫面 0–1（0,0 = 左上） */
    x: number;
    y: number;
    /** 放大倍率 1.1–4 */
    scale: number;
    /** 進出場緩動秒數（預設 0.4；區段太短時自動縮成一半長度） */
    ease?: number;
}

export const ZOOM_LIMITS = { minScale: 1.1, maxScale: 4, minLength: 0.5, minEase: 0.1, maxEase: 1.5, defaultEase: 0.4 };

export interface ZoomState { scale: number; x: number; y: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (p: number) => p * p * (3 - 2 * p);

/** 區段實際使用的緩動秒數 */
export function effectiveEase(z: ZoomRegion): number {
    return Math.min(z.ease ?? ZOOM_LIMITS.defaultEase, (z.end - z.start) / 2);
}

/** 某個來源時間的縮放狀態；x/y 已夾在畫面內（放大後的視窗不會超出原畫面） */
export function zoomAt(regions: readonly ZoomRegion[] | undefined, t: number): ZoomState {
    let scale = 1, x = 0.5, y = 0.5;
    for (const z of regions ?? []) {
        if (t < z.start || t >= z.end) continue;
        const e = effectiveEase(z);
        const k = smooth(clamp(Math.min((t - z.start) / e, (z.end - t) / e), 0, 1));
        scale += (z.scale - 1) * k;
        x += (z.x - 0.5) * k;
        y += (z.y - 0.5) * k;
        break; // 區段不重疊
    }
    const half = 0.5 / scale;
    return { scale, x: clamp(x, half, 1 - half), y: clamp(y, half, 1 - half) };
}

/** 驗證單一素材的縮放區段（排序後不可重疊） */
export function checkZooms(zooms: unknown, duration: number): string | null {
    if (zooms === undefined) return null;
    if (!Array.isArray(zooms)) return '縮放必須為陣列';
    const ids = new Set<string>();
    const sorted = [...zooms].sort((a, b) => a?.start - b?.start);
    let prevEnd = -Infinity;
    for (const z of sorted) {
        const ok = z && typeof z.id === 'string' && z.id.length > 0 && !ids.has(z.id)
            && [z.start, z.end, z.x, z.y, z.scale].every(n => typeof n === 'number' && Number.isFinite(n));
        if (!ok) return '縮放區段格式無效';
        ids.add(z.id);
        if (z.start < 0 || z.end > duration + 1e-6 || z.end - z.start < ZOOM_LIMITS.minLength)
            return `縮放區段需在素材範圍內且至少 ${ZOOM_LIMITS.minLength} 秒`;
        if (z.x < 0 || z.x > 1 || z.y < 0 || z.y > 1) return '縮放中心 x/y 需為 0–1';
        if (z.scale < ZOOM_LIMITS.minScale || z.scale > ZOOM_LIMITS.maxScale)
            return `縮放倍率需為 ${ZOOM_LIMITS.minScale}–${ZOOM_LIMITS.maxScale}`;
        if (z.ease !== undefined && (typeof z.ease !== 'number' || z.ease < ZOOM_LIMITS.minEase || z.ease > ZOOM_LIMITS.maxEase))
            return `緩動秒數需為 ${ZOOM_LIMITS.minEase}–${ZOOM_LIMITS.maxEase}`;
        if (z.start < prevEnd - 1e-6) return '同一素材的縮放區段不可重疊';
        prevEnd = z.end;
    }
    return null;
}
