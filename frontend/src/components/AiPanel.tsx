/* ── AI 文案助手面板（可折疊）── */
import { RefreshCw, Check } from 'lucide-react';
import type { RefObject } from 'react';

interface AiTab {
    key: string;
    label: string;
}

interface Props {
    expanded: boolean;
    onToggle: () => void;
    tabs: ReadonlyArray<AiTab>;
    activeTab: string;
    onSelectTab: (key: string) => void;
    loadingType: string | null;
    /** 結果存在 ref（避免 stale closure）；父層以 forceRender 觸發重繪反映內容 */
    results: RefObject<Record<string, string>>;
    copied: boolean;
    onCopy: (text: string) => void;
    onRefresh: () => void;
}

export function AiPanel({
    expanded, onToggle, tabs, activeTab, onSelectTab, loadingType, results, copied, onCopy, onRefresh,
}: Props) {
    return (
        <div className="ai-collapse">
            {/* 標題列：展開鈕與重新生成鈕並排（按鈕不可巢狀，螢幕閱讀器才讀得正確） */}
            <div className="ai-collapse-toggle">
                <button className="ai-collapse-label" onClick={onToggle} aria-expanded={expanded}>
                    {expanded ? '▾' : '▸'} AI 助手
                </button>
                <button className="ai-refresh-btn" disabled={!!loadingType}
                    onClick={onRefresh} title="重新生成" aria-label="重新生成 AI 助手內容"><RefreshCw aria-hidden /></button>
            </div>
            {expanded && (
                <div className="ai-assistant">
                    <div className="ai-tabs">
                        {tabs.map(tab => (
                            <button key={tab.key}
                                className={`ai-tab ${activeTab === tab.key ? 'active' : ''} ${loadingType === tab.key ? 'loading' : ''}`}
                                onClick={() => onSelectTab(tab.key)}>
                                {tab.label}
                                {loadingType === tab.key && <span className="ai-spinner">●</span>}
                            </button>
                        ))}
                    </div>
                    <div className="ai-result">
                        <pre>{results.current[activeTab] || ''}{loadingType === activeTab ? '▌' : ''}</pre>
                        {results.current[activeTab] && loadingType !== activeTab && (
                            <button className="copy-btn" onClick={() => onCopy(results.current[activeTab])}>
                                {copied ? <><Check aria-hidden />已複製</> : '複製'}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
