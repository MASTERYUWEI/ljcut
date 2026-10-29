/* 說明：基本流程＋全部快捷鍵與隱藏手勢（按 ? 或頂部「說明」開啟） */
import { X } from 'lucide-react';
import { useRef } from 'react';
import { useDialog } from '../useDialog';

const STEPS = [
    ['匯入', '左側「媒體」拖放影片，或用「螢幕錄影」錄完自動匯入。'],
    ['辨識字幕', '左側「字幕」頁籤按「開始辨識」，完成後在右欄逐句校對。'],
    ['剪輯', '在播放線按 S 分割、選片段按 Delete 刪除；縮放與標註軌的「＋」加入效果，點一下在右欄改屬性。'],
    ['匯出', '「匯出影片」先看摘要再開始；預設是乾淨畫面＋獨立 SRT。'],
    ['上傳', '匯出後按「YouTube」，選封面、確認標題後上傳（預設私人）。'],
] as const;

const GROUPS: { title: string; keys: [string, string][] }[] = [
    { title: '播放', keys: [
        ['空白鍵', '播放／暫停'], ['K ／ L', '暫停／播放'], ['J', '倒退 5 秒'],
        ['← ／ →', '逐格移動'], ['Shift + ← ／ →', '移動 1 秒'], ['Home ／ End', '跳到開頭／結尾'],
    ] },
    { title: '剪輯', keys: [
        ['S', '在播放線分割片段'], ['Delete', '刪除選取的片段、標註或縮放'],
        ['Ctrl + Z', '復原'], ['Ctrl + Shift + Z ／ Ctrl + Y', '重做'],
        ['Shift + F10 或右鍵', '片段選單（分割、刪除、速度）'], ['Ctrl + ＋ ／ －', '放大／縮小時間軸'],
    ] },
    { title: '標註與縮放', keys: [
        ['點一下片段', '在右欄編輯屬性'], ['Shift + 點預覽畫面', '移動選取標註／縮放中心'],
        ['Shift + 拖曳預覽畫面', '框出標註範圍'], ['Esc', '取消選取、關閉對話框'],
    ] },
    { title: '字幕', keys: [
        ['↑ ／ ↓', '在字幕清單上下移動'], ['Enter', '跳到該句（編輯中則在游標處分句）'],
        ['Ctrl + 點字幕', '多選，再按「合併」'], ['?', '開啟這個說明'],
    ] },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useDialog(ref);
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box help-box" ref={ref} role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 id="help-title">說明與快捷鍵</h2>
                    <button className="btn btn-icon" onClick={onClose} aria-label="關閉" title="關閉（Esc）"><X aria-hidden /></button>
                </div>
                <h3 className="help-h">基本流程</h3>
                <ol className="help-steps">
                    {STEPS.map(([t, d]) => <li key={t}><strong>{t}</strong>{d}</li>)}
                </ol>
                <div className="help-grid">
                    {GROUPS.map(g => (
                        <section key={g.title}>
                            <h3 className="help-h">{g.title}</h3>
                            <dl className="help-keys">
                                {g.keys.map(([k, d]) => <div key={k}><dt>{k.split(' ／ ').map((part, i) => <span key={part}>{i > 0 && <span className="help-or">或</span>}<kbd>{part}</kbd></span>)}</dt><dd>{d}</dd></div>)}
                            </dl>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
