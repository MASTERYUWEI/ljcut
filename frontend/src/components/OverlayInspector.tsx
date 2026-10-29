import { useEffect, useState } from 'react';
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, Trash2, X } from 'lucide-react';
import type { MediaItem, TimelineClip } from '../types';
import type { Overlay, OverlayColor, ArrowFrom, TitlePosition } from '../overlay';
import { OVERLAY_LABEL } from '../overlay';
import type { ZoomRegion } from '../zoom';
import { toTimelineTime } from '../editCore';

/* 標註／縮放屬性面板：選取後在右欄直接編輯（取代原生輸入框與「↻ 一路循環」）。
   每次確定修改送一筆 edit_overlay／edit_zoom（一次操作 = 一筆 undo）；文字在離開欄位或按 Enter 時才送出。 */

type Ops = (ops: Record<string, unknown>[]) => unknown;
interface Props {
    media: MediaItem;
    overlay?: Overlay;
    zoom?: ZoomRegion;
    clips: TimelineClip[];
    onOps: Ops;
    onClose: () => void;
}

const COLORS: { id: OverlayColor; label: string; hex: string }[] = [
    { id: 'red', label: '紅', hex: '#ff3b30' }, { id: 'yellow', label: '黃', hex: '#ffcc00' },
    { id: 'blue', label: '藍', hex: '#0a84ff' }, { id: 'green', label: '綠', hex: '#34c759' }, { id: 'white', label: '白', hex: '#f5f5f5' },
];
// 箭尾所在方向：圖示畫的是「箭頭指向」，所以用反方向
const FROMS: { id: ArrowFrom; label: string; icon: typeof ArrowUp }[] = [
    { id: 'bottom-right', label: '從右下', icon: ArrowUpLeft }, { id: 'bottom', label: '從下', icon: ArrowUp }, { id: 'bottom-left', label: '從左下', icon: ArrowUpRight },
    { id: 'right', label: '從右', icon: ArrowLeft }, { id: 'left', label: '從左', icon: ArrowRight },
    { id: 'top-right', label: '從右上', icon: ArrowDownLeft }, { id: 'top', label: '從上', icon: ArrowDown }, { id: 'top-left', label: '從左上', icon: ArrowDownRight },
];
const POSITIONS: { id: TitlePosition; label: string }[] = [
    { id: 'bottom-left', label: '左下' }, { id: 'bottom-center', label: '下方置中' }, { id: 'top-left', label: '左上' }, { id: 'top-center', label: '上方置中' },
];

/** 文字／數字欄位：本地編輯，離開欄位或按 Enter 才送出 */
function Field({ label, value, onCommit, type = 'text', step, min, max, suffix, maxLength }: {
    label: string; value: string | number; onCommit: (v: string) => void; type?: 'text' | 'number';
    step?: number; min?: number; max?: number; suffix?: string; maxLength?: number;
}) {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    const commit = () => { if (draft !== String(value)) onCommit(draft); };
    return (
        <label className="insp-field">
            <span>{label}</span>
            <span className="insp-input-wrap">
                <input className="st-input" type={type} value={draft} step={step} min={min} max={max} maxLength={maxLength}
                    onChange={e => setDraft(e.target.value)} onBlur={commit}
                    onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(String(value)); e.stopPropagation(); } }} />
                {suffix && <span className="insp-suffix">{suffix}</span>}
            </span>
        </label>
    );
}

const pct = (v: number | undefined) => Math.round((v ?? 0) * 1000) / 10;
const fromPct = (s: string) => Math.max(0, Math.min(100, Number(s))) / 100;

export function OverlayInspector({ media, overlay, zoom, clips, onOps, onClose }: Props) {
    const target = overlay ?? zoom!;
    const id = overlay ? { overlayId: overlay.id } : { zoomId: zoom!.id };
    const edit = (patch: Record<string, unknown>) => onOps([{ type: overlay ? 'edit_overlay' : 'edit_zoom', ...id, ...patch }]);
    const remove = () => { if (onOps([{ type: overlay ? 'delete_overlay' : 'delete_zoom', ...id }])) onClose(); };

    // 時間以「時間軸」顯示與輸入（存成素材秒數）：用區段開頭所在的片段換算
    const clip = clips.find(c => c.mediaId === media.id && !c.bookend && target.start >= c.trimStart - 1e-6 && target.start < c.trimEnd)
        ?? clips.find(c => c.mediaId === media.id && c.trimStart < target.end && c.trimEnd > target.start);
    const tl = (src: number) => clip ? Math.round(toTimelineTime(clip, src) * 100) / 100 : src;
    const src = (t: number) => clip ? Math.round((clip.trimStart + (t - clip.startTime) * clip.speed) * 100) / 100 : t;
    const commitTime = (key: 'start' | 'end', v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return;
        edit({ [key]: Math.max(0, Math.min(media.info.duration, src(n))) });
    };

    const kind = overlay?.kind;
    const title = overlay ? OVERLAY_LABEL[overlay.kind] : '畫面縮放';
    return (
        <section className="inspector" aria-label={`${title}屬性`}>
            <header className="inspector-head">
                <h2>{title}</h2>
                <button className="btn insp-icon" onClick={remove} title="刪除（Delete）" aria-label={`刪除這個${title}`}><Trash2 aria-hidden /></button>
                <button className="btn insp-icon" onClick={onClose} title="取消選取（Esc）" aria-label="取消選取"><X aria-hidden /></button>
            </header>

            <div className="insp-grid">
                <Field label="開始" type="number" step={0.1} value={tl(target.start)} onCommit={v => commitTime('start', v)} suffix="秒" />
                <Field label="結束" type="number" step={0.1} value={tl(target.end)} onCommit={v => commitTime('end', v)} suffix="秒" />
            </div>
            {!clip && <p className="insp-note">這段目前不在時間軸上（已被剪掉），時間以素材秒數顯示。</p>}

            {overlay && kind !== 'html' && kind !== 'media' && (
                <Field label={kind === 'step' ? '編號' : kind === 'title' ? '標題' : '說明文字'} value={overlay.text ?? ''}
                    maxLength={kind === 'step' ? 3 : 40} onCommit={v => { if (v.trim()) edit({ text: v.trim() }); else if (kind !== 'step' && kind !== 'title') edit({ text: null }); }} />
            )}
            {kind === 'title' && <Field label="第二行" value={overlay!.sub ?? ''} maxLength={60} onCommit={v => edit({ sub: v.trim() || null })} />}
            {(kind === 'html' || kind === 'media') && <Field label="名稱" value={overlay!.text ?? ''} maxLength={40} onCommit={v => edit({ text: v.trim() || null })} />}

            {overlay && kind !== 'html' && kind !== 'media' && (
                <div className="insp-row" role="radiogroup" aria-label="顏色">
                    <span className="insp-label">顏色</span>
                    <span className="insp-swatches">
                        {COLORS.map(c => {
                            const on = (overlay.color ?? (kind === 'title' ? 'yellow' : 'red')) === c.id;
                            return <button key={c.id} role="radio" aria-checked={on} aria-label={c.label} title={c.label}
                                className={`insp-swatch ${on ? 'on' : ''}`} style={{ background: c.hex }} onClick={() => edit({ color: c.id })} />;
                        })}
                    </span>
                </div>
            )}

            {kind === 'arrow' && (
                <div className="insp-row" role="radiogroup" aria-label="箭頭方向">
                    <span className="insp-label">方向</span>
                    <span className="insp-dirs">
                        {FROMS.map(f => {
                            const on = (overlay!.from ?? 'bottom-right') === f.id;
                            const Icon = f.icon;
                            return <button key={f.id} role="radio" aria-checked={on} aria-label={f.label} title={f.label}
                                className={`btn insp-icon ${on ? 'on' : ''}`} onClick={() => edit({ from: f.id })}><Icon aria-hidden /></button>;
                        })}
                    </span>
                </div>
            )}

            {kind === 'title' && (
                <div className="insp-row" role="radiogroup" aria-label="標題位置">
                    <span className="insp-label">位置</span>
                    <span className="insp-seg">
                        {POSITIONS.map(p => {
                            const on = (overlay!.position ?? 'bottom-left') === p.id;
                            return <button key={p.id} role="radio" aria-checked={on} className={`insp-seg-btn ${on ? 'on' : ''}`} onClick={() => edit({ position: p.id })}>{p.label}</button>;
                        })}
                    </span>
                </div>
            )}

            {overlay && kind !== 'title' && kind !== 'html' && (
                <div className="insp-grid">
                    <Field label={kind === 'box' || kind === 'spotlight' || kind === 'media' ? '左' : 'X'} type="number" step={0.5} min={0} max={100}
                        value={pct(overlay.x)} onCommit={v => edit({ x: fromPct(v) })} suffix="%" />
                    <Field label={kind === 'box' || kind === 'spotlight' || kind === 'media' ? '上' : 'Y'} type="number" step={0.5} min={0} max={100}
                        value={pct(overlay.y)} onCommit={v => edit({ y: fromPct(v) })} suffix="%" />
                    {(kind === 'box' || kind === 'spotlight' || kind === 'media') && (
                        <Field label="寬" type="number" step={0.5} min={1} max={100} value={pct(overlay.w)} onCommit={v => edit({ w: Math.max(0.01, fromPct(v)) })} suffix="%" />
                    )}
                    {(kind === 'box' || kind === 'spotlight') && (
                        <Field label="高" type="number" step={0.5} min={1} max={100} value={pct(overlay.h)} onCommit={v => edit({ h: Math.max(0.01, fromPct(v)) })} suffix="%" />
                    )}
                </div>
            )}

            {kind === 'media' && (
                <>
                    <div className="insp-row" role="radiogroup" aria-label="形狀">
                        <span className="insp-label">形狀</span>
                        <span className="insp-seg">
                            {([['rounded', '圓角'], ['circle', '圓形'], ['rect', '直角']] as const).map(([v, l]) => {
                                const on = (overlay!.shape ?? 'rounded') === v;
                                return <button key={v} role="radio" aria-checked={on} className={`insp-seg-btn ${on ? 'on' : ''}`} onClick={() => edit({ shape: v })}>{l}</button>;
                            })}
                        </span>
                    </div>
                    <label className="insp-check"><input type="checkbox" checked={(overlay!.border ?? 'white') !== 'none'}
                        onChange={e => edit({ border: e.target.checked ? 'white' : 'none' })} /> 白色外框</label>
                    <label className="insp-check"><input type="checkbox" checked={overlay!.shadow !== false}
                        onChange={e => edit({ shadow: e.target.checked })} /> 陰影</label>
                    {overlay!.asset?.type === 'video' && (
                        <>
                            <div className="insp-grid">
                                <Field label="從素材第" type="number" step={0.1} min={0} value={overlay!.offset ?? 0}
                                    onCommit={v => edit({ offset: Math.max(0, Number(v) || 0) })} suffix="秒起播" />
                                {overlay!.asset.hasAudio && (
                                    <Field label="音量" type="number" step={5} min={0} max={100} value={Math.round((overlay!.volume ?? 0) * 100)}
                                        onCommit={v => edit({ volume: Math.max(0, Math.min(100, Number(v) || 0)) / 100 })} suffix="%" />
                                )}
                            </div>
                            <label className="insp-check"><input type="checkbox" checked={!!overlay!.loop}
                                onChange={e => edit({ loop: e.target.checked })} /> 素材比區段短時循環播放</label>
                        </>
                    )}
                </>
            )}

            {(kind === 'html' || kind === 'media') && (
                <label className="insp-check"><input type="checkbox" checked={overlay!.layer === 'content'}
                    onChange={e => edit({ layer: e.target.checked ? 'content' : 'screen' })} /> 跟著畫面縮放一起放大</label>
            )}
            {kind === 'html' && <p className="insp-note">HTML 動畫的內容由 AI 撰寫：在對話中描述要怎麼改即可。</p>}

            {zoom && (
                <div className="insp-grid">
                    <Field label="倍率" type="number" step={0.1} min={1.1} max={4} value={zoom.scale}
                        onCommit={v => edit({ scale: Math.max(1.1, Math.min(4, Number(v) || 2)) })} suffix="×" />
                    <Field label="緩動" type="number" step={0.1} min={0.1} max={1.5} value={zoom.ease ?? 0.4}
                        onCommit={v => edit({ ease: Math.max(0.1, Math.min(1.5, Number(v) || 0.4)) })} suffix="秒" />
                    <Field label="中心 X" type="number" step={0.5} min={0} max={100} value={pct(zoom.x)} onCommit={v => edit({ x: fromPct(v) })} suffix="%" />
                    <Field label="中心 Y" type="number" step={0.5} min={0} max={100} value={pct(zoom.y)} onCommit={v => edit({ y: fromPct(v) })} suffix="%" />
                </div>
            )}

            {kind !== 'html' && (
                <p className="insp-note">也可以在預覽畫面上 Shift＋點一下移動位置{(kind === 'box' || kind === 'spotlight' || kind === 'media') ? '，或 Shift＋拖曳框出範圍' : ''}。</p>
            )}
        </section>
    );
}
