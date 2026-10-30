/* 說明：基本流程＋全部快捷鍵與隱藏手勢（按 ? 或頂部「說明」開啟） */
import { Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDialog } from '../useDialog';

const STEPS = [
    ['匯入', '左側「媒體」拖放影片，或用「螢幕錄影」錄完自動匯入。'],
    ['辨識字幕', '左側「字幕辨識」頁籤按「開始辨識」，完成後在右欄逐句校對。'],
    ['剪輯', '在右欄點一句字幕按「剪掉這句」（Ctrl／Shift＋點可多選），或用 I／O 標記一段再「剪掉 I–O」；在播放頭按 S 分割；縮放與標註軌的「＋」加入效果。'],
    ['或交給 AI 助理', '在 AI 助理的對話裡請它提出剪除、縮放、標註；它套用的每一步都會出現在標題列的 AI 紀錄，並可 Ctrl+Z 復原。'],
    ['匯出', '「匯出影片」先看摘要再開始；預設是乾淨畫面＋獨立 SRT。'],
    ['上傳', '匯出後按「YouTube」，選封面、確認標題後上傳（預設私人）。'],
] as const;

const GROUPS: { title: string; keys: [string, string][] }[] = [
    { title: '播放', keys: [
        ['空白鍵', '播放／暫停'], ['K ／ L', '暫停／播放'], ['J', '倒退 5 秒（LJCUT 不做連按加速）'],
        ['Alt + ↑ ／ ↓', '跳到上一句／下一句字幕'], ['Alt + Shift + ↑ ／ ↓', '跳到上一個／下一個剪接點'],
        ['← ／ →', '逐格移動'], ['Shift + ← ／ →', '移動 1 秒'], ['Home ／ End', '跳到開頭／結尾'],
    ] },
    { title: '剪輯', keys: [
        ['S', '在播放頭分割片段'], ['Delete', '刪除選取的標註、縮放，或先點一下的片段'],
        ['I ／ O', '標記要剪掉的起點／終點（播放列也有 I、O 按鈕）'], ['X', '剪掉 I 到 O 之間'], ['Ctrl + N', '新專案'],
        ['Ctrl + Z', '復原'], ['Ctrl + Shift + Z ／ Ctrl + Y', '重做'],
        ['Ctrl + S', '儲存專案'], ['Ctrl + Shift + S', '另存新檔'], ['Ctrl + E', '匯出影片'], ['Ctrl + B', '收合／展開左欄'],
        ['Z', '在播放頭加入畫面放大'], ['A', '在播放頭加入標註（選類型）'],
        ['Shift + F10 或右鍵', '片段選單（分割、刪除、速度）'], ['Ctrl + ＋ ／ －', '放大／縮小時間軸'],
    ] },
    { title: '標註與縮放', keys: [
        ['點一下片段', '在右欄編輯屬性'], ['Shift + 點預覽畫面', '移動選取標註／縮放中心'],
        ['Shift + 拖曳預覽畫面', '框出標註範圍'], ['Esc', '取消選取、關閉對話框'],
    ] },
    { title: '字幕', keys: [
        ['↑ ／ ↓', '在字幕清單上下移動'], ['Enter', '跳到該句（編輯中則在游標處分句）'],
        ['Ctrl + 點 ／ Shift + 點', '多選／範圍選取字幕'], ['Delete（按兩次）／ Ctrl + X', '剪掉選取的句子'],
        ['Ctrl + M', '合併選取的句子'], ['?', '開啟這個說明'],
    ] },
];

// 名詞解釋與常見問題（可搜尋）
const FAQ: [string, string][] = [
    ['字幕「另附檔」和「燒進畫面」差在哪？', '燒進畫面：字幕直接畫進影片，之後不能關掉或修改。另附檔（預設）：匯出乾淨畫面，另附 SRT 字幕檔。'],
    ['預覽上的字幕會出現在成品裡嗎？', '只有選「燒進畫面」才會。預設「另附檔」時，預覽字幕只是方便校對，拖動位置也只影響燒進畫面的版本。'],
    ['畫面放大的「放大過程」是什麼？', '畫面從原本大小放大到指定倍率所花的秒數；數字越小越突然，0.3～0.6 秒最自然。'],
    ['子母畫面是什麼？', '在主畫面角落疊一張圖片或一段影片（例如 Logo、臉部鏡頭），可設定大小、圓角、外框和音量。'],
    ['怎麼一次剪掉一大段？', '把播放頭移到開頭按 I，移到結尾按 O，時間軸右上角會出現「剪掉 N 秒」。也可以在字幕 Shift＋點選取連續多句再剪。'],
    ['怎麼讓 AI 助理幫我剪？', '在 Claude／Codex 等 AI 助理的對話裡請它「用 LJ Cut 剪這支影片」；它會透過本機控制連上。標題列的 AI 標示會從「AI 待命」變成「AI 連線中」，每次修改都會列在 AI 紀錄，可逐筆退回。'],
    ['AI 潤飾改了哪些句子？', '潤飾後改過的句子左側會有琥珀色線和「AI 改過」標記；字幕標題旁可切換「只看 AI 改過的」，每句都能「還原原句」。'],
    ['怎麼開始下一支影片？', '按「開啟」裡的「新專案」或 Ctrl+N。有沒存的修改會先問你要不要儲存。'],
    ['SRT／CC 是什麼？', 'SRT 是字幕檔，上傳 YouTube 時會掛成可開關的 CC 字幕；改錯字只要換字幕，不用重傳影片。'],
    ['怎麼剪掉講錯的一句話？', '在右欄點那一句，按「剪掉這句」。多句就 Ctrl＋點選，再按「剪掉這 N 句」。都可以 Ctrl+Z 復原。'],
    ['AI 改壞了怎麼辦？', 'AI 每次修改都是一步，按 Ctrl+Z 或頂部的復原就能退回；點標題列的「AI」可以看它改了什麼。'],
    ['專案存在哪裡？', '存在專案資料夾（安裝版是「文件\\LJCUT 專案」）。按「開啟」可以看到存放位置與全部專案，也能直接開啟資料夾。'],
    ['忘記存檔、程式關掉了？', '有修改時每分鐘會自動備份。下次開啟會提示還原，也可以從「開啟」清單最上面那列還原。'],
    ['畫面放大和標註是什麼？', '畫面放大：把畫面某一塊放大，讓觀眾看清楚。標註：醒目框、箭頭、聚光燈、步驟編號和標題。'],
    ['片頭片尾在哪裡設定？', '左側「媒體」頁籤最下面的「片頭與片尾」。選好檔案按一次「加入時間軸」，會自動接上轉場。'],
    ['為什麼選「公開」上傳後還是私人？', 'LJCUT 的上傳功能還沒通過 Google 審核，YouTube 會先把影片鎖成私人；到 YouTube 後台手動改成公開即可。'],
];

export function ShortcutHelp({ onClose, query = '' }: { onClose: () => void; query?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useDialog(ref);
    const [q, setQ] = useState(query);
    const hit = (...t: string[]) => !q.trim() || t.some(x => x.toLowerCase().includes(q.trim().toLowerCase()));
    const steps = STEPS.filter(([t, d]) => hit(t, d));
    const faq = FAQ.filter(([t, d]) => hit(t, d));
    const groups = GROUPS.map(g => ({ ...g, keys: g.keys.filter(([k, d]) => hit(k, d, g.title)) })).filter(g => g.keys.length);
    return (
        <div className="modal-overlay help-layer" onClick={onClose}>
            <div className="modal-box help-box" ref={ref} role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 id="help-title">說明與快捷鍵</h2>
                    <button className="btn btn-icon" onClick={onClose} aria-label="關閉" title="關閉（Esc）"><X aria-hidden /></button>
                </div>
                <div className="help-search">
                    <Search aria-hidden />
                    <input className="st-input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋，例如：剪掉、字幕、存檔、Ctrl" aria-label="搜尋說明" />
                </div>
                {!steps.length && !faq.length && !groups.length && <p className="help-empty">找不到「{q}」。試試「剪」「字幕」「匯出」或按鍵名稱。</p>}
                {steps.length > 0 && <>
                    <h3 className="help-h">基本流程</h3>
                    <ol className="help-steps">
                        {steps.map(([t, d]) => <li key={t}><strong>{t}</strong>{d}</li>)}
                    </ol>
                </>}
                {faq.length > 0 && <>
                    <h3 className="help-h">常見問題與名詞</h3>
                    <div className="help-faq">
                        {faq.map(([t, d]) => <details key={t} open={!!q.trim()}><summary>{t}</summary><p>{d}</p></details>)}
                    </div>
                </>}
                <div className="help-grid">
                    {groups.map(g => (
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
