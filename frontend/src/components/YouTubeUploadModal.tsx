/* Export-bound captions, Codex cover selection and YouTube upload. */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { controlRequest } from '../controlClient';
import { CoverPicker, type Publication } from './CoverPicker';

interface Props {
    videoPath: string;
    defaultTitle: string;
    defaultDescription: string;
    publicationId: string;
    thumbnailTime: number;
    onClose: () => void;
}

const STAGE_LABEL: Record<string, string> = {
    init: '建立上傳工作…',
    upload: '上傳影片中',
    thumbnail: '設定縮圖…',
    caption: '設定已對齊的 SRT 字幕…',
    publish: '設定影片公開狀態…',
};

export function YouTubeUploadModal({ videoPath, defaultTitle, defaultDescription, publicationId, thumbnailTime, onClose }: Props) {
    const [connected, setConnected] = useState<boolean | null>(null);
    const [channel, setChannel] = useState('');
    const [title, setTitle] = useState(defaultTitle);
    const [desc, setDesc] = useState(defaultDescription);
    const [tags, setTags] = useState('');
    const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
    const [publication, setPublication] = useState<Publication | null>(null);
    const segments = publication?.segments ?? [];
    const [includeSrt, setIncludeSrt] = useState(true);

    // 縮圖：frame=播放頭畫面 / ai=AI 封面 / none
    const [thumbMode, setThumbMode] = useState<'frame' | 'ai' | 'none'>('ai');
    const [thumbSel, setThumbSel] = useState('');

    const [uploading, setUploading] = useState(false);
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
        if (!title.trim()) { alert('請輸入影片標題'); return; }
        if (thumbMode === 'ai' && !thumbSel) { alert('請先生成並選一款封面，或改用其他縮圖模式'); return; }
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
        border: '1px solid #444', background: '#1e1e1e', color: '#eee', fontSize: 13,
    };

    return (
        <div className="modal-overlay" onClick={uploading ? undefined : onClose}>
            <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 1000, maxHeight: '88vh', overflowY: 'auto' }}>
                <div className="modal-header">
                    <h3>⬆️ 上傳到 YouTube</h3>
                    <button className="btn" onClick={onClose} disabled={uploading} style={{ padding: '2px 8px' }}>✕</button>
                </div>

                {!publication && <p role="status">{error || "正在讀取這次匯出的影片與字幕…"}</p>}
                {connected === false && (
                    <div style={{ fontSize: 13, color: '#ffb74d', padding: '8px 0' }}>
                        ⚠️ 尚未連結 YouTube 帳號 — 請先到「設定 ⚙」完成連結。
                    </div>
                )}
                {publication && !result && (
                    <>
                        <div style={{ fontSize: 12, color: '#7cb27c', marginBottom: 8 }}>頻道：{channel || '(已連結)'}</div>
                        <p style={{ fontSize: 12 }}>本次成品 {publication.duration.toFixed(2)} 秒；主片從 {publication.mainStart.toFixed(2)} 秒開始。字幕已含片頭、裁切及變速換算，不會再次加偏移。匯出後的剪輯修改需重新匯出才會使用。</p>
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
                                        placeholder="選用下方封面後帶入 Codex 整理的標題與說明，也可手動修改" />
                                </label>
                            </div>

                            {/* ── 標籤 / 隱私 ── */}
                            <div>
                                <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>標籤（逗號或空格分隔）</div>
                                <input value={tags} onChange={e => setTags(e.target.value)} style={inputStyle}
                                    placeholder="Revit, BIM, 教學" disabled={uploading} />
                            </div>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                                <span style={{ color: '#999', fontSize: 12 }}>隱私</span>
                                <select value={privacy} onChange={e => setPrivacy(e.target.value as typeof privacy)} disabled={uploading}
                                    style={{ ...inputStyle, width: 'auto' }}>
                                    <option value="private">私人（建議：上架前到 Studio 檢查再公開）</option>
                                    <option value="unlisted">不公開（有連結就能看）</option>
                                    <option value="public">公開（未審核 API 專案會被強制轉私人）</option>
                                </select>
                            </div>

                            {/* ── 封面縮圖 ── */}
                            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>封面縮圖</div>
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                                    {([
                                        ['frame', '播放頭畫面'],
                                        ['ai', '🎨 AI 生成封面（2.5D 像素風）'],
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

                            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: segments.length ? 'pointer' : 'not-allowed', opacity: segments.length ? 1 : 0.5 }}>
                                <input type="checkbox" checked={includeSrt} onChange={e => setIncludeSrt(e.target.checked)} disabled={uploading || !segments.length} />
                                自動掛上本次匯出的 SRT（{segments.length} 句，繁體中文 CC）
                            </label>

                            <button className="btn btn-primary" onClick={doUpload} disabled={uploading || !!partialStudio || !title.trim() || !connected || (thumbMode === 'ai' && !thumbSel)}
                                style={{ justifyContent: 'center', marginTop: 4 }}>
                                {uploading ? `⬆️ ${STAGE_LABEL[stage] || '上傳中'} ${progress}%` : '⬆️ 開始上傳'}
                            </button>
                            {uploading && (
                                <div className="progress-bar">
                                    <div className="fill" style={{ width: `${progress}%` }} />
                                </div>
                            )}
                            {error && <div style={{ fontSize: 12, color: '#ff8a80', whiteSpace: 'pre-wrap' }}>❌ {error}</div>}
                            {partialStudio && <button className="btn" onClick={() => openUrl(partialStudio)}>檢查已上傳的影片（避免重複上傳）</button>}
                        </div>
                    </>
                )}
                {result && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
                        <div style={{ fontSize: 15, color: '#7cb27c' }}>🎉 上傳完成！</div>
                        {(result.warnings || []).map((w, i) => (
                            <div key={i} style={{ fontSize: 12, color: '#ffb74d' }}>⚠ {w}</div>
                        ))}
                        <button className="btn" onClick={() => openUrl(result.studio_url)} style={{ justifyContent: 'center' }}>
                            🛠 到 YouTube Studio 檢查/發佈
                        </button>
                        <button className="btn" onClick={() => openUrl(result.watch_url)} style={{ justifyContent: 'center' }}>
                            ▶️ 觀看影片頁
                        </button>
                        <button className="btn btn-primary" onClick={onClose} style={{ justifyContent: 'center' }}>完成</button>
                    </div>
                )}
            </div>
        </div>
    );
}
