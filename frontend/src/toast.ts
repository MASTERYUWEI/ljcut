/* 通知：取代原生 alert()。不會擋住操作、不會打斷正在跑的 AI 流程。
   錯誤會留著直到關閉（附「複製詳情」），成功與提示幾秒後自動消失。 */

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; kind: ToastKind; message: string; detail?: string; actions?: ToastAction[] }

let seq = 0;
let items: Toast[] = [];
const listeners = new Set<(list: Toast[]) => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() { for (const l of listeners) l(items); }

export function subscribeToasts(fn: (list: Toast[]) => void) {
    listeners.add(fn);
    fn(items);
    return () => { listeners.delete(fn); };
}

export function dismissToast(id: number) {
    items = items.filter(t => t.id !== id);
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    emit();
}

// 常見的原始例外 → 白話說明＋下一步（原文保留在「複製詳情」）
const FRIENDLY: [RegExp, string][] = [
    [/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNREFUSED/i, '連不到 LJCUT 後端服務。請等幾秒再試；若一直出現，請重新開啟 LJCUT。'],
    [/\b401\b|Unauthorized/i, '本機控制連線已失效，請重新整理畫面或重開 LJCUT。'],
    [/ENOSPC|No space left/i, '磁碟空間不足，請清出空間或改存到其他磁碟。'],
    [/EACCES|Permission denied|WinError 32|being used by another process|拒絕存取/i, '檔案被其他程式占用或沒有寫入權限。請關閉正在使用它的程式，或改存到其他位置。'],
    [/RESOURCE_EXHAUSTED|\b429\b|quota/i, 'AI 服務額度用完或請求太頻繁，請稍後再試。'],
    [/API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i, 'AI 金鑰無效或沒有權限，請到「設定」檢查 Gemini API Key。'],
    [/ffmpeg|Invalid data found|moov atom/i, '影片處理失敗，檔案可能損壞或格式不支援。可按「複製詳情」把錯誤交給 AI 或開發者檢查。'],
];
export function humanizeError(raw: string): { message: string; detail?: string } {
    const hit = FRIENDLY.find(([re]) => re.test(raw));
    if (!hit) {
        const clean = raw.replace(/\b(Type|Reference|Syntax)?Error:\s*/g, '');
        // 沒對到常見錯誤：保留原文，並給一個下一步
        return /[一-鿿]/.test(clean) && clean.length < 80 ? { message: clean, detail: raw }
            : { message: `${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}（可按「複製詳情」交給 AI 助理判斷）`, detail: raw };
    }
    const context = raw.match(/^([^:：\n]{1,30}?)\s*[:：]/)?.[1];          // 例如「匯出失敗」
    const lead = context && /[一-鿿]/.test(context) ? `${context}：` : '';
    return { message: lead + hit[1], detail: raw };
}

const keyed = new Map<string, number>();
export function toast(kind: ToastKind, message: string, actions?: ToastAction[], opts?: { sticky?: boolean; key?: string }) {
    // 同一個 key 只留最新一則（例如連按 Ctrl+Z 不會疊一堆提示）
    if (opts?.key) { const old = keyed.get(opts.key); if (old !== undefined) dismissToast(old); }
    const id = ++seq;
    if (opts?.key) keyed.set(opts.key, id);
    const h = kind === 'error' ? humanizeError(message.trim()) : { message: message.trim() };
    items = [...items, { id, kind, message: h.message, detail: h.detail, actions }].slice(-4);   // 最多同時 4 則
    if (kind !== 'error' && !opts?.sticky) timers.set(id, setTimeout(() => dismissToast(id), actions?.length ? 9000 : 5000));
    emit();
    return id;
}

/** 依訊息內容判斷種類（沿用原本 alert 的文字，不改文案）：失敗／錯誤 → 錯誤；✅／完成 → 成功；其餘 → 提示 */
export function notify(message: unknown, actions?: ToastAction[]) {
    const text = String(message ?? '');
    const kind: ToastKind = /❌|失敗|錯誤|無法|error|failed/i.test(text) ? 'error'
        : /✅|完成|已加入|已依|已複製|已儲存|已上傳/.test(text) ? 'success' : 'info';
    return toast(kind, text.replace(/^[✅❌⚠️]\s*/u, ''), actions);
}
