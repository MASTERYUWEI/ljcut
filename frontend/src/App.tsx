/* ── LJCUT 主應用 ── */

import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { useStore } from './store';
import { api } from './api';
import type { MediaItem, TimelineClip, Segment } from './types';

// ── 格式化時間 ──
function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

// ── 時間刻度 ──
function generateRulerTicks(duration: number, pps: number) {
    if (duration <= 0) return [];
    const intervals = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let interval = intervals[intervals.length - 1];
    for (const iv of intervals) {
        if (iv * pps >= 60) { interval = iv; break; }
    }
    const ticks: { time: number; label: string }[] = [];
    for (let t = 0; t <= duration; t += interval) {
        ticks.push({ time: t, label: formatTime(t) });
    }
    return ticks;
}

// ── Snap 吸附：找最接近的字幕邊界 ──
function findSnapTime(time: number, segments: { start: number; end: number }[], threshold: number): number | null {
    let closest: number | null = null;
    let minDist = threshold;
    for (const seg of segments) {
        const dStart = Math.abs(time - seg.start);
        const dEnd = Math.abs(time - seg.end);
        if (dStart < minDist) { minDist = dStart; closest = seg.start; }
        if (dEnd < minDist) { minDist = dEnd; closest = seg.end; }
    }
    return closest;
}

// ── 軌道標籤寬度 ──
const LABEL_W = 72;

export default function App() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const tracksRef = useRef<HTMLDivElement>(null);
    const rulerRef = useRef<HTMLDivElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const timeDisplayRef = useRef<HTMLSpanElement>(null);
    const rangeSliderRef = useRef<HTMLInputElement>(null);
    const subtitleOverlayRef = useRef<HTMLDivElement>(null);
    const currentTimeRef = useRef(0); // 播放中用 ref 追蹤 media time
    const timelinePosRef = useRef(0); // 當前時間軸位置（秒）
    const playStartRef = useRef(0); // performance.now() when play started
    const playStartTlRef = useRef(0); // timeline position when play started
    const currentPlayingClipRef = useRef<string | null>(null); // 當前播放中的 clip ID
    const isDraggingRef = useRef(false); // 拖拉中旗標（ref 避免 stale closure）
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recChunksRef = useRef<Blob[]>([]);
    const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const [zoom, setZoom] = useState(1);
    const [leftTab, setLeftTab] = useState<'media' | 'subtitle'>('media');
    const [aiExpanded, setAiExpanded] = useState(false);
    const [isBurning, setIsBurning] = useState(false);
    const [exportProgress, setExportProgress] = useState(-1); // -1=idle, 0~100=progress
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
    const [snapTime, setSnapTime] = useState<number | null>(null);
    const [isDraggingPreview, setIsDraggingPreview] = useState(false);
    const [isDraggingCue, setIsDraggingCue] = useState(false);
    const [selectedSegIds, setSelectedSegIds] = useState<Set<number>>(new Set());
    const [showSettings, setShowSettings] = useState(false);
    const [settings, setSettings] = useState({ outputDir: '', srtDir: '' });
    const [isRecording, setIsRecording] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [recSeconds, setRecSeconds] = useState(0);
    const [showRecSettings, setShowRecSettings] = useState(false);
    const [recOpts, setRecOpts] = useState({ sysAudio: false, mic: false, quality: '1080p' as '720p' | '1080p' | '4k', fps: 30 as 24 | 30 | 60, micDevice: '', sysAudioDevice: '', micVol: 1.0, sysVol: 1.0 });
    const [micDevices, setMicDevices] = useState<{ deviceId: string; label: string }[]>([]);
    const [micLevel, setMicLevel] = useState(0);
    const micStreamRef = useRef<MediaStream | null>(null);
    const micAnimRef = useRef<number>(0);
    // ── 倍速右鍵選單 ──
    const [speedMenu, setSpeedMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);

    // ── 系統音訊 loopback 裝置偵測（獨立於麥克風，設定面板開啟時觸發） ──
    useEffect(() => {
        if (!showRecSettings) return;
        const IS_TAURI_ENV = !!(window as any).__TAURI_INTERNALS__;
        if (!IS_TAURI_ENV) return;

        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const dshowDevices: string[] = await invoke('list_audio_devices');
                if (cancelled) return;

                const loopbackKeywords = ['cable', 'virtual-audio-capturer', 'stereo mix', 'loopback', '立體聲混音'];
                const loopbackDevice = dshowDevices.find(name =>
                    loopbackKeywords.some(k => name.toLowerCase().includes(k))
                );

                if (loopbackDevice) {
                    setRecOpts(o => ({
                        ...o,
                        sysAudioDevice: loopbackDevice,
                        sysAudio: o.sysAudioDevice ? o.sysAudio : true,
                    }));
                }
            } catch (e) {
                console.error('偵測 loopback 裝置失敗:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [showRecSettings]);

    // ── 麥克風裝置列舉 + 即時音量測試 ──
    useEffect(() => {
        // 清理函數
        const cleanup = () => {
            cancelAnimationFrame(micAnimRef.current);
            micAnimRef.current = 0;
            if (micStreamRef.current) {
                micStreamRef.current.getTracks().forEach(t => t.stop());
                micStreamRef.current = null;
            }
            setMicLevel(0);
        };

        if (!recOpts.mic || !showRecSettings) { cleanup(); return; }

        let cancelled = false;

        (async () => {
            try {
                // Tauri 模式：用 FFmpeg dshow 列舉裝置（名稱與 FFmpeg 完全一致）
                const IS_TAURI_ENV = !!(window as any).__TAURI_INTERNALS__;
                if (IS_TAURI_ENV) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    const dshowDevices: string[] = await invoke('list_audio_devices');
                    if (cancelled) return;

                    // 分離 loopback 裝置（系統音訊）和麥克風
                    const loopbackKeywords = ['cable', 'virtual-audio-capturer', 'stereo mix', 'loopback', '立體聲混音'];
                    const loopbackDevices: string[] = [];
                    const micOnlyDevices: { deviceId: string; label: string }[] = [];

                    dshowDevices.forEach((name, i) => {
                        const lower = name.toLowerCase();
                        if (loopbackKeywords.some(k => lower.includes(k))) {
                            loopbackDevices.push(name);
                        } else {
                            micOnlyDevices.push({ deviceId: `dshow-${i}`, label: name });
                        }
                    });

                    setMicDevices(micOnlyDevices);
                    if (!recOpts.micDevice && micOnlyDevices.length > 0) {
                        setRecOpts(o => ({ ...o, micDevice: micOnlyDevices[0].label }));
                    }

                    // 自動偵測 loopback 裝置 → 啟用系統音訊
                    if (loopbackDevices.length > 0) {
                        setRecOpts(o => ({
                            ...o,
                            sysAudioDevice: loopbackDevices[0],
                            sysAudio: o.sysAudioDevice ? o.sysAudio : true,  // 首次偵測到時自動開啟
                        }));
                    }
                } else {
                    // 瀏覽器模式：原本的 enumerateDevices
                    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    if (cancelled) { tempStream.getTracks().forEach(t => t.stop()); return; }
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const audioInputs = devices
                        .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
                        .map(d => ({ deviceId: d.deviceId, label: d.label || `麥克風 ${d.deviceId.slice(0, 6)}` }));
                    tempStream.getTracks().forEach(t => t.stop());
                    if (cancelled) return;
                    setMicDevices(audioInputs);
                    if (!recOpts.micDevice && audioInputs.length > 0) {
                        setRecOpts(o => ({ ...o, micDevice: audioInputs[0].label }));
                    }
                }

                // 音量測試：仍用 Web Audio API（用模糊配對找瀏覽器裝置）
                const tempStream2 = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (cancelled) { tempStream2.getTracks().forEach(t => t.stop()); return; }
                const browserDevices = await navigator.mediaDevices.enumerateDevices();
                const browserAudioInputs = browserDevices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default');
                tempStream2.getTracks().forEach(t => t.stop());

                // 用名稱模糊配對（dshow 名稱可能是瀏覽器 label 的子集）
                const selectedLabel = recOpts.micDevice;
                const matchedBrowser = browserAudioInputs.find(d =>
                    d.label.includes(selectedLabel) || selectedLabel.includes(d.label.replace(/\s*\([0-9a-f:]+\)\s*$/i, ''))
                ) || browserAudioInputs[0];

                if (!matchedBrowser) return;

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: { deviceId: { exact: matchedBrowser.deviceId } }
                });
                if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
                micStreamRef.current = stream;

                // Web Audio API 音量分析
                const audioCtx = new AudioContext();
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                const dataArray = new Uint8Array(analyser.fftSize);

                const tick = () => {
                    if (cancelled) { audioCtx.close(); return; }
                    analyser.getByteTimeDomainData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        const val = (dataArray[i] - 128) / 128;
                        sum += val * val;
                    }
                    const rms = Math.sqrt(sum / dataArray.length);
                    setMicLevel(Math.min(rms * 3.5, 1));
                    micAnimRef.current = requestAnimationFrame(tick);
                };
                tick();
            } catch (e) {
                console.error('麥克風存取失敗:', e);
            }
        })();

        return () => { cancelled = true; cleanup(); };
    }, [recOpts.mic, recOpts.micDevice, showRecSettings]);

    // ── Resize 面板 ──
    const [leftWidth, setLeftWidth] = useState(240);
    const [rightWidth, setRightWidth] = useState(340);
    const [timelineHeight, setTimelineHeight] = useState(200);
    const [isResizing, setIsResizing] = useState(false);

    // AI 助手 — 用 ref 避免 closure stale state
    const aiResultsRef = useRef<Record<string, string>>({});
    const [, forceRender] = useState(0);
    const [aiLoadingType, setAiLoadingType] = useState<string | null>(null);
    const [aiActiveTab, setAiActiveTab] = useState('summary');
    const [aiCopied, setAiCopied] = useState(false);

    const AI_TABS = [
        { key: 'summary', label: '摘要' },
        { key: 'marketing', label: '行銷' },
        { key: 'youtube', label: 'YT 說明' },
    ] as const;

    const runAiGenerate = useCallback(async (segs: typeof segments, type: string) => {
        setAiLoadingType(type);
        aiResultsRef.current[type] = '⏳ 生成中...';
        forceRender(n => n + 1);
        try {
            const text = await api.aiGenerate(segs, type);
            aiResultsRef.current[type] = text;
        } catch (e) {
            aiResultsRef.current[type] = `❌ ${e}`;
        }
        forceRender(n => n + 1);
        setAiLoadingType(null);
    }, []);

    const runAllAi = useCallback(async (segs: typeof segments) => {
        for (const tab of ['summary', 'marketing', 'youtube']) {
            setAiActiveTab(tab);
            await runAiGenerate(segs, tab);
        }
    }, [runAiGenerate]);

    const {
        mediaItems, timelineClips,
        activeClipId, setActiveClipId,
        segments, activeSegmentId,
        subtitleStyle,
        currentTime, isPlaying,
        isUploading, isTranscribing, language,
        getDuration,
        addMedia, removeMedia, updateMedia,
        addClip, updateClip, removeClip: _removeClip, setClipSpeed,
        setClipSegments,
        setSegments, updateSegment, setActiveSegment,
        setSubtitleStyle,
        setCurrentTime, setIsPlaying,
        setIsUploading, setIsTranscribing, setLanguage,
    } = useStore();

    const duration = getDuration();
    // 第一個有 video 的媒體（向後相容：用於辨識/匯出/燒入）
    const primaryMedia = mediaItems.find(m => m.info.width && m.info.width > 0) || mediaItems[0] || null;
    const fileId = primaryMedia?.id ?? null;
    const hasTimeline = timelineClips.length > 0;

    // ── Undo 歷史堆疊 ──
    const undoStack = useRef<(typeof segments)[]>([]);
    const pushUndo = useCallback(() => {
        undoStack.current.push(segments.map(s => ({ ...s })));
        if (undoStack.current.length > 50) undoStack.current.shift();
    }, [segments]);
    const handleUndo = useCallback(() => {
        const prev = undoStack.current.pop();
        if (prev) setSegments(prev);
    }, [setSegments]);

    const pixelsPerSecond = 10 * zoom;
    const timelineWidth = duration > 0 ? duration * pixelsPerSecond : 0;
    const SNAP_THRESHOLD_SEC = 8 / pixelsPerSecond; // 8px 吸附範圍

    // ── 同步尺標滾動 ──
    const syncRulerScroll = useCallback(() => {
        if (rulerRef.current && tracksRef.current) {
            rulerRef.current.scrollLeft = tracksRef.current.scrollLeft;
        }
    }, []);

    // ── 上傳（多檔，加入媒體庫） ──
    const handleUpload = useCallback(async (file: File) => {
        setIsUploading(true);
        try {
            const result = await api.upload(file);
            const item: MediaItem = {
                id: result.file_id,
                filename: result.filename,
                url: api.mediaUrl(result.url),
                info: result.info,
                waveformPeaks: [],
                thumbnailUrl: api.getThumbnailUrl(result.file_id),
            };
            addMedia(item);
            // 背景載入波形
            api.getWaveform(result.file_id).then(peaks => {
                updateMedia(result.file_id, { waveformPeaks: peaks });
            }).catch(() => { });
        } catch (err) { alert(`上傳失敗: ${err}`); }
        finally { setIsUploading(false); }
    }, [addMedia, updateMedia, setIsUploading]);

    // ── 螢幕錄影 ──
    const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;

    const handleStartRec = useCallback(async () => {
        setShowRecSettings(false);

        if (IS_TAURI) {
            // ── Tauri 模式：開啟透明 overlay 選區視窗，自動走 FFmpeg gdigrab ──
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const { listen } = await import('@tauri-apps/api/event');

                // 先將音訊選項傳給 Rust（overlay 讀取）
                await invoke('set_rec_options', {
                    sysAudio: recOpts.sysAudio,
                    mic: recOpts.mic,
                    micDevice: recOpts.micDevice || null,
                    sysAudioDevice: recOpts.sysAudioDevice || null,
                    fps: recOpts.fps,
                    micVol: recOpts.micVol,
                    sysVol: recOpts.sysVol,
                });

                // 開啟 overlay 選區窗
                await invoke('start_region_select');

                // 監聽錄影開始事件（overlay 按下「開始錄製」後觸發）
                const unlistenStart = await listen<string>('recording_started', () => {
                    setIsRecording(true);
                    setIsPaused(false);
                    setRecSeconds(0);
                    recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
                    unlistenStart();
                });

                // 監聽錄影停止事件（Rust 端已直接複製到 backend/uploads 並回傳完整資訊）
                const unlistenStop = await listen<{ file_id: string; filename: string; url: string; info: any; thumbnail_url: string }>('recording_stopped', async (event) => {
                    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
                    setRecSeconds(0);
                    setIsRecording(false);
                    setIsPaused(false);

                    // 直接從 Rust 回傳的 payload 建立 MediaItem
                    const result = event.payload;
                    if (result && result.file_id) {
                        try {
                            const item: MediaItem = {
                                id: result.file_id,
                                filename: result.filename,
                                url: api.mediaUrl(result.url),
                                info: result.info,
                                waveformPeaks: [],
                                thumbnailUrl: api.mediaUrl(result.thumbnail_url),
                            };
                            addMedia(item);
                            // 背景載入波形
                            api.getWaveform(result.file_id).then(peaks => {
                                updateMedia(result.file_id, { waveformPeaks: peaks });
                            }).catch(() => { });
                            console.log('✅ 錄影已自動匯入媒體庫:', result.filename);
                        } catch (e) {
                            console.error('匯入錄影失敗:', e);
                            alert(`匯入錄影失敗: ${e}`);
                        }
                    }
                    unlistenStop();
                });
            } catch (e) {
                console.error('Tauri 錄影失敗:', e);
            }
            return;
        }

        // ── 瀏覽器模式：原始 getDisplayMedia ──
        const qMap = { '720p': 1280, '1080p': 1920, '4k': 3840 };
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: qMap[recOpts.quality] }, frameRate: 30 },
                audio: recOpts.sysAudio,
            });
            if (recOpts.mic) {
                try {
                    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    micStream.getAudioTracks().forEach(t => stream.addTrack(t));
                } catch { /* mic 權限被拒 */ }
            }
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
            recChunksRef.current = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
            recorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
                setRecSeconds(0);
                setIsRecording(false);
                setIsPaused(false);
                const blob = new Blob(recChunksRef.current, { type: 'video/webm' });
                const now = new Date();
                const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
                const file = new File([blob], `錄影_${ts}.webm`, { type: 'video/webm' });
                handleUpload(file);
            };
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                if (recorder.state !== 'inactive') recorder.stop();
            });
            recorder.start(1000);
            mediaRecorderRef.current = recorder;
            setIsRecording(true);
            setIsPaused(false);
            setRecSeconds(0);
            recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
        } catch { /* 使用者取消 */ }
    }, [handleUpload, recOpts, addMedia, updateMedia]);

    const handlePauseRec = useCallback(() => {
        // Tauri FFmpeg 錄影不支援暫停，僅瀏覽器模式
        const r = mediaRecorderRef.current;
        if (!r) return;
        if (r.state === 'recording') {
            r.pause();
            setIsPaused(true);
            if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
        } else if (r.state === 'paused') {
            r.resume();
            setIsPaused(false);
            recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
        }
    }, []);

    const handleStopRec = useCallback(async () => {
        if (IS_TAURI) {
            // Tauri：呼叫 Rust 停止 ffmpeg
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('stop_recording');
            } catch (e) {
                console.error('停止錄影失敗:', e);
                alert(`停止錄影失敗: ${e}`);
            }
            return;
        }
        // 瀏覽器模式
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
    }, []);

    // ── 從媒體庫拖放到時間軸：建立 clip ──
    const handleDropToTimeline = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const mediaId = e.dataTransfer.getData('application/ljcut-media-id');
        if (!mediaId) return;
        const item = mediaItems.find(m => m.id === mediaId);
        if (!item) return;

        // 計算放置位置（秒）
        const el = tracksRef.current;
        let dropTime = 0;
        if (el) {
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left + el.scrollLeft - LABEL_W;
            dropTime = Math.max(0, x / pixelsPerSecond);
        }

        // 磁力吸附到最近的 clip 邊界
        const threshold = SNAP_THRESHOLD_SEC;
        for (const c of timelineClips) {
            const cEnd = c.startTime + c.duration;
            if (Math.abs(dropTime - cEnd) < threshold) { dropTime = cEnd; break; }
            if (Math.abs(dropTime - c.startTime) < threshold) { dropTime = c.startTime; break; }
        }

        const clipId = crypto.randomUUID();
        const clip: TimelineClip = {
            id: clipId,
            mediaId,
            trackIndex: 0,
            startTime: dropTime,
            duration: item.info.duration,
            trimStart: 0,
            trimEnd: item.info.duration,
            speed: 1,
            segments: [],
        };
        addClip(clip);
        setActiveClipId(clipId);
    }, [mediaItems, timelineClips, addClip, pixelsPerSecond, SNAP_THRESHOLD_SEC]);

    // ── 拖拉時間軸上的 clip（左右移動 + 磁力吸附） ──
    const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
    const handleClipDragStart = useCallback((e: React.MouseEvent, clipId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setDraggingClipId(clipId);
        const el = tracksRef.current;
        if (!el) return;
        const startX = e.clientX;
        const clip = timelineClips.find(c => c.id === clipId);
        if (!clip) return;
        const startTime = clip.startTime;

        const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            let newStart = Math.max(0, startTime + dx / pixelsPerSecond);

            // 磁力吸附
            const threshold = SNAP_THRESHOLD_SEC;
            const clipEnd = newStart + clip.duration;
            let snapped = false;
            for (const c of useStore.getState().timelineClips) {
                if (c.id === clipId) continue;
                const cEnd = c.startTime + c.duration;
                // clip 的左邊吸附到其他 clip 的右邊
                if (Math.abs(newStart - cEnd) < threshold) {
                    newStart = cEnd; snapped = true; break;
                }
                // clip 的右邊吸附到其他 clip 的左邊
                if (Math.abs(clipEnd - c.startTime) < threshold) {
                    newStart = c.startTime - clip.duration; snapped = true; break;
                }
                // clip 的左邊吸附到其他 clip 的左邊
                if (Math.abs(newStart - c.startTime) < threshold) {
                    newStart = c.startTime; snapped = true; break;
                }
            }
            setSnapTime(snapped ? newStart : null);
            updateClip(clipId, { startTime: Math.max(0, newStart) });
        };
        const onUp = () => {
            setDraggingClipId(null);
            setSnapTime(null);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [timelineClips, pixelsPerSecond, SNAP_THRESHOLD_SEC, updateClip]);

    // ── Cue Splitting：超長字幕自動分段（語義斷句） ──
    const splitLongCues = useCallback((segs: typeof segments, maxChars: number) => {
        if (maxChars <= 0) return segs;
        const result: typeof segments = [];
        const punctuation = /[，。！？；：、,.!?;:]/;
        // 中文助詞/介詞/連詞 — 在這些字「前面」斷句最自然
        const breakBefore = new Set(
            '的了在是把被跟和與或但而也都就會要能可讓給對向從到為那這有不很'
                .split('')
        );

        // 容忍區間：maxChars ~ hardLimit 之間只在有好斷點時才切
        const hardLimit = maxChars + 5;

        for (const seg of segs) {
            if (seg.text.length <= maxChars) {
                result.push({ ...seg, id: result.length });
                continue;
            }

            // 在容忍區間內（maxChars < len <= hardLimit）：
            // 只在有語意斷點時才切，否則保留完整不切
            const len = seg.text.length;
            const isInTolerance = len <= hardLimit;

            // 找最佳切割點
            let splitIdx = -1;
            const mid = Math.floor(len / 2);
            // 搜尋範圍：確保兩半都不超過 maxChars
            const lo = Math.max(1, len - maxChars);
            const hi = Math.min(len - 1, maxChars);

            // P1: 標點符號（在標點後面切）
            for (let d = 0; splitIdx < 0; d++) {
                const r = mid + d, l = mid - d;
                if (r > hi && l < lo) break;
                if (r <= hi && r < len && punctuation.test(seg.text[r])) { splitIdx = r + 1; }
                else if (l >= lo && l >= 0 && punctuation.test(seg.text[l])) { splitIdx = l + 1; }
            }

            // P2: 空格（混合語言內容）
            if (splitIdx <= 0 || splitIdx >= len) {
                for (let d = 0; splitIdx < 0; d++) {
                    const r = mid + d, l = mid - d;
                    if (r > hi && l < lo) break;
                    if (r <= hi && r < len && seg.text[r] === ' ') { splitIdx = r + 1; }
                    else if (l >= lo && l >= 0 && seg.text[l] === ' ') { splitIdx = l + 1; }
                }
            }

            // P3: 中文助詞/介詞前斷句（保持詞語完整）
            if (splitIdx <= 0 || splitIdx >= len) {
                for (let d = 0; splitIdx < 0; d++) {
                    const r = mid + d, l = mid - d;
                    if (r > hi && l < lo) break;
                    if (r <= hi && r < len && breakBefore.has(seg.text[r])) { splitIdx = r; }
                    else if (l >= lo && l > 0 && breakBefore.has(seg.text[l])) { splitIdx = l; }
                }
            }

            // P4: 容忍區間內找不到好斷點 → 不切，保留完整
            if ((splitIdx <= 0 || splitIdx >= len) && isInTolerance) {
                result.push({ ...seg, id: result.length });
                continue;
            }

            // P5: 超出硬上限且找不到好斷點 → 最後手段從中間硬切
            if (splitIdx <= 0 || splitIdx >= len) splitIdx = mid;

            const ratio = splitIdx / len;
            const midTime = seg.start + (seg.end - seg.start) * ratio;
            result.push({ ...seg, id: result.length, text: seg.text.slice(0, splitIdx).trim(), end: midTime });
            result.push({ ...seg, id: result.length + 1, text: seg.text.slice(splitIdx).trim(), start: midTime });
            result[result.length - 1].id = result.length - 1;
        }
        return result;
    }, []);

    // ── 辨識（完成後自動觸發 AI 助手）──
    const handleTranscribe = useCallback(async () => {
        // 對當前選中的 clip 做辨識
        const activeClip = activeClipId ? timelineClips.find(c => c.id === activeClipId) : null;
        const targetMedia = activeClip ? mediaItems.find(m => m.id === activeClip.mediaId) : null;
        const targetFileId = targetMedia?.id ?? fileId;
        if (!targetFileId) return;
        if (timelineClips.length === 0) {
            alert('時間軸中尚無影片，請先將媒體拖放到時間軸上');
            return;
        }
        if (!activeClip) {
            alert('請先點擊選取要辨識字幕的影片片段');
            return;
        }
        setIsTranscribing(true);
        try {
            const result = await api.transcribe(targetFileId, language);
            // 自動 cue splitting
            const split = splitLongCues(result.segments, subtitleStyle.maxCharsPerCue);
            // 寫入到選中的 clip
            setClipSegments(activeClip.id, split);
            // 辨識完成後自動啟動 AI 生成
            if (split.length > 0) {
                runAllAi(split);
            }
        } catch (err) { alert(`辨識失敗: ${err}`); }
        finally { setIsTranscribing(false); }
    }, [fileId, language, setClipSegments, setIsTranscribing, runAllAi, splitLongCues, subtitleStyle.maxCharsPerCue, timelineClips, activeClipId, mediaItems]);

    // ── 匯出 SRT ──
    const handleExportSrt = useCallback(async () => {
        // 收集時間軸上所有 track=0 的 clips，按 startTime 排序
        const track0Clips = timelineClips
            .filter(c => c.trackIndex === 0)
            .sort((a, b) => a.startTime - b.startTime);

        if (track0Clips.length === 0 || !fileId) return;

        // 合併所有 clip 的字幕，加上時間軸偏移
        const allSegments: Segment[] = [];
        for (const clip of track0Clips) {
            const clipSegs = clip.segments ?? [];
            for (const seg of clipSegs) {
                // 媒體時間 → 時間軸時間: (mediaTime - trimStart) / speed + clip.startTime
                const s = (seg.start - clip.trimStart) / clip.speed + clip.startTime;
                const e = (seg.end - clip.trimStart) / clip.speed + clip.startTime;
                if (e <= 0) continue;
                allSegments.push({ ...seg, id: allSegments.length, start: Math.max(s, 0), end: e });
            }
        }

        if (allSegments.length === 0) {
            alert('沒有字幕資料可匯出');
            return;
        }

        try {
            const savePath = await api.exportSrt(fileId, allSegments, primaryMedia?.filename, settings.srtDir || settings.outputDir || undefined);
            if (savePath) {
                alert(`✅ SRT 已匯出！\n路徑：${savePath}`);
            }
        }
        catch (err) { alert(`匯出失敗: ${err}`); }
    }, [fileId, timelineClips, primaryMedia, settings.srtDir, settings.outputDir]);

    // ── 匯出影片（含字幕） ──
    const handleExportVideo = useCallback(async () => {
        // 收集時間軸上所有 track=0 的 clips，按 startTime 排序
        const track0Clips = timelineClips
            .filter(c => c.trackIndex === 0)
            .sort((a, b) => a.startTime - b.startTime);

        if (track0Clips.length === 0) {
            alert('時間軸中尚無影片，請先將媒體拖放到時間軸上');
            return;
        }

        setIsBurning(true);
        setExportProgress(0);
        try {
            const v = videoRef.current;
            const videoW = v?.videoWidth || 1920;
            const videoH = v?.videoHeight || 1080;

            let result: { outputPath: string } | null = null;

            if (track0Clips.length === 1) {
                // ── 單 clip：走舊 API（向後相容）──
                const clip = track0Clips[0];
                const media = mediaItems.find(m => m.id === clip.mediaId);
                const burnFileId = media?.id ?? fileId;
                const burnSegments = clip.segments ?? segments;
                const burnSpeed = clip.speed ?? 1;
                const burnDuration = clip.trimEnd - clip.trimStart;
                if (!burnFileId) { alert('找不到影片'); return; }
                const mediaName = media?.filename?.replace(/\.[^.]+$/, '') ?? 'output';
                const defaultFileName = `${mediaName}_subtitled.mp4`;

                result = await api.exportVideo(
                    burnFileId, burnSegments,
                    subtitleStyle as unknown as Record<string, unknown>,
                    burnSpeed, burnDuration, defaultFileName,
                    clip.trimStart, clip.trimEnd,
                    videoW, videoH,
                    (pct) => setExportProgress(pct),
                );
            } else {
                // ── 多 clip：走新 timeline API ──
                const clipsPayload = track0Clips.map(clip => {
                    const media = mediaItems.find(m => m.id === clip.mediaId);
                    return {
                        fileId: media?.id ?? clip.mediaId,
                        trimStart: clip.trimStart,
                        trimEnd: clip.trimEnd,
                        speed: clip.speed,
                        segments: clip.segments ?? [],
                    };
                });
                const defaultFileName = 'timeline_output.mp4';

                result = await api.exportTimeline(
                    clipsPayload,
                    subtitleStyle as unknown as Record<string, unknown>,
                    defaultFileName,
                    videoW, videoH,
                    (pct) => setExportProgress(pct),
                );
            }

            if (result) {
                setExportProgress(100);
                setTimeout(async () => {
                    alert(`✅ 匯出完成！\n輸出路徑：${result!.outputPath}`);
                    setExportProgress(-1);
                    // 自動開啟匯出檔案所在資料夾
                    try {
                        const folderPath = result!.outputPath.replace(/[\\/][^\\/]+$/, '');
                        if (folderPath) {
                            const { open } = await import('@tauri-apps/plugin-shell');
                            await open(folderPath);
                        }
                    } catch (e) {
                        console.warn('開啟資料夾失敗:', e);
                    }
                }, 300);
            } else {
                setExportProgress(-1); // 用戶取消
            }
        } catch (err) {
            alert(`匯出失敗: ${err}`);
            setExportProgress(-1);
        } finally {
            setIsBurning(false);
        }
    }, [fileId, segments, subtitleStyle, timelineClips, mediaItems, duration]);

    // ── 播放 ──
    const activeClipSpeed = useMemo(() => {
        if (activeClipId) {
            const clip = timelineClips.find(c => c.id === activeClipId);
            return clip?.speed ?? 1;
        }
        const clip = timelineClips.find(c => c.trackIndex === 0);
        return clip?.speed ?? 1;
    }, [timelineClips, activeClipId]);

    // ── 找到 timelinePos 所在的 clip ──
    const findClipAtTime = useCallback((tlPos: number) => {
        return timelineClips.find(c =>
            c.trackIndex === 0 && tlPos >= c.startTime && tlPos < c.startTime + c.duration
        ) ?? null;
    }, [timelineClips]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (isPlaying) {
            v.pause();
            setIsPlaying(false);
        } else {
            // 記錄開始播放的 wall-clock 和 timeline 位置
            playStartRef.current = performance.now();
            playStartTlRef.current = timelinePosRef.current;
            setIsPlaying(true);

            // 找到當前 clip 並開始播放
            const clip = findClipAtTime(timelinePosRef.current);
            if (clip) {
                const media = mediaItems.find(m => m.id === clip.mediaId);
                if (media && v.src !== media.url && !v.src.endsWith(media.url)) {
                    v.src = media.url;
                    v.load();
                }
                const mediaTime = clip.trimStart + (timelinePosRef.current - clip.startTime) * clip.speed;
                v.currentTime = mediaTime;
                v.playbackRate = clip.speed;
                v.preservesPitch = true;
                currentPlayingClipRef.current = clip.id;
                v.play();
            }
            // 如果在 gap，tick 會處理
        }
    }, [isPlaying, setIsPlaying, findClipAtTime, mediaItems]);

    // ── Seek（直接設定時間軸位置） ──
    const seekTo = useCallback((tlPos: number) => {
        const v = videoRef.current;
        timelinePosRef.current = tlPos;
        // 如果正在播放，重置 wall-clock
        if (isPlaying && !isDraggingRef.current) {
            playStartRef.current = performance.now();
            playStartTlRef.current = tlPos;
        }
        // 找到對應的 clip
        const clip = findClipAtTime(tlPos);
        if (clip && v) {
            const media = mediaItems.find(m => m.id === clip.mediaId);
            if (media && v.src !== media.url && !v.src.endsWith(media.url)) {
                v.src = media.url;
                v.load();
            }
            const mediaTime = clip.trimStart + (tlPos - clip.startTime) * clip.speed;
            v.currentTime = mediaTime;
            v.playbackRate = clip.speed;
            v.preservesPitch = true;
            currentPlayingClipRef.current = clip.id;
            currentTimeRef.current = mediaTime;
            // 拖拉中不要呼叫 play，避免 seek/play race condition
            if (isPlaying && !isDraggingRef.current) v.play();
        } else if (v) {
            v.pause();
            currentPlayingClipRef.current = null;
        }
        setCurrentTime(tlPos); // store timeline pos for React
    }, [setCurrentTime, findClipAtTime, mediaItems, isPlaying]);

    // ── 拖放 ──
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) handleUpload(file);
    }, [handleUpload]);

    // ── 時間軸 x 座標 → 秒數（含吸附） ──
    const xToTime = useCallback((clientX: number, snap = true) => {
        const el = tracksRef.current;
        if (!el || duration <= 0) return 0;
        const rect = el.getBoundingClientRect();
        const x = clientX - rect.left + el.scrollLeft - LABEL_W;
        let time = Math.max(0, Math.min(x / pixelsPerSecond, duration));
        if (snap) {
            const snapped = findSnapTime(time, segments, SNAP_THRESHOLD_SEC);
            if (snapped !== null) {
                setSnapTime(snapped);
                return snapped;
            }
        }
        setSnapTime(null);
        return time;
    }, [duration, pixelsPerSecond, segments, SNAP_THRESHOLD_SEC]);

    // ── 點擊時間軸 seek ──
    const handleTimelineClick = useCallback((e: React.MouseEvent) => {
        if (isDraggingPlayhead) return;
        const time = xToTime(e.clientX, true);
        seekTo(time);
    }, [xToTime, seekTo, isDraggingPlayhead]);

    // ── 播放頭拖拉 ──
    const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingPlayhead(true);
        isDraggingRef.current = true;
        const v = videoRef.current;
        const wasPlaying = v ? !v.paused : false;
        if (v && wasPlaying) { v.pause(); setIsPlaying(false); }

        const onMove = (ev: MouseEvent) => {
            const time = xToTime(ev.clientX, true);
            // 拖拉中直接設定 video currentTime，不走 seekTo 避免 stale closure
            timelinePosRef.current = time;
            const clip = findClipAtTime(time);
            if (clip && v) {
                const media = mediaItems.find(m => m.id === clip.mediaId);
                if (media && v.src !== media.url && !v.src.endsWith(media.url)) {
                    v.src = media.url;
                    v.load();
                }
                const mediaTime = clip.trimStart + (time - clip.startTime) * clip.speed;
                v.currentTime = mediaTime;
                currentTimeRef.current = mediaTime;
                currentPlayingClipRef.current = clip.id;
            }
            setCurrentTime(time);
        };
        const onUp = () => {
            isDraggingRef.current = false;
            setIsDraggingPlayhead(false);
            setSnapTime(null);
            // 拖拉結束後恢復播放
            if (wasPlaying && v) {
                // 先確保 video 已 ready
                playStartRef.current = performance.now();
                playStartTlRef.current = timelinePosRef.current;
                v.play().catch(() => { });
                setIsPlaying(true);
            }
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [xToTime, setIsPlaying, findClipAtTime, mediaItems, setCurrentTime]);

    // ── 滾輪縮放（只在時間軸區域攔截） ──
    const handleTimelineWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY < 0 ? 1.15 : 0.87;
            setZoom((prev) => Math.min(Math.max(prev * factor, 0.1), 50));
        } else {
            const el = tracksRef.current;
            if (el) { el.scrollLeft += e.deltaY; syncRulerScroll(); }
        }
    }, [syncRulerScroll]);

    // ── 只在時間軸區域攔截 Ctrl+滾輪（不干擾瀏覽器正常縮放） ──
    const timelineAreaRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = timelineAreaRef.current;
        if (!el) return;
        const prevent = (e: WheelEvent) => { e.preventDefault(); };
        el.addEventListener('wheel', prevent, { passive: false });
        return () => el.removeEventListener('wheel', prevent);
    });

    // ── Resize Handle 拖曳 ──
    const startResize = useCallback((direction: 'left' | 'right' | 'timeline', e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = leftWidth;
        const startRight = rightWidth;
        const startTlH = timelineHeight;

        const onMove = (ev: MouseEvent) => {
            if (direction === 'left') {
                const dx = ev.clientX - startX;
                setLeftWidth(Math.max(80, Math.min(400, startLeft + dx)));
            } else if (direction === 'right') {
                const dx = ev.clientX - startX;
                setRightWidth(Math.max(120, Math.min(500, startRight - dx)));
            } else {
                const dy = ev.clientY - startY;
                setTimelineHeight(Math.max(120, Math.min(400, startTlH - dy)));
            }
        };
        const onUp = () => {
            setIsResizing(false);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftWidth, rightWidth, timelineHeight]);

    // ── CUE 邊緣拖拉（調整 start/end） ──
    const handleCueEdgeDrag = useCallback((e: React.MouseEvent, segId: number, edge: 'left' | 'right') => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingCue(true);
        pushUndo();

        const onMove = (ev: MouseEvent) => {
            // 直接從 DOM 計算時間軸時間，避免 stale closure
            const el = tracksRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const curDuration = useStore.getState().getDuration();
            if (curDuration <= 0) return;
            // 從 track 容器的實際寬度反推 pixelsPerSecond
            const contentEl = el.querySelector('.track-content') as HTMLElement | null;
            const trackW = contentEl ? contentEl.offsetWidth : (el.scrollWidth - LABEL_W);
            const pps = trackW / curDuration;
            const x = ev.clientX - rect.left + el.scrollLeft - LABEL_W;
            let tlTime = Math.max(0, Math.min(x / pps, curDuration));

            // 吸附（在時間軸座標空間）
            const snapThreshold = 8 / pps;
            const curSegments = useStore.getState().segments;
            const snapped = findSnapTime(tlTime, curSegments, snapThreshold);
            if (snapped !== null) {
                setSnapTime(snapped);
                tlTime = snapped;
            } else {
                setSnapTime(null);
            }

            // 找到字幕所屬的 clip，將時間軸時間轉換為媒體時間
            const state = useStore.getState();
            const ownerClip = state.timelineClips.find(c =>
                c.trackIndex === 0 && c.segments.some(s => s.id === segId)
            );
            if (!ownerClip) return;

            // 時間軸時間 → 媒體時間: mediaTime = (tlTime - clip.startTime) * speed
            const mediaTime = (tlTime - ownerClip.startTime) * ownerClip.speed;
            const mediaDuration = ownerClip.trimEnd; // 媒體最大時間

            const seg = curSegments.find(s => s.id === segId);
            if (!seg) return;
            if (edge === 'left') {
                const newStart = Math.min(mediaTime, seg.end - 0.1);
                updateSegment(segId, { start: Math.max(ownerClip.trimStart, newStart) });
            } else {
                const newEnd = Math.max(mediaTime, seg.start + 0.1);
                updateSegment(segId, { end: Math.min(mediaDuration, newEnd) });
            }
        };
        const onUp = () => {
            setIsDraggingCue(false);
            setSnapTime(null);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [pushUndo, updateSegment]);

    // ── 手動重新分段 ──
    const handleResplit = useCallback(() => {
        if (segments.length === 0) return;
        const split = splitLongCues(segments, subtitleStyle.maxCharsPerCue);
        pushUndo();
        setSegments(split);
    }, [segments, subtitleStyle.maxCharsPerCue, splitLongCues, setSegments, pushUndo]);

    // ── Ctrl+Click 多選字幕項目 ──
    const handleSubtitleItemClick = useCallback((segId: number, e: React.MouseEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setSelectedSegIds(prev => {
                const next = new Set(prev);
                if (next.has(segId)) next.delete(segId);
                else next.add(segId);
                return next;
            });
        } else {
            setSelectedSegIds(new Set());
            setActiveSegment(segId);
            // seg.start 是 media time，轉算成 timeline pos
            const activeClip = activeClipId ? timelineClips.find(c => c.id === activeClipId) : null;
            const seg = segments.find(s => s.id === segId);
            if (seg && activeClip) {
                seekTo(activeClip.startTime + seg.start / activeClip.speed);
            } else if (seg) {
                seekTo(seg.start);
            }
        }
    }, [setActiveSegment, seekTo, segments, activeClipId, timelineClips]);

    // ── 合併已選取的相鄰 CUE（active + Ctrl 選取合計） ──
    const mergeIds = useMemo(() => {
        const all = new Set(selectedSegIds);
        if (activeSegmentId != null) all.add(activeSegmentId);
        return all;
    }, [selectedSegIds, activeSegmentId]);

    const canMergeSelected = useMemo(() => {
        if (mergeIds.size < 2) return false;
        const indices = Array.from(mergeIds).map(id => segments.findIndex(s => s.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
        if (indices.length < 2) return false;
        for (let i = 1; i < indices.length; i++) {
            if (indices[i] !== indices[i - 1] + 1) return false;
        }
        return true;
    }, [mergeIds, segments]);

    const handleMergeSelected = useCallback(() => {
        if (!canMergeSelected) return;
        const indices = Array.from(mergeIds).map(id => segments.findIndex(s => s.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
        const first = indices[0];
        const last = indices[indices.length - 1];
        const mergedSeg = {
            ...segments[first],
            text: indices.map(i => segments[i].text).join(''),
            end: segments[last].end,
        };
        pushUndo();
        const newSegs = [
            ...segments.slice(0, first),
            mergedSeg,
            ...segments.slice(last + 1),
        ].map((s, i) => ({ ...s, id: i }));
        setSegments(newSegs);
        setSelectedSegIds(new Set());
        setActiveSegment(first);
    }, [canMergeSelected, mergeIds, segments, pushUndo, setSegments, setActiveSegment]);

    // ── Enter 手動分割 cue ──
    const handleSplitCue = useCallback((segId: number, cursorPos: number) => {
        const idx = segments.findIndex(s => s.id === segId);
        if (idx < 0) return;
        const seg = segments[idx];
        if (cursorPos <= 0 || cursorPos >= seg.text.length) return;

        const textA = seg.text.slice(0, cursorPos).trim();
        const textB = seg.text.slice(cursorPos).trim();
        if (!textA || !textB) return;

        const ratio = cursorPos / seg.text.length;
        const midTime = seg.start + (seg.end - seg.start) * ratio;

        const newSegments = [
            ...segments.slice(0, idx),
            { ...seg, text: textA, end: midTime },
            { ...seg, text: textB, start: midTime },
            ...segments.slice(idx + 1),
        ].map((s, i) => ({ ...s, id: i }));

        pushUndo();
        setSegments(newSegments);
        // 跳到第二段
        setActiveSegment(idx + 1);
    }, [segments, setSegments, setActiveSegment, pushUndo]);

    // ── 字幕列表自動捲動到當前 cue 置中 ──
    const subtitleListRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (activeSegmentId == null || !subtitleListRef.current) return;
        const el = subtitleListRef.current.querySelector<HTMLElement>(`[data-seg-id="${activeSegmentId}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [activeSegmentId]);

    // ── 快捷鍵：空白鍵 播放/暫停 + Ctrl+Z 復原 ──
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            // Ctrl+Z 復原（不在 textarea/input 時）
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                if (tag === 'TEXTAREA' || tag === 'INPUT') return;
                e.preventDefault();
                handleUndo();
                return;
            }
            // 空白鍵 播放/暫停
            if (e.code !== 'Space') return;
            if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
            e.preventDefault();
            togglePlay();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [togglePlay, handleUndo]);

    // ── 60fps 純 DOM 更新（wall-clock timeline 引擎） ──
    useEffect(() => {
        if (!isPlaying) return;
        let raf: number;
        const clips = timelineClips.filter(c => c.trackIndex === 0).sort((a, b) => a.startTime - b.startTime);
        const items = mediaItems; // closure snapshot

        const tick = () => {
            const v = videoRef.current;
            const ph = playheadRef.current;
            const el = tracksRef.current;

            // 初始用 wall-clock 推算 timeline 位置（用於 gap 或尚未有 clip 的情況）
            const elapsed = (performance.now() - playStartRef.current) / 1000;
            let tl = playStartTlRef.current + elapsed;

            // 找到當前 clip（先用 wall-clock 粗定位）
            const clip = clips.find(c => tl >= c.startTime && tl < c.startTime + c.duration) ?? null;

            if (clip && v) {
                // 在 clip 內
                const media = items.find(m => m.id === clip.mediaId);

                // 需要切換 src？
                if (currentPlayingClipRef.current !== clip.id) {
                    const mediaTime = clip.trimStart + (tl - clip.startTime) * clip.speed;
                    if (media && v.src !== media.url && !v.src.endsWith(media.url)) {
                        v.src = media.url;
                        v.load();
                    }
                    v.playbackRate = clip.speed;
                    v.preservesPitch = true;
                    v.currentTime = mediaTime;
                    currentPlayingClipRef.current = clip.id;
                    v.play();
                }

                // 保持 video 播放
                if (v.paused) v.play();

                // ── 核心修正：用 v.currentTime（實際播放位置）推算 timeline position ──
                // 避免 wall-clock 與瀏覽器影片解碼器時鐘的漂移
                if (!v.paused && currentPlayingClipRef.current === clip.id) {
                    const actualMediaTime = v.currentTime;
                    tl = clip.startTime + (actualMediaTime - clip.trimStart) / clip.speed;
                    // 同步 wall-clock 基準，讓離開 clip 後的 gap 計算正確
                    playStartRef.current = performance.now();
                    playStartTlRef.current = tl;
                }

                const mediaTime = clip.trimStart + (tl - clip.startTime) * clip.speed;
                currentTimeRef.current = mediaTime;
                timelinePosRef.current = tl;

                // 同步 store 的 currentTime（節流：每 250ms 更新一次，避免 60fps re-render）
                if (Math.abs(tl - (useStore.getState().currentTime)) > 0.25) {
                    setCurrentTime(tl);
                }

                // 字幕 overlay — 用 v.currentTime（實際播放位置）比對
                const overlay = subtitleOverlayRef.current;
                if (overlay) {
                    if (clip.segments.length > 0) {
                        const actualMediaTime = v.currentTime;
                        const activeSeg = clip.segments.find(s => actualMediaTime >= s.start && actualMediaTime <= s.end);
                        if (activeSeg) {
                            overlay.textContent = activeSeg.text;
                            overlay.style.display = '';
                            // 同步字幕列表高亮（節流：只在切換 segment 時觸發）
                            if (activeSeg.id !== useStore.getState().activeSegmentId) {
                                setActiveSegment(activeSeg.id);
                            }
                        } else {
                            overlay.style.display = 'none';
                        }
                    } else {
                        overlay.style.display = 'none';
                    }
                }
            } else if (v) {
                // 在 gap 內 — 暫停 video，播放器黑畫面
                if (!v.paused) v.pause();
                currentPlayingClipRef.current = null;
                timelinePosRef.current = tl;
                // 隱藏字幕
                const overlay = subtitleOverlayRef.current;
                if (overlay) overlay.style.display = 'none';
            }

            // 超過時間軸結尾 → 停止
            if (tl >= duration && duration > 0) {
                timelinePosRef.current = duration;
                if (v) v.pause();
                setIsPlaying(false);
                setCurrentTime(duration);
                return; // 不再 requestAnimationFrame
            }
            // 播放頭位置
            if (ph) ph.style.left = `${tl * pixelsPerSecond + LABEL_W}px`;
            // 自動捲動
            if (el && duration > 0) {
                const pos = tl * pixelsPerSecond + LABEL_W;
                const viewStart = el.scrollLeft;
                const viewEnd = viewStart + el.clientWidth;
                if (pos > viewEnd - 80 || pos < viewStart + 80) {
                    el.scrollLeft = pos - 160;
                    syncRulerScroll();
                }
            }
            // 時間顯示
            if (timeDisplayRef.current) timeDisplayRef.current.textContent = `${formatTime(tl)} / ${formatTime(duration)}`;
            // Range slider
            if (rangeSliderRef.current) rangeSliderRef.current.value = String(tl);

            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            setCurrentTime(timelinePosRef.current);
        };
    }, [isPlaying, pixelsPerSecond, duration, timelineClips, mediaItems, syncRulerScroll, setCurrentTime, setIsPlaying, setActiveSegment]);

    // ── Per-clip 波形繪製 ──
    const drawClipWaveform = useCallback((canvas: HTMLCanvasElement, peaks: number[], clipWidthPx: number) => {
        if (peaks.length === 0 || clipWidthPx <= 0) return;
        const h = canvas.parentElement?.clientHeight || 60;
        const dpr = window.devicePixelRatio || 1;

        // Canvas 最大安全寬度（像素含 DPR），避免瀏覽器 crash
        const MAX_CANVAS_PX = 16384;
        const rawW = Math.ceil(clipWidthPx);
        const w = Math.min(rawW, Math.floor(MAX_CANVAS_PX / dpr));
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${rawW}px`; // CSS 寬度保持原始（讓滾動正常）
        canvas.style.height = `${h}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        // 如果超限，計算要繪製的 peak 範圍（只畫可見區域附近）
        const ratio = w / rawW; // 實際繪製的比例
        const peaksToRender = ratio < 1
            ? peaks.slice(0, Math.ceil(peaks.length * ratio))
            : peaks;

        const cellH = 4, gapY = 1.5, gapX = 1;
        const barW = Math.max(3, w / peaksToRender.length - gapX);
        const maxCells = Math.floor(h / (cellH + gapY));
        const maxAmp = Math.max(...peaksToRender, 0.01);

        for (let i = 0; i < peaksToRender.length; i++) {
            const norm = peaksToRender[i] / maxAmp;
            const cells = Math.max(1, Math.round(norm * maxCells));
            const x = (i / peaksToRender.length) * w;
            for (let c = 0; c < cells; c++) {
                const y = h - (c + 1) * (cellH + gapY);
                const ratioc = c / maxCells;
                ctx.fillStyle = ratioc > 0.85 ? '#e04050' : ratioc > 0.7 ? '#e0a040' : '#6eccc0';
                ctx.fillRect(x, y, barW, cellH);
            }
        }
    }, []);

    useEffect(() => {
        for (const clip of timelineClips) {
            const media = mediaItems.find(m => m.id === clip.mediaId);
            if (!media || media.waveformPeaks.length === 0) continue;
            const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-clip-id="${clip.id}"]`);
            if (!canvas) continue;
            const clipWidthPx = clip.duration * pixelsPerSecond;
            drawClipWaveform(canvas, media.waveformPeaks, clipWidthPx);
        }
    }, [timelineClips, mediaItems, pixelsPerSecond, drawClipWaveform]);

    const rulerTicks = generateRulerTicks(duration, pixelsPerSecond);

    const mainJsx = (
        <div className="app">
            {/* Header */}
            <header className="app-header">
                <h1>LJCUT</h1>
                <div style={{ display: 'flex', gap: 8 }}>
                    {segments.length > 0 && (
                        <>
                            <button className="btn" onClick={handleExportSrt}>📄 匯出 SRT</button>
                            <button className="btn btn-accent" onClick={handleExportVideo} disabled={isBurning}>
                                {isBurning ? `⏳ 匯出中 ${exportProgress >= 0 ? exportProgress + '%' : '...'}` : '🎬 匯出影片'}
                            </button>
                        </>
                    )}
                    <button className="btn" onClick={() => setShowRecSettings(true)}>⏺ 螢幕錄影</button>
                    <button className="btn" onClick={() => setShowSettings(true)} title="設定" style={{ padding: '6px 10px' }}>⚙</button>
                </div>
            </header>

            {/* 錄影設定 Modal */}
            {showRecSettings && (
                <div className="modal-overlay" onClick={() => setShowRecSettings(false)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>螢幕錄影設定</h3>
                            <button className="btn" onClick={() => setShowRecSettings(false)} style={{ padding: '2px 8px' }}>✕</button>
                        </div>
                        <div className="rec-setting-row">
                            <label>🔊 系統聲音</label>
                            <label className="toggle-switch" title={IS_TAURI ? '需安裝 loopback 音訊裝置（如 VB-Cable）' : ''}>
                                <input type="checkbox" checked={recOpts.sysAudio}
                                    disabled={IS_TAURI && !recOpts.sysAudioDevice}
                                    onChange={e => setRecOpts(o => ({ ...o, sysAudio: e.target.checked }))} />
                                <span className="toggle-slider" />
                            </label>
                            {IS_TAURI && !recOpts.sysAudioDevice && (
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
                                        <div
                                            className="mic-meter-fill"
                                            style={{ width: `${micLevel * 100}%` }}
                                        />
                                    </div>
                                    <span className="mic-level-val">{Math.round(micLevel * 100)}%</span>
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
                                {(['720p', '1080p', '4k'] as const).map(q => (
                                    <button key={q}
                                        className={`btn rec-quality-btn ${recOpts.quality === q ? 'active' : ''}`}
                                        onClick={() => setRecOpts(o => ({ ...o, quality: q }))}>{q.toUpperCase()}</button>
                                ))}
                            </div>
                        </div>
                        <div className="rec-setting-row">
                            <label>🎞️ FPS</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                                {([24, 30, 60] as const).map(f => (
                                    <button key={f}
                                        className={`btn rec-quality-btn ${recOpts.fps === f ? 'active' : ''}`}
                                        onClick={() => setRecOpts(o => ({ ...o, fps: f }))}>{f}</button>
                                ))}
                            </div>
                        </div>
                        <button className="btn btn-accent" onClick={handleStartRec}
                            style={{ width: '100%', justifyContent: 'center', marginTop: 16, padding: '10px 0', fontSize: 14 }}>
                            ⏺ 開始錄影
                        </button>
                    </div>
                </div>
            )}

            {/* 懸浮錄影控制列 */}
            {isRecording && (
                <div className="rec-floating-bar">
                    <span className="rec-dot" />
                    <span className="rec-timer">{formatTime(recSeconds)}</span>
                    <button className="rec-ctrl-btn" onClick={handlePauseRec} title={isPaused ? '繼續' : '暫停'}>
                        {isPaused ? '▶' : '⏸'}
                    </button>
                    <button className="rec-ctrl-btn rec-stop" onClick={handleStopRec} title="停止">⏹</button>
                </div>
            )}

            {/* 設定 Modal */}
            {showSettings && (
                <div className="modal-overlay" onClick={() => setShowSettings(false)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>設定</h3>
                            <button className="btn" onClick={() => setShowSettings(false)} style={{ padding: '2px 8px' }}>✕</button>
                        </div>
                        <div className="style-row">
                            <label>輸出目錄</label>
                            <button className="folder-pick-btn" onClick={async () => {
                                try {
                                    const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
                                    if (IS_TAURI) {
                                        const { open } = await import('@tauri-apps/plugin-dialog');
                                        const selected = await open({ directory: true, title: '選擇輸出目錄' });
                                        if (selected) setSettings(s => ({ ...s, outputDir: String(selected) }));
                                    } else {
                                        const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
                                        setSettings(s => ({ ...s, outputDir: handle.name }));
                                    }
                                } catch { /* 使用者取消 */ }
                            }}>
                                <span>{settings.outputDir || '點擊選擇資料夾...'}</span>
                                <span className="folder-icon">📁</span>
                            </button>
                        </div>
                        <div className="style-row">
                            <label>SRT 存放目錄</label>
                            <button className="folder-pick-btn" onClick={async () => {
                                try {
                                    const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
                                    if (IS_TAURI) {
                                        const { open } = await import('@tauri-apps/plugin-dialog');
                                        const selected = await open({ directory: true, title: '選擇 SRT 存放目錄' });
                                        if (selected) setSettings(s => ({ ...s, srtDir: String(selected) }));
                                    } else {
                                        const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
                                        setSettings(s => ({ ...s, srtDir: handle.name }));
                                    }
                                } catch { /* 使用者取消 */ }
                            }}>
                                <span>{settings.srtDir || '預設：與輸出相同'}</span>
                                <span className="folder-icon">📁</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className={`app-body ${isResizing ? 'resizing' : ''}`}>
                {/* 左側 — 媒體庫 */}
                <aside className="panel-left" style={{ width: leftWidth }}>
                    {/* 頁籤切換 */}
                    <div className="left-tabs">
                        <button className={`left-tab ${leftTab === 'media' ? 'active' : ''}`} onClick={() => setLeftTab('media')}>媒體</button>
                        <button className={`left-tab ${leftTab === 'subtitle' ? 'active' : ''}`} onClick={() => setLeftTab('subtitle')}>字幕</button>
                    </div>

                    <div className="left-tab-body">
                        {/* ─── 媒體頁籤 ─── */}
                        {leftTab === 'media' && (
                            <>
                                {/* 上傳區 */}
                                <div className="upload-zone upload-zone-compact" onClick={() => fileInputRef.current?.click()}
                                    onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                    <p>{isUploading ? '上傳中...' : '點擊新增 或 拖放檔案'}</p>
                                    <input ref={fileInputRef} type="file" accept="video/*,audio/*" hidden multiple
                                        onChange={(e) => {
                                            const files = e.target.files;
                                            if (files) Array.from(files).forEach(f => handleUpload(f));
                                            e.target.value = '';
                                        }} />
                                </div>

                                {/* 媒體清單 */}
                                {mediaItems.length > 0 && (
                                    <div className="media-list">
                                        {mediaItems.map(item => (
                                            <div key={item.id} className="media-item"
                                                draggable
                                                onDragStart={(e) => {
                                                    e.dataTransfer.setData('application/ljcut-media-id', item.id);
                                                    e.dataTransfer.effectAllowed = 'copy';
                                                }}
                                                title={`${item.filename}\n${formatTime(item.info.duration)} | ${item.info.size_mb} MB\n拖放到時間軸`}>
                                                <div className="media-thumb">
                                                    {item.thumbnailUrl ? (
                                                        <img src={item.thumbnailUrl} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                    ) : (
                                                        <span>🎥</span>
                                                    )}
                                                </div>
                                                <div className="media-meta">
                                                    <div className="media-name">{item.filename}</div>
                                                    <div className="media-duration">{formatTime(item.info.duration)}</div>
                                                </div>
                                                <button className="media-remove" onClick={(e) => { e.stopPropagation(); removeMedia(item.id); }} title="移除">×</button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                            </>
                        )}

                        {/* ─── 字幕設定頁籤 ─── */}
                        {leftTab === 'subtitle' && (
                            <>
                                {/* 辨識控制 */}
                                {primaryMedia && (
                                    <>
                                        <div className="language-select">
                                            <label>辨識語言</label>
                                            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                                                <option value="zh">中文</option>
                                                <option value="en">English</option>
                                                <option value="ja">日本語</option>
                                                <option value="auto">自動偵測</option>
                                            </select>
                                        </div>
                                        <div className="action-buttons">
                                            <button className="btn btn-primary" onClick={handleTranscribe}
                                                disabled={isTranscribing} style={{ width: '100%', justifyContent: 'center' }}>
                                                {isTranscribing ? '辨識中...' : '開始辨識'}
                                            </button>
                                            {isTranscribing && <div className="progress-bar"><div className="fill loading" style={{ width: '100%' }} /></div>}
                                        </div>
                                    </>
                                )}
                                {!primaryMedia && <div className="empty-state" style={{ padding: 20 }}><p>請先上傳媒體</p></div>}

                                {/* 字幕樣式 */}
                                {segments.length > 0 && (
                                    <div className="subtitle-style-panel">
                                        <div className="style-title">字幕樣式</div>
                                        <div className="style-row">
                                            <label>字形</label>
                                            <select value={subtitleStyle.fontName}
                                                onChange={e => setSubtitleStyle({ fontName: e.target.value })}>
                                                <option value="Microsoft JhengHei">微軟正黑體</option>
                                                <option value="DFKai-SB">標楷體</option>
                                                <option value="Microsoft YaHei">微軟雅黑</option>
                                                <option value="Noto Sans TC">Noto Sans TC</option>
                                                <option value="Arial">Arial</option>
                                            </select>
                                        </div>
                                        <div className="style-row">
                                            <label>字體大小</label>
                                            <input type="number" min={8} max={72} value={subtitleStyle.fontSize}
                                                onChange={e => setSubtitleStyle({ fontSize: Number(e.target.value) })} />
                                        </div>
                                        <div className="style-row">
                                            <label>外框粗細</label>
                                            <input type="number" min={0} max={5} value={subtitleStyle.outlineWidth}
                                                onChange={e => setSubtitleStyle({ outlineWidth: Number(e.target.value) })} />
                                        </div>
                                        <div className="style-row">
                                            <label>文字背景</label>
                                            <label className="toggle-switch">
                                                <input type="checkbox" checked={subtitleStyle.bgEnabled}
                                                    onChange={e => setSubtitleStyle({ bgEnabled: e.target.checked })} />
                                                <span className="toggle-slider" />
                                            </label>
                                        </div>
                                        {subtitleStyle.bgEnabled && (
                                            <div className="style-row">
                                                <label>透明度</label>
                                                <input type="range" min={0} max={100} value={subtitleStyle.bgOpacity}
                                                    onChange={e => setSubtitleStyle({ bgOpacity: Number(e.target.value) })} />
                                                <span className="opacity-val">{subtitleStyle.bgOpacity}%</span>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* 字幕分段 */}
                                {segments.length > 0 && (
                                    <div className="subtitle-style-panel">
                                        <div className="style-title">字幕分段</div>
                                        <div className="style-row">
                                            <label>每段上限</label>
                                            <input type="number" min={5} max={50} value={subtitleStyle.maxCharsPerCue}
                                                onChange={e => setSubtitleStyle({ maxCharsPerCue: Number(e.target.value) })} />
                                            <span className="opacity-val">字</span>
                                        </div>
                                        <button className="btn" onClick={handleResplit}
                                            style={{ width: '100%', justifyContent: 'center', marginTop: 6, fontSize: 12 }}>
                                            重新分段
                                        </button>
                                    </div>
                                )}

                                {/* ── AI 助手（可折疊） ── */}
                                {segments.length > 0 && (
                                    <div className="ai-collapse">
                                        <button className="ai-collapse-toggle" onClick={() => setAiExpanded(v => !v)}>
                                            <span>{aiExpanded ? '▾' : '▸'} AI 助手</span>
                                            <button className="ai-refresh-btn" disabled={!!aiLoadingType}
                                                onClick={(ev) => { ev.stopPropagation(); runAllAi(segments); }} title="重新生成">🔄</button>
                                        </button>
                                        {aiExpanded && (
                                            <div className="ai-assistant">
                                                <div className="ai-tabs">
                                                    {AI_TABS.map(tab => (
                                                        <button key={tab.key}
                                                            className={`ai-tab ${aiActiveTab === tab.key ? 'active' : ''} ${aiLoadingType === tab.key ? 'loading' : ''}`}
                                                            onClick={() => setAiActiveTab(tab.key)}>
                                                            {tab.label}
                                                            {aiLoadingType === tab.key && <span className="ai-spinner">●</span>}
                                                        </button>
                                                    ))}
                                                </div>
                                                <div className="ai-result">
                                                    <pre>{aiResultsRef.current[aiActiveTab] || ''}{aiLoadingType === aiActiveTab ? '▌' : ''}</pre>
                                                    {aiResultsRef.current[aiActiveTab] && aiLoadingType !== aiActiveTab && (
                                                        <button className="copy-btn" onClick={() => {
                                                            navigator.clipboard.writeText(aiResultsRef.current[aiActiveTab]);
                                                            setAiCopied(true); setTimeout(() => setAiCopied(false), 2000);
                                                        }}>{aiCopied ? '✅ 已複製' : '複製'}</button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </aside>

                {/* 左側 Resize Handle */}
                <div className="resize-handle-v" onMouseDown={(e) => startResize('left', e)} />

                {/* 中間：影片 */}
                <main className="panel-center">
                    <div className="video-container" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
                        {primaryMedia ? (
                            <video ref={videoRef} src={primaryMedia.url}
                                onTimeUpdate={() => {
                                    // 播放中由 tick loop 處理字幕同步，避免 React re-render 覆蓋正確的 overlay
                                    if (isPlaying) return;
                                    const v = videoRef.current;
                                    if (v && !v.paused) {
                                        const active = segments.find((s) => v.currentTime >= s.start && v.currentTime <= s.end);
                                        if (active && active.id !== activeSegmentId) setActiveSegment(active.id);
                                    }
                                }}
                                onEnded={() => setIsPlaying(false)}
                                onClick={togglePlay} style={{ cursor: 'pointer' }} />
                        ) : (
                            <div className="video-placeholder">
                                <div className="icon">🎬</div><p>請上傳影片或音頻</p>
                            </div>
                        )}

                        {/* 字幕即時預覽 overlay */}
                        {primaryMedia && segments.length > 0 && (() => {
                            // currentTime 是 timeline position，需轉換為 media time 再比對字幕區間
                            const overlayClip = timelineClips.find(c =>
                                c.trackIndex === 0 && currentTime >= c.startTime && currentTime < c.startTime + c.duration
                            );
                            const mediaTimeForOverlay = overlayClip
                                ? overlayClip.trimStart + (currentTime - overlayClip.startTime) * overlayClip.speed
                                : currentTime;
                            const overlaySegs = overlayClip?.segments ?? segments;
                            const activeSeg = overlaySegs.find(s => mediaTimeForOverlay >= s.start && mediaTimeForOverlay <= s.end);
                            const bgAlpha = subtitleStyle.bgEnabled ? subtitleStyle.bgOpacity / 100 : 0;

                            // 計算影片實際顯示範圍（object-fit: contain 的 letterbox）
                            const v = videoRef.current;
                            let frameTop = 0, frameLeft = 0, frameW = 0, frameH = 0, scale = 1;
                            if (v && v.videoWidth && v.videoHeight) {
                                const containerRect = v.parentElement?.getBoundingClientRect();
                                if (containerRect) {
                                    const cW = containerRect.width;
                                    const cH = containerRect.height;
                                    const videoAspect = v.videoWidth / v.videoHeight;
                                    const containerAspect = cW / cH;
                                    if (containerAspect > videoAspect) {
                                        // pillarbox（上下填滿，左右有黑邊）
                                        frameH = cH;
                                        frameW = cH * videoAspect;
                                        frameTop = 0;
                                        frameLeft = (cW - frameW) / 2;
                                    } else {
                                        // letterbox（左右填滿，上下有黑邊）
                                        frameW = cW;
                                        frameH = cW / videoAspect;
                                        frameLeft = 0;
                                        frameTop = (cH - frameH) / 2;
                                    }
                                    scale = frameH / v.videoHeight;
                                }
                            }

                            const scaledFontSize = Math.max(12, subtitleStyle.fontSize * scale);
                            const scaledOutline = Math.max(1, subtitleStyle.outlineWidth * scale);

                            return (
                                <div
                                    ref={subtitleOverlayRef}
                                    className={`subtitle-preview-overlay ${isDraggingPreview ? 'dragging' : ''}`}
                                    style={{
                                        top: `${frameTop + frameH * (subtitleStyle.posY / 100)}px`,
                                        left: `${frameLeft + frameW / 2}px`,
                                        fontFamily: subtitleStyle.fontName,
                                        fontSize: `${scaledFontSize}px`,
                                        WebkitTextStroke: `${scaledOutline}px #000`,
                                        paintOrder: 'stroke fill',
                                        backgroundColor: bgAlpha > 0 ? `rgba(0,0,0,${bgAlpha})` : 'transparent',
                                        display: activeSeg ? '' : 'none',
                                        maxWidth: `${frameW * 0.9}px`,
                                    }}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setIsDraggingPreview(true);
                                        const startY = e.clientY;
                                        const startPos = subtitleStyle.posY;

                                        const onMove = (ev: MouseEvent) => {
                                            const dy = ev.clientY - startY;
                                            // 用影片高度計算 posY 百分比
                                            const fH = frameH || 1;
                                            const newPos = Math.max(5, Math.min(95, startPos + (dy / fH) * 100));
                                            setSubtitleStyle({ posY: Math.round(newPos) });
                                        };
                                        const onUp = () => {
                                            setIsDraggingPreview(false);
                                            window.removeEventListener('mousemove', onMove);
                                            window.removeEventListener('mouseup', onUp);
                                        };
                                        window.addEventListener('mousemove', onMove);
                                        window.addEventListener('mouseup', onUp);
                                    }}
                                    title="拖拉調整字幕位置"
                                >
                                    {activeSeg?.text ?? ''}
                                </div>
                            );
                        })()}
                    </div>

                    {(hasTimeline || primaryMedia) && (
                        <div className="video-controls">
                            <button className="btn" onClick={togglePlay} style={{ padding: '6px 12px' }}>
                                {isPlaying ? '⏸' : '▶'}
                            </button>
                            <span className="time" ref={timeDisplayRef}>{formatTime(currentTime)} / {formatTime(duration)}</span>
                            <input type="range" ref={rangeSliderRef} min={0} max={duration || 0} step={0.1} defaultValue={currentTime}
                                onChange={(e) => seekTo(Number(e.target.value))}
                                style={{ flex: 1, accentColor: 'var(--accent-amber)' }} />
                            {activeClipSpeed !== 1 && <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>⚡{activeClipSpeed}x</span>}
                            <span className="time" style={{ fontSize: 11 }}>{Math.round(zoom * 100)}%</span>
                            <button className="btn" onClick={() => setZoom(z => Math.max(z * 0.8, 0.1))} style={{ padding: '4px 8px', fontSize: 12 }}>−</button>
                            <button className="btn" onClick={() => setZoom(z => Math.min(z * 1.25, 50))} style={{ padding: '4px 8px', fontSize: 12 }}>+</button>
                        </div>
                    )}

                    {/* Timeline Resize Handle（水平） */}
                    {(hasTimeline || primaryMedia) && <div className="resize-handle-h" onMouseDown={(e) => startResize('timeline', e)} />}

                    {/* ── 多軌時間軸 ── */}
                    {(hasTimeline || primaryMedia) && (
                        <div className="timeline-area" ref={timelineAreaRef} onWheel={handleTimelineWheel} style={{ height: timelineHeight }}>
                            {/* 時間刻度尺 */}
                            <div className="timeline-ruler" ref={rulerRef}>
                                <div className="ruler-pad" style={{ width: LABEL_W }} />
                                <div className="ruler-content" style={{ width: timelineWidth }}>
                                    {rulerTicks.map((tick) => (
                                        <div key={tick.time} className="ruler-tick"
                                            style={{ left: tick.time * pixelsPerSecond }}>
                                            <span className="ruler-label">{tick.label}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* 軌道 */}
                            <div className="timeline-tracks" ref={tracksRef}
                                onScroll={syncRulerScroll} onClick={handleTimelineClick}
                                onDrop={handleDropToTimeline}
                                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}>
                                {/* 影片軌（多 clip） */}
                                <div className="track">
                                    <div className="track-label" style={{ width: LABEL_W }}>🎬 影片</div>
                                    <div className="track-content" style={{ width: timelineWidth }}>
                                        {timelineClips.filter(c => c.trackIndex === 0).map(clip => {
                                            const media = mediaItems.find(m => m.id === clip.mediaId);
                                            const left = clip.startTime * pixelsPerSecond;
                                            const width = Math.max(clip.duration * pixelsPerSecond, 4);
                                            return (
                                                <div key={clip.id}
                                                    className={`track-clip video-clip ${draggingClipId === clip.id ? 'dragging' : ''} ${activeClipId === clip.id ? 'active-clip' : ''}`}
                                                    style={{ left, width }}
                                                    onClick={() => setActiveClipId(clip.id)}
                                                    onMouseDown={(e) => handleClipDragStart(e, clip.id)}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        setSpeedMenu({ clipId: clip.id, x: e.clientX, y: e.clientY });
                                                    }}
                                                    title={`${media?.filename ?? 'clip'}${clip.speed !== 1 ? ` (${clip.speed}x)` : ''}\n${formatTimestamp(clip.startTime)} → ${formatTimestamp(clip.startTime + clip.duration)}`}>
                                                    <canvas data-clip-id={clip.id} className="waveform-canvas" />
                                                    <span className="clip-text clip-text-over-waveform">{media?.filename ?? ''}</span>
                                                    {clip.speed !== 1 && <span style={{ position: 'absolute', right: 4, top: 2, fontSize: 10, color: '#fbbf24', fontWeight: 700 }}>⚡{clip.speed}x</span>}
                                                </div>
                                            );
                                        })}
                                        {timelineClips.length === 0 && (
                                            <div className="track-drop-hint">從左側媒體庫拖放媒體到此號</div>
                                        )}
                                    </div>
                                </div>

                                {/* 字幕軌 */}
                                <div className="track">
                                    <div className="track-label" style={{ width: LABEL_W }}>💬 字幕</div>
                                    <div className="track-content" style={{ width: timelineWidth }}>
                                        {timelineClips.filter(c => c.trackIndex === 0 && c.segments.length > 0).map(clip =>
                                            clip.segments.map((seg) => {
                                                const left = (clip.startTime + seg.start / clip.speed) * pixelsPerSecond;
                                                const width = Math.max(((seg.end - seg.start) / clip.speed) * pixelsPerSecond, 2);
                                                return (
                                                    <div
                                                        key={`${clip.id}-${seg.id}`}
                                                        className={`track-clip subtitle-clip ${seg.id === activeSegmentId ? 'active' : ''} ${isDraggingCue ? 'resizing' : ''}`}
                                                        style={{ left, width }}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setActiveClipId(clip.id);
                                                            setActiveSegment(seg.id);
                                                            seekTo((clip.startTime + seg.start / clip.speed));
                                                        }}
                                                        title={`${formatTimestamp(seg.start)} → ${formatTimestamp(seg.end)}\n${seg.text}`}
                                                    >
                                                        <div className="cue-handle cue-handle-left"
                                                            onMouseDown={(e) => handleCueEdgeDrag(e, seg.id, 'left')} />
                                                        <span className="clip-text">{seg.text}</span>
                                                        <div className="cue-handle cue-handle-right"
                                                            onMouseDown={(e) => handleCueEdgeDrag(e, seg.id, 'right')} />
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>

                                {/* 播放頭（可拖拉，用 ref 直接操作 DOM） */}
                                {duration > 0 && (
                                    <div
                                        ref={playheadRef}
                                        className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                                        style={{ left: currentTime * pixelsPerSecond + LABEL_W }}
                                        onMouseDown={handlePlayheadMouseDown}
                                    />
                                )}

                                {/* 吸附指示線 */}
                                {snapTime !== null && duration > 0 && (
                                    <div className="snap-line"
                                        style={{ left: snapTime * pixelsPerSecond + LABEL_W }} />
                                )}
                            </div>
                        </div>
                    )}
                </main>

                {/* 右側 Resize Handle */}
                <div className="resize-handle-v" onMouseDown={(e) => startResize('right', e)} />

                {/* 右側：字幕 */}
                <aside className="panel-right" style={{ width: rightWidth }}>
                    <div className="subtitle-header">
                        <h3>字幕</h3>
                        {segments.length > 0 && (
                            <span style={{ fontSize: 12, color: 'var(--fg-subtext0)' }}>{segments.length} 段</span>
                        )}
                    </div>
                    <div className="subtitle-list" ref={subtitleListRef}>
                        {segments.length === 0 ? (
                            <div className="empty-state">
                                <p>尚無字幕</p>
                                <p style={{ fontSize: 11 }}>上傳影片後在「字幕」頁籤點擊開始辨識</p>
                            </div>
                        ) : (
                            <>
                                {segments.map((seg) => (
                                    <div key={seg.id}
                                        data-seg-id={seg.id}
                                        className={`subtitle-item ${seg.id === activeSegmentId ? 'active' : ''} ${selectedSegIds.has(seg.id) ? 'selected' : ''}`}
                                        onClick={(e) => handleSubtitleItemClick(seg.id, e)}>
                                        <div className="index">{seg.id + 1}</div>
                                        <div className="content">
                                            <div className="time-range">
                                                {formatTimestamp(seg.start)} → {formatTimestamp(seg.end)}
                                            </div>
                                            {seg.id === activeSegmentId && !selectedSegIds.has(seg.id) ? (
                                                <textarea value={seg.text}
                                                    onChange={(e) => updateSegment(seg.id, { text: e.target.value })}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' && !e.shiftKey) {
                                                            e.preventDefault();
                                                            const pos = (e.target as HTMLTextAreaElement).selectionStart;
                                                            handleSplitCue(seg.id, pos);
                                                        }
                                                    }}
                                                    onClick={(e) => e.stopPropagation()} rows={2} />
                                            ) : (
                                                <div className="text">{seg.text}</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {/* 懸浮合併按鈕 */}
                                {canMergeSelected && (() => {
                                    const maxId = Math.max(...Array.from(selectedSegIds));
                                    const anchorEl = subtitleListRef.current?.querySelector(`[data-seg-id="${maxId}"]`) as HTMLElement | null;
                                    const listEl = subtitleListRef.current;
                                    if (!anchorEl || !listEl) return null;
                                    const anchorRect = anchorEl.getBoundingClientRect();
                                    const listRect = listEl.getBoundingClientRect();
                                    const top = anchorRect.bottom - listRect.top + listEl.scrollTop + 4;
                                    return (
                                        <div className="merge-float-btn" style={{ top }}>
                                            <button className="btn" onClick={handleMergeSelected}>
                                                合併 {mergeIds.size} 個字幕
                                            </button>
                                        </div>
                                    );
                                })()}
                            </>
                        )}
                    </div>
                </aside>
            </div>
        </div>
    );

    // ── 倍速右鍵選單 portal（放在最外層避免被截斷） ──
    const speedMenuClip = speedMenu ? timelineClips.find(c => c.id === speedMenu.clipId) : null;

    return (
        <>
            {mainJsx}
            {speedMenu && speedMenuClip && (
                <div className="speed-menu-backdrop" onClick={() => setSpeedMenu(null)}>
                    <div className="speed-menu" style={{
                        left: Math.min(speedMenu.x, window.innerWidth - 220),
                        top: Math.min(speedMenu.y, window.innerHeight - 200),
                    }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="speed-menu-title">⚡ 影片速度</div>
                        <div className="speed-menu-value">{speedMenuClip.speed.toFixed(1)}x</div>
                        <input type="range" className="speed-slider"
                            min={1} max={5} step={0.1}
                            value={speedMenuClip.speed}
                            onChange={(e) => setClipSpeed(speedMenu!.clipId, parseFloat(e.target.value))} />
                        <div className="speed-menu-labels">
                            <span>1x</span><span>2x</span><span>3x</span><span>4x</span><span>5x</span>
                        </div>
                        <div className="speed-menu-presets">
                            {[1, 1.5, 2, 3, 5].map(s => (
                                <button key={s}
                                    className={`speed-preset-btn ${speedMenuClip!.speed === s ? 'active' : ''}`}
                                    onClick={() => setClipSpeed(speedMenu!.clipId, s)}>{s}x</button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {/* 匯出進度 Modal */}
            {exportProgress >= 0 && (
                <div className="export-progress-backdrop">
                    <div className="export-progress-modal">
                        <div className="export-progress-title">🎬 匯出影片中...</div>
                        <div className="export-progress-bar-track">
                            <div
                                className="export-progress-bar-fill"
                                style={{ width: `${exportProgress}%` }}
                            />
                        </div>
                        <div className="export-progress-pct">{exportProgress}%</div>
                        {exportProgress >= 100 && (
                            <div className="export-progress-done">✅ 完成！</div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
