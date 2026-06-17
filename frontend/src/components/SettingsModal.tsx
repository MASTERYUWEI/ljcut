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
                    {saveMsg && <div style={{ fontSize: 12, color: '#ccc' }}>{saveMsg}</div>}
                </div>
            </div>
        </div>
    );
}
