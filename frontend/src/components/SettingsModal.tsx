/* ── 設定 Modal（輸出目錄 / SRT 目錄 / Gemini API Key）── */
import { useEffect, useState } from 'react';
import type { AppSettings } from '../types';
import { api } from '../api';

interface Props {
    settings: AppSettings;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
    onClose: () => void;
}

const APPLY_KEY_URL = 'https://aistudio.google.com/apikey';

export function SettingsModal({ settings, setSettings, onClose }: Props) {
    const pickDir = async (key: 'outputDir' | 'srtDir', title: string) => {
        try {
            const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
            if (IS_TAURI) {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const selected = await open({ directory: true, title });
                if (selected) setSettings(s => ({ ...s, [key]: String(selected) }));
            } else {
                const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
                setSettings(s => ({ ...s, [key]: handle.name }));
            }
        } catch { /* 使用者取消 */ }
    };

    // ── Gemini API Key ──
    const [keyInfo, setKeyInfo] = useState<{ has_key: boolean; masked: string }>({ has_key: false, masked: '' });
    const [keyInput, setKeyInput] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    // 沒金鑰 → 直接顯示輸入框；有金鑰 → 顯示遮罩狀態，按「變更」才進入編輯
    const editing = !keyInfo.has_key || isEditing;

    useEffect(() => {
        api.getApiKeyInfo().then(setKeyInfo).catch(() => { });
    }, []);

    // ── AI 模型（動態偵測 Google 最新 Flash）──
    const [modelInfo, setModelInfo] = useState<{ current: string; best: string; update_available: boolean; current_alive: boolean | null } | null>(null);
    const [switching, setSwitching] = useState(false);

    const loadModelInfo = () => { api.getAiModel().then(setModelInfo).catch(() => { }); };
    useEffect(() => { loadModelInfo(); }, []);

    // ── 金鑰健康度實測 ──
    const [testing, setTesting] = useState(false);
    const [health, setHealth] = useState('');

    const testKey = async () => {
        setTesting(true);
        setHealth('');
        try {
            const r = await api.checkAiHealth();
            if (r.ok) {
                setHealth(`✅ 金鑰正常 — 模型 ${r.model} 實際回應，延遲 ${((r.latency_ms ?? 0) / 1000).toFixed(1)} 秒`);
                loadModelInfo(); // 若健檢觸發自動換模型，同步顯示
            } else {
                setHealth(`❌ ${r.error || '未知錯誤'}${r.detail ? `\n${r.detail}` : ''}`);
            }
        } catch (e) { setHealth(`❌ 測試失敗：${e}`); }
        finally { setTesting(false); }
    };

    // ── YouTube 連結 ──
    const [yt, setYt] = useState<{ configured: boolean; connected: boolean; channel?: string; auth_error?: string } | null>(null);
    const [ytCid, setYtCid] = useState('');
    const [ytSecret, setYtSecret] = useState('');
    const [ytBusy, setYtBusy] = useState(false);
    const [ytMsg, setYtMsg] = useState('');

    const loadYt = () => { api.ytStatus().then(setYt).catch(() => { }); };
    useEffect(() => { loadYt(); }, []);

    const saveYtCreds = async () => {
        if (!ytCid.trim() || !ytSecret.trim()) return;
        setYtBusy(true);
        setYtMsg('');
        try {
            await api.ytSetCredentials(ytCid.trim(), ytSecret.trim());
            setYtCid(''); setYtSecret('');
            loadYt();
            setYtMsg('✅ 憑證已儲存，請按「連結 YouTube 帳號」完成授權');
        } catch (e) { setYtMsg(`❌ ${e}`); }
        finally { setYtBusy(false); }
    };

    const connectYt = async () => {
        setYtBusy(true);
        setYtMsg('');
        try {
            const r = await api.ytAuthStart();
            if (!r.ok || !r.auth_url) { setYtMsg(`❌ ${r.error || '啟動授權失敗'}`); return; }
            const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
            if (IS_TAURI) {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(r.auth_url);
            } else { window.open(r.auth_url, '_blank'); }
            setYtMsg('🔗 已開啟瀏覽器，請用你的 Google 帳號完成授權…');
            for (let i = 0; i < 90; i++) {
                await new Promise(res => setTimeout(res, 2000));
                const s = await api.ytStatus();
                if (s.connected) { setYt(s); setYtMsg(`✅ 已連結頻道：${s.channel || ''}`); return; }
                if (s.auth_error) { setYtMsg(`❌ ${s.auth_error}`); return; }
            }
            setYtMsg('⚠️ 等待授權逾時，請重新按「連結」');
        } catch (e) { setYtMsg(`❌ ${e}`); }
        finally { setYtBusy(false); }
    };

    // ── 版本與更新 ──
    const [appVer, setAppVer] = useState('');
    const [updBusy, setUpdBusy] = useState(false);
    const [updMsg, setUpdMsg] = useState('');

    useEffect(() => {
        (async () => {
            try {
                const { getVersion } = await import('@tauri-apps/api/app');
                setAppVer(await getVersion());
            } catch { /* 非 Tauri */ }
        })();
    }, []);

    const checkUpdate = async () => {
        setUpdBusy(true);
        setUpdMsg('');
        try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const update = await check();
            if (!update) { setUpdMsg('✅ 已是最新版本'); return; }
            const yes = window.confirm(`發現新版本 v${update.version}（目前 v${update.currentVersion}），現在下載並安裝？`);
            if (yes) {
                setUpdMsg('⬇️ 下載更新中，完成後會自動重啟…');
                await update.downloadAndInstall();
                const { relaunch } = await import('@tauri-apps/plugin-process');
                await relaunch();
            }
        } catch (e) { setUpdMsg(`❌ 檢查失敗：${e}（開發模式無更新功能）`); }
        finally { setUpdBusy(false); }
    };

    const switchModel = async (target: string) => {
        setSwitching(true);
        try {
            const r = await api.setAiModel(target);
            if (r.ok) loadModelInfo();
            else if (r.error) alert(r.error);
        } catch (e) { alert(`切換失敗: ${e}`); }
        finally { setSwitching(false); }
    };

    const saveKey = async () => {
        const k = keyInput.trim();
        if (!k) return;
        setSaving(true);
        setSaveMsg('');
        try {
            const r = await api.setApiKey(k);
            setKeyInfo({ has_key: r.has_key, masked: r.masked });
            setKeyInput('');
            setShowKey(false);
            setIsEditing(false);
            setSaveMsg(r.status?.available
                ? '✅ 金鑰有效，已儲存'
                : `⚠️ 已儲存，但驗證失敗：${r.status?.error || '未知錯誤'}`);
        } catch (e) {
            setSaveMsg(`❌ 儲存失敗：${e}`);
        } finally {
            setSaving(false);
        }
    };

    const applyKey = async () => {
        try {
            const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
            if (IS_TAURI) {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(APPLY_KEY_URL);
            } else {
                window.open(APPLY_KEY_URL, '_blank');
            }
        } catch { /* 忽略 */ }
    };

    const inputStyle: React.CSSProperties = {
        flex: 1, padding: '6px 8px', borderRadius: 4,
        border: '1px solid #444', background: '#1e1e1e', color: '#eee', fontSize: 13,
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>設定</h3>
                    <button className="btn" onClick={onClose} style={{ padding: '2px 8px' }}>✕</button>
                </div>
                <div className="style-row">
                    <label>輸出目錄</label>
                    <button className="folder-pick-btn" onClick={() => pickDir('outputDir', '選擇輸出目錄')}>
                        <span>{settings.outputDir || '點擊選擇資料夾...'}</span>
                        <span className="folder-icon">📁</span>
                    </button>
                </div>
                <div className="style-row">
                    <label>SRT 存放目錄</label>
                    <button className="folder-pick-btn" onClick={() => pickDir('srtDir', '選擇 SRT 存放目錄')}>
                        <span>{settings.srtDir || '預設：與輸出相同'}</span>
                        <span className="folder-icon">📁</span>
                    </button>
                </div>

                {/* ── Gemini API Key ── */}
                <div className="style-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                    <label>Gemini API Key</label>

                    {!editing ? (
                        // 已設定：顯示遮罩 + 變更按鈕（不再是空白框）
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#4caf50', fontSize: 13 }}>
                                ✅ 已設定金鑰：<code style={{ background: '#1e1e1e', padding: '2px 6px', borderRadius: 4 }}>{keyInfo.masked}</code>
                            </span>
                            <button className="btn" onClick={() => { setIsEditing(true); setKeyInput(''); setSaveMsg(''); }}
                                style={{ marginLeft: 'auto', padding: '0 12px' }}>
                                變更金鑰
                            </button>
                        </div>
                    ) : (
                        // 編輯中（無金鑰或按了變更）：輸入框 + 顯示切換 + 儲存（+ 有舊金鑰時可取消）
                        <>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                    type={showKey ? 'text' : 'password'}
                                    value={keyInput}
                                    onChange={e => setKeyInput(e.target.value)}
                                    placeholder={keyInfo.has_key ? '貼上新的 API Key...' : '貼上你的 API Key...'}
                                    autoComplete="off"
                                    spellCheck={false}
                                    style={inputStyle}
                                />
                                <button className="btn" onClick={() => setShowKey(s => !s)}
                                    title={showKey ? '隱藏' : '顯示'} style={{ padding: '0 10px' }}>
                                    {showKey ? '🙈' : '👁'}
                                </button>
                                <button className="btn btn-primary" onClick={saveKey}
                                    disabled={saving || !keyInput.trim()} style={{ padding: '0 12px' }}>
                                    {saving ? '儲存中...' : '儲存'}
                                </button>
                                {keyInfo.has_key && (
                                    <button className="btn" onClick={() => { setIsEditing(false); setKeyInput(''); setShowKey(false); setSaveMsg(''); }}
                                        style={{ padding: '0 12px' }}>
                                        取消
                                    </button>
                                )}
                            </div>
                            <button className="btn" onClick={applyKey} style={{ justifyContent: 'center' }}
                                title="開啟 Google AI Studio 申請金鑰">
                                🔑 一鍵申請 API Key
                            </button>
                        </>
                    )}
                    <button className="btn" disabled={testing || !keyInfo.has_key} onClick={testKey}
                        style={{ justifyContent: 'center' }}
                        title="實際呼叫一次 Gemini API，確認金鑰真的能拿到回應">
                        {testing ? '🩺 測試中...' : '🩺 測試金鑰健康度'}
                    </button>
                    {health && (
                        <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: health.startsWith('✅') ? '#7cb27c' : '#ff8a80' }}>
                            {health}
                        </div>
                    )}
                    {saveMsg && <div style={{ fontSize: 12, color: '#ccc' }}>{saveMsg}</div>}
                </div>

                {/* ── AI 模型（Gemini）── */}
                <div className="style-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <label>AI 模型（Gemini）</label>
                    {modelInfo ? (
                        <>
                            <div style={{ fontSize: 13, color: modelInfo.current_alive === false ? '#ff9800' : '#ccc' }}>
                                目前：<code style={{ background: '#1e1e1e', padding: '2px 6px', borderRadius: 4 }}>{modelInfo.current}</code>
                                {modelInfo.current_alive === false && '　⚠️ 此模型已被 Google 下架（呼叫時會自動換新）'}
                            </div>
                            {modelInfo.update_available ? (
                                <button className="btn" disabled={switching} onClick={() => switchModel(modelInfo.best)}
                                    style={{ justifyContent: 'center', color: '#ffd54f' }}
                                    title="Google 已推出較新的 Flash 模型，點擊切換並儲存">
                                    {switching ? '切換中...' : `✨ Google 有新模型 ${modelInfo.best} — 點此切換`}
                                </button>
                            ) : modelInfo.best ? (
                                <div style={{ fontSize: 12, color: '#7cb27c' }}>✅ 已是最新的 Flash 模型</div>
                            ) : (
                                <div style={{ fontSize: 12, color: '#888' }}>（需先設定有效的 API Key 才能檢查新版）</div>
                            )}
                        </>
                    ) : (
                        <div style={{ fontSize: 12, color: '#888' }}>模型資訊載入中…</div>
                    )}
                </div>

                {/* ── YouTube 上傳連結 ── */}
                <div className="style-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <label>YouTube 上傳</label>
                    {yt?.connected ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                            <span style={{ color: '#4caf50' }}>✅ 已連結頻道：{yt.channel || '(讀取中)'}</span>
                            <button className="btn" style={{ marginLeft: 'auto', padding: '0 10px' }}
                                onClick={async () => { await api.ytDisconnect(); loadYt(); setYtMsg(''); }}>
                                解除連結
                            </button>
                        </div>
                    ) : (
                        <>
                            {!yt?.configured && (
                                <>
                                    <input value={ytCid} onChange={e => setYtCid(e.target.value)}
                                        placeholder="OAuth 用戶端 ID（xxx.apps.googleusercontent.com）"
                                        autoComplete="off" spellCheck={false} style={inputStyle} />
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <input value={ytSecret} onChange={e => setYtSecret(e.target.value)}
                                            placeholder="用戶端密鑰" type="password" autoComplete="off" style={inputStyle} />
                                        <button className="btn btn-primary" disabled={ytBusy || !ytCid.trim() || !ytSecret.trim()}
                                            onClick={saveYtCreds} style={{ padding: '0 12px' }}>儲存</button>
                                    </div>
                                </>
                            )}
                            <button className="btn" disabled={ytBusy || !yt?.configured} onClick={connectYt}
                                style={{ justifyContent: 'center' }}
                                title={yt?.configured ? '開啟瀏覽器完成 Google 授權（一次性）' : '請先儲存 OAuth 憑證'}>
                                {ytBusy ? '⏳ 等待授權中...' : '🔗 連結 YouTube 帳號'}
                            </button>
                            {yt?.configured && (
                                <button className="btn" style={{ justifyContent: 'center', fontSize: 12 }}
                                    onClick={async () => { await api.ytSetCredentials('', ''); loadYt(); setYtMsg('已清除憑證'); }}>
                                    重設憑證
                                </button>
                            )}
                        </>
                    )}
                    {ytMsg && <div style={{ fontSize: 12, color: ytMsg.startsWith('❌') ? '#ff8a80' : '#ccc', whiteSpace: 'pre-wrap' }}>{ytMsg}</div>}
                </div>

                {/* ── 版本與更新 ── */}
                <div className="style-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <label>版本</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        <span style={{ color: '#ccc' }}>LJCUT v{appVer || '—'}</span>
                        <button className="btn" disabled={updBusy} onClick={checkUpdate}
                            style={{ marginLeft: 'auto', padding: '0 12px' }}
                            title="向 GitHub Releases 檢查是否有新版本">
                            {updBusy ? '⏳ 檢查中...' : '🔄 檢查更新'}
                        </button>
                    </div>
                    {updMsg && <div style={{ fontSize: 12, color: updMsg.startsWith('❌') ? '#ff8a80' : '#7cb27c' }}>{updMsg}</div>}
                </div>
            </div>
        </div>
    );
}
