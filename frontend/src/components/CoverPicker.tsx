import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { controlRequest } from '../controlClient';
import type { Segment } from '../types';

export interface CoverAnalysis {
    summary: string; highlights: { text: string; evidenceStart: number }[];
    slogan: string; title: string; description: string; visualBrief: string;
}
export interface Publication {
    id: string; title: string; description?: string; videoPath: string; duration: number; mainStart: number;
    segments: Segment[]; mainSegments: Segment[]; batches: string[];
    selected: { file: string; url: string; batchId: string } | null;
}
interface Batch {
    id: string; status: string; provider: string; analysis: CoverAnalysis | null;
    items: { file: string; url: string }[]; errors: string[];
}

export function CoverPicker({ publication, disabled, onSelect, onAnalysis }: {
    publication: Publication; disabled: boolean; onSelect: (file: string) => void;
    onAnalysis: (analysis: CoverAnalysis) => void;
}) {
    const [batch, setBatch] = useState<Batch | null>(null);
    const [selected, setSelected] = useState(publication.selected);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const requestVersion = useRef(0);
    const actionBusy = useRef(false);
    const pollBusy = useRef(false);
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        setBatch(null); setSelected(publication.selected); setError('');
        const poll = async () => {
            if (actionBusy.current || pollBusy.current) {
                timer = setTimeout(poll, 2000);
                return;
            }
            pollBusy.current = true;
            const version = requestVersion.current;
            try {
                const p: Publication = await controlRequest(`/publications/${publication.id}`);
                if (cancelled || version !== requestVersion.current) return;
                const id = p.batches[p.batches.length - 1];
                const next: Batch | null = id ? await controlRequest(`/cover-batches/${id}`) : null;
                if (cancelled || version !== requestVersion.current) return;
                setBatch(next); setSelected(p.selected); setError('');
            } catch (e) {
                if (!cancelled && version === requestVersion.current) setError(String(e));
            } finally {
                pollBusy.current = false;
                // Poll even when there is no batch yet; external editing can create one later.
                if (!cancelled) timer = setTimeout(poll, 2000);
            }
        };
        void poll();
        return () => { cancelled = true; requestVersion.current++; clearTimeout(timer); };
    }, [publication.id]);
    const refresh = async () => {
        actionBusy.current = true; requestVersion.current++;
        const version = requestVersion.current;
        setBusy(true); setError('');
        try {
            const next = await controlRequest('/cover-batches', { publicationId: publication.id, provider: 'codex' });
            if (version === requestVersion.current) setBatch(next);
        }
        catch (e) { if (version === requestVersion.current) setError(String(e)); }
        finally { actionBusy.current = false; setBusy(false); }
    };
    const select = async (file: string) => {
        if (!batch) return;
        actionBusy.current = true; requestVersion.current++;
        const version = requestVersion.current;
        setBusy(true); setError('');
        try {
            const p = await controlRequest(`/publications/${publication.id}/select-cover`, { batchId: batch.id, file });
            if (version !== requestVersion.current) return;
            setSelected(p.selected); onSelect(file);
            if (batch.analysis) onAnalysis(batch.analysis);
        } catch (e) { if (version === requestVersion.current) setError(String(e)); }
        finally { actionBusy.current = false; setBusy(false); }
    };
    return <section aria-label="六張封面候選" className="cover-picker">
        <p>固定風格：藍色系、黃色大字、Q 版工程師。每批 6 張，依本次匯出的主片逐字稿提煉摘要與短句。</p>
        <div className="cover-actions">
            <span>由 Codex 對話生成</span>
            <button className="btn" onClick={refresh} disabled={disabled || busy}>
                {busy ? '處理中…' : batch ? '刷新，再產生 6 張' : '產生 6 張封面'}
            </button>
        </div>
        {!batch && <p role="status">請 Codex 幫你剪輯時，會一併準備六張封面，完成後自動顯示在這裡。</p>}
        {batch?.status === 'awaiting_codex' && <p role="status">已建立生成請求，等待 Codex 準備六張封面；完成後會自動顯示。刷新本身不會啟動 AI；若目前沒有進行中的剪輯，請在 Codex 說「幫我更新這支影片的封面」，不用複製批次編號。</p>}
        {batch?.analysis && <div className="cover-brief">
            <strong>封面短句：{batch.analysis.slogan}</strong><p>{batch.analysis.summary}</p>
            <ul>{batch.analysis.highlights.map((h,i) => <li key={i}>{h.text}（成品 {h.evidenceStart.toFixed(1)} 秒）</li>)}</ul>
            <button className="btn" disabled={disabled} onClick={() => onAnalysis(batch.analysis!)}>採用這批標題與說明</button>
        </div>}
        {batch && <div className="cover-grid">{Array.from({ length: 6 }, (_,i) => {
            const item = batch.items[i];
            return item ? <button key={item.file} className={`cover-card ${selected?.file === item.file ? 'selected' : ''}`}
                disabled={disabled || busy} onClick={() => select(item.file)} aria-label={`選用封面 ${i+1}`} aria-pressed={selected?.file === item.file}>
                <img src={api.outputUrl(item.url)} alt={`封面方案 ${i+1}`} /><span>{selected?.file === item.file ? '✓ 已選用' : `選用方案 ${i+1}`}</span>
            </button> : <div className="cover-placeholder" key={i}>方案 {i+1} · {batch.status === 'failed' ? '生成失敗' : '等待圖片'}</div>;
        })}</div>}
        {selected && <div className="cover-selected"><img src={api.outputUrl(selected.url)} alt="將上傳的已選封面" /><span>已選用此圖作為 YouTube 封面。刷新不會覆蓋，改選後才會替換。</span></div>}
        {[error,...(batch?.errors ?? [])].filter(Boolean).map((e,i) => <p role="alert" key={i}>{e}</p>)}
    </section>;
}
