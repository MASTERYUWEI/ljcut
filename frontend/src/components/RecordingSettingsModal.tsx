/* ── 螢幕錄影設定 Modal ── */
import type { RecOpts, RecQuality, RecFps, MicDevice } from '../types';

interface Props {
    recOpts: RecOpts;
    setRecOpts: React.Dispatch<React.SetStateAction<RecOpts>>;
    micDevices: MicDevice[];
    isTauri: boolean;
    micMeterFillRef: React.RefObject<HTMLDivElement | null>;
    micMeterValRef: React.RefObject<HTMLSpanElement | null>;
    onClose: () => void;
    onStartRec: () => void;
}

export function RecordingSettingsModal({
    recOpts, setRecOpts, micDevices, isTauri, micMeterFillRef, micMeterValRef, onClose, onStartRec,
}: Props) {
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>螢幕錄影設定</h3>
                    <button className="btn" onClick={onClose} style={{ padding: '2px 8px' }}>✕</button>
                </div>
                <div className="rec-setting-row">
                    <label>🔊 系統聲音</label>
                    <label className="toggle-switch" title={isTauri ? '需安裝 loopback 音訊裝置（如 VB-Cable）' : ''}>
                        <input type="checkbox" checked={recOpts.sysAudio}
                            disabled={isTauri && !recOpts.sysAudioDevice}
                            onChange={e => setRecOpts(o => ({ ...o, sysAudio: e.target.checked }))} />
                        <span className="toggle-slider" />
                    </label>
                    {isTauri && !recOpts.sysAudioDevice && (
                        <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 8 }}>需安裝 loopback 裝置</span>
                    )}
                </div>
                {recOpts.sysAudio && recOpts.sysAudioDevice && (
                    <div className="rec-setting-row" style={{ borderBottom: 'none', paddingTop: 0 }}>
                        <label style={{ fontSize: 12 }}>音量</label>
                        <input type="range" min="0" max="200" value={Math.round(recOpts.sysVol * 100)}
                            onChange={e => setRecOpts(o => ({ ...o, sysVol: parseInt(e.target.value) / 100 }))}
                            style={{ flex: 1, margin: '0 8px' }} />
                        <span style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>{Math.round(recOpts.sysVol * 100)}%</span>
                    </div>
                )}
                <div className="rec-setting-row">
                    <label>🎤 麥克風</label>
                    <label className="toggle-switch">
                        <input type="checkbox" checked={recOpts.mic}
                            onChange={e => setRecOpts(o => ({ ...o, mic: e.target.checked }))} />
                        <span className="toggle-slider" />
                    </label>
                </div>
                {recOpts.mic && (
                    <div className="mic-detail-panel">
                        <div className="rec-setting-row" style={{ borderBottom: 'none', paddingTop: 4 }}>
                            <label>裝置</label>
                            <select
                                className="mic-select"
                                value={recOpts.micDevice}
                                onChange={e => setRecOpts(o => ({ ...o, micDevice: e.target.value }))}
                            >
                                {micDevices.length === 0 && <option value="">偵測中…</option>}
                                {micDevices.map(d => (
                                    <option key={d.deviceId} value={d.label}>{d.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="mic-level-row">
                            <label>音量</label>
                            <div className="mic-meter">
                                <div ref={micMeterFillRef} className="mic-meter-empty" style={{ width: '100%' }} />
                            </div>
                            <span ref={micMeterValRef} className="mic-level-val">0%</span>
                        </div>
                    </div>
                )}
                {recOpts.mic && (
                    <div className="rec-setting-row" style={{ borderBottom: 'none', paddingTop: 0 }}>
                        <label style={{ fontSize: 12 }}>錄音音量</label>
                        <input type="range" min="0" max="200" value={Math.round(recOpts.micVol * 100)}
                            onChange={e => setRecOpts(o => ({ ...o, micVol: parseInt(e.target.value) / 100 }))}
                            style={{ flex: 1, margin: '0 8px' }} />
                        <span style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>{Math.round(recOpts.micVol * 100)}%</span>
                    </div>
                )}
                <div className="rec-setting-row">
                    <label>🎬 畫質</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                        {(['720p', '1080p', '4k'] as RecQuality[]).map(q => (
                            <button key={q}
                                className={`btn rec-quality-btn ${recOpts.quality === q ? 'active' : ''}`}
                                onClick={() => setRecOpts(o => ({ ...o, quality: q }))}>{q.toUpperCase()}</button>
                        ))}
                    </div>
                </div>
                <div className="rec-setting-row">
                    <label>🎞️ FPS</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                        {([24, 30, 60] as RecFps[]).map(f => (
                            <button key={f}
                                className={`btn rec-quality-btn ${recOpts.fps === f ? 'active' : ''}`}
                                onClick={() => setRecOpts(o => ({ ...o, fps: f }))}>{f}</button>
                        ))}
                    </div>
                </div>
                <div className="rec-setting-row">
                    <label>🖱️ 滑鼠光暈</label>
                    {recOpts.cursorGlow && (
                        <input type="color" value={recOpts.glowColor}
                            onChange={e => setRecOpts(o => ({ ...o, glowColor: e.target.value }))}
                            title="光暈顏色"
                            style={{ width: 34, height: 24, marginLeft: 'auto', marginRight: 8, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
                    )}
                    <label className="toggle-switch">
                        <input type="checkbox" checked={recOpts.cursorGlow}
                            onChange={e => setRecOpts(o => ({ ...o, cursorGlow: e.target.checked }))} />
                        <span className="toggle-slider" />
                    </label>
                </div>
                <div className="rec-setting-row">
                    <label>✨ 點擊特效</label>
                    {recOpts.clickEffect && (
                        <input type="color" value={recOpts.clickColor}
                            onChange={e => setRecOpts(o => ({ ...o, clickColor: e.target.value }))}
                            title="點擊漣漪顏色"
                            style={{ width: 34, height: 24, marginLeft: 'auto', marginRight: 8, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
                    )}
                    <label className="toggle-switch">
                        <input type="checkbox" checked={recOpts.clickEffect}
                            onChange={e => setRecOpts(o => ({ ...o, clickEffect: e.target.checked }))} />
                        <span className="toggle-slider" />
                    </label>
                </div>
                <button className="btn btn-accent" onClick={onStartRec}
                    style={{ width: '100%', justifyContent: 'center', marginTop: 16, padding: '10px 0', fontSize: 14 }}>
                    ⏺ 開始錄影
                </button>
            </div>
        </div>
    );
}
