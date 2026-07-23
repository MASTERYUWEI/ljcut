/* ── YouTube 上傳 Modal：AI 標題 5 選 1 → AI 封面 5 選 1（2.5D 像素風）→ 一鍵上架 ── */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Segment } from '../types';

interface Props {
    videoPath: string;
    defaultTitle: string;
    defaultDescription: string;
    segments: Segment[];
    thumbnailTime: number;
    onClose: () => void;
}

const STAGE_LABEL: Record<string, string> = {
    init: '建立上傳工作…',
    upload: '上傳影片中',
    thumbnail: '設定縮圖…',
    caption: '注入 SRT 字幕…',
};

export function YouTubeUploadModal({ videoPath, defaultTitle, defaultDescription, segments, thumbnailTime, onClose }: Props) {
    const [connected, setConnected] = useState<boolean | null>(null);
    const [channel, setChannel] = useState('');
    const [title, setTitle] = useState(defaultTitle);
    const [desc, setDesc] = useState(defaultDescription);
    const [tags, setTags] = useState('');
    const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
    const [includeSrt, setIncludeSrt] = useState(segments.length > 0);

    // AI 標題候選
    const [titleOptions, setTitleOptions] = useState<string[]>([]);
    const [titleLoading, setTitleLoading] = useState(false);

    // AI 描述 / 更多文案
    const [descLoading, setDescLoading] = useState(false);
    const [extraType, setExtraType] = useState<'summary' | 'marketing' | null>(null);
    const [extraText, setExtraText] = useState('');
    const [extraLoading, setExtraLoading] = useState(false);
    const [extraCopied, setExtraCopied] = useState(false);

    // 縮圖：frame=播放頭畫面 / ai=AI 封面 / none
    const [thumbMode, setThumbMode] = useState<'frame' | 'ai' | 'none'>('frame');
    const [thumbCands, setThumbCands] = useState<{ file: string; url: string }[]>([]);
    const [thumbSel, setThumbSel] = useState<string>('');
    const [thumbLoading, setThumbLoading] = useState(false);
    const [thumbMsg, setThumbMsg] = useState('');
    const [thumbVer, setThumbVer] = useState(0); // 破快取用
    const [thumbTitleUsed, setThumbTitleUsed] = useState(''); // 生成封面當下的標題（偵測過期）

    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [stage, setStage] = useState('');
    const [result, setResult] = useState<{ watch_url: string; studio_url: string; warnings?: string[] } | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.ytStatus()
            .then(s => { setConnected(!!s.connected); setChannel(s.channel || ''); })
            .catch(() => setConnected(false));
    }, []);

    const openUrl = async (url: string) => {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(url);
        } catch { window.open(url, '_blank'); }
    };

    const genDesc = async () => {
        if (!segments.length) { alert('沒有字幕可參考，請先辨識字幕'); return; }
        setDescLoading(true);
        try { setDesc(await api.aiGenerate(segments, 'youtube')); }
        catch (e) { alert(`生成失敗: ${e}`); }
        finally { setDescLoading(false); }
    };

    const genExtra = async (kind: 'summary' | 'marketing') => {
        if (!segments.length) { alert('沒有字幕可參考，請先辨識字幕'); return; }
        setExtraType(kind);
        setExtraLoading(true);
        setExtraText('');
        setExtraCopied(false);
        try { setExtraText(await api.aiGenerate(segments, kind)); }
        catch (e) { setExtraText(`❌ ${e}`); }
        finally { setExtraLoading(false); }
    };

    const genTitles = async () => {
        if (!segments.length && !desc) { alert('沒有字幕/大綱可參考，請先辨識字幕'); return; }
        setTitleLoading(true);
        try {
            const src = segments.length ? segments.map(s => s.text) : [desc];
            const r = await api.aiTitles(src);
            if (!r.ok) { alert(r.error || '標題生成失敗'); return; }
            setTitleOptions(r.titles);
        } catch (e) { alert(`標題生成失敗: ${e}`); }
        finally { setTitleLoading(false); }
    };

    const genThumbs = async () => {
        if (!title.trim()) { alert('請先選定/輸入標題，封面會把標題合成上去'); return; }
        if (title.trim() === defaultTitle.trim()) {
            const ok = window.confirm(
                `目前標題還是預設檔名：
「${title.trim()}」

封面會把這串檔名當標題畫上去。
建議先按「✨ AI 標題 5 款」選好標題再生成封面。

仍要用檔名生成嗎？`
            );
            if (!ok) return;
        }
        setThumbLoading(true);
        setThumbMsg('');
        setThumbCands([]);
        setThumbSel('');
        try {
            const transcript = segments.map(s => s.text).join('\n').slice(0, 8000);
            const r = await api.ytGenThumbnails(title.trim(), transcript, 5);
            if (!r.ok) { setThumbMsg(`❌ ${r.error || '封面生成失敗'}`); return; }
            setThumbCands(r.items);
            setThumbVer(v => v + 1);
            setThumbTitleUsed(title.trim());
            if (r.items.length) setThumbSel(r.items[0].file);
            setThumbMsg(`✅ 生成 ${r.items.length} 款，點一款選用`);
        } catch (e) { setThumbMsg(`❌ ${e}`); }
        finally { setThumbLoading(false); }
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
                segments: includeSrt ? segments : [],
            }, (pct, st) => { setProgress(pct); setStage(st || ''); });
            setResult(r);
        } catch (e) {
            setError(String(e));
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
            <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 600, maxHeight: '88vh', overflowY: 'auto' }}>
                <div className="modal-header">
                    <h3>⬆️ 上傳到 YouTube</h3>
                    <button className="btn" onClick={onClose} disabled={uploading} style={{ padding: '2px 8px' }}>✕</button>
                </div>

                {connected === false && (
                    <div style={{ fontSize: 13, color: '#ffb74d', padding: '8px 0' }}>
                        ⚠️ 尚未連結 YouTube 帳號 — 請先到「設定 ⚙」完成連結。
                    </div>
                )}
                {connected && !result && (
                    <>
                        <div style={{ fontSize: 12, color: '#7cb27c', marginBottom: 8 }}>頻道：{channel || '(已連結)'}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

                            {/* ── 標題 + AI 5 款 ── */}
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ fontSize: 12, color: '#999' }}>標題（必填，100 字內）</span>
                                    <button className="btn" onClick={genTitles} disabled={titleLoading || uploading}
                                        style={{ marginLeft: 'auto', padding: '0 10px', fontSize: 12 }}
                                        title="依字幕/大綱產 5 個不同風格的標題候選">
                                        {titleLoading ? '✨ 生成中...' : '✨ AI 標題 5 款'}
                                    </button>
                                </div>
                                <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} maxLength={100} disabled={uploading} />
                                {titleOptions.length > 0 && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                                        {titleOptions.map((t, i) => (
                                            <button key={i} className="btn"
                                                onClick={() => setTitle(t)}
                                                style={{
                                                    justifyContent: 'flex-start', fontSize: 12, textAlign: 'left',
                                                    border: title === t ? '1px solid var(--accent-amber, #f0b050)' : undefined,
                                                }}
                                                title="點擊採用這個標題">
                                                {title === t ? '✅ ' : ''}{t}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* ── 描述（AI 生成整合於此）── */}
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ fontSize: 12, color: '#999' }}>描述</span>
                                    <button className="btn" onClick={genDesc} disabled={descLoading || uploading}
                                        style={{ marginLeft: 'auto', padding: '0 10px', fontSize: 12 }}
                                        title="依字幕內容生成 YouTube 說明欄（含章節時間軸）">
                                        {descLoading ? '✨ 生成中...' : (desc ? '✨ 重新生成' : '✨ AI 生成描述')}
                                    </button>
                                </div>
                                <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={5}
                                    style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} disabled={uploading}
                                    placeholder="可手動輸入，或按「AI 生成描述」自動撰寫" />
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                                    <span style={{ fontSize: 12, color: '#777' }}>更多文案：</span>
                                    <button className="btn" onClick={() => genExtra('summary')} disabled={extraLoading || uploading}
                                        style={{ padding: '0 10px', fontSize: 12 }} title="產生影片摘要（自用/社群）">📝 摘要</button>
                                    <button className="btn" onClick={() => genExtra('marketing')} disabled={extraLoading || uploading}
                                        style={{ padding: '0 10px', fontSize: 12 }} title="產生 IG/FB 行銷貼文">📣 行銷貼文</button>
                                </div>
                                {extraType && (
                                    <div style={{ marginTop: 6 }}>
                                        <textarea value={extraLoading ? '⏳ 生成中...' : extraText} readOnly rows={4}
                                            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', color: '#ccc' }} />
                                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                            <button className="btn" disabled={extraLoading || !extraText || extraText.startsWith('❌')}
                                                onClick={() => { navigator.clipboard.writeText(extraText); setExtraCopied(true); setTimeout(() => setExtraCopied(false), 1500); }}
                                                style={{ padding: '0 10px', fontSize: 12 }}>
                                                {extraCopied ? '✅ 已複製' : '📋 複製'}
                                            </button>
                                            <button className="btn" onClick={() => setExtraType(null)}
                                                style={{ padding: '0 10px', fontSize: 12 }}>收合</button>
                                        </div>
                                    </div>
                                )}
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
                                {thumbMode === 'ai' && (
                                    <div style={{ marginTop: 8 }}>
                                        <button className="btn" onClick={genThumbs} disabled={thumbLoading || uploading || !title.trim()}
                                            style={{ width: '100%', justifyContent: 'center' }}
                                            title="用固定風格模板生成 5 款候選（標題會直接合成在封面上）">
                                            {thumbLoading ? '🎨 生成中（約 20-40 秒）...' : (thumbCands.length ? '🎨 重新生成 5 款' : '🎨 生成 5 款封面')}
                                        </button>
                                        {thumbLoading && <div className="progress-bar"><div className="fill loading" style={{ width: '100%' }} /></div>}
                                        {thumbCands.length > 0 && (
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                                                {thumbCands.map(c => (
                                                    <img key={c.file}
                                                        src={`${api.outputUrl(c.url)}?v=${thumbVer}`}
                                                        onClick={() => setThumbSel(c.file)}
                                                        style={{
                                                            width: '100%', aspectRatio: '16/9', objectFit: 'cover',
                                                            borderRadius: 8, cursor: 'pointer',
                                                            border: thumbSel === c.file ? '3px solid var(--accent-amber, #f0b050)' : '3px solid transparent',
                                                            boxSizing: 'border-box',
                                                        }}
                                                        title="點擊選用這款封面" />
                                                ))}
                                            </div>
                                        )}
                                        {thumbMsg && <div style={{ fontSize: 12, color: thumbMsg.startsWith('❌') ? '#ff8a80' : '#7cb27c', marginTop: 4 }}>{thumbMsg}</div>}
                                        {thumbCands.length > 0 && thumbTitleUsed && thumbTitleUsed !== title.trim() && (
                                            <div style={{ fontSize: 12, color: '#ffb74d', marginTop: 4 }}>
                                                ⚠ 標題已變更 — 封面上畫的還是舊標題「{thumbTitleUsed}」，建議按「重新生成 5 款」
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: segments.length ? 'pointer' : 'not-allowed', opacity: segments.length ? 1 : 0.5 }}>
                                <input type="checkbox" checked={includeSrt} onChange={e => setIncludeSrt(e.target.checked)} disabled={uploading || !segments.length} />
                                自動掛上 SRT 字幕（{segments.length} 句，繁體中文 CC）
                            </label>

                            <button className="btn btn-primary" onClick={doUpload} disabled={uploading || !title.trim()}
                                style={{ justifyContent: 'center', marginTop: 4 }}>
                                {uploading ? `⬆️ ${STAGE_LABEL[stage] || '上傳中'} ${progress}%` : '⬆️ 開始上傳'}
                            </button>
                            {uploading && (
                                <div className="progress-bar">
                                    <div className="fill" style={{ width: `${progress}%` }} />
                                </div>
                            )}
                            {error && <div style={{ fontSize: 12, color: '#ff8a80', whiteSpace: 'pre-wrap' }}>❌ {error}</div>}
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
