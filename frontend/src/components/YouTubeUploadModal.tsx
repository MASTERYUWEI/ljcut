/* Export-bound captions, Codex cover selection and YouTube upload. */
import { X, Upload, ExternalLink, Play } from 'lucide-react';
import { StatusText } from './StatusText';
import { formatTime } from '../utils';
import { useEffect, useRef, useState } from 'react';
import { useDialog } from '../useDialog';
import { notify } from '../toast';
import { api } from '../api';
import { controlRequest } from '../controlClient';
import { CoverPicker, type Publication } from './CoverPicker';

interface Props {
    videoPath: string;
    defaultTitle: string;
    defaultDescription: string;
    publicationId: string;
    thumbnailTime: number;
    stale?: boolean;
    projectSubtitleCount?: number;
    onReexport?: () => void;
    onClose: () => void;
}

const STAGE_LABEL: Record<string, string> = {
    init: '建立上傳工作…',
    upload: '上傳影片中',
    thumbnail: '設定縮圖…',
    caption: '設定已對齊的 SRT 字幕…',
    publish: '設定影片公開狀態…',
};

export function YouTubeUploadModal({ videoPath, defaultTitle, defaultDescription, publicationId, thumbnailTime, stale, projectSubtitleCount = 0, onReexport, onClose }: Props) {
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialog(dialogRef);
    const uploadingRef = useRef(false);
    const [connected, setConnected] = useState<boolean | null>(null);
    const [channel, setChannel] = useState('');
    const [title, setTitle] = useState(defaultTitle);
    const [desc, setDesc] = useState(defaultDescription);
    const [tags, setTags] = useState('');
    const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
    const [publication, setPublication] = useState<Publication | null>(null);
    const segments = publication?.segments ?? [];
    // Esc 關閉：上傳中不關（避免看不到進度、重複上傳）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !uploadingRef.current) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const [includeSrt, setIncludeSrt] = useState(true);

    // 縮圖：frame=播放頭畫面 / ai=AI 封面 / none
    const [thumbMode, setThumbMode] = useState<'frame' | 'ai' | 'none'>('ai');
    const [thumbSel, setThumbSel] = useState('');

    const [uploading, setUploadingState] = useState(false);
    const setUploading = (v: boolean) => { uploadingRef.current = v; setUploadingState(v); };
    const [progress, setProgress] = useState(0);
    const [stage, setStage] = useState('');
    const [result, setResult] = useState<{ watch_url: string; studio_url: string; warnings?: string[] } | null>(null);
    const [error, setError] = useState('');
    const [partialStudio, setPartialStudio] = useState('');

    useEffect(() => {
        api.ytStatus()
            .then(s => { setConnected(!!s.connected); setChannel(s.channel || ''); })
            .catch(() => setConnected(false));
    }, []);

    useEffect(() => {
        let active = true;
        controlRequest(`/publications/${publicationId}`).then(p => {
            if (!active) return;
            setPublication(p); setThumbSel(p.selected?.file ?? '');
            // 還沒有任何 AI 封面時，預設用播放頭畫面，避免卡在「請先選封面」
            if (!p.selected && !(p.batches?.length)) setThumbMode('frame');
            if (p.selected) { setTitle(p.title); setDesc(p.description || ''); }
        }).catch(e => { if (active) setError(String(e)); });
        return () => { active = false; };
    }, [publicationId]);

    const openUrl = async (url: string) => {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(url);
        } catch { window.open(url, '_blank'); }
    };

    const doUpload = async () => {
        if (!title.trim()) { notify('請輸入影片標題'); return; }
        if (thumbMode === 'ai' && !thumbSel) { notify('請先生成並選一款封面，或改用其他縮圖模式'); return; }
        setUploading(true);
        setError('');
        setProgress(0);
        try {
            const r = await api.ytUpload({
                video_path: videoPath,
                title: title.trim(),
                description: desc,
                tags: tags.split(/[,，\s]+/).filter(Boolean),
                privacy,
                thumbnail_time: thumbMode === 'frame' ? thumbnailTime : null,
                thumbnail_path: thumbMode === 'ai' ? thumbSel : undefined,
                publication_id: publicationId,
                include_srt: includeSrt,
            }, (pct, st) => { setProgress(pct); setStage(st || ''); });
            setResult(r);
        } catch (e) {
            setError(String(e));
            const partial = e as Error & { studio_url?: string };
            if (partial.studio_url) setPartialStudio(partial.studio_url);
        } finally {
            setUploading(false);
        }
    };

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '6px 8px', borderRadius: 4, boxSizing: 'border-box',
        border: '1px solid var(--bg-surface2)', background: 'var(--bg-surface0)', color: 'var(--fg-text)', fontSize: 13,
    };

    return (
        <div className="modal-overlay" onClick={uploading ? undefined : onClose}>
            <div className="modal-box" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="yt-upload-title" onClick={e => e.stopPropagation()} style={{ maxWidth: 1000, maxHeight: '88vh', overflowY: 'auto' }}>
                <div className="modal-header">
                    <h2 id="yt-upload-title">上傳到 YouTube</h2>
                    <button className="btn" onClick={onClose} disabled={uploading} style={{ padding: '4px 6px' }} aria-label="關閉" title="關閉（Esc）"><X aria-hidden /></button>
                </div>

                {stale && !result && (
                    <div className="stale-banner">
                        <StatusText kind="warn" text="匯出後專案又改過了，這支成品不含之後的修改。要上傳最新版本，請先重新匯出。" />
                        {onReexport && <button className="btn" onClick={onReexport} disabled={uploading}>重新匯出</button>}
                    </div>
                )}
                {!publication && <p role="status">{error || "正在讀取這次匯出的影片與字幕…"}</p>}
                {connected === false && (
                    <StatusText kind="warn" text="尚未連結 YouTube 帳號：請先到右上角「設定」完成連結。" />
                )}
                {publication && !result && (
                    <>
                        <div style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 8 }}>頻道：{channel || '(已連結)'}</div>
                        <dl className="export-summary">
                            <dt>成品長度</dt><dd>{formatTime(publication.duration)}</dd>
                            <dt>CC 字幕</dt><dd>{segments.length ? `${segments.length} 句，時間已配合片頭、剪接和變速對好` : '沒有（這支成品匯出時沒有字幕）'}</dd>
                        </dl>
                        {!segments.length && projectSubtitleCount > 0 && (
                            <div className="stale-banner">
                                <StatusText kind="warn" text={`專案現在有 ${projectSubtitleCount} 句字幕，但這支成品沒有。直接上傳的話，YouTube 上不會有 CC 字幕。`} />
                                {onReexport && <button className="btn" onClick={onReexport} disabled={uploading}>重新匯出</button>}
                            </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

                            <div>
                                <label>影片標題（可在選用封面後調整）
                                    <input aria-label="影片標題" value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} maxLength={100} disabled={uploading} />
                                </label>
                            </div>
                            <div>
                                <label>影片說明
                                    <textarea aria-label="影片說明" value={desc} onChange={e => setDesc(e.target.value)} rows={4}
                                        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} disabled={uploading}
                                        placeholder="選用下方 AI 封面後會帶入 AI 整理的標題與說明，也可直接手寫" />
                                </label>
                            </div>

                            {/* ── 標籤 / 隱私 ── */}
                            <div>
                                <label>標籤（逗號或空格分隔）
                                <input value={tags} onChange={e => setTags(e.target.value)} style={inputStyle}
                                    placeholder="Revit, BIM, 教學" disabled={uploading} />
                                </label>
                            </div>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                                <label htmlFor="yt-privacy">隱私</label>
                                <select id="yt-privacy" value={privacy} onChange={e => setPrivacy(e.target.value as typeof privacy)} disabled={uploading}
                                    style={{ ...inputStyle, width: 'auto' }}>
                                    <option value="private">私人（建議：上架前到 Studio 檢查再公開）</option>
                                    <option value="unlisted">不公開（有連結就能看）</option>
                                    <option value="public">公開（YouTube 可能先鎖成私人，需到後台改）</option>
                                </select>
                            </div>

                            {/* ── 封面縮圖 ── */}
                            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                                <div className="yt-field-label" id="yt-thumb-label">封面縮圖</div>
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                                    {([
                                        ['frame', '播放頭畫面'],
                                        ['ai', 'AI 封面（由 AI 助理準備）'],
                                        ['none', '不設定'],
                                    ] as const).map(([mode, label]) => (
                                        <label key={mode} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                                            <input type="radio" checked={thumbMode === mode} onChange={() => setThumbMode(mode)} disabled={uploading} />
                                            {label}
                                        </label>
                                    ))}
                                </div>
                                {thumbMode === 'ai' && <CoverPicker publication={publication} disabled={uploading}
                                    onSelect={setThumbSel} onAnalysis={a => { setTitle(a.title); setDesc(a.description); }} />}

                            </div>

                            {segments.length > 0 && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                                <input type="checkbox" checked={includeSrt} onChange={e => setIncludeSrt(e.target.checked)} disabled={uploading} />
                                自動掛上本次匯出的 SRT（{segments.length} 句，繁體中文 CC）
                            </label>}

                            <button className="btn btn-primary" onClick={doUpload} disabled={uploading || !!partialStudio || !title.trim() || !connected || (thumbMode === 'ai' && !thumbSel)}
                                style={{ justifyContent: 'center', marginTop: 4 }}>
                                <Upload aria-hidden />{uploading ? `${STAGE_LABEL[stage] || '上傳中'} ${progress}%` : '開始上傳'}
                            </button>
                            {!uploading && (() => {
                                const why = !connected ? '尚未連結 YouTube 帳號：請到「設定」完成連結'
                                    : !title.trim() ? '請輸入影片標題'
                                    : thumbMode === 'ai' && !thumbSel ? '請先選一款封面，或改用其他縮圖模式'
                                    : partialStudio ? '上次已部分上傳：請先檢查已上傳的影片，避免重複' : '';
                                return why ? <div className="field-hint" role="note">{why}</div> : null;
                            })()}
                            {uploading && (
                                <div className="progress-bar">
                                    <div className="fill" style={{ width: `${progress}%` }} />
                                </div>
                            )}
                            {error && <StatusText kind="error" text={error} />}
                            {partialStudio && <button className="btn" onClick={() => openUrl(partialStudio)}>檢查已上傳的影片（避免重複上傳）</button>}
                        </div>
                    </>
                )}
                {result && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
                        <StatusText kind="ok" className="yt-done" text="上傳完成" />
                        {(result.warnings || []).map((w, i) => (
                            <StatusText key={i} kind="warn" text={w} />
                        ))}
                        <button className="btn" onClick={() => openUrl(result.studio_url)} style={{ justifyContent: 'center' }}>
                            <ExternalLink aria-hidden />到 YouTube Studio 檢查／發佈
                        </button>
                        <button className="btn" onClick={() => openUrl(result.watch_url)} style={{ justifyContent: 'center' }}>
                            <Play aria-hidden />觀看影片頁
                        </button>
                        <button className="btn btn-primary" onClick={onClose} style={{ justifyContent: 'center' }}>完成</button>
                    </div>
                )}
            </div>
        </div>
    );
}
