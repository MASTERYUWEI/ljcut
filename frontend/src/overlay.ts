/* 標註疊加層：醒目框、箭頭、聚光燈、步驟編號、標題條。
   存在素材上、用來源秒數（同字幕與縮放），可多層同時出現，陣列越後面越上層。
   外觀只由後端 backend/services/overlay.py 畫成透明貼圖（預覽與匯出用同一張圖）；
   這裡負責驗證與進出場動畫，公式與後端 anim_filters / anim_state 相同。 */

export type OverlayKind = 'box' | 'arrow' | 'spotlight' | 'step' | 'title';
export type OverlayColor = 'red' | 'yellow' | 'blue' | 'green' | 'white';
export type ArrowFrom = 'right' | 'left' | 'top' | 'bottom' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export type TitlePosition = 'bottom-left' | 'bottom-center' | 'top-left' | 'top-center';

export interface Overlay {
    id: string;
    kind: OverlayKind;
    /** 來源秒數，左閉右開 */
    start: number;
    end: number;
    /** 畫面比例 0–1：框／聚光燈為左上角，箭頭為尖端，步驟為圓心；標題不使用 */
    x: number;
    y: number;
    /** 框／聚光燈的寬高（畫面比例） */
    w?: number;
    h?: number;
    /** 框／聚光燈／箭頭的說明、步驟的編號（最多 3 字）、標題主文字 */
    text?: string;
    /** 標題第二行 */
    sub?: string;
    color?: OverlayColor;
    /** 箭頭：箭尾在尖端的哪個方向（預設 bottom-right，即從右下指過去） */
    from?: ArrowFrom;
    /** 標題位置（預設 bottom-left） */
    position?: TitlePosition;
}

export const OVERLAY_KINDS: OverlayKind[] = ['box', 'arrow', 'spotlight', 'step', 'title'];
export const OVERLAY_LABEL: Record<OverlayKind, string> = { box: '醒目框', arrow: '箭頭', spotlight: '聚光燈', step: '步驟', title: '標題' };
/** 內容層會跟著畫面縮放一起放大；標題固定在畫面上 */
export const isContentOverlay = (o: Overlay) => o.kind !== 'title';

const COLORS = ['red', 'yellow', 'blue', 'green', 'white'];
const FROMS = ['right', 'left', 'top', 'bottom', 'top-right', 'top-left', 'bottom-right', 'bottom-left'];
const POSITIONS = ['bottom-left', 'bottom-center', 'top-left', 'top-center'];
export const FADE_IN = 0.25, FADE_OUT = 0.2, POP_FROM = 0.8, SLIDE_PX = 40;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** 驗證單一素材的疊加層；回傳錯誤訊息或 null */
export function checkOverlays(list: unknown, duration: number): string | null {
    if (list === undefined) return null;
    if (!Array.isArray(list) || list.length > 200) return '疊加層必須為陣列（每個素材最多 200 個）';
    const ids = new Set<string>();
    for (const o of list as Overlay[]) {
        if (!o || typeof o.id !== 'string' || !o.id || ids.has(o.id) || !OVERLAY_KINDS.includes(o.kind)) return '疊加層需有唯一 id 與有效 kind';
        ids.add(o.id);
        if (![o.start, o.end, o.x, o.y].every(finite)) return '疊加層數值無效';
        if (o.start < 0 || o.end > duration + 1e-6 || o.end - o.start < 0.3) return '疊加層需在素材範圍內且至少 0.3 秒';
        if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) return '疊加層位置 x/y 需為 0–1';
        if (o.kind === 'box' || o.kind === 'spotlight') {
            if (!finite(o.w) || !finite(o.h) || o.w < 0.01 || o.h < 0.01 || o.x + o.w > 1.0001 || o.y + o.h > 1.0001)
                return '框的範圍需在畫面內（x+w、y+h ≤ 1）';
        }
        if (o.color !== undefined && !COLORS.includes(o.color)) return `顏色需為 ${COLORS.join('/')}`;
        if (o.from !== undefined && !FROMS.includes(o.from)) return `箭頭 from 需為 ${FROMS.join('/')}`;
        if (o.position !== undefined && !POSITIONS.includes(o.position)) return `標題位置需為 ${POSITIONS.join('/')}`;
        for (const [k, limit] of [['text', o.kind === 'step' ? 3 : 40], ['sub', 60]] as const) {
            const v = o[k];
            if (v !== undefined && (typeof v !== 'string' || v.length > limit || /[\x00-\x1f]/.test(v))) return `${k} 需為單行文字（最多 ${limit} 字）`;
        }
        if ((o.kind === 'step' || o.kind === 'title') && !o.text?.trim()) return '步驟編號與標題需提供 text';
    }
    return null;
}

/** 某個來源時間的動畫狀態：不透明度、彈出縮放、標題滑入（以 1080p 為基準的像素，負值往左） */
export function overlayAnim(o: Overlay, t: number): { opacity: number; scale: number; slide: number } {
    const k = Math.min(1, Math.max(0, (t - o.start) / FADE_IN));
    const out = Math.min(1, Math.max(0, (o.end - t) / FADE_OUT));
    const smooth = k * k * (3 - 2 * k);
    return {
        opacity: Math.min(k, out),
        scale: o.kind === 'box' || o.kind === 'arrow' || o.kind === 'step' ? POP_FROM + (1 - POP_FROM) * smooth : 1,
        slide: o.kind === 'title' ? -(1 - smooth) * SLIDE_PX : 0,
    };
}
