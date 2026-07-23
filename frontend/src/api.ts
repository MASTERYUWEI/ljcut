/* ── API 層 (Tauri + 瀏覽器雙模式) ── */

import type { UploadResult, TranscribeResult, Segment } from './types';

// 偵測是否在 Tauri 環境
const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;

// ── Tauri invoke 封裝 ──
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

/**
 * 後端 base URL。
 * - Tauri 桌面：Python sidecar 由 Rust 啟動在隨機 port，啟動後向 Rust 查詢，
 *   組成 http://127.0.0.1:<port>，直連後端（不經 Vite proxy）。
 * - 純瀏覽器 dev：留空字串，走 Vite proxy 轉發到 :8000。
 */
let resolvedBase = '';

/** 在 App 掛載前呼叫一次：解析後端 port 並等待後端就緒 */
export async function initApiBase(): Promise<void> {
    if (!IS_TAURI) {
        resolvedBase = ''; // Vite proxy
        return;
    }
    // 1. 向 Rust 取得 sidecar port（setup 可能稍慢，重試）
    let port: number | null = null;
    for (let i = 0; i < 50 && port == null; i++) {
        try {
            port = await tauriInvoke<number | null>('get_backend_port');
        } catch { /* 指令尚未就緒 */ }
        if (port == null) await new Promise(r => setTimeout(r, 200));
    }
    if (port == null) {
        console.error('無法取得後端 port，sidecar 可能未啟動');
        return;
    }
    resolvedBase = `http://127.0.0.1:${port}`;

    // 2. 等待 FastAPI 真的可連（best-effort，最多 ~15s）
    for (let i = 0; i < 75; i++) {
        try {
            const res = await fetch(`${resolvedBase}/health`);
            if (res.ok) { console.log(`✅ 後端就緒: ${resolvedBase}`); return; }
        } catch { /* 尚未起來 */ }
        await new Promise(r => setTimeout(r, 200));
    }
    console.warn(`後端 ${resolvedBase} 健康檢查逾時，仍嘗試使用`);
}

/** 取得目前後端 base URL（已解析） */
export function getBase(): string {
    return resolvedBase;
}

export const api = {
    /** 上傳影片 */
    async upload(file: File): Promise<UploadResult> {
        // 無論是否 Tauri，都用 fetch 上傳到 Python 後端
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${resolvedBase}/api/upload`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** 用原生對話框選擇檔案後上傳 (Tauri 桌面專用) */
    async openAndUpload(): Promise<UploadResult | null> {
        if (!IS_TAURI) return null;
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: false,
            filters: [{
                name: '影片/音頻',
                extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'mp3', 'wav', 'm4a'],
            }],
        });
        if (!selected) return null;

        // 使用 fetch 讀取選中的檔案並上傳到 Python 後端
        const filePath = typeof selected === 'string' ? selected : String(selected);
        const response = await fetch(`https://tauri.localhost/` + filePath);
        const blob = await response.blob();
        const fileName = filePath.split(/[/\\]/).pop() || 'file';
        const file = new File([blob], fileName);
        return api.upload(file);
    },

    /** 語音辨識（SSE 串流進度；相容舊後端的純 JSON 回應） */
    async transcribe(
        fileId: string,
        language = 'zh',
        onProgress?: (pct: number, current?: number, total?: number) => void,
    ): Promise<TranscribeResult> {
        const form = new FormData();
        form.append('language', language);
        const res = await fetch(`${resolvedBase}/api/transcribe/${fileId}`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());

        // 舊後端：直接回 JSON（無串流）
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('text/event-stream')) {
            return res.json();
        }

        // 新後端：解析 SSE 進度，最後一個事件帶 result
        const reader = res.body?.getReader();
        if (!reader) throw new Error('無法讀取串流');
        const decoder = new TextDecoder();
        let buffer = '';
        let result: TranscribeResult | null = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                const line = block.trim();
                if (!line.startsWith('data: ')) continue;
                const evt = JSON.parse(line.slice(6));
                if (evt.error) throw new Error(evt.error);
                if (evt.progress != null) onProgress?.(evt.progress, evt.current, evt.total);
                if (evt.result) result = evt.result;
            }
        }
        if (!result) throw new Error('辨識未回傳結果');
        return result;
    },

    /** 匯出 SRT */
    async exportSrt(fileId: string, segments: Segment[], downloadName?: string, srtDir?: string): Promise<string | void> {
        const baseName = downloadName ? downloadName.replace(/\.[^.]+$/, '') : fileId;
        const srtFileName = `${baseName}.srt`;

        // Tauri 桌面模式：透過後端產生 SRT，再複製到目標路徑
        if (IS_TAURI) {
            // 1. 先透過後端產生 SRT 到 ./outputs
            const res = await fetch(`${resolvedBase}/api/export/srt/${fileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(segments),
            });
            if (!res.ok) throw new Error(await res.text());
            const srtBlob = await res.blob();
            const srtContent = await srtBlob.text();

            // 2. 決定儲存路徑
            let savePath = '';
            if (srtDir) {
                // 已設定 SRT 目錄，直接寫入
                const { join } = await import('@tauri-apps/api/path');
                savePath = await join(srtDir, srtFileName);
            } else {
                // 沒有設定，彈出 save dialog
                const { save } = await import('@tauri-apps/plugin-dialog');
                const result = await save({
                    defaultPath: srtFileName,
                    filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
                });
                if (!result) return;
                savePath = result;
            }

            // 3. 用 Tauri fs API 寫入
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(savePath, srtContent);
            return savePath;
        }

        // Web 模式：blob 下載
        const res = await fetch(`${resolvedBase}/api/export/srt/${fileId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(segments),
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = srtFileName;
        a.click();
        URL.revokeObjectURL(url);
    },

    /** 匯出影片（含字幕）— 含存檔對話框 + 進度回報 */
    async exportVideo(
        fileId: string,
        segments: Segment[],
        style: Record<string, unknown>,
        speed: number,
        duration: number,
        defaultFileName: string,
        trimStart: number,
        trimEnd: number,
        videoWidth: number,
        videoHeight: number,
        onProgress: (pct: number) => void,
    ): Promise<{ outputPath: string } | null> {
        // 1. 彈出存檔對話框讓用戶選位置
        let outputPath = '';
        if (IS_TAURI) {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const result = await save({
                defaultPath: defaultFileName,
                filters: [{ name: '影片', extensions: ['mp4'] }],
            });
            if (!result) return null; // 用戶取消
            outputPath = result;
        } else {
            // 非 Tauri 環境用預設路徑
            outputPath = '';
        }

        // 2. POST 到 SSE 端點
        const res = await fetch(`${resolvedBase}/api/export-video/${fileId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                segments,
                style,
                speed: speed || 1.0,
                duration: duration || 0,
                output_path: outputPath,
                trim_start: trimStart || 0,
                trim_end: trimEnd || 0,
                video_width: videoWidth || 1920,
                video_height: videoHeight || 1080,
            }),
        });
        if (!res.ok) throw new Error(await res.text());

        // 3. 解析 SSE 串流
        const reader = res.body?.getReader();
        if (!reader) throw new Error('無法讀取串流');

        const decoder = new TextDecoder();
        let buffer = '';
        let finalPath = outputPath;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // 解析 SSE 格式: data: {...}\n\n
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            for (const block of lines) {
                const dataLine = block.trim();
                if (!dataLine.startsWith('data: ')) continue;
                try {
                    const evt = JSON.parse(dataLine.slice(6));
                    if (evt.error) throw new Error(evt.error);
                    if (evt.progress != null) onProgress(evt.progress);
                    if (evt.output_path) finalPath = evt.output_path;
                } catch (e) {
                    if (e instanceof Error && e.message) throw e;
                }
            }
        }

        return { outputPath: finalPath };
    },

    /** 多 clip 時間軸匯出（含字幕）— 含存檔對話框 + 進度回報 */
    async exportTimeline(
        clips: { fileId: string; trimStart: number; trimEnd: number; speed: number; segments: Segment[] }[],
        style: Record<string, unknown>,
        defaultFileName: string,
        videoWidth: number,
        videoHeight: number,
        onProgress: (pct: number, stage?: string, etaSeconds?: number | null) => void,
    ): Promise<{ outputPath: string } | null> {
        // 1. 存檔對話框
        let outputPath = '';
        if (IS_TAURI) {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const result = await save({
                defaultPath: defaultFileName,
                filters: [{ name: '影片', extensions: ['mp4'] }],
            });
            if (!result) return null;
            outputPath = result;
        }

        // 2. POST 到 SSE 端點
        const res = await fetch(`${resolvedBase}/api/export-timeline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clips: clips.map(c => ({
                    file_id: c.fileId,
                    trim_start: c.trimStart,
                    trim_end: c.trimEnd,
                    speed: c.speed,
                    segments: c.segments,
                })),
                style,
                output_path: outputPath,
                video_width: videoWidth || 1920,
                video_height: videoHeight || 1080,
            }),
        });
        if (!res.ok) throw new Error(await res.text());

        // 3. 解析 SSE 串流
        const reader = res.body?.getReader();
        if (!reader) throw new Error('無法讀取串流');

        const decoder = new TextDecoder();
        let buffer = '';
        let finalPath = outputPath;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            for (const block of lines) {
                const dataLine = block.trim();
                if (!dataLine.startsWith('data: ')) continue;
                try {
                    const evt = JSON.parse(dataLine.slice(6));
                    if (evt.error) throw new Error(evt.error);
                    if (evt.progress != null) onProgress(evt.progress, evt.stage, evt.eta_seconds);
                    if (evt.output_path) finalPath = evt.output_path;
                } catch (e) {
                    if (e instanceof Error && e.message) throw e;
                }
            }
        }

        return { outputPath: finalPath };
    },

    /** AI 狀態檢查 */
    async aiStatus(): Promise<{ ollama_running: boolean; model_available: boolean; model_name: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/status`);
        if (!res.ok) return { ollama_running: false, model_available: false, model_name: '' };
        return res.json();
    },

    /** AI 生成文案 */
    async aiGenerate(segments: Segment[], promptType: string): Promise<string> {
        const res = await fetch(`${resolvedBase}/api/ai/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments, prompt_type: promptType }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.result || '';
    },

    /** 音訊同步校正：同時錄系統+麥克風幾秒，互相關算出麥克風超前 ms */
    async calibrateAudio(sysDevice: string, micDevice: string, seconds = 5): Promise<{ ok: boolean; mic_ahead_ms?: number; confidence?: number; reliable?: boolean; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/calibrate-audio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sys_device: sysDevice, mic_device: micDevice, seconds }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** AI 產 5 個 YouTube 標題候選 */
    async aiTitles(texts: string[]): Promise<{ ok: boolean; titles: string[]; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/titles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** AI 生成 N 款封面候選（內容感知：附逐字稿），回傳可預覽的 URL 與檔名 */
    async ytGenThumbnails(title: string, transcript = '', count = 5): Promise<{ ok: boolean; items: { file: string; url: string }[]; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/yt/thumbnails`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, transcript, count }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** outputs 靜態檔完整網址（封面預覽用） */
    outputUrl(path: string): string {
        return `${resolvedBase}${path.startsWith('/') ? path : '/' + path}`;
    },

    /** YouTube：連結狀態 */
    async ytStatus(): Promise<{ configured: boolean; connected: boolean; channel?: string; auth_error?: string }> {
        const res = await fetch(`${resolvedBase}/api/yt/status`);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** YouTube：儲存 OAuth 用戶端憑證（空字串=清除） */
    async ytSetCredentials(clientId: string, clientSecret: string): Promise<{ configured: boolean; connected: boolean }> {
        const res = await fetch(`${resolvedBase}/api/yt/credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** YouTube：啟動 OAuth 授權，回傳要開的網址 */
    async ytAuthStart(): Promise<{ ok: boolean; auth_url?: string; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/yt/auth/start`, { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** YouTube：解除連結 */
    async ytDisconnect(): Promise<void> {
        await fetch(`${resolvedBase}/api/yt/disconnect`, { method: 'POST' });
    },

    /** YouTube：上傳影片（SSE 進度），完成回傳網址 */
    async ytUpload(
        body: {
            video_path: string; title: string; description: string; tags: string[];
            privacy: string; thumbnail_time: number | null; thumbnail_path?: string; segments: Segment[];
        },
        onProgress: (pct: number, stage?: string) => void,
    ): Promise<{ video_id: string; watch_url: string; studio_url: string; warnings?: string[] }> {
        const res = await fetch(`${resolvedBase}/api/yt/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        const reader = res.body?.getReader();
        if (!reader) throw new Error('無法讀取串流');
        const decoder = new TextDecoder();
        let buffer = '';
        let result: { video_id: string; watch_url: string; studio_url: string; warnings?: string[] } | null = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                const line = block.trim();
                if (!line.startsWith('data: ')) continue;
                const evt = JSON.parse(line.slice(6));
                if (evt.error) throw new Error(evt.error);
                if (evt.progress != null) onProgress(evt.progress, evt.stage);
                if (evt.done) result = evt;
            }
        }
        if (!result) throw new Error('上傳未完成');
        return result;
    },

    /** AI 掃描語意不通順/疑似辨識錯誤的句子：回傳 index+原因 */
    async scanSuspicious(texts: string[]): Promise<{ ok: boolean; items: { index: number; reason: string }[]; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/suspicious`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** AI 掃描字幕錯字：回傳建議「錯字→正字」清單 */
    async scanTypos(texts: string[]): Promise<{ ok: boolean; suggestions: { wrong: string; correct: string }[]; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/typos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** 金鑰健康度實測：真的敲一次 Gemini，回傳延遲與錯誤說明 */
    async checkAiHealth(): Promise<{ ok: boolean; model?: string; latency_ms?: number; reply?: string; status?: number; error?: string; detail?: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/health`, { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** 取得 AI 模型資訊（目前使用 / 最新可用 / 是否有更新） */
    async getAiModel(): Promise<{ current: string; best: string; update_available: boolean; current_alive: boolean | null; models: string[] }> {
        const res = await fetch(`${resolvedBase}/api/ai/model`);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** 切換 AI 模型（空字串 = 自動選最新 Flash），寫回 .env */
    async setAiModel(model = ''): Promise<{ ok: boolean; current: string; error?: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** 取得目前 Gemini 金鑰狀態（遮罩） */
    async getApiKeyInfo(): Promise<{ has_key: boolean; masked: string }> {
        const res = await fetch(`${resolvedBase}/api/ai/key`);
        if (!res.ok) return { has_key: false, masked: '' };
        return res.json();
    },

    /** 設定 Gemini 金鑰（寫回 .env 並即時生效），回傳可用性 */
    async setApiKey(key: string): Promise<{ saved: boolean; has_key: boolean; masked: string; status: { available: boolean; error?: string } }> {
        const res = await fetch(`${resolvedBase}/api/ai/key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    },

    /** AI 逐句潤飾字幕（修錯字／去贅字／補標點），時間碼不變 */
    async polishSubtitles(segments: Segment[]): Promise<Segment[]> {
        const res = await fetch(`${resolvedBase}/api/ai/polish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.segments || segments;
    },

    /** 取得音頻波形 peak 數據 */
    async getWaveform(fileId: string): Promise<number[]> {
        const res = await fetch(`${resolvedBase}/api/waveform/${fileId}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.peaks || [];
    },

    /** 取得影片首幀縮圖 URL */
    getThumbnailUrl(fileId: string): string {
        return `${resolvedBase}/api/thumbnail/${fileId}`;
    },

    /** 將後端相對路徑（/uploads/..., /outputs/...）補成可直接存取的絕對 URL */
    mediaUrl(path: string): string {
        if (!path) return path;
        if (/^https?:\/\//.test(path)) return path; // 已是絕對 URL
        return `${resolvedBase}${path}`;
    },

    /** 是否為 Tauri 桌面模式 */
    isTauri(): boolean {
        return IS_TAURI;
    },
};
