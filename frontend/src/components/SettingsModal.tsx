/* ── 設定 Modal（輸出目錄 / SRT 目錄）── */
import type { AppSettings } from '../types';

interface Props {
    settings: AppSettings;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
    onClose: () => void;
}

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
            </div>
        </div>
    );
}
