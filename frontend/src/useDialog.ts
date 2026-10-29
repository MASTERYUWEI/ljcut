import { useEffect, type RefObject } from 'react';

/* 對話框的鍵盤與螢幕閱讀器行為（掛在現有 .modal-box 上，不改外觀）：
   開啟時把焦點移進框內（略過右上角 ✕），Tab／Shift+Tab 只在框內循環，關閉後焦點回到開啟前的位置。
   Esc 關閉由 App 的全域快捷鍵處理。 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog(ref: RefObject<HTMLElement | null>, active = true) {
    useEffect(() => {
        if (!active) return;
        const box = ref.current;
        if (!box) return;
        const previous = document.activeElement as HTMLElement | null;
        const focusables = () => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
        const first = focusables().find(el => el.getAttribute('aria-label') !== '關閉') ?? focusables()[0] ?? box;
        if (first === box) box.tabIndex = -1;
        first.focus({ preventScroll: true });
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const list = focusables();
            if (!list.length) { e.preventDefault(); return; }
            const i = list.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
            else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
        };
        box.addEventListener('keydown', onKey);
        return () => {
            box.removeEventListener('keydown', onKey);
            if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
        };
    }, [ref, active]);
}
