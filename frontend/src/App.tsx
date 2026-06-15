/* ── LJCUT 主應用 ── */

import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { useStore } from './store';
import { api } from './api';
import type { MediaItem, TimelineClip, Segment, AppSettings, RecOpts, MicDevice } from './types';
import { formatTime, formatTimestamp, generateRulerTicks, findSnapTime, LABEL_W } from './utils';
import { SettingsModal } from './components/SettingsModal';
import { RecordingSettingsModal } from './components/RecordingSettingsModal';
import { SpeedMenu } from './components/SpeedMenu';
import { ExportProgress } from './components/ExportProgress';
import { AiPanel } from './components/AiPanel';

export default function App() {
    // 雙緩衝：兩個 <video> 疊在一起，永遠只有一個顯示(active)，另一個(standby)預載下一段。
    // videoRef 永遠指向 active 元素（手動維護），既有邏輯一律透過它操作目前顯示中的影片。
    const vid0Ref = useRef<HTMLVideoElement | null>(null);
    const vid1Ref = useRef<HTMLVideoElement | null>(null);
    const activeIdxRef = useRef(0); // 0 或 1：目前 active 的元素
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const primedClipRef = useRef<string | null>(null); // standby 已預載好的 clip ID（null=未預載）
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
    const clipReadyRef = useRef(false); // 當前 clip 的影片是否已載入+seek 完成（未就緒時時間軸改用牆鐘推算，避免載入空窗跳針）
    const pendingLoadRef = useRef<(() => void) | null>(null); // 尚未觸發的 loadedmetadata 監聽（切換太快時用來移除舊的）
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
    const [settings, setSettings] = useState<AppSettings>({ outputDir: '', srtDir: '' });
    const [isRecording, setIsRecording] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [recSeconds, setRecSeconds] = useState(0);
    const [showRecSettings, setShowRecSettings] = useState(false);
    const [recOpts, setRecOpts] = useState<RecOpts>({ sysAudio: false, mic: false, quality: '1080p', fps: 60, micDevice: '', sysAudioDevice: '', micVol: 1.0, sysVol: 1.0, cursorGlow: false, clickEffect: false });
    const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
    const micStreamRef = useRef<MediaStream | null>(null);
    const micAnimRef = useRef<number>(0);
    const micMeterFillRef = useRef<HTMLDivElement>(null);
    const micMeterValRef = useRef<HTMLSpanElement>(null);
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
            if (micMeterFillRef.current) micMeterFillRef.current.style.width = '100%';
            if (micMeterValRef.current) micMeterValRef.current.textContent = '0%';
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
                // WebView2/Chromium 的 autoplay 政策可能讓 AudioContext 處於 suspended，
                // 導致分析資料凍結 → 音量計卡住。明確 resume。
                await audioCtx.resume().catch(() => { });
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                const dataArray = new Uint8Array(analyser.fftSize);

                const tick = () => {
                    if (cancelled) { audioCtx.close(); return; }
                    // 若被瀏覽器暫停就嘗試恢復（避免凍結）
                    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { });
                    analyser.getByteTimeDomainData(dataArray);
                    // 先求實際平均值(DC offset)再扣除：某些麥克風波形中心不在 128，
                    // 固定用 128 當基準會讓靜音時 RMS 殘留非零。
                    let mean = 0;
                    for (let i = 0; i < dataArray.length; i++) mean += dataArray[i];
                    mean /= dataArray.length;
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        const val = (dataArray[i] - mean) / 128;
                        sum += val * val;
                    }
                    const rms = Math.sqrt(sum / dataArray.length);
                    let level = Math.min(rms * 3.5, 1);
                    if (level < 0.02) level = 0; // 雜訊門檻：靜音時歸零
                    // 直接更新 DOM（不走 React state，避免每秒 60 次重繪整個 App 造成凍結）
                    // micMeterFillRef 是「未滿遮罩」：寬度 = 未滿百分比，蓋住右側未達到的漸層
                    if (micMeterFillRef.current) micMeterFillRef.current.style.width = `${(1 - level) * 100}%`;
                    if (micMeterValRef.current) micMeterValRef.current.textContent = `${Math.round(level * 100)}%`;
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
                    cursorGlow: recOpts.cursorGlow,
                    clickEffect: recOpts.clickEffect,
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

    // ── F10 全域快捷鍵停止錄影（Rust 端發 hotkey_stop 事件）──
    useEffect(() => {
        if (!IS_TAURI) return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const u = await listen('hotkey_stop', () => { handleStopRec(); });
            // 處理 StrictMode 下 cleanup 早於 listen 解析的競態，避免重複訂閱
            if (cancelled) { u(); } else { unlisten = u; }
        })();
        return () => { cancelled = true; if (unlisten) unlisten(); };
    }, [handleStopRec]);

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

    // ── 雙緩衝輔助 ──
    const getActiveVideo = useCallback(() => (activeIdxRef.current === 0 ? vid0Ref.current : vid1Ref.current), []);
    const getStandbyVideo = useCallback(() => (activeIdxRef.current === 0 ? vid1Ref.current : vid0Ref.current), []);

    // 預載下一段到 standby 元素（換好 src + seek 到起點，保持暫停隱藏），到交界即可瞬間切換
    const primeStandby = useCallback((clip: TimelineClip) => {
        const s = getStandbyVideo();
        if (!s) return;
        const media = mediaItems.find(m => m.id === clip.mediaId);
        if (!media) return;
        if (s.src !== media.url && !s.src.endsWith(media.url)) {
            s.src = media.url;
            s.load();
        }
        const applySeek = () => {
            try { s.currentTime = clip.trimStart; } catch { /* ignore */ }
            s.preservesPitch = true;
            s.muted = false;
            s.playbackRate = clip.speed;
        };
        if (s.readyState >= 1) applySeek();
        else {
            const h = () => { s.removeEventListener('loadedmetadata', h); applySeek(); };
            s.addEventListener('loadedmetadata', h);
        }
        s.pause();
        primedClipRef.current = clip.id;
    }, [getStandbyVideo, mediaItems]);

    // 把已預載好的 standby 切成 active 並播放（無縫）。未預載/未就緒則回 false 讓呼叫端降級。
    const swapToStandby = useCallback((clip: TimelineClip, autoplay: boolean): boolean => {
        const standby = getStandbyVideo();
        const old = getActiveVideo();
        if (!standby || primedClipRef.current !== clip.id || standby.readyState < 1) return false;
        if (old) { old.pause(); old.style.opacity = '0'; }
        standby.style.opacity = '1';
        standby.muted = false;
        standby.preservesPitch = true;
        standby.playbackRate = clip.speed;
        activeIdxRef.current = 1 - activeIdxRef.current;
        videoRef.current = standby;
        currentPlayingClipRef.current = clip.id;
        clipReadyRef.current = true;
        primedClipRef.current = null;
        if (autoplay) standby.play().then(() => { standby.playbackRate = clip.speed; standby.preservesPitch = true; }).catch(() => { });
        return true;
    }, [getStandbyVideo, getActiveVideo]);

    // ── 把某個 clip 載入「目前 active」<video> 並定位到指定 media time ──
    // 關鍵：換 src 是非同步的，直接設 currentTime 會因尚未載入而被丟掉、且 v.currentTime 在
    // 載入空窗期是 0。所以「不同媒體」一律等 loadedmetadata 才 seek + 設速率 + 播放，期間
    // clipReadyRef=false 讓播放迴圈改用牆鐘推算時間軸（不會跳針）。「同媒體」則直接套用。
    // 注意：此函式會在 active 元素上換 src（會有黑閃），僅用於 seek/未預載的降級情況；
    // 連續播放的交界由 swapToStandby 無縫處理。
    const loadClipIntoVideo = useCallback((clip: TimelineClip, mediaTime: number, autoplay: boolean) => {
        const v = videoRef.current;
        if (!v) return;
        const media = mediaItems.find(m => m.id === clip.mediaId);
        currentPlayingClipRef.current = clip.id;
        // 移除尚未觸發的舊 loadedmetadata 監聽，避免切換太快時舊的 seek 蓋掉新的
        if (pendingLoadRef.current) {
            v.removeEventListener('loadedmetadata', pendingLoadRef.current);
            pendingLoadRef.current = null;
        }
        const applyAfterReady = () => {
            try { v.currentTime = mediaTime; } catch { /* ignore */ }
            v.preservesPitch = true;
            v.muted = false;
            v.playbackRate = clip.speed; // best-effort 先設一次
            clipReadyRef.current = true;
            if (autoplay) {
                // 先起播，待音訊管線就緒後再「重新確認」倍速 — 在未就緒時設 rate 有時會讓音軌靜音
                v.play().then(() => {
                    v.playbackRate = clip.speed;
                    v.preservesPitch = true;
                }).catch(() => { });
            }
        };
        if (media && v.src !== media.url && !v.src.endsWith(media.url)) {
            clipReadyRef.current = false;
            v.src = media.url;
            v.load();
            const onReady = () => {
                v.removeEventListener('loadedmetadata', onReady);
                pendingLoadRef.current = null;
                // 確認仍是目前的 clip 才套用（避免過時的切換把 seek 設到錯位置）
                if (currentPlayingClipRef.current === clip.id) applyAfterReady();
            };
            pendingLoadRef.current = onReady;
            v.addEventListener('loadedmetadata', onReady);
        } else {
            applyAfterReady();
        }
    }, [mediaItems]);

    // 切到某個 clip：standby 已預載則無縫切換，否則降級為在 active 換 src 載入。
    const goToClip = useCallback((clip: TimelineClip, mediaTime: number, autoplay: boolean) => {
        if (swapToStandby(clip, autoplay)) return;
        loadClipIntoVideo(clip, mediaTime, autoplay);
    }, [swapToStandby, loadClipIntoVideo]);

    // 兩個 video 的 callback ref（穩定身分，避免每次 render detach）：掛載時設定初始顯示/隱藏，
    // 並讓 videoRef 指向目前 active 元素。
    const setVid0 = useCallback((el: HTMLVideoElement | null) => {
        vid0Ref.current = el;
        if (el) {
            el.style.opacity = activeIdxRef.current === 0 ? '1' : '0';
            if (activeIdxRef.current === 0) videoRef.current = el;
        }
    }, []);
    const setVid1 = useCallback((el: HTMLVideoElement | null) => {
        vid1Ref.current = el;
        if (el) {
            el.style.opacity = activeIdxRef.current === 1 ? '1' : '0';
            if (activeIdxRef.current === 1) videoRef.current = el;
        }
    }, []);

    // 影片自然播完：後面緊接片段→無縫切；有間隙→保持播放交給 tick；沒東西→停。
    const handleVideoEnded = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
        if (e.currentTarget !== getActiveVideo()) return; // 只處理 active 元素
        if (!isPlaying) return;
        if (!clipReadyRef.current) return; // tick 已搶先在 active 換 src 載入中，別重複前進（避免跳過片段/誤停）
        const ordered = timelineClips.filter(c => c.trackIndex === 0).sort((a, b) => a.startTime - b.startTime);
        const cur = ordered.find(c => c.id === currentPlayingClipRef.current);
        if (cur) {
            const curEnd = cur.startTime + cur.duration;
            const next = ordered.find(c => c.id !== cur.id && c.startTime >= curEnd - 0.05);
            if (next && Math.abs(next.startTime - curEnd) < 0.3) {
                timelinePosRef.current = next.startTime;
                playStartRef.current = performance.now();
                playStartTlRef.current = next.startTime;
                goToClip(next, next.trimStart, true);
                return;
            }
            if (next) return; // 有間隙再接片段 → 保持播放，交給 tick 處理
        }
        setIsPlaying(false);
    }, [getActiveVideo, isPlaying, timelineClips, goToClip, setIsPlaying]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (isPlaying) {
            v.pause();
            setIsPlaying(false);
        } else {
            // 播放頭已在(或超過)結尾 → 從頭重播（否則 findClipAtTime(duration)=null，按 Play 沒反應/沒聲音）。
            // 必須在擷取 wall-clock 基準「之前」歸零，讓 goToClip 與 tick 都從 0 起算。
            if (duration > 0 && timelinePosRef.current >= duration - 0.001) {
                timelinePosRef.current = 0;
            }
            // 記錄開始播放的 wall-clock 和 timeline 位置
            playStartRef.current = performance.now();
            playStartTlRef.current = timelinePosRef.current;
            setIsPlaying(true);

            // 找到當前 clip 並開始播放
            const clip = findClipAtTime(timelinePosRef.current);
            if (clip) {
                const mediaTime = clip.trimStart + (timelinePosRef.current - clip.startTime) * clip.speed;
                goToClip(clip, mediaTime, true);
            }
            // 如果在 gap，tick 會處理
        }
    }, [isPlaying, setIsPlaying, findClipAtTime, goToClip, duration]);

    // ── Seek（直接設定時間軸位置） ──
    const seekTo = useCallback((tlPos: number) => {
        const v = videoRef.current;
        timelinePosRef.current = tlPos;
        // 如果正在播放，重置 wall-clock
        if (isPlaying && !isDraggingRef.current) {
            playStartRef.current = performance.now();
            playStartTlRef.current = tlPos;
        }
        // seek 後作廢 standby 預載，避免之後在交界用到過時的 standby（trimStart/速率可能已變）
        primedClipRef.current = null;
        // 找到對應的 clip
        const clip = findClipAtTime(tlPos);
        if (clip && v) {
            const mediaTime = clip.trimStart + (tlPos - clip.startTime) * clip.speed;
            currentTimeRef.current = mediaTime;
            // 拖拉中不要呼叫 play，避免 seek/play race condition
            loadClipIntoVideo(clip, mediaTime, isPlaying && !isDraggingRef.current);
        } else if (v) {
            v.pause();
            currentPlayingClipRef.current = null;
            clipReadyRef.current = false;
        }
        setCurrentTime(tlPos); // store timeline pos for React
    }, [setCurrentTime, findClipAtTime, loadClipIntoVideo, isPlaying]);

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
        primedClipRef.current = null; // 拖拉開始即作廢預載
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
            // 拖拉結束後恢復播放 — 經 loadClipIntoVideo 套用 src/seek/速率/preservesPitch
            // （bare v.play() 會漏設速率與 seek，跨速率/跨媒體 resume 會錯）
            if (wasPlaying && v) {
                playStartRef.current = performance.now();
                playStartTlRef.current = timelinePosRef.current;
                const clip = findClipAtTime(timelinePosRef.current);
                if (clip) {
                    const mt = clip.trimStart + (timelinePosRef.current - clip.startTime) * clip.speed;
                    loadClipIntoVideo(clip, mt, true);
                }
                setIsPlaying(true);
            }
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [xToTime, setIsPlaying, findClipAtTime, mediaItems, setCurrentTime, loadClipIntoVideo]);

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

        const tick = () => {
            let v = videoRef.current;
            const ph = playheadRef.current;
            const el = tracksRef.current;

            // 初始用 wall-clock 推算 timeline 位置（用於 gap 或尚未有 clip 的情況）
            const elapsed = (performance.now() - playStartRef.current) / 1000;
            let tl = playStartTlRef.current + elapsed;

            // 找到當前 clip（先用 wall-clock 粗定位）
            const clip = clips.find(c => tl >= c.startTime && tl < c.startTime + c.duration) ?? null;

            if (clip && v) {
                // 需要切換 clip？standby 已預載則瞬間切換(無黑閃)，否則降級在 active 換 src
                if (currentPlayingClipRef.current !== clip.id) {
                    const mediaTime = clip.trimStart + (tl - clip.startTime) * clip.speed;
                    goToClip(clip, mediaTime, true);
                    v = videoRef.current; // swap 後 active 元素可能已改變
                    if (!v) { raf = requestAnimationFrame(tick); return; }
                }

                // 已就緒時保持 video 播放（已 ended 的片段不要 v.play()，否則會從頭重播）
                if (clipReadyRef.current && v.paused && !v.ended) v.play().catch(() => { });

                // ── 接近交界時，預載下一段到 standby，讓交界可無縫切換、不黑閃 ──
                const nextClip = clips[clips.indexOf(clip) + 1] ?? null;
                if (nextClip) {
                    const remaining = (clip.startTime + clip.duration) - tl;
                    if (remaining > 0 && remaining <= 1.0 && primedClipRef.current !== nextClip.id) {
                        primeStandby(nextClip);
                    }
                }

                // ── 用 v.currentTime（實際播放位置）推算 timeline，避免與解碼器時鐘漂移 ──
                // 僅在「影片真的就緒、seek 完成、且位置落在此 clip 範圍內」才採用；否則維持迴圈
                // 開頭的牆鐘推算值，避免載入空窗期 v.currentTime=0 造成播放頭跳針（速率≠1 會放大）。
                const ready = clipReadyRef.current && !v.paused && v.readyState >= 2 && !v.seeking;
                if (ready && currentPlayingClipRef.current === clip.id) {
                    const actualMediaTime = v.currentTime;
                    if (actualMediaTime >= clip.trimStart - 0.1 && actualMediaTime <= clip.trimEnd + 0.1) {
                        // 用 Math.max 只允許前進：交界剛 swap 進來時 standby 仍 ≈trimStart，
                        // 直接採用會把 tl 拉回（向後跳針）；mid-clip 時 v.currentTime 較大會正常接管。
                        tl = Math.max(tl, clip.startTime + (actualMediaTime - clip.trimStart) / clip.speed);
                        // 同步 wall-clock 基準，讓離開 clip 後的 gap 計算正確
                        playStartRef.current = performance.now();
                        playStartTlRef.current = tl;
                    }
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
                clipReadyRef.current = false;
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
            if (ph) ph.style.transform = `translateX(${tl * pixelsPerSecond + LABEL_W}px)`;
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
    }, [isPlaying, pixelsPerSecond, duration, timelineClips, goToClip, primeStandby, syncRulerScroll, setCurrentTime, setIsPlaying, setActiveSegment]);

    // ── 閒置（未播放）時在 active 元素顯示目前播放頭所在片段的畫面 ──
    // （雙緩衝後 video 不再有宣告式 src，需在此補上靜止預覽幀；播放中由 tick/swap 管理，不介入）
    useEffect(() => {
        if (isPlaying) return;
        const v = getActiveVideo();
        if (!v) return;
        const pos = timelinePosRef.current;
        // 找不到（在結尾）時退回「最後一段」而非第一段，避免在結尾停住時重載第一段媒體造成黑閃/錯幀
        const clip = findClipAtTime(pos)
            ?? timelineClips.filter(c => c.trackIndex === 0).sort((a, b) => a.startTime - b.startTime).pop()
            ?? null;
        const media = clip ? mediaItems.find(m => m.id === clip.mediaId) : primaryMedia;
        if (!media) return;
        let h: (() => void) | null = null;
        if (v.src !== media.url && !v.src.endsWith(media.url)) {
            v.src = media.url;
            v.load();
            const mt = clip
                ? Math.min(clip.trimEnd, clip.trimStart + Math.max(0, pos - clip.startTime) * clip.speed)
                : 0;
            // 必須清掉監聽：若在載入完成前又換了媒體（拖拉/seek），舊監聽會把錯誤的 seek 套到現在的元素
            h = () => { if (h) v.removeEventListener('loadedmetadata', h); h = null; try { v.currentTime = mt; } catch { /* ignore */ } };
            v.addEventListener('loadedmetadata', h);
        }
        return () => { if (h) v.removeEventListener('loadedmetadata', h); };
    }, [isPlaying, primaryMedia, timelineClips, mediaItems, findClipAtTime, getActiveVideo, currentTime]);

    // ── 暫停時驅動字幕 overlay（播放中由 tick 驅動）──
    // overlay 的文字與顯示/隱藏只由「單一來源」寫入：播放中 tick、暫停時此 effect。
    // JSX 不再用 React state 設 display/textContent，根除兩邊搶寫造成的閃爍。
    useEffect(() => {
        if (isPlaying) return;
        const overlay = subtitleOverlayRef.current;
        if (!overlay) return;
        const overlayClip = timelineClips.find(c =>
            c.trackIndex === 0 && currentTime >= c.startTime && currentTime < c.startTime + c.duration
        );
        const mediaTimeForOverlay = overlayClip
            ? overlayClip.trimStart + (currentTime - overlayClip.startTime) * overlayClip.speed
            : currentTime;
        const overlaySegs = overlayClip?.segments ?? segments;
        const activeSeg = overlaySegs.find(s => mediaTimeForOverlay >= s.start && mediaTimeForOverlay <= s.end);
        if (activeSeg) {
            overlay.textContent = activeSeg.text;
            overlay.style.display = '';
        } else {
            overlay.style.display = 'none';
        }
    }, [isPlaying, currentTime, timelineClips, segments]);

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
                    {/* 匯出 SRT：有字幕才出現 */}
                    {segments.length > 0 && (
                        <button className="btn" onClick={handleExportSrt}>📄 匯出 SRT</button>
                    )}
                    {/* 匯出影片：只要時間軸上有片段就能匯出（純剪輯、無字幕也可） */}
                    {hasTimeline && (
                        <button className="btn btn-accent" onClick={handleExportVideo} disabled={isBurning}>
                            {isBurning ? `⏳ 匯出中 ${exportProgress >= 0 ? exportProgress + '%' : '...'}` : '🎬 匯出影片'}
                        </button>
                    )}
                    <button className="btn" onClick={() => setShowRecSettings(true)}>⏺ 螢幕錄影</button>
                    <button className="btn" onClick={() => setShowSettings(true)} title="設定" style={{ padding: '6px 10px' }}>⚙</button>
                </div>
            </header>

            {/* 錄影設定 Modal */}
            {showRecSettings && (
                <RecordingSettingsModal
                    recOpts={recOpts}
                    setRecOpts={setRecOpts}
                    micDevices={micDevices}
                    isTauri={IS_TAURI}
                    micMeterFillRef={micMeterFillRef}
                    micMeterValRef={micMeterValRef}
                    onClose={() => setShowRecSettings(false)}
                    onStartRec={handleStartRec}
                />
            )}

            {/* 懸浮錄影控制列 */}
            {isRecording && (
                <div className="rec-floating-bar">
                    <span className="rec-dot" />
                    <span className="rec-timer">{formatTime(recSeconds)}</span>
                    <button className="rec-ctrl-btn" onClick={handlePauseRec} title={isPaused ? '繼續' : '暫停'}>
                        {isPaused ? '▶' : '⏸'}
                    </button>
                    <button className="rec-ctrl-btn rec-stop" onClick={handleStopRec} title="停止 (F10)">⏹</button>
                    <span className="rec-hotkey-hint">按 F10 結束</span>
                </div>
            )}

            {/* 設定 Modal */}
            {showSettings && (
                <SettingsModal
                    settings={settings}
                    setSettings={setSettings}
                    onClose={() => setShowSettings(false)}
                />
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
                                    <AiPanel
                                        expanded={aiExpanded}
                                        onToggle={() => setAiExpanded(v => !v)}
                                        tabs={AI_TABS}
                                        activeTab={aiActiveTab}
                                        onSelectTab={setAiActiveTab}
                                        loadingType={aiLoadingType}
                                        results={aiResultsRef}
                                        copied={aiCopied}
                                        onCopy={(t) => {
                                            navigator.clipboard.writeText(t);
                                            setAiCopied(true);
                                            setTimeout(() => setAiCopied(false), 2000);
                                        }}
                                        onRefresh={() => runAllAi(segments)}
                                    />
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
                            <>
                                {/* 雙緩衝：兩個 video 疊放，imperative 控制 opacity（不走 React style 以免被覆蓋） */}
                                <video ref={setVid0} className="dbl-video"
                                    onTimeUpdate={(e) => {
                                        if (isPlaying) return; // 播放中由 tick loop 處理字幕
                                        const v = e.currentTarget;
                                        if (v !== getActiveVideo() || v.paused) return;
                                        const active = segments.find((s) => v.currentTime >= s.start && v.currentTime <= s.end);
                                        if (active && active.id !== activeSegmentId) setActiveSegment(active.id);
                                    }}
                                    onEnded={handleVideoEnded}
                                    onClick={togglePlay} style={{ cursor: 'pointer' }} />
                                <video ref={setVid1} className="dbl-video"
                                    onTimeUpdate={(e) => {
                                        if (isPlaying) return;
                                        const v = e.currentTarget;
                                        if (v !== getActiveVideo() || v.paused) return;
                                        const active = segments.find((s) => v.currentTime >= s.start && v.currentTime <= s.end);
                                        if (active && active.id !== activeSegmentId) setActiveSegment(active.id);
                                    }}
                                    onEnded={handleVideoEnded}
                                    onClick={togglePlay} style={{ cursor: 'pointer' }} />
                            </>
                        ) : (
                            <div className="video-placeholder">
                                <div className="icon">🎬</div><p>請上傳影片或音頻</p>
                            </div>
                        )}

                        {/* 字幕即時預覽 overlay */}
                        {primaryMedia && segments.length > 0 && (() => {
                            // 字幕文字與顯示/隱藏改由 tick(播放中) 與 paused-overlay effect(暫停時)
                            // 以 imperative 方式驅動；這裡不再用 React state 設定，避免與 tick 兩邊搶寫造成閃爍。
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
                                />
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
                                        style={{ left: 0, transform: `translateX(${currentTime * pixelsPerSecond + LABEL_W}px)` }}
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
                <SpeedMenu
                    clip={speedMenuClip}
                    x={speedMenu.x}
                    y={speedMenu.y}
                    onSetSpeed={setClipSpeed}
                    onClose={() => setSpeedMenu(null)}
                />
            )}
            {exportProgress >= 0 && <ExportProgress progress={exportProgress} />}
        </>
    );
}
