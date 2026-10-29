/* 標註疊加層：醒目框、箭頭、聚光燈、步驟編號、標題條。
   存在素材上、用來源秒數（同字幕與縮放），可多層同時出現，陣列越後面越上層。
   外觀只由後端 backend/services/overlay.py 畫成透明貼圖（預覽與匯出用同一張圖）；
   這裡負責驗證與進出場動畫，公式與後端 anim_filters / anim_state 相同。 */

export type OverlayKind = 'box' | 'arrow' | 'spotlight' | 'step' | 'title' | 'html' | 'media';
/** 子母畫面素材（存在 uploads/assets；疊加層只記中繼資料） */
export interface OverlayAsset { id: string; type: 'image' | 'video'; filename: string; url: string; width: number; height: number; duration: number; hasAudio?: boolean }
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
    /** 自訂 HTML 動畫（kind = html）：AI 撰寫，設計畫面高 1080 px、寬依素材比例；時間由 LJ Cut 控制 */
    html?: string;
    /** HTML 動畫與子母畫面的圖層：content 跟著畫面縮放、screen 固定在畫面上（預設 screen） */
    layer?: 'content' | 'screen';
    /** 子母畫面（kind = media）：素材、寬度（畫面寬比例；高度依素材比例）、影片起播秒數、循環、音量 0–1、形狀、外框、陰影 */
    asset?: OverlayAsset;
    offset?: number;
    loop?: boolean;
    volume?: number;
    shape?: 'rect' | 'rounded' | 'circle';
    border?: OverlayColor | 'none';
    shadow?: boolean;
}

export const OVERLAY_KINDS: OverlayKind[] = ['box', 'arrow', 'spotlight', 'step', 'title', 'html', 'media'];
/** 介面「＋ 加入」可直接新增的模板（HTML 動畫由 AI 撰寫） */
export const TEMPLATE_KINDS: OverlayKind[] = ['box', 'arrow', 'spotlight', 'step', 'title'];
export const OVERLAY_LABEL: Record<OverlayKind, string> = { box: '醒目框', arrow: '箭頭', spotlight: '聚光燈', step: '步驟', title: '標題', html: 'HTML 動畫', media: '子母畫面' };
/** 內容層會跟著畫面縮放一起放大；標題固定在畫面上；HTML 動畫與子母畫面依 layer */
export const isContentOverlay = (o: Overlay) => o.kind === 'html' || o.kind === 'media' ? o.layer === 'content' : o.kind !== 'title';

/** 子母畫面在主畫面（原解析度像素）上的位置：與後端 overlay.media_geometry 相同公式 */
export function mediaGeometry(o: Overlay, srcW: number, srcH: number) {
    const a = o.asset!;
    const pw = Math.max(2, Math.round((o.w ?? 0.3) * srcW / 2) * 2);
    const ph = o.shape === 'circle' ? pw : Math.max(2, Math.round(pw * a.height / a.width / 2) * 2);
    const radius = o.shape === 'circle' ? Math.floor(pw / 2) : (o.shape ?? 'rounded') === 'rounded' ? Math.round(16 * srcH / 1080) : 0;
    return { left: Math.round(o.x * srcW), top: Math.round(o.y * srcH), width: pw, height: ph, radius };
}
/** 子母畫面影片在主素材時間 t 應顯示的素材秒數（循環或停在最後一格） */
export function mediaTime(o: Overlay, t: number): number {
    const dur = o.asset?.duration ?? 0;
    const pos = (o.offset ?? 0) + (t - o.start);
    return o.loop && dur > 0 ? ((pos % dur) + dur) % dur : Math.min(Math.max(0, pos), Math.max(0, dur - 0.05));
}
export const HTML_LIMITS = { maxChars: 200_000, maxSeconds: 60 };

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
        if (o.kind === 'media') {
            const a = o.asset;
            if (!a || typeof a.id !== 'string' || !/^a_[0-9a-f]{12}$/.test(a.id) || (a.type !== 'image' && a.type !== 'video')
                || !(a.width > 0 && a.height > 0) || !(a.duration >= 0)) return '子母畫面需提供 asset（先匯入圖片／影片）';
            if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) return '子母畫面位置 x/y 需為 0–1';
            if (o.w !== undefined && !(o.w >= 0.05 && o.w <= 1)) return '子母畫面寬度 w 需為 0.05–1';
            if (o.offset !== undefined && !(o.offset >= 0)) return 'offset 需 ≥ 0';
            if (o.volume !== undefined && !(o.volume >= 0 && o.volume <= 1)) return 'volume 需為 0–1';
            if (o.shape !== undefined && !['rect', 'rounded', 'circle'].includes(o.shape)) return 'shape 需為 rect/rounded/circle';
            if (o.border !== undefined && o.border !== 'none' && !COLORS.includes(o.border)) return 'border 需為 none 或顏色';
            if (o.layer !== undefined && o.layer !== 'content' && o.layer !== 'screen') return 'layer 需為 content 或 screen';
            continue;
        }
        if (o.kind === 'html') {
            if (typeof o.html !== 'string' || !o.html.trim() || o.html.length > HTML_LIMITS.maxChars) return `HTML 動畫需提供 html（最多 ${HTML_LIMITS.maxChars / 1000}K 字元）`;
            if (o.end - o.start > HTML_LIMITS.maxSeconds) return `HTML 動畫每段最多 ${HTML_LIMITS.maxSeconds} 秒`;
            if (o.layer !== undefined && o.layer !== 'content' && o.layer !== 'screen') return 'HTML 動畫 layer 需為 content 或 screen';
            if (o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 40 || /[\x00-\x1f]/.test(o.text))) return 'text 需為單行文字（最多 40 字）';
            continue;
        }
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
    if (o.kind === 'html') return { opacity: 1, scale: 1, slide: 0 };   // HTML 自己控制進出場
    if (o.kind === 'media') {   // 子母畫面：只淡入淡出
        return { opacity: Math.min(Math.min(1, Math.max(0, (t - o.start) / FADE_IN)), Math.min(1, Math.max(0, (o.end - t) / FADE_OUT))), scale: 1, slide: 0 };
    }
    const k = Math.min(1, Math.max(0, (t - o.start) / FADE_IN));
    const out = Math.min(1, Math.max(0, (o.end - t) / FADE_OUT));
    const smooth = k * k * (3 - 2 * k);
    return {
        opacity: Math.min(k, out),
        scale: o.kind === 'box' || o.kind === 'arrow' || o.kind === 'step' ? POP_FROM + (1 - POP_FROM) * smooth : 1,
        slide: o.kind === 'title' ? -(1 - smooth) * SLIDE_PX : 0,
    };
}
