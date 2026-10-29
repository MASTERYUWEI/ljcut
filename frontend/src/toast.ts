/* 通知：取代原生 alert()。不會擋住操作、不會打斷正在跑的 AI 流程。
   錯誤會留著直到關閉（附「複製詳情」），成功與提示幾秒後自動消失。 */

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; kind: ToastKind; message: string; actions?: ToastAction[] }

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

export function toast(kind: ToastKind, message: string, actions?: ToastAction[]) {
    const id = ++seq;
    items = [...items, { id, kind, message: message.trim(), actions }].slice(-4);   // 最多同時 4 則
    if (kind !== 'error') timers.set(id, setTimeout(() => dismissToast(id), actions?.length ? 9000 : 5000));
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
