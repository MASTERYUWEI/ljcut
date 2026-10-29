/* ── LJCUT 主應用 ── */

import { Clapperboard, Upload, CircleDot, Settings, Play, Pause, Square, Video, FolderOpen, Film, ZoomIn, PenLine, Captions, Plus, Sparkles, SpellCheck, Brain, Copy, Check, Download, X, Image as ImageIcon, ArrowUpRight, Type, Code, Focus, ListOrdered, Gauge, Undo2, Redo2, TriangleAlert, CheckCheck, CircleHelp, MousePointerClick, Minus, Scissors, Replace } from 'lucide-react';
import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { useStore } from './store';
import { api, onApiReady, getBase } from './api';
import type { MediaItem, TimelineClip, Segment, AppSettings, RecOpts, MicDevice } from './types';
import { previewSrc, hasSrc, isShowing } from './proxy';
import { zoomAt, type ZoomRegion } from './zoom';
import { overlayAnim, isContentOverlay, mediaTime, TEMPLATE_KINDS, OVERLAY_LABEL, type Overlay, type OverlayKind } from './overlay';
import { getSprite, getHtmlDoc, getMediaDecor } from './overlaySprites';
import { formatTime, formatTimestamp, generateRulerTicks, findSnapTime, LABEL_W, splitLongCues as splitLongCuesUtil } from './utils';
import { SettingsModal } from './components/SettingsModal';
import { RecordingSettingsModal } from './components/RecordingSettingsModal';
import { SpeedMenu } from './components/SpeedMenu';
import { ExportProgress } from './components/ExportProgress';
import { YouTubeUploadModal } from './components/YouTubeUploadModal';
import { ProjectFileButtons, useControlWorkspace } from './components/ProjectControl';
import { BookendControls } from './components/BookendControls';
import Toaster from './components/Toaster';
import { StatusText } from './components/StatusText';
import { ShortcutHelp } from './components/ShortcutHelp';
import { AiStatus } from './components/AiStatus';
import { OverlayInspector } from './components/OverlayInspector';
import { notify, toast, humanizeError } from './toast';
import { useDialog } from './useDialog';
import { pushUndo, undo, redo, projectData, dryRun, applyPlan, readState, history as editHistory } from './editSession';
import { clippedSegments, splitClip, timelineSegments, toSourceTime, toTimelineTime, validateProject } from './editCore';
import { registerPreviewReader } from './controlClient';
import { transitionVisual } from './transitions';

/** 找出時間點所在的字幕：區間左閉右開，並容忍跳轉時的微小誤差（點第 2 句不會亮第 1 句） */
function segAt<T extends { start: number; end: number }>(list: T[], t: number): T | undefined {
    return list.find(s => t >= s.start - 0.02 && t < s.end - 0.02);
}
function readWidth(key: string, fallback: number) {
    try { const v = Number(localStorage.getItem(key)); return v >= 120 && v <= 700 ? v : fallback; } catch { return fallback; }
}
export default function App() {
    // 雙緩衝：兩個 <video> 疊在一起，永遠只有一個顯示(active)，另一個(standby)預載下一段。
    // videoRef 永遠指向 active 元素（手動維護），既有邏輯一律透過它操作目前顯示中的影片。
    const vid0Ref = useRef<HTMLVideoElement | null>(null);
    const vid1Ref = useRef<HTMLVideoElement | null>(null);
    const activeIdxRef = useRef(0); // 0 或 1：目前 active 的元素
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const transitionOverlayRef = useRef<HTMLDivElement>(null);
    const videoContainerRef = useRef<HTMLDivElement>(null);
    const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const container = videoContainerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(([entry]) => {
            setPreviewSize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);
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
    const [isBurning, setIsBurning] = useState(false);
    const [exportProgress, setExportProgress] = useState(-1); // -1=idle, 0~100=progress
    // 辨識進度：null=idle；pct<0=準備中(抽取音訊)；0~100=辨識中
    const [transProg, setTransProg] = useState<{ pct: number; cur: number; total: number } | null>(null);
    // 快速辨識（批次推論，約 4 倍速；專有名詞準確度略降）— 記住使用者偏好
    const [fastAsr, setFastAsr] = useState<boolean>(() => { try { return localStorage.getItem('ljcut-fast-asr') === '1'; } catch { return false; } });
    const [transElapsed, setTransElapsed] = useState(0);
    // 最近一次匯出成品路徑（YouTube 上傳用）
    const [lastExport, setLastExport] = useState<string | null>(() => localStorage.getItem('ljcut-export-path'));
    const [publicationId, setPublicationId] = useState(() => localStorage.getItem('ljcut-publication-id') || '');
    // 匯出當下的專案版本；之後又改過剪輯 → 成品「較舊」（上次啟動留下的成品版本未知，不標示）
    const [exportRevision, setExportRevision] = useState<number | null>(null);
    useEffect(() => {
        if (lastExport && publicationId) {
            localStorage.setItem('ljcut-export-path', lastExport);
            localStorage.setItem('ljcut-publication-id', publicationId);
        }
    }, [lastExport, publicationId]);
    useEffect(() => {
        const ready = (event: Event) => {
            const result = (event as CustomEvent).detail;
            setLastExport(result.outputPath); setPublicationId(result.publicationId);
            setExportRevision(readState().revision);
        };
        window.addEventListener('ljcut-export-ready', ready);
        return () => window.removeEventListener('ljcut-export-ready', ready);
    }, []);
    // 匯出時是否把字幕燒進畫面（false = 乾淨畫面，YouTube 用 CC/SRT 顯示字幕）
    const [burnSubs, setBurnSubs] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);
    // 後端就緒前顯示啟動畫面（首次啟動被防毒掃描拖慢時不再黑屏）
    const [backendBooting, setBackendBooting] = useState<boolean>(() => !!(window as any).__TAURI_INTERNALS__);
    const [showYtUpload, setShowYtUpload] = useState(false);
    const [exportEta, setExportEta] = useState<number | null>(null); // 預估剩餘秒數
    const [exportStage, setExportStage] = useState(''); // 目前階段文字
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
    const [snapTime, setSnapTime] = useState<number | null>(null);
    const [isDraggingPreview, setIsDraggingPreview] = useState(false);
    const [isDraggingCue, setIsDraggingCue] = useState(false);
    const [selectedSegIds, setSelectedSegIds] = useState<Set<number>>(new Set());
    const [showSettings, setShowSettings] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);
    const overlayMenuRef = useRef<HTMLDivElement>(null);
    const runOpsRef = useRef<(ops: Record<string, unknown>[], what: string) => unknown>(() => null);
    const [showReplace, setShowReplace] = useState(false);
    const [exportDone, setExportDone] = useState<string | null>(null);
    const [overlayMenuPos, setOverlayMenuPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
    const [settings, setSettings] = useState<AppSettings>({ outputDir: '', srtDir: '' });
    const [isRecording, setIsRecording] = useState(false);
    type EncoderInfo = { hw: boolean; name: string; nvenc_active: boolean | null };
    const [encoderInfo, setEncoderInfo] = useState<EncoderInfo | null>(null);
    const [isPaused, setIsPaused] = useState(false);
    const [recSeconds, setRecSeconds] = useState(0);
    const [showRecSettings, setShowRecSettings] = useState(false);
    const [recOpts, setRecOpts] = useState<RecOpts>(() => {
        const saved = parseInt(localStorage.getItem('ljcut.audioSyncMs') ?? '');
        const audioSyncMs = Number.isFinite(saved) ? saved : 250; // 預設鎖 250ms，之後讀回上次校正值
        return { sysAudio: false, mic: false, quality: '1080p', fps: 60, micDevice: '', sysAudioDevice: '', micVol: 1.0, sysVol: 1.0, audioSyncMs, cursorGlow: false, clickEffect: false, glowColor: '#ffd228', clickColor: '#ffe65a', cursorScale: 1, cursorHidden: false };
    });
    // 音訊同步偏移持久化（每次變更即存，下次啟動自動讀回，不必重設）
    useEffect(() => {
        localStorage.setItem('ljcut.audioSyncMs', String(recOpts.audioSyncMs));
    }, [recOpts.audioSyncMs]);
    const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
    const micStreamRef = useRef<MediaStream | null>(null);
    const micAnimRef = useRef<number>(0);
    const micMeterFillRef = useRef<HTMLDivElement>(null);
    const micMeterValRef = useRef<HTMLSpanElement>(null);
    // ── 倍速右鍵選單 ──
    const [speedMenu, setSpeedMenu] = useState<{ clipId: string; x: number; y: number; splitTime: number } | null>(null);
    const speedUndoPushedRef = useRef(false); // 同一次右鍵選單調速只記一次 undo

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
    // 窄視窗（< 1280，例如旁邊開著 AI）左欄預設窄一點，把空間留給預覽與時間軸
    // 欄寬：依視窗寬度給預設值，拖曳後記住
    const [leftWidth, setLeftWidth] = useState(() => readWidth('ljcut-left-w', window.innerWidth < 1280 ? 170 : 240));
    const [rightWidth, setRightWidth] = useState(() => readWidth('ljcut-right-w', window.innerWidth < 1280 ? 290 : 340));
    useEffect(() => { try { localStorage.setItem('ljcut-left-w', String(leftWidth)); localStorage.setItem('ljcut-right-w', String(rightWidth)); } catch { /* 無法記住不影響 */ } }, [leftWidth, rightWidth]);
    // 時間軸是剪輯主角：預設約 40% 視窗高，拖曳後記住
    const [timelineHeight, setTimelineHeight] = useState<number>(() => {
        try {
            const saved = Number(localStorage.getItem('ljcut-timeline-h'));
            if (saved >= 160) return Math.min(saved, Math.round(window.innerHeight * 0.7));
        } catch { /* 無法存取 localStorage 時用預設值 */ }
        return Math.max(220, Math.round(window.innerHeight * 0.4));
    });
    useEffect(() => {
        try { localStorage.setItem('ljcut-timeline-h', String(timelineHeight)); } catch { /* ignore */ }
    }, [timelineHeight]);
    const [isResizing, setIsResizing] = useState(false);


    const {
        mediaItems, timelineClips,
        activeClipId, setActiveClipId,
        segments, activeSegmentId,
        subtitleStyle,
        currentTime, isPlaying,
        isUploading, isTranscribing, language,
        getDuration,
        addMedia, removeMedia, updateMedia,
        addClip, updateClip, removeClip, setClipSpeed,
        setClipSegments,
        setSegments, updateSegment, setActiveSegment,
        setSubtitleStyle,
        setCurrentTime, setIsPlaying,
        setIsUploading, setIsTranscribing, setLanguage,
    } = useStore();

    const duration = getDuration();
    const exportStale = !!lastExport && exportRevision !== null && readState().revision !== exportRevision;
    // 第一個有 video 的媒體（向後相容：用於辨識/匯出/燒入）
    const primaryMedia = mediaItems.find(m => m.info.width && m.info.width > 0) || mediaItems[0] || null;
    const fileId = primaryMedia?.id ?? null;
    const hasTimeline = timelineClips.length > 0;

    // ── Undo 歷史堆疊（記錄整個時間軸：片段 + 各片段字幕 + 選取）──
    const handleUndo = useCallback(() => {
        if (!editHistory().canUndo) { toast('info', '沒有可以復原的操作', undefined, { key: 'history' }); return; }
        try { const r = undo(); toast('info', `已復原：${r.change}`, undefined, { key: 'history' }); } catch { /* 沒有歷史 */ }
    }, []);
    const handleRedo = useCallback(() => {
        if (!editHistory().canRedo) { toast('info', '沒有可以重做的操作', undefined, { key: 'history' }); return; }
        try { const r = redo(); toast('info', `已重做：${r.change}`, undefined, { key: 'history' }); } catch { /* 沒有歷史 */ }
    }, []);
    const [hist, setHist] = useState(editHistory());
    useEffect(() => {
        const on = () => setHist(editHistory());
        window.addEventListener('ljcut-history', on);
        return () => window.removeEventListener('ljcut-history', on);
    }, []);
    const controlWorkspace = useControlWorkspace();   // 片頭片尾需要本機控制工作區

    const pixelsPerSecond = 10 * zoom;
    const timelineWidth = duration > 0 ? duration * pixelsPerSecond : 0;
    const SNAP_THRESHOLD_SEC = 8 / pixelsPerSecond; // 8px 吸附範圍

    // ── 防重疊：以剛放下/移動的片段為錨點，把同軌重疊到的鄰段往兩側推開（保留間隙）──
    const resolveOverlaps = useCallback((anchorId: string) => {
        const clips = useStore.getState().timelineClips;
        const anchor = clips.find(c => c.id === anchorId);
        if (!anchor) return;
        const Ms = anchor.startTime;
        const Me = anchor.startTime + anchor.duration;
        const others = clips.filter(c => c.id !== anchorId && c.trackIndex === anchor.trackIndex);
        const patches: { id: string; startTime: number }[] = [];

        // 右側（start >= 錨點起點）：依序往右推到不重疊（原本就不重疊的維持間隙）
        let wallR = Me;
        for (const c of others.filter(c => c.startTime >= Ms).sort((a, b) => a.startTime - b.startTime)) {
            let s = c.startTime;
            if (s < wallR - 1e-6) { s = wallR; patches.push({ id: c.id, startTime: s }); }
            wallR = s + c.duration;
        }
        // 左側（start < 錨點起點）：依序往左推到不重疊
        let wallL = Ms;
        for (const c of others.filter(c => c.startTime < Ms).sort((a, b) => b.startTime - a.startTime)) {
            let s = c.startTime;
            if (s + c.duration > wallL + 1e-6) { s = Math.max(0, wallL - c.duration); patches.push({ id: c.id, startTime: s }); }
            wallL = s;
        }
        for (const p of patches) updateClip(p.id, { startTime: p.startTime });
    }, [updateClip]);

    // ── 同步尺標滾動 ──
    const syncRulerScroll = useCallback(() => {
        if (rulerRef.current && tracksRef.current) {
            rulerRef.current.scrollLeft = tracksRef.current.scrollLeft;
        }
    }, []);

    // ── 匯入（多檔，加入媒體庫；時間軸空的時候第一支自動放上去） ──
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
            // 時間軸還是空的：第一支素材直接放上去（不必再拖曳）
            if (useStore.getState().timelineClips.length === 0 && item.info.duration > 0) {
                pushUndo();
                addClip({ id: crypto.randomUUID(), mediaId: item.id, trackIndex: 0, startTime: 0, trimStart: 0,
                    trimEnd: item.info.duration, speed: 1, duration: item.info.duration, segments: [] });
            }
            // 背景載入波形
            api.getWaveform(result.file_id).then(peaks => {
                updateMedia(result.file_id, { waveformPeaks: peaks });
            }).catch(() => { });
        } catch (err) { notify(`匯入失敗: ${err}`); }
        finally { setIsUploading(false); }
    }, [addMedia, addClip, updateMedia, setIsUploading]);

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
                    audioSyncMs: recOpts.audioSyncMs,
                    cursorGlow: recOpts.cursorGlow,
                    clickEffect: recOpts.clickEffect,
                    glowColor: recOpts.glowColor,
                    clickColor: recOpts.clickColor,
                    cursorScale: recOpts.cursorScale,
                    cursorHidden: recOpts.cursorHidden,
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
                            notify(`匯入錄影失敗: ${e}`);
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
                notify(`停止錄影失敗: ${e}`);
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

    // ── 編碼器狀態徽章：監聽 recorder 回報的硬體/NVENC 狀態 ──
    useEffect(() => {
        if (!IS_TAURI) return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const u = await listen<EncoderInfo>('recorder://encoder', (e) => setEncoderInfo(e.payload));
            if (cancelled) { u(); } else { unlisten = u; }
        })();
        return () => { cancelled = true; if (unlisten) unlisten(); };
    }, []);

    // ── 後端就緒通知：關閉啟動畫面 ──
    useEffect(() => {
        if (!IS_TAURI) return;
        onApiReady(() => setBackendBooting(false));
    }, []);

    // ── 自動檢查更新（發行版；開發模式 check 會失敗並靜默略過）──
    useEffect(() => {
        if (!IS_TAURI) return;
        const t = setTimeout(async () => {
            try {
                const { check } = await import('@tauri-apps/plugin-updater');
                const update = await check();
                if (update) {
                    toast('info', `LJCUT 有新版本 v${update.version}（目前 v${update.currentVersion}）。安裝完成後會自動重新啟動。`, [
                        { label: '下載並安裝', run: () => { void (async () => {
                            toast('info', '正在下載更新…');
                            await update.downloadAndInstall();
                            const { relaunch } = await import('@tauri-apps/plugin-process');
                            await relaunch();
                        })().catch(e => notify(`更新失敗：${e}`)); } },
                    ]);
                }
            } catch { /* 開發模式或離線：靜默 */ }
        }, 3000);
        return () => clearTimeout(t);
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
        pushUndo();
        addClip(clip);
        resolveOverlaps(clipId); // 放下後把重疊到的鄰段推開
        setActiveClipId(clipId);
    }, [mediaItems, timelineClips, addClip, pixelsPerSecond, SNAP_THRESHOLD_SEC, resolveOverlaps, pushUndo, setActiveClipId]);

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

        let undoPushed = false;
        const onMove = (ev: MouseEvent) => {
            if (!undoPushed) { undoPushed = true; pushUndo(); } // 第一次實際拖動才記錄 undo
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
            resolveOverlaps(clipId); // 放開後把重疊到的鄰段推開
            setDraggingClipId(null);
            setSnapTime(null);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [timelineClips, pixelsPerSecond, SNAP_THRESHOLD_SEC, updateClip, resolveOverlaps, pushUndo]);

    // ── 片段邊緣拉桿（trim）：左拉桿改 in 點(右邊固定)、右拉桿改 out 點(左邊固定）──
    const handleClipTrim = useCallback((e: React.MouseEvent, clipId: string, edge: 'left' | 'right') => {
        e.preventDefault();
        e.stopPropagation(); // 不要觸發整段拖動
        const clip = timelineClips.find(c => c.id === clipId);
        if (!clip) return;
        const media = mediaItems.find(m => m.id === clip.mediaId);
        const mediaDur = media?.info.duration ?? clip.trimEnd;
        const speed = clip.speed || 1;
        const MIN = 0.1; // 最短片段（秒）
        const startX = e.clientX;
        const o = { startTime: clip.startTime, duration: clip.duration, trimStart: clip.trimStart, trimEnd: clip.trimEnd };
        const R = o.startTime + o.duration;
        // 鄰段邊界（同軌，trim 不可越界造成重疊）
        const same = timelineClips.filter(c => c.id !== clipId && c.trackIndex === clip.trackIndex);
        const prevEnd = Math.max(0, ...same.filter(c => c.startTime + c.duration <= o.startTime + 1e-3).map(c => c.startTime + c.duration));
        const nextStart = Math.min(Infinity, ...same.filter(c => c.startTime >= R - 1e-3).map(c => c.startTime));

        // 純 state 更新；拖拉裁切時把該片段波形淡出(避免拖曳期視覺飄移/lag)，放開復原
        const cv = document.querySelector<HTMLElement>(`canvas[data-clip-id="${clipId}"]`);
        let undoPushed = false;
        const onMove = (ev: MouseEvent) => {
            if (!undoPushed) { undoPushed = true; pushUndo(); } // 第一次實際拖動才記錄 undo
            if (cv) cv.style.opacity = '0'; // 拖拉中隱藏波形
            const dx = (ev.clientX - startX) / pixelsPerSecond;
            if (edge === 'left') {
                const maxDur = o.trimEnd / speed; // trimStart 最多回到 0
                const minStart = Math.max(0, prevEnd, R - maxDur);
                const newStart = Math.min(Math.max(o.startTime + dx, minStart), R - MIN);
                const duration = R - newStart;
                const trimStart = Math.max(0, o.trimEnd - duration * speed);
                updateClip(clipId, { startTime: newStart, duration, trimStart });
            } else {
                const maxEnd = Math.min(o.startTime + (mediaDur - o.trimStart) / speed, nextStart);
                const newEnd = Math.max(Math.min(R + dx, maxEnd), o.startTime + MIN);
                const duration = newEnd - o.startTime;
                const trimEnd = Math.min(mediaDur, o.trimStart + duration * speed);
                updateClip(clipId, { duration, trimEnd });
            }
        };
        const onUp = () => {
            if (cv) cv.style.opacity = ''; // 放開復原波形
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [timelineClips, mediaItems, pixelsPerSecond, updateClip, pushUndo]);

    // ── 刪除片段（右鍵選單）──
    const handleClipDelete = useCallback((clipId: string) => {
        pushUndo();
        removeClip(clipId);
        if (activeClipId === clipId) setActiveClipId(null);
        setSpeedMenu(null);
    }, [removeClip, activeClipId, setActiveClipId, pushUndo]);

    // ── Cue Splitting：超長字幕自動分段（語義斷句） ──
    const splitLongCues = splitLongCuesUtil;

    // ── AI 逐句潤飾字幕（修錯字／去贅字／補標點，時間碼不變）──
    const [isPolishing, setIsPolishing] = useState(false);
    const handlePolishSubtitles = useCallback(async () => {
        const activeClip = activeClipId ? timelineClips.find(c => c.id === activeClipId) : null;
        if (!activeClip || !(activeClip.segments && activeClip.segments.length)) {
            notify('這個片段還沒有字幕可潤飾，請先辨識字幕');
            return;
        }
        setIsPolishing(true);
        try {
            const polished = await api.polishSubtitles(activeClip.segments);
            pushUndo();
            setClipSegments(activeClip.id, polished);
        } catch (err) {
            notify(`潤飾失敗: ${err}`);
        } finally {
            setIsPolishing(false);
        }
    }, [activeClipId, timelineClips, setClipSegments, pushUndo]);

    // ── 辨識（完成後自動觸發 AI 助手）──
    const handleTranscribe = useCallback(async () => {
        // 對當前選中的 clip 做辨識
        const activeClip = activeClipId ? timelineClips.find(c => c.id === activeClipId) : null;
        const targetMedia = activeClip ? mediaItems.find(m => m.id === activeClip.mediaId) : null;
        const targetFileId = targetMedia?.id ?? fileId;
        if (!targetFileId) return;
        if (timelineClips.length === 0) {
            notify('時間軸中尚無影片，請先將媒體拖放到時間軸上');
            return;
        }
        if (!activeClip) {
            notify('請先點擊選取要辨識字幕的影片片段');
            return;
        }
        setIsTranscribing(true);
        setTransProg({ pct: -1, cur: 0, total: 0 });
        setTransElapsed(0);
        const t0 = Date.now();
        const elapsedTimer = setInterval(() => setTransElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
        try {
            const result = await api.transcribe(targetFileId, language, (pct, cur, total) => {
                setTransProg({ pct, cur: cur ?? 0, total: total ?? 0 });
            }, fastAsr);
            pushUndo();
            updateMedia(targetFileId, { transcript: structuredClone(result) });
            // 自動 cue splitting
            const split = splitLongCues(result.segments, subtitleStyle.maxCharsPerCue);
            // 寫入到選中的 clip
            setClipSegments(activeClip.id, split);
        } catch (err) { notify(`辨識失敗: ${err}`); }
        finally { clearInterval(elapsedTimer); setIsTranscribing(false); setTransProg(null); }
    }, [fileId, language, setClipSegments, setIsTranscribing, splitLongCues, subtitleStyle.maxCharsPerCue, timelineClips, activeClipId, mediaItems, fastAsr]);

    // ── 收集時間軸全部字幕（時間映射到時間軸；複製/匯出共用邏輯）──
    const buildTimelineSegments = useCallback((): Segment[] => {
        return timelineSegments(timelineClips);
    }, [timelineClips]);

    // ── 一鍵複製字幕（純文字 / SRT 格式）──
    const [copyMsg, setCopyMsg] = useState<'' | 'text' | 'srt'>('');
    const handleCopySubtitles = useCallback(async (kind: 'text' | 'srt') => {
        const segs = buildTimelineSegments();
        if (segs.length === 0) { notify('沒有字幕可複製'); return; }
        const fmtSrtTime = (t: number) => {
            const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
            const ms = Math.min(999, Math.round((t - Math.floor(t)) * 1000));
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        };
        const content = kind === 'text'
            ? segs.map(s => s.text).join('\n')
            : segs.map((s, i) => `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${s.text}\n`).join('\n');
        try {
            await navigator.clipboard.writeText(content);
        } catch {
            // 剪貼簿 API 被擋時的退路
            const ta = document.createElement('textarea');
            ta.value = content;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        setCopyMsg(kind);
        setTimeout(() => setCopyMsg(''), 1500);
    }, [buildTimelineSegments]);

    // ── 錯字修正：全部取代（套用到時間軸全部 clip，可 Ctrl+Z 復原）──
    const [typoFrom, setTypoFrom] = useState('');
    const [typoTo, setTypoTo] = useState('');
    const [typoMsg, setTypoMsg] = useState('');
    const [isScanningTypos, setIsScanningTypos] = useState(false);
    const [typoSuggestions, setTypoSuggestions] = useState<{ wrong: string; correct: string; count: number }[]>([]);

    const countOccurrences = useCallback((needle: string) => {
        let n = 0;
        for (const clip of timelineClips) {
            for (const seg of (clip.segments ?? [])) n += seg.text.split(needle).length - 1;
        }
        return n;
    }, [timelineClips]);

    /** 批次取代核心：一次 pushUndo，多組取代 → Ctrl+Z 一次全復原 */
    const applyReplacements = useCallback((pairs: { from: string; to: string }[]) => {
        const valid = pairs.filter(pr => pr.from);
        if (!valid.length) return 0;
        let total = 0;
        for (const pr of valid) total += countOccurrences(pr.from);
        if (total === 0) return 0;
        pushUndo();
        for (const clip of timelineClips) {
            if (!(clip.segments?.length)) continue;
            let changed = false;
            const segs = clip.segments.map(s => {
                let t = s.text;
                for (const pr of valid) {
                    if (t.includes(pr.from)) t = t.split(pr.from).join(pr.to);
                }
                if (t !== s.text) { changed = true; return { ...s, text: t }; }
                return s;
            });
            if (changed) setClipSegments(clip.id, segs);
        }
        return total;
    }, [timelineClips, countOccurrences, pushUndo, setClipSegments]);

    const handleReplaceAll = useCallback(() => {
        const n = applyReplacements([{ from: typoFrom, to: typoTo }]);
        setTypoMsg(n > 0
            ? `✅ 已把「${typoFrom}」→「${typoTo}」共 ${n} 處（Ctrl+Z 可復原）`
            : `找不到「${typoFrom}」`);
        if (n > 0) { setTypoFrom(''); setTypoTo(''); }
    }, [typoFrom, typoTo, applyReplacements]);

    const handleScanTypos = useCallback(async () => {
        const segs = buildTimelineSegments();
        if (segs.length === 0) { notify('沒有字幕可掃描'); return; }
        setIsScanningTypos(true);
        setTypoSuggestions([]);
        setTypoMsg('');
        try {
            const r = await api.scanTypos(segs.map(s => s.text));
            if (!r.ok && r.error) { setTypoMsg(`❌ ${r.error}`); return; }
            const sugg = (r.suggestions || [])
                .map(t => ({ ...t, count: countOccurrences(t.wrong) }))
                .filter(t => t.count > 0 && t.wrong !== t.correct);
            setTypoSuggestions(sugg);
            if (sugg.length === 0) setTypoMsg('🎉 沒掃到可疑錯字');
        } catch (e) { setTypoMsg(`❌ ${humanizeError(`掃描失敗：${e}`).message}`); }
        finally { setIsScanningTypos(false); }
    }, [buildTimelineSegments, countOccurrences]);

    const handleApplySuggestion = useCallback((idx: number) => {
        const t = typoSuggestions[idx];
        if (!t) return;
        const n = applyReplacements([{ from: t.wrong, to: t.correct }]);
        setTypoMsg(n > 0 ? `✅「${t.wrong}」→「${t.correct}」共 ${n} 處` : `找不到「${t.wrong}」（可能已被取代）`);
        setTypoSuggestions(list => list.filter((_, i) => i !== idx));
    }, [typoSuggestions, applyReplacements]);

    const handleApplyAllSuggestions = useCallback(() => {
        if (!typoSuggestions.length) return;
        const n = applyReplacements(typoSuggestions.map(t => ({ from: t.wrong, to: t.correct })));
        setTypoMsg(n > 0 ? `✅ 已套用 ${typoSuggestions.length} 組建議，共 ${n} 處（Ctrl+Z 一次全復原）` : '沒有可取代的內容');
        setTypoSuggestions([]);
    }, [typoSuggestions, applyReplacements]);

    // ── 匯出 SRT ──
    const handleExportSrt = useCallback(async () => {
        // 收集時間軸上所有 track=0 的 clips，按 startTime 排序
        const track0Clips = timelineClips
            .filter(c => c.trackIndex === 0)
            .sort((a, b) => a.startTime - b.startTime);

        if (track0Clips.length === 0 || !fileId) return;

        // 合併所有 clip 的字幕，加上時間軸偏移
        const allSegments = timelineSegments(track0Clips);

        if (allSegments.length === 0) {
            notify('沒有字幕資料可匯出');
            return;
        }

        try {
            const savePath = await api.exportSrt(fileId, allSegments, primaryMedia?.filename, settings.srtDir || settings.outputDir || undefined);
            if (savePath) {
                notify(`✅ SRT 已匯出！\n路徑：${savePath}`);
            }
        }
        catch (err) { notify(`匯出失敗: ${err}`); }
    }, [fileId, timelineClips, primaryMedia, settings.srtDir, settings.outputDir]);

    // ── 匯出影片（含字幕） ──
    const handleExportVideo = useCallback(async () => {
        // 收集時間軸上所有 track=0 的 clips，按 startTime 排序
        const track0Clips = timelineClips
            .filter(c => c.trackIndex === 0)
            .sort((a, b) => a.startTime - b.startTime);

        if (track0Clips.length === 0) {
            notify('時間軸中尚無影片，請先將媒體拖放到時間軸上');
            return;
        }

        // 匯出時暫停預覽（背景影片/聲音停住，匯出走獨立的 ffmpeg 管線）
        vid0Ref.current?.pause();
        vid1Ref.current?.pause();
        setIsPlaying(false);

        setIsBurning(true);
        setExportProgress(0);
        setExportEta(null);
        setExportStage('準備中');
        const revisionAtExport = readState().revision;
        try {
            validateProject(projectData(), true);
            const v = videoRef.current;
            const mainClip = track0Clips.find(c => !c.bookend) ?? track0Clips[0];
            const outputMedia = mediaItems.find(m => m.id === mainClip.mediaId);
            const videoW = outputMedia?.info.width || v?.videoWidth || 1920;
            const videoH = outputMedia?.info.height || v?.videoHeight || 1080;

            let result: { outputPath: string; publicationId: string } | null = null;

            // 單段與多段共用相同的時間軸輸出流程
            const clipsPayload = track0Clips.map(clip => {
                const media = mediaItems.find(m => m.id === clip.mediaId);
                return {
                    fileId: media?.id ?? clip.mediaId,
                    trimStart: clip.trimStart,
                    trimEnd: clip.trimEnd,
                    speed: clip.speed,
                    segments: burnSubs ? (clip.segments ?? []) : [],
                    captionSegments: clip.segments ?? [],
                    bookend: clip.bookend,
                    transitionIn: clip.transitionIn,
                    zooms: media?.zooms ?? [],
                    overlays: media?.overlays ?? [],
                };
            });
            // 預設檔名：主素材名稱＋日期（原本固定為 timeline_output.mp4，容易互相覆蓋）
            const mainName = (mediaItems.find(m => m.id === (track0Clips.find(c => !c.bookend) ?? track0Clips[0]).mediaId)?.filename ?? 'LJCUT')
                .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
            const today = new Date();
            const defaultFileName = `${mainName}_${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.mp4`;

            result = await api.exportTimeline(
                clipsPayload,
                subtitleStyle as unknown as Record<string, unknown>,
                defaultFileName,
                videoW, videoH,
                (pct, stage, eta) => { setExportProgress(pct); setExportStage(stage ?? ''); setExportEta(eta ?? null); },
            );

            if (result) {
                setExportProgress(100);
                setLastExport(result.outputPath);
                setPublicationId(result.publicationId);
                setExportRevision(revisionAtExport);
                setTimeout(() => { setExportProgress(-1); setExportDone(result!.outputPath); }, 300);
            } else {
                setExportProgress(-1); // 用戶取消
            }
        } catch (err) {
            if (err instanceof Error && err.message === 'EXPORT_CANCELLED') toast('info', '已取消匯出，沒有產生成品');
            else notify(`匯出失敗: ${err}`);
            setExportProgress(-1);
        } finally {
            setIsBurning(false);
        }
    }, [fileId, segments, subtitleStyle, timelineClips, mediaItems, duration, setIsPlaying, burnSubs]);

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
    const updateTransition = useCallback((time: number) => {
        const visual = transitionVisual(timelineClips, time);
        const layer = transitionOverlayRef.current;
        if (layer) {
            layer.style.backgroundColor = visual.color;
            layer.style.opacity = String(visual.opacity);
            const main = timelineClips.find(c => !c.bookend) ?? timelineClips[0];
            const info = mediaItems.find(m => m.id === main?.mediaId)?.info;
            const container = videoContainerRef.current;
            if (container && info?.width && info.height) {
                const scale = Math.min(container.clientWidth / info.width, container.clientHeight / info.height);
                layer.style.width = `${info.width * scale}px`;
                layer.style.height = `${info.height * scale}px`;
                // Use the same main-video canvas as export, including mixed-aspect bookends.
                for (const video of [vid0Ref.current, vid1Ref.current]) {
                    if (!video) continue;
                    video.style.width = layer.style.width;
                    video.style.height = layer.style.height;
                    video.style.inset = 'auto';
                    video.style.left = '50%';
                    video.style.top = '50%';
                    // 畫面縮放迴圈會在這個置中之後接上自己的放大；已是置中開頭就不覆寫
                    if (!video.style.transform.startsWith('translate(-50%, -50%)')) video.style.transform = 'translate(-50%, -50%)';
                    video.style.backgroundColor = '#000';
                }
            }
        }
        if (videoRef.current) videoRef.current.volume = 1 - visual.opacity;
    }, [timelineClips, mediaItems]);
    useEffect(() => { updateTransition(currentTime); }, [currentTime, previewSize, updateTransition]);
    const getActiveVideo = useCallback(() => (activeIdxRef.current === 0 ? vid0Ref.current : vid1Ref.current), []);
    const getStandbyVideo = useCallback(() => (activeIdxRef.current === 0 ? vid1Ref.current : vid0Ref.current), []);

    // 預載下一段到 standby 元素（換好 src + seek 到起點，保持暫停隱藏），到交界即可瞬間切換
    const primeStandby = useCallback((clip: TimelineClip) => {
        const s = getStandbyVideo();
        if (!s) return;
        const media = mediaItems.find(m => m.id === clip.mediaId);
        if (!media) return;
        if (!hasSrc(s, previewSrc(media))) {
            s.src = previewSrc(media);
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
        if (media && !hasSrc(v, previewSrc(media))) {
            clipReadyRef.current = false;
            v.src = previewSrc(media);
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
            // 暫停時拖動播放頭：字幕清單也標出目前這句（播放中由 tick loop 處理）
            if (!isPlaying) {
                const seg = segAt(clip.segments, mediaTime);
                if (seg && seg.id !== useStore.getState().activeSegmentId) useStore.getState().setActiveSegment(seg.id);
            }
        } else if (v) {
            v.pause();
            currentPlayingClipRef.current = null;
            clipReadyRef.current = false;
        }
        setCurrentTime(tlPos); // store timeline pos for React
    }, [setCurrentTime, findClipAtTime, loadClipIntoVideo, isPlaying]);

    const previewRequest = useStore(s => s.previewRequest);
    useEffect(() => {
        if (!previewRequest.serial) return;
        vid0Ref.current?.pause();
        vid1Ref.current?.pause();
        seekTo(previewRequest.time);
        // A request is consumed once; playback and manual scrubbing keep their existing flow.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewRequest.serial]);
    useEffect(() => {
        registerPreviewReader(() => ({ sourceTime: videoRef.current?.currentTime ?? -1,
            ready: (videoRef.current?.readyState ?? 0) >= 2 && !videoRef.current?.seeking,
            paused: videoRef.current?.paused ?? true,
            subtitle: subtitleOverlayRef.current?.style.display === 'none' ? '' : subtitleOverlayRef.current?.textContent ?? '' }));
        return () => registerPreviewReader(undefined);
    }, []);

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
                if (media && !hasSrc(v, previewSrc(media))) {
                    v.src = previewSrc(media);
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
                setTimelineHeight(Math.max(160, Math.min(Math.round(window.innerHeight * 0.7), startTlH - dy)));
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
    const handleCueEdgeDrag = useCallback((e: React.MouseEvent, clipId: string, segId: number, edge: 'left' | 'right') => {
        e.preventDefault();
        e.stopPropagation();
        setActiveClipId(clipId);
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
            const curSegments = useStore.getState().timelineClips.find(c => c.id === clipId)?.segments ?? [];
            const snapped = findSnapTime(tlTime, timelineSegments(useStore.getState().timelineClips), snapThreshold);
            if (snapped !== null) {
                setSnapTime(snapped);
                tlTime = snapped;
            } else {
                setSnapTime(null);
            }

            // 找到字幕所屬的 clip，將時間軸時間轉換為媒體時間
            const state = useStore.getState();
            const ownerClip = state.timelineClips.find(c => c.id === clipId);
            if (!ownerClip) return;

            // 時間軸時間 → 媒體時間: mediaTime = (tlTime - clip.startTime) * speed
            const mediaTime = toSourceTime(ownerClip, tlTime);
            const mediaDuration = ownerClip.trimEnd; // 媒體最大時間

            const seg = curSegments.find(s => s.id === segId);
            if (!seg) return;
            if (edge === 'left') {
                const newStart = Math.min(mediaTime, seg.end - 0.1);
                state.updateClipSegment(clipId, segId, { start: Math.max(ownerClip.trimStart, newStart) });
            } else {
                const newEnd = Math.max(mediaTime, seg.start + 0.1);
                state.updateClipSegment(clipId, segId, { end: Math.min(mediaDuration, newEnd) });
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
    // ── AI 掃描不通順語句（點擊定位，手動修改）──
    const [isScanningFlow, setIsScanningFlow] = useState(false);
    const [flowMsg, setFlowMsg] = useState('');
    const [flowIssues, setFlowIssues] = useState<{ clipId: string; segId: number; text: string; tl: number; reason: string }[]>([]);

    const handleScanFlow = useCallback(async () => {
        const refs: { clipId: string; segId: number; text: string; tl: number }[] = [];
        const track0 = timelineClips.filter(c => c.trackIndex === 0).sort((a, b) => a.startTime - b.startTime);
        for (const clip of track0) {
            for (const seg of (clip.segments ?? [])) {
                refs.push({
                    clipId: clip.id,
                    segId: seg.id,
                    text: seg.text,
                    tl: (seg.start - clip.trimStart) / clip.speed + clip.startTime,
                });
            }
        }
        if (!refs.length) { notify('沒有字幕可掃描'); return; }
        setIsScanningFlow(true);
        setFlowIssues([]);
        setFlowMsg('');
        try {
            const r = await api.scanSuspicious(refs.map(x => x.text));
            if (!r.ok && r.error) { setFlowMsg(`❌ ${r.error}`); return; }
            const items = (r.items || [])
                .filter(it => Number.isInteger(it.index) && it.index >= 0 && it.index < refs.length)
                .map(it => ({ ...refs[it.index], reason: it.reason || '語意可疑' }));
            setFlowIssues(items);
            setFlowMsg(items.length ? `找到 ${items.length} 句可疑，點擊可定位` : '🎉 沒掃到明顯不通順的句子');
        } catch (e) { setFlowMsg(`❌ ${humanizeError(`掃描失敗：${e}`).message}`); }
        finally { setIsScanningFlow(false); }
    }, [timelineClips]);

    const handleLocateIssue = useCallback((item: { clipId: string; segId: number; tl: number }) => {
        // 選中片段（同步右側清單）→ 高亮該句（清單自動捲到）→ 播放頭跳過去
        setActiveClipId(item.clipId);
        setActiveSegment(item.segId);
        seekTo(item.tl);
    }, [setActiveClipId, setActiveSegment, seekTo]);

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
                seekTo((seg.start - activeClip.trimStart) / activeClip.speed + activeClip.startTime);
            } else if (seg) {
                // 沒有 activeClip 的退路：找出實際擁有此字幕的 clip 來換算 timeline 位置
                const owner = timelineClips.find(c => c.trackIndex === 0 && c.segments.some(x => x.id === segId));
                seekTo(owner ? (seg.start - owner.trimStart) / owner.speed + owner.startTime : seg.start);
            }
        }
    }, [setActiveSegment, seekTo, segments, activeClipId, timelineClips]);

    // ── 從字幕直接剪：把選取句子的影片區間剪掉（相鄰的句子連同中間空白一起剪）──
    const handleCutSegments = useCallback((ids: Set<number>) => {
        const clip = activeClipId ? timelineClips.find(c => c.id === activeClipId) : null;
        if (!clip) { notify('請先在時間軸點選這些字幕所在的片段'); return; }
        const order = segments.map(s => s.id);
        const picked = segments.filter(s => ids.has(s.id)).sort((x, y) => x.start - y.start);
        const ranges: [number, number][] = [];
        let prev = -2;
        for (const s of picked) {
            const idx = order.indexOf(s.id);
            const st = Math.max(s.start, clip.trimStart), en = Math.min(s.end, clip.trimEnd);
            if (en - st < 0.05) { prev = idx; continue; }
            if (idx === prev + 1 && ranges.length) ranges[ranges.length - 1][1] = en; else ranges.push([st, en]);
            prev = idx;
        }
        if (!ranges.length) { notify('選取的句子不在這個片段的範圍內'); return; }
        const seconds = ranges.reduce((n, [s, e]) => n + (e - s) / clip.speed, 0);
        const ops = [...ranges].reverse().map(([start, end]) => ({ type: 'ripple_delete', mediaId: clip.mediaId, start, end }));
        if (!runOpsRef.current(ops, '剪掉字幕段落')) return;
        setSelectedSegIds(new Set());
        // 播放頭停在剪接點，並改選剪接點後面的片段（字幕清單接著顯示後面的句子）
        const st = useStore.getState();
        const t = Math.min((ranges[0][0] - clip.trimStart) / clip.speed + clip.startTime, st.getDuration());
        const here = st.timelineClips.find(c => c.trackIndex === 0 && t >= c.startTime - 1e-3 && t < c.startTime + c.duration - 1e-3)
            ?? st.timelineClips.find(c => c.mediaId === clip.mediaId);
        if (here) st.setActiveClipId(here.id);
        seekTo(t);
        toast('info', `已剪掉 ${picked.length} 句（${seconds.toFixed(1)} 秒）`, [{ label: '復原', run: handleUndo }], { key: 'history' });
    }, [activeClipId, timelineClips, segments, handleUndo, seekTo]);

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

    useEffect(() => {
        if (!overlayMenuOpen) return;
        overlayMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();   // 開啟時焦點移到第一項
        const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.add-menu-wrap')) setOverlayMenuOpen(false); };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [overlayMenuOpen]);

    // ── 快捷鍵：空白鍵 播放/暫停 + Ctrl+Z 復原 ──
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            // Ctrl+Z 復原（不在 textarea/input 時）
            if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
                if (tag === 'TEXTAREA' || tag === 'INPUT') return;
                e.preventDefault();
                if (e.shiftKey || e.key.toLowerCase() === 'y') handleRedo(); else handleUndo();
                return;
            }
            // 空白鍵 播放/暫停
            if (e.code !== 'Space') return;
            if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
            // 焦點在按鈕、頁籤、字幕項目上時，空白鍵是「按下它」，不是播放
            if ((e.target as HTMLElement).closest?.('button, a, summary, [role="button"], [role="tab"], [role="listitem"]')) return;
            e.preventDefault();
            togglePlay();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [togglePlay, handleUndo, handleRedo]);

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

                updateTransition(tl);

                // 同步 store 的 currentTime（節流：每 250ms 更新一次，避免 60fps re-render）
                if (Math.abs(tl - (useStore.getState().currentTime)) > 0.25) {
                    setCurrentTime(tl);
                }

                // 字幕 overlay — 用 v.currentTime（實際播放位置）比對
                const overlay = subtitleOverlayRef.current;
                if (overlay) {
                    if (clip.segments.length > 0) {
                        const actualMediaTime = v.currentTime;
                        const activeSeg = segAt(clip.segments, actualMediaTime);
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
    }, [isPlaying, pixelsPerSecond, duration, timelineClips, goToClip, primeStandby, syncRulerScroll, setCurrentTime, setIsPlaying, setActiveSegment, updateTransition]);

    // ── 暫停時跳到別的時間點（AI 預覽、點字幕、鍵盤），播放頭若在畫面外就把時間軸捲過去 ──
    useEffect(() => {
        if (isPlaying) return;
        const el = tracksRef.current;
        if (!el || duration <= 0) return;
        const pos = currentTime * pixelsPerSecond + LABEL_W;
        const left = el.scrollLeft + LABEL_W + 16, right = el.scrollLeft + el.clientWidth - 16;
        if (pos < left || pos > right) {
            el.scrollLeft = Math.max(0, pos - LABEL_W - el.clientWidth / 3);
            syncRulerScroll();
        }
    }, [currentTime, isPlaying, pixelsPerSecond, duration, syncRulerScroll]);

    // ── 畫面縮放編輯（介面）：與 AI 同一條 dry-run → apply 路徑，一次操作 = 一筆 undo ──
    const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
    const [zoomBusy, setZoomBusy] = useState(false);
    const runZoomOps = useCallback((operations: Record<string, unknown>[], what = '縮放操作') => {
        return runOps(operations, what);
    }, []);
    runOpsRef.current = runZoomOps;
    function runOps(operations: Record<string, unknown>[], what: string) {
        try {
            const s = readState();
            const v = { sessionId: s.sessionId, projectId: s.projectId, expectedRevision: s.revision };
            const draft = dryRun({ ...v, timeUnit: 'seconds', operations: operations.map(o => ({ trackId: 'video-main', timeDomain: 'source', ...o })) } as never);
            applyPlan({ ...v, dryRunId: draft.dryRunId, confirmed: true });
            return draft.changes as { zoomId?: string }[];
        } catch (e) {
            notify(`${what}失敗：${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
    const selectedZoom = useMemo(() => {
        for (const m of mediaItems) {
            const z = m.zooms?.find(z => z.id === selectedZoomId);
            if (z) return { media: m, zoom: z };
        }
        return null;
    }, [mediaItems, selectedZoomId]);
    const addZoomAtPlayhead = useCallback(() => {
        const t = timelinePosRef.current;
        const clip = timelineClips.find(c => c.trackIndex === 0 && !c.bookend && t >= c.startTime && t < c.startTime + c.duration);
        const media = clip && mediaItems.find(m => m.id === clip.mediaId);
        if (!clip || !media) { notify('請把播放頭移到要放大的片段上'); return; }
        if (!media.info.width) { notify('純音訊素材不能縮放'); return; }
        const start = Math.round(toSourceTime(clip, t) * 100) / 100;
        const end = Math.min(media.info.duration, start + 3);
        const changes = runZoomOps([{ type: 'add_zoom', mediaId: media.id, start, end, x: 0.5, y: 0.5, scale: 2 }]);
        if (changes?.[0]?.zoomId) selectZoom(changes[0].zoomId);
    }, [timelineClips, mediaItems, runZoomOps]);
    const autoZoom = useCallback(async () => {
        const ids = [...new Set(timelineClips.filter(c => c.trackIndex === 0 && !c.bookend).map(c => c.mediaId))];
        if (!ids.length) return;
        setZoomBusy(true);
        try {
            const ops: Record<string, unknown>[] = [];
            let tracked = 0;
            for (const id of ids) {
                const media = mediaItems.find(m => m.id === id);
                const rep = await api.zoomSuggestions(id);
                if (!rep || !media) continue;
                tracked++;
                const taken = media.zooms ?? [];
                for (const z of rep.suggestions) {
                    if (taken.some(o => z.start < o.end && z.end > o.start)) continue; // 不覆蓋已有的縮放
                    ops.push({ type: 'add_zoom', mediaId: id, start: z.start, end: z.end, x: z.x, y: z.y, scale: z.scale });
                }
            }
            if (!tracked) { notify('這些素材沒有游標紀錄。自動縮放只支援用 LJ Cut 錄的影片（錄影時會記下滑鼠點擊）。'); return; }
            if (!ops.length) { notify('沒有新的縮放建議（沒有點擊，或建議的時段已有縮放）。'); return; }
            if (runZoomOps(ops)) notify(`已依滑鼠點擊加入 ${ops.length} 段縮放，可按 Ctrl+Z 復原。`);
        } catch (e) {
            notify(e instanceof Error ? e.message : String(e));
        } finally { setZoomBusy(false); }
    }, [timelineClips, mediaItems, runZoomOps]);
    // 預覽畫面上的滑鼠位置 → 素材畫面比例座標（已放大時會換算回原畫面）；畫面外回 null
    const screenToSource = useCallback((clientX: number, clientY: number, media: MediaItem) => {
        // 兩個 <video> 疊放，點到的可能是隱藏的待命元素；用正在顯示這個素材的那個換算
        const shown = [vid0Ref.current, vid1Ref.current].find(el => el && el.style.opacity !== '0' && isShowing(el, media));
        const v = shown ?? getActiveVideo(), box = videoContainerRef.current;
        if (!v || !box || !v.videoWidth) return null;
        const rect = box.getBoundingClientRect();
        const W = rect.width, H = rect.height, aspect = v.videoWidth / v.videoHeight;
        const fw = W / H > aspect ? H * aspect : W, fh = W / H > aspect ? H : W / aspect;
        const cur = shown ? zoomAt(media.zooms, v.currentTime) : { scale: 1, x: 0.5, y: 0.5 };
        const x = cur.x + (clientX - rect.left - W / 2) / (cur.scale * fw);
        const y = cur.y + (clientY - rect.top - H / 2) / (cur.scale * fh);
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    }, [getActiveVideo]);
    // Shift+點預覽畫面：把選取的縮放中心設到點擊位置
    const setZoomCenterFromClick = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
        if (!selectedZoom) return false;
        const p = screenToSource(e.clientX, e.clientY, selectedZoom.media);
        if (p) runZoomOps([{ type: 'edit_zoom', zoomId: selectedZoom.zoom.id, ...p }]);
        return true;
    }, [selectedZoom, runZoomOps, screenToSource]);

    // ── 標註疊加層編輯（介面）：與縮放相同走 dry-run → apply，一次操作 = 一筆 undo ──
    const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
    const selectedOverlay = useMemo(() => {
        for (const m of mediaItems) {
            const o = m.overlays?.find(o => o.id === selectedOverlayId);
            if (o) return { media: m, overlay: o };
        }
        return null;
    }, [mediaItems, selectedOverlayId]);
    const selectZoom = useCallback((id: string | null) => { setSelectedZoomId(id); if (id) setSelectedOverlayId(null); }, []);
    const selectOverlay = useCallback((id: string | null) => { setSelectedOverlayId(id); if (id) setSelectedZoomId(null); }, []);
    // 子母畫面：選檔 → 上傳素材庫 → 在播放頭加入（右下角、寬 30%）
    const assetInputRef = useRef<HTMLInputElement>(null);
    const addMediaFromFile = useCallback(async (file: File) => {
        const t = timelinePosRef.current;
        const clip = timelineClips.find(c => c.trackIndex === 0 && !c.bookend && t >= c.startTime && t < c.startTime + c.duration);
        const media = clip && mediaItems.find(m => m.id === clip.mediaId);
        if (!clip || !media || !media.info.width) { notify('請把播放頭移到要疊子母畫面的影片片段上'); return; }
        try {
            const asset = await api.uploadAsset(file);
            const start = Math.round(toSourceTime(clip, t) * 100) / 100;
            const len = asset.type === 'video' ? Math.max(0.5, asset.duration) : 5;
            const end = Math.min(media.info.duration, start + len);
            const changes = runZoomOps([{ type: 'add_overlay', kind: 'media', mediaId: media.id, start, end, asset,
                x: 0.66, y: 0.62, w: 0.3, text: asset.filename.slice(0, 40) }]) as { overlayId?: string }[] | null;
            if (changes?.[0]?.overlayId) setSelectedOverlayId(changes[0].overlayId);
        } catch (e) {
            notify(e instanceof Error ? e.message : String(e));
        }
    }, [timelineClips, mediaItems, runZoomOps]);
    const addOverlayAtPlayhead = useCallback((kind: OverlayKind) => {
        if (kind === 'media') { assetInputRef.current?.click(); return; }
        const t = timelinePosRef.current;
        const clip = timelineClips.find(c => c.trackIndex === 0 && !c.bookend && t >= c.startTime && t < c.startTime + c.duration);
        const media = clip && mediaItems.find(m => m.id === clip.mediaId);
        if (!clip || !media) { notify('請把播放頭移到要加標註的片段上'); return; }
        if (!media.info.width) { notify('純音訊素材沒有畫面'); return; }
        const start = Math.round(toSourceTime(clip, t) * 100) / 100;
        const end = Math.min(media.info.duration, start + 3);
        const op: Record<string, unknown> = { type: 'add_overlay', kind, mediaId: media.id, start, end };
        if (kind === 'box' || kind === 'spotlight') Object.assign(op, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
        if (kind === 'step') op.text = String((media.overlays ?? []).filter(o => o.kind === 'step').length + 1);
        if (kind === 'title') op.text = '標題文字';   // 加入後在右欄屬性面板直接改
        const changes = runZoomOps([op]) as { overlayId?: string }[] | null;
        if (changes?.[0]?.overlayId) selectOverlay(changes[0].overlayId);
    }, [timelineClips, mediaItems, runZoomOps, selectOverlay]);
    // Shift+點／拖曳預覽畫面：箭頭與步驟設位置；框與聚光燈拖出範圍
    const overlayDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    const onPreviewMouseDown = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
        if (!e.shiftKey || !selectedOverlay) return;
        const o = selectedOverlay.overlay;
        if (o.kind !== 'box' && o.kind !== 'spotlight' && o.kind !== 'media') return;
        const p0 = screenToSource(e.clientX, e.clientY, selectedOverlay.media);
        if (!p0) return;
        e.preventDefault();
        overlayDragRef.current = { ...p0, moved: false };
        const onUp = (ev: MouseEvent) => {
            window.removeEventListener('mouseup', onUp);
            const p1 = screenToSource(ev.clientX, ev.clientY, selectedOverlay.media);
            const start = overlayDragRef.current;
            if (!p1 || !start) return;
            const x = Math.min(start.x, p1.x), y = Math.min(start.y, p1.y);
            const w = Math.abs(p1.x - start.x), h = Math.abs(p1.y - start.y);
            if (w < 0.01 || h < 0.01) return;   // 只是點一下：交給 onClick 移動位置
            start.moved = true;
            if (o.kind === 'media') {   // 子母畫面：拖出的寬度決定大小，高度依素材比例
                runZoomOps([{ type: 'edit_overlay', overlayId: o.id, x, y, w: Math.max(0.05, Math.round(w * 1000) / 1000) }]);
                return;
            }
            runZoomOps([{ type: 'edit_overlay', overlayId: o.id, x, y, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 }]);
        };
        window.addEventListener('mouseup', onUp);
    }, [selectedOverlay, screenToSource, runZoomOps]);
    const onPreviewShiftClick = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
        if (selectedOverlay) {
            const drag = overlayDragRef.current;
            overlayDragRef.current = null;
            if (drag?.moved) return true;
            const o = selectedOverlay.overlay;
            const p = screenToSource(e.clientX, e.clientY, selectedOverlay.media);
            if (!p || o.kind === 'title') return true;
            if (o.kind === 'media') {
                // 點一下：把子母畫面的左上角移到這裡（大小不變）
                runZoomOps([{ type: 'edit_overlay', overlayId: o.id, ...p }]);
            } else if (o.kind === 'box' || o.kind === 'spotlight') {
                // 點一下：把框的中心移到這裡（大小不變）
                const w = o.w ?? 0.2, h = o.h ?? 0.2;
                const x = Math.min(1 - w, Math.max(0, p.x - w / 2)), y = Math.min(1 - h, Math.max(0, p.y - h / 2));
                runZoomOps([{ type: 'edit_overlay', overlayId: o.id, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }]);
            } else {
                runZoomOps([{ type: 'edit_overlay', overlayId: o.id, ...p }]);
            }
            return true;
        }
        return setZoomCenterFromClick(e);
    }, [selectedOverlay, screenToSource, runZoomOps, setZoomCenterFromClick]);

    // ── 畫面縮放預覽：常駐迴圈，依每個 <video> 自己的素材與 currentTime 套 CSS transform ──
    // 與匯出同一套公式（zoom.ts ↔ backend/services/zoom.py）；播放、暫停、拖拉播放頭都適用。
    const overlayContentRef = useRef<HTMLDivElement>(null);
    const overlayScreenRef = useRef<HTMLDivElement>(null);
    const zoomMediaRef = useRef(mediaItems);
    zoomMediaRef.current = mediaItems;
    useEffect(() => {
        let raf = 0;
        const applied = new WeakMap<HTMLVideoElement, string>();
        const tick = () => {
            for (const v of [vid0Ref.current, vid1Ref.current]) {
                if (!v) continue;
                // updateTransition 會把 <video> 縮成主畫面大小並以 translate(-50%,-50%) 置中；放大接在置中之後
                const base = v.style.left === '50%' ? 'translate(-50%, -50%)' : '';
                const media = zoomMediaRef.current.find(m => m.zooms?.length && isShowing(v, m));
                const z = media ? zoomAt(media.zooms, v.currentTime) : null;
                let transform = base, clip = '';
                if (z && z.scale > 1.0005 && v.videoWidth && v.videoHeight && v.clientWidth && v.clientHeight) {
                    // 元素內以 object-fit: contain 顯示，畫面框置中於元素
                    const W = v.clientWidth, H = v.clientHeight;
                    const aspect = v.videoWidth / v.videoHeight;
                    const fw = W / H > aspect ? H * aspect : W, fh = W / H > aspect ? H : W / aspect;
                    const s = z.scale, tx = -s * (z.x - 0.5) * fw, ty = -s * (z.y - 0.5) * fh;
                    transform = `${base} translate(${tx}px, ${ty}px) scale(${s})`.trim();
                    // 只顯示原畫面範圍：把畫面框反推回元素座標當 clip-path（clip-path 會跟著 transform 一起變換）
                    const back = (q: number, half: number, t: number) => half + (q - half - t) / s;
                    const l = back((W - fw) / 2, W / 2, tx), r = back((W + fw) / 2, W / 2, tx);
                    const t = back((H - fh) / 2, H / 2, ty), b = back((H + fh) / 2, H / 2, ty);
                    clip = `inset(${t}px ${W - r}px ${H - b}px ${l}px)`;
                }
                // 與目前樣式比對（其他程式也會寫 transform），有差才寫
                const key = transform + '|' + clip;
                if (applied.get(v) !== key || !v.style.transform.startsWith(base)) {
                    v.style.transform = transform;
                    v.style.clipPath = clip;
                    v.style.borderRadius = clip ? '0' : '';
                    applied.set(v, key);
                }
            }
            drawOverlays();
            raf = requestAnimationFrame(tick);
        };
        // ── 標註疊加層預覽：內容層跟著 <video> 的位置與縮放，標題層只跟位置；貼圖與匯出同一張 ──
        const imgs = new Map<string, HTMLImageElement>();
        const frames = new Map<string, HTMLIFrameElement>();
        const pips = new Map<string, { under: HTMLImageElement; body: HTMLImageElement | HTMLVideoElement; over: HTMLImageElement }>();
        const drawOverlays = () => {
            const content = overlayContentRef.current, screen = overlayScreenRef.current;
            const v = getActiveVideo();
            if (!content || !screen) return;
            const layers = [content, screen];
            const media = v ? zoomMediaRef.current.find(m => m.overlays?.length && isShowing(v, m)) : undefined;
            const shown = new Set<string>();
            if (v && media && media.info.width && media.info.height && v.clientWidth && v.clientHeight) {
                for (const [i, layer] of layers.entries()) {
                    layer.style.left = v.style.left; layer.style.top = v.style.top;
                    layer.style.width = `${v.clientWidth}px`; layer.style.height = `${v.clientHeight}px`;
                    layer.style.transform = i === 0 ? v.style.transform : (v.style.left === '50%' ? 'translate(-50%, -50%)' : '');
                    layer.style.clipPath = i === 0 ? v.style.clipPath : '';
                    if (v.style.left !== '50%') { layer.style.left = '0'; layer.style.top = '0'; }
                }
                const W = v.clientWidth, H = v.clientHeight, srcW = media.info.width, srcH = media.info.height;
                const aspect = srcW / srcH;
                const fw = W / H > aspect ? H * aspect : W, fh = W / H > aspect ? H : W / aspect;
                const fx = (W - fw) / 2, fy = (H - fh) / 2, q = fw / srcW;
                const t = v.currentTime;
                media.overlays!.forEach((o, index) => {
                    if (t < o.start || t >= o.end) return;
                    if (o.kind === 'media' && o.asset) {
                        const g = getMediaDecor(o, srcW, srcH);
                        if (!g) return;
                        const layer = isContentOverlay(o) ? content : screen;
                        let pip = pips.get(o.id);
                        if (!pip) {
                            const make = (tag: 'img' | 'video') => { const el = document.createElement(tag); el.className = 'overlay-sprite'; return el; };
                            const body = o.asset.type === 'video' ? make('video') as HTMLVideoElement : make('img') as HTMLImageElement;
                            if (body instanceof HTMLVideoElement) { body.muted = true; body.playsInline = true; body.preload = 'auto'; }
                            pip = { under: make('img') as HTMLImageElement, body, over: make('img') as HTMLImageElement };
                            pips.set(o.id, pip);
                        }
                        const a = overlayAnim(o, t);
                        const place = (el: HTMLElement, x: number, y: number, w: number, h: number, z: number) => {
                            if (el.parentElement !== layer) layer.appendChild(el);
                            el.style.left = `${fx + x * q}px`; el.style.top = `${fy + y * q}px`;
                            el.style.width = `${w * q}px`; el.style.height = `${h * q}px`;
                            el.style.opacity = String(a.opacity); el.style.zIndex = String(z); el.style.display = '';
                        };
                        for (const key of ['under', 'over'] as const) {
                            const s = g[key], el = pip[key];
                            if (!s) { el.style.display = 'none'; continue; }
                            if (el.dataset.src !== s.url) { el.src = s.url; el.dataset.src = s.url; }
                            place(el, s.left, s.top, s.width, s.height, index);
                        }
                        const url = `${getBase()}${o.asset.url}`;
                        const body = pip.body;
                        if (body.dataset.src !== url) { body.src = url; body.dataset.src = url; }
                        place(body, g.left, g.top, g.width, g.height, index);
                        body.style.borderRadius = `${g.radius * q}px`;
                        body.style.objectFit = 'cover';
                        if (body instanceof HTMLVideoElement) {
                            // 跟著主畫面時間：播放中用相同倍速並校正漂移，暫停時精準跳轉
                            const want = mediaTime(o, t);
                            const playing = !v.paused;
                            body.playbackRate = v.playbackRate || 1;
                            body.muted = !(o.volume && o.volume > 0);
                            body.volume = Math.min(1, o.volume ?? 0);
                            if (playing) {
                                if (body.paused) void body.play().catch(() => { });
                                if (Math.abs(body.currentTime - want) > 0.2) body.currentTime = want;
                            } else {
                                if (!body.paused) body.pause();
                                if (Math.abs(body.currentTime - want) > 0.02) body.currentTime = want;
                            }
                        }
                        shown.add(o.id);
                        return;
                    }
                    if (o.kind === 'html') {
                        const doc = o.html ? getHtmlDoc(o.html, srcW, srcH) : null;
                        if (!doc) return;
                        let frame = frames.get(o.id);
                        if (!frame) {
                            frame = document.createElement('iframe');
                            frame.className = 'overlay-html';
                            frame.setAttribute('sandbox', 'allow-scripts');   // 不同源：碰不到 LJ Cut 本體
                            frame.setAttribute('tabindex', '-1');
                            frame.setAttribute('aria-hidden', 'true');
                            frame.addEventListener('load', () => { frame!.dataset.sent = ''; });
                            frames.set(o.id, frame);
                        }
                        const layer = isContentOverlay(o) ? content : screen;
                        if (frame.parentElement !== layer) layer.appendChild(frame);
                        if (frame.dataset.doc !== doc.doc) { frame.srcdoc = doc.doc; frame.dataset.doc = doc.doc; frame.dataset.sent = ''; }
                        const k = fw / doc.width;
                        frame.style.left = `${fx}px`;
                        frame.style.top = `${fy}px`;
                        frame.style.width = `${doc.width}px`;
                        frame.style.height = `${doc.height}px`;
                        frame.style.transform = `scale(${k})`;
                        frame.style.zIndex = String(index);
                        frame.style.display = '';
                        // 時間有變就送；暫停時每 0.5 秒補送（iframe 載入前送出的訊息會遺失）
                        const local = (t - o.start).toFixed(3);
                        const now = performance.now();
                        if (frame.dataset.sent !== local || now - Number(frame.dataset.at || 0) > 500) {
                            frame.contentWindow?.postMessage({ ljcutT: Number(local) }, '*');
                            frame.dataset.sent = local;
                            frame.dataset.at = String(now);
                        }
                        shown.add(o.id);
                        return;
                    }
                    const sprite = getSprite(o, srcW, srcH);
                    if (!sprite) return;
                    let img = imgs.get(o.id);
                    if (!img) {
                        img = document.createElement('img');
                        img.className = 'overlay-sprite';
                        img.draggable = false;
                        imgs.set(o.id, img);
                    }
                    const layer = isContentOverlay(o) ? content : screen;
                    if (img.parentElement !== layer) layer.appendChild(img);
                    if (img.dataset.src !== sprite.url) { img.src = sprite.url; img.dataset.src = sprite.url; }
                    const a = overlayAnim(o, t);
                    img.style.left = `${fx + sprite.left * q}px`;
                    img.style.top = `${fy + sprite.top * q}px`;
                    img.style.width = `${sprite.width * q}px`;
                    img.style.height = `${sprite.height * q}px`;
                    img.style.opacity = String(a.opacity);
                    img.style.transform = `translateX(${a.slide * srcH / 1080 * q}px) scale(${a.scale})`;
                    img.style.zIndex = String(index);
                    img.style.display = '';
                    shown.add(o.id);
                });
            }
            for (const [id, img] of imgs) {
                if (shown.has(id)) continue;
                if (img.style.display !== 'none') img.style.display = 'none';
                if (!zoomMediaRef.current.some(m => m.overlays?.some(o => o.id === id))) { img.remove(); imgs.delete(id); }
            }
            for (const [id, pip] of pips) {
                if (shown.has(id)) continue;
                for (const el of [pip.under, pip.body, pip.over]) if (el.style.display !== 'none') el.style.display = 'none';
                if (pip.body instanceof HTMLVideoElement && !pip.body.paused) pip.body.pause();
                if (!zoomMediaRef.current.some(m => m.overlays?.some(o => o.id === id && o.kind === 'media'))) {
                    for (const el of [pip.under, pip.body, pip.over]) el.remove();
                    pips.delete(id);
                }
            }
            for (const [id, frame] of frames) {
                if (shown.has(id)) continue;
                if (frame.style.display !== 'none') frame.style.display = 'none';
                if (!zoomMediaRef.current.some(m => m.overlays?.some(o => o.id === id && o.kind === 'html'))) { frame.remove(); frames.delete(id); }
            }
        };
        // HTML 動畫 iframe 載入完成會回報 ljcutReady：立即重送目前時間
        const onReady = (e: MessageEvent) => {
            if (!e.data?.ljcutReady) return;
            for (const frame of frames.values()) if (e.source === frame.contentWindow) { frame.dataset.sent = ''; frame.dataset.at = '0'; }
        };
        window.addEventListener('message', onReady);
        raf = requestAnimationFrame(tick);
        return () => {
            window.removeEventListener('message', onReady);
            cancelAnimationFrame(raf);
            for (const img of imgs.values()) img.remove();   // 迴圈重啟（卸載／熱更新）時不留舊貼圖
            for (const frame of frames.values()) frame.remove();
            for (const pip of pips.values()) for (const el of [pip.under, pip.body, pip.over]) el.remove();
        };
    }, [getActiveVideo]);

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
        if (!hasSrc(v, previewSrc(media))) {
            v.src = previewSrc(media);
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
        const overlaySegs = overlayClip?.segments ?? [];
        const activeSeg = segAt(overlaySegs, mediaTimeForOverlay);
        if (activeSeg) {
            overlay.textContent = activeSeg.text;
            overlay.style.display = '';
        } else {
            overlay.style.display = 'none';
        }
    }, [isPlaying, currentTime, timelineClips, segments]);

    // ── 波形繪製（filmstrip 模式）──
    // 把「整段媒體」的波形畫成一張固定寬度的底片(canvas)，每個 clip 用 overflow:hidden 當視窗、
    // 以 CSS translateX 對準 trimStart。裁切/移動只改 React state(視窗寬 + translateX)，
    // canvas 不重畫、不改尺寸 → 幾何全部由同一次 render 算出，絕不漂移。
    // canvas 顯示寬(style.width)與 translateX 由 JSX inline style 控制；此函式只負責「點陣圖」。
    const drawFullWaveform = useCallback((canvas: HTMLCanvasElement, peaks: number[], fullWidthPx: number) => {
        if (peaks.length === 0 || fullWidthPx <= 0) return;
        const h = canvas.parentElement?.clientHeight || 60;
        const dpr = window.devicePixelRatio || 1;
        const MAX_CANVAS_PX = 16384;
        const bitmapW = Math.min(Math.ceil(fullWidthPx), Math.floor(MAX_CANVAS_PX / dpr));
        const wantW = bitmapW * dpr;
        const wantH = Math.round(h * dpr);
        if (canvas.width === wantW && canvas.height === wantH && canvas.dataset.drawn === '1') return; // 尺寸沒變→不重畫
        canvas.width = wantW;   // 設 bitmap（會清空+重設 transform）
        canvas.height = wantH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, bitmapW, h);
        const cellH = 4, gapY = 1.5, gapX = 1;
        const stepX = bitmapW / peaks.length;        // 每個 peak 在 bitmap 內的像素步距
        const barW = Math.max(1, stepX - gapX);
        const maxCells = Math.floor(h / (cellH + gapY));
        const maxAmp = peaks.reduce((a, v) => (v > a ? v : a), 0.01); // 整段最大振幅→高度一致
        for (let i = 0; i < peaks.length; i++) {
            const x = i * stepX;
            const cells = Math.max(1, Math.round((peaks[i] / maxAmp) * maxCells));
            for (let c = 0; c < cells; c++) {
                const y = h - (c + 1) * (cellH + gapY);
                const rc = c / maxCells;
                ctx.fillStyle = rc > 0.85 ? '#e04050' : rc > 0.7 ? '#e0a040' : '#6eccc0';
                ctx.fillRect(x, y, barW, cellH);
            }
        }
        canvas.dataset.drawn = '1';
    }, []);

    // 媒體/縮放/速度變更時重畫底片；裁切/移動因 fullWidth 不變 → guard 內部略過(零重畫)
    // useLayoutEffect：在瀏覽器繪製前同步執行，避免「狀態變更→畫面已動，canvas 慢一幀」的延遲抖動
    useLayoutEffect(() => {
        for (const clip of timelineClips) {
            const m = mediaItems.find(x => x.id === clip.mediaId);
            if (!m || m.waveformPeaks.length === 0) continue;
            const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-clip-id="${clip.id}"]`);
            if (!canvas) continue;
            const dur = m.info.duration || 0;
            const fullW = dur > 0 ? (dur / (clip.speed || 1)) * pixelsPerSecond : clip.duration * pixelsPerSecond;
            drawFullWaveform(canvas, m.waveformPeaks, fullW);
        }
    }, [timelineClips, mediaItems, pixelsPerSecond, drawFullWaveform]);

    const rulerTicks = generateRulerTicks(duration, pixelsPerSecond);

    const mainJsx = (
        <div className="app">
            {/* Header */}
            <header className="app-header">
                <h1>LJCUT</h1>
                <ProjectFileButtons />
                <AiStatus />
                <div className="header-actions">
                    <button className="btn" onClick={() => setShowRecSettings(true)}><CircleDot aria-hidden />螢幕錄影</button>
                    {/* 匯出影片：只要時間軸上有片段就能匯出（純剪輯、無字幕也可） */}
                    {hasTimeline && (<>
                        <span className="header-sep" aria-hidden />
                        <button className="btn btn-accent" onClick={() => setShowExportModal(true)} disabled={isBurning}>
                            {isBurning ? `匯出中 ${exportProgress >= 0 ? exportProgress + '%' : '…'}` : <><Clapperboard aria-hidden />匯出影片</>}
                        </button>
                        <button className="btn" onClick={() => setShowYtUpload(true)} disabled={!lastExport || isBurning}
                            aria-label={exportStale ? '上傳到 YouTube（成品較舊）' : '上傳到 YouTube'}
                            title={!lastExport ? '請先匯出影片，再上傳 YouTube' : exportStale ? `匯出後專案又改過，這支成品不含之後的修改\n${lastExport}` : `上傳最近匯出的成品到 YouTube\n${lastExport}`}>
                            <Upload aria-hidden />YouTube{exportStale && <span className="stale-tag">成品較舊</span>}
                        </button>
                    </>)}
                    <span className="header-sep" aria-hidden />
                    <button className="btn btn-icon" onClick={() => setShowHelp(true)} title="說明與快捷鍵（?）" aria-label="說明與快捷鍵" style={{ padding: '6px 10px' }}><CircleHelp aria-hidden /></button>
                    <button className="btn btn-icon" onClick={() => setShowSettings(true)} title="設定" aria-label="設定" style={{ padding: '6px 10px' }}><Settings aria-hidden /></button>
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
                    {encoderInfo && (() => {
                        const e = encoderInfo;
                        let label: string, cls: string, tip: string;
                        if (!e.hw) { label = '軟體編碼'; cls = 'sw'; tip = '本機無硬體 H.264 編碼器，使用 CPU 軟體編碼'; }
                        else if (e.nvenc_active === false) { label = '掉回軟體'; cls = 'warn'; tip = '偵測到硬體編碼器，但這次錄影未在使用（可能 NVENC session 被其他程式占用），已掉回 CPU 軟體編碼'; }
                        else if (e.nvenc_active === true) { label = 'NVENC'; cls = 'hw'; tip = `硬體編碼運作中：${e.name}`; }
                        else { label = '硬體編碼'; cls = 'hw'; tip = `硬體編碼器：${e.name}（執行期確認中…）`; }
                        return <span className={`enc-badge enc-${cls}`} title={tip}><span className={`encoder-dot ${cls === 'hw' ? '' : 'warn'}`} aria-hidden />{label}</span>;
                    })()}
                    <button className="rec-ctrl-btn" onClick={handlePauseRec} title={isPaused ? '繼續' : '暫停'} aria-label={isPaused ? '繼續錄影' : '暫停錄影'}>
                        {isPaused ? <Play aria-hidden /> : <Pause aria-hidden />}
                    </button>
                    <button className="rec-ctrl-btn rec-stop" onClick={handleStopRec} title="停止 (F10)" aria-label="停止錄影"><Square aria-hidden /></button>
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
                <aside className="panel-left" style={{ width: leftWidth }} aria-label="媒體與辨識">
                    {/* 頁籤切換 */}
                    <div className="left-tabs" role="tablist" aria-label="左側面板"
                        onKeyDown={(e) => {
                            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                            e.preventDefault();
                            const next = leftTab === 'media' ? 'subtitle' : 'media';
                            setLeftTab(next);
                            document.getElementById(`left-tab-${next}`)?.focus();
                        }}>
                        {([['media', '媒體'], ['subtitle', '辨識']] as const).map(([key, label]) => (
                            <button key={key} id={`left-tab-${key}`} role="tab" aria-selected={leftTab === key} aria-controls="left-tab-panel"
                                tabIndex={leftTab === key ? 0 : -1}
                                className={`left-tab ${leftTab === key ? 'active' : ''}`} onClick={() => setLeftTab(key)}>{label}</button>
                        ))}
                    </div>

                    <div className="left-tab-body" id="left-tab-panel" role="tabpanel" aria-labelledby={`left-tab-${leftTab}`}>
                        {/* ─── 媒體頁籤 ─── */}
                        {leftTab === 'media' && (
                            <>
                                {/* 上傳區 */}
                                <div className="upload-zone upload-zone-compact" onClick={() => fileInputRef.current?.click()}
                                    role="button" tabIndex={0} aria-label="新增素材：選擇影片或音訊檔"
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
                                    onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                    <p>{isUploading ? '匯入中…' : '點一下匯入影片，或把檔案拖進來'}</p>
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
                                                        <Video aria-hidden />
                                                    )}
                                                </div>
                                                <div className="media-meta">
                                                    <div className="media-name">{item.filename}</div>
                                                    <div className="media-duration">{formatTime(item.info.duration)}</div>
                                                </div>
                                                {IS_TAURI && (
                                                    <button className="media-remove media-folder" onClick={async (e) => {
                                                        e.stopPropagation();
                                                        try {
                                                            const { invoke } = await import('@tauri-apps/api/core');
                                                            await invoke('reveal_media', { filename: item.filename, fileId: item.id });
                                                        } catch (err) { notify(`開啟資料夾失敗: ${err}`); }
                                                    }} title="開啟檔案所在資料夾" aria-label="開啟檔案所在資料夾"><FolderOpen aria-hidden /></button>
                                                )}
                                                <button className="media-remove" onClick={(e) => { e.stopPropagation(); pushUndo(); removeMedia(item.id); }} title="從媒體庫移除（不會刪除磁碟上的檔案）" aria-label={`從媒體庫移除 ${item.filename}`}><X aria-hidden /></button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {controlWorkspace && hasTimeline && (
                                    <section className="left-section" id="bookend-section" aria-labelledby="bookend-heading">
                                        <h3 id="bookend-heading">片頭與片尾</h3>
                                        <BookendControls />
                                    </section>
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
                                        <label className="fast-asr-toggle" title="批次推論，約 4 倍速，適合長片先粗剪；專有名詞準確度略降，會省略部分口語贅詞（僅 GPU 有效）">
                                            <input type="checkbox" checked={fastAsr} disabled={isTranscribing}
                                                onChange={(e) => { setFastAsr(e.target.checked); try { localStorage.setItem('ljcut-fast-asr', e.target.checked ? '1' : '0'); } catch { /* noop */ } }} />
                                            快速辨識（約 4 倍速，準確度略降）
                                        </label>
                                        <div className="action-buttons">
                                            {/* 已經有字幕時降為次要按鈕並明示會取代，避免誤點重跑辨識、蓋掉校對好的字幕 */}
                                            <button className={timelineClips.some(c => c.segments.length > 0) ? 'btn' : 'btn btn-primary'} onClick={handleTranscribe}
                                                disabled={isTranscribing} style={{ width: '100%', justifyContent: 'center' }}
                                                title={timelineClips.some(c => c.segments.length > 0) ? '重新辨識會取代目前的字幕（可 Ctrl+Z 復原）' : undefined}>
                                                {isTranscribing ? '辨識中…' : timelineClips.some(c => c.segments.length > 0) ? '重新辨識（取代目前字幕）' : '開始辨識'}
                                            </button>
                                            {isTranscribing && (
                                                <div className="transcribe-prog">
                                                    <div className="progress-bar">
                                                        <div
                                                            className={`fill ${!transProg || transProg.pct < 0 ? 'loading' : ''}`}
                                                            style={{ width: transProg && transProg.pct >= 0 ? `${transProg.pct}%` : '100%' }}
                                                        />
                                                    </div>
                                                    <div className="transcribe-prog-info">
                                                        <span className="alive-dot" title="運作中（未當機）" />
                                                        {!transProg || transProg.pct < 0
                                                            ? '準備中…（抽取音訊）'
                                                            : `辨識中 ${transProg.pct}%`}
                                                        {transProg && transProg.total > 0 && transProg.pct >= 0
                                                            ? ` · ${formatTime(transProg.cur)} / ${formatTime(transProg.total)}`
                                                            : ''}
                                                        <span className="transcribe-elapsed">已費時 {formatTime(transElapsed)}</span>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                                {!primaryMedia && <div className="empty-state" style={{ padding: 20 }}><p>請先匯入影片</p></div>}

                            </>
                        )}
                    </div>
                </aside>

                {/* 左側 Resize Handle */}
                <div className="resize-handle-v" onMouseDown={(e) => startResize('left', e)} />

                {/* 中間：影片 */}
                <main className="panel-center">
                    <div ref={videoContainerRef} className="video-container" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
                        {(selectedOverlayId || selectedZoomId) && (
                            <span className="preview-hint" role="note">Shift＋點畫面{selectedOverlayId ? '移動位置；Shift＋拖曳框出範圍' : '設定放大中心'}</span>
                        )}
                        {primaryMedia ? (
                            <>
                                {/* 雙緩衝：兩個 video 疊放，imperative 控制 opacity（不走 React style 以免被覆蓋） */}
                                <video ref={setVid0} className="dbl-video"
                                    onTimeUpdate={(e) => {
                                        if (isPlaying) return; // 播放中由 tick loop 處理字幕
                                        const v = e.currentTarget;
                                        if (v !== getActiveVideo() || v.paused) return;
                                        const active = segAt(segments, v.currentTime);
                                        if (active && active.id !== activeSegmentId) setActiveSegment(active.id);
                                    }}
                                    onEnded={handleVideoEnded}
                                    onMouseDown={onPreviewMouseDown}
                                    onClick={(e) => { if (e.shiftKey && onPreviewShiftClick(e)) return; togglePlay(); }} style={{ cursor: 'pointer' }} />
                                <video ref={setVid1} className="dbl-video"
                                    onTimeUpdate={(e) => {
                                        if (isPlaying) return;
                                        const v = e.currentTarget;
                                        if (v !== getActiveVideo() || v.paused) return;
                                        const active = segAt(segments, v.currentTime);
                                        if (active && active.id !== activeSegmentId) setActiveSegment(active.id);
                                    }}
                                    onEnded={handleVideoEnded}
                                    onMouseDown={onPreviewMouseDown}
                                    onClick={(e) => { if (e.shiftKey && onPreviewShiftClick(e)) return; togglePlay(); }} style={{ cursor: 'pointer' }} />
                            </>
                        ) : (
                            <div className="video-placeholder">
                                <div className="icon"><Film aria-hidden /></div><p>匯入影片或音訊開始剪輯</p>
                                <ol className="first-steps" aria-label="三個步驟">
                                    <li><strong>匯入</strong>把檔案拖進來，或按左側「點一下匯入影片」</li>
                                    <li><strong>辨識字幕</strong>左側「辨識」頁籤按「開始辨識」</li>
                                    <li><strong>剪掉講錯的句子</strong>在右欄點一句按「剪掉這句」，再「匯出影片」</li>
                                </ol>
                                <div className="first-actions">
                                    <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}><Upload aria-hidden />匯入影片</button>
                                    <button className="btn" onClick={() => setShowHelp(true)}><CircleHelp aria-hidden />完整說明</button>
                                </div>
                            </div>
                        )}

                        {/* 標註疊加層預覽：內容層跟著畫面縮放、標題層固定（樣式由常駐迴圈設定） */}
                        <div ref={overlayContentRef} className="overlay-layer" aria-hidden="true" />
                        <div ref={overlayScreenRef} className="overlay-layer" aria-hidden="true" />
                        <div ref={transitionOverlayRef} className="transition-preview" aria-hidden="true" />
                        {/* 字幕即時預覽 overlay */}
                        {primaryMedia && timelineClips.some(c => c.segments.length > 0) && (() => {
                            // 字幕文字與顯示/隱藏改由 tick(播放中) 與 paused-overlay effect(暫停時)
                            // 以 imperative 方式驅動；這裡不再用 React state 設定，避免與 tick 兩邊搶寫造成閃爍。
                            const bgAlpha = subtitleStyle.bgEnabled ? subtitleStyle.bgOpacity / 100 : 0;

                            // 計算影片實際顯示範圍（object-fit: contain 的 letterbox）
                            const v = videoRef.current;
                            const previewClip = timelineClips.find(c => currentTime >= c.startTime && currentTime < c.startTime + c.duration);
                            const previewMedia = mediaItems.find(m => m.id === previewClip?.mediaId);
                            const sourceWidth = previewMedia?.info.width || v?.videoWidth || 0;
                            const sourceHeight = previewMedia?.info.height || v?.videoHeight || 0;
                            let frameTop = 0, frameLeft = 0, frameW = 0, frameH = 0, scale = 1;
                            if (sourceWidth && sourceHeight) {
                                const containerRect = previewSize;
                                if (containerRect) {
                                    const cW = containerRect.width;
                                    const cH = containerRect.height;
                                    const videoAspect = sourceWidth / sourceHeight;
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
                                    scale = frameH / sourceHeight;
                                }
                            }

                            const scaledFontSize = Math.max(12, subtitleStyle.fontSize * scale);
                            const scaledOutline = Math.max(1, subtitleStyle.outlineWidth * scale);

                            return (
                                <div
                                    ref={subtitleOverlayRef}
                                    className={`subtitle-preview-overlay ${isDraggingPreview ? 'dragging' : ''}`}
                                    style={{
                                        visibility: frameW > 0 && frameH > 0 ? 'visible' : 'hidden',
                                        top: `${frameTop + frameH * (subtitleStyle.posY / 100)}px`,
                                        left: `${frameLeft + frameW / 2}px`,
                                        fontFamily: subtitleStyle.fontName,
                                        fontSize: `${scaledFontSize}px`,
                                        padding: `${4 * scale}px ${14 * scale}px`,
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
                            <button className="btn" onClick={togglePlay} style={{ padding: '6px 12px' }} aria-label={isPlaying ? '暫停（空白鍵）' : '播放（空白鍵）'} title={isPlaying ? '暫停（空白鍵／K）' : '播放（空白鍵／L）'}>
                                {isPlaying ? <Pause aria-hidden /> : <Play aria-hidden />}
                            </button>
                            <button className="btn btn-icon" onClick={handleUndo} disabled={!hist.canUndo} aria-label="復原" title={hist.canUndo ? '復原（Ctrl+Z）' : '沒有可以復原的操作'}><Undo2 aria-hidden /></button>
                            <button className="btn btn-icon" onClick={handleRedo} disabled={!hist.canRedo} aria-label="重做" title={hist.canRedo ? '重做（Ctrl+Shift+Z）' : '沒有可以重做的操作'}><Redo2 aria-hidden /></button>
                            <span className="time" ref={timeDisplayRef}>{formatTime(currentTime)} / {formatTime(duration)}</span>
                            <input type="range" ref={rangeSliderRef} aria-label="播放位置" min={0} max={duration || 0} step={0.1} defaultValue={currentTime}
                                onChange={(e) => seekTo(Number(e.target.value))}
                                style={{ flex: 1, accentColor: 'var(--accent-amber)' }} />
                            {activeClipSpeed !== 1 && <span style={{ fontSize: 11, color: 'var(--accent-amber)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 2 }}><Gauge aria-hidden />{activeClipSpeed}x</span>}
                            {segments.length > 0 && (
                                <button className={`btn preview-sub-chip ${burnSubs ? 'burn' : ''}`} onClick={() => setShowExportModal(true)}
                                    aria-label={burnSubs ? '匯出時字幕會燒進畫面，開啟匯出設定' : '匯出時字幕不燒入畫面（另附 SRT），開啟匯出設定'}
                                    title={burnSubs ? '匯出時字幕會燒進畫面（點一下到匯出設定修改）' : '預覽上的字幕只供校對；匯出為乾淨畫面＋獨立 SRT（點一下到匯出設定修改）'}>
                                    <Captions aria-hidden />{burnSubs ? '燒入' : '不燒入'}
                                </button>
                            )}
                            <span className="time zoom-ratio" style={{ fontSize: 12 }} title="時間軸比例（Ctrl+＋／－）" aria-label={`時間軸比例 ${Math.round(zoom * 100)}%`}><ZoomIn aria-hidden style={{ width: 12, height: 12, verticalAlign: -2 }} /> {Math.round(zoom * 100)}%</span>
                            <button className="btn" onClick={() => setZoom(z => Math.max(z * 0.8, 0.1))} style={{ padding: '4px 6px' }} aria-label="縮小時間軸" title="縮小時間軸（Ctrl+－）"><Minus aria-hidden /></button>
                            <button className="btn" onClick={() => setZoom(z => Math.min(z * 1.25, 50))} style={{ padding: '4px 6px' }} aria-label="放大時間軸" title="放大時間軸（Ctrl+＋）"><Plus aria-hidden /></button>
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
                                <div className="timeline-tracks-inner">
                                {/* 影片軌（多 clip） */}
                                <div className="track track-video">
                                    <div className="track-label" style={{ width: LABEL_W }}><Film aria-hidden />&nbsp;影片</div>
                                    <div className="track-content" style={{ width: timelineWidth }}>
                                        {timelineClips.filter(c => c.trackIndex === 0).map(clip => {
                                            const media = mediaItems.find(m => m.id === clip.mediaId);
                                            // left/right 都取整數像素：左裁切時右邊緣(rightPx)恆定、左邊緣(left)整數位移
                                            const left = Math.round(clip.startTime * pixelsPerSecond);
                                            const rightPx = Math.round((clip.startTime + clip.duration) * pixelsPerSecond);
                                            const width = Math.max(rightPx - left, 4);
                                            // filmstrip 視窗：波形 canvas 寬 = 整段媒體寬。
                                            // 關鍵：waveTx = 波形原點(media t=0)在時間軸的像素位置 − 實際取整後的 left。
                                            // 如此 canvas 螢幕位置 = left + waveTx = 原點位置(裁切時恆定) → 與 left 取整精準抵消，左裁切零漂移。
                                            const mDur = media?.info.duration || 0;
                                            const waveFullW = mDur > 0 ? (mDur / (clip.speed || 1)) * pixelsPerSecond : width;
                                            const waveOriginPx = (clip.startTime - clip.trimStart / (clip.speed || 1)) * pixelsPerSecond;
                                            // 取整：left(整數)+waveTx(整數) = round(waveOriginPx)，左裁切時為定值常數→
                                            // 不留分數給 GPU 合成層去捨入(will-change 會把圖層 snap 到整數裝置像素)→徹底零漂
                                            const waveTx = mDur > 0 ? Math.round(waveOriginPx - left) : 0;
                                            return (
                                                <div key={clip.id}
                                                    className={`track-clip video-clip ${draggingClipId === clip.id ? 'dragging' : ''} ${activeClipId === clip.id ? 'active-clip' : ''}`}
                                                    role="button" tabIndex={0} aria-pressed={activeClipId === clip.id} aria-label={`片段 ${media?.filename ?? ''}`}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setActiveClipId(clip.id); }
                                                        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                                                            e.preventDefault(); e.stopPropagation();
                                                            const r = e.currentTarget.getBoundingClientRect();
                                                            const area = tracksRef.current?.getBoundingClientRect();
                                                            const visibleLeft = Math.max(r.left, (area?.left ?? 0) + LABEL_W);
                                                            speedUndoPushedRef.current = false;
                                                            setSpeedMenu({ clipId: clip.id, x: visibleLeft + 8, y: r.bottom, splitTime: timelinePosRef.current });
                                                        }
                                                    }}
                                                    style={{ left, width }}
                                                    onClick={(e) => { setActiveClipId(clip.id); (e.currentTarget as HTMLElement).focus({ preventScroll: true }); }}
                                                    onMouseDown={(e) => handleClipDragStart(e, clip.id)}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        // 切點 = 播放線位置（不是滑鼠點的位置，才精確可控）
                                                        speedUndoPushedRef.current = false;
                                                        setSpeedMenu({ clipId: clip.id, x: e.clientX, y: e.clientY, splitTime: timelinePosRef.current });
                                                    }}
                                                    title={`${media?.filename ?? 'clip'}${clip.speed !== 1 ? ` (${clip.speed}x)` : ''}\n${formatTimestamp(clip.startTime)} → ${formatTimestamp(clip.startTime + clip.duration)}\n拖曳左右邊緣可裁切；右鍵（或 Shift+F10）可分割/刪除/調速`}>
                                                    <canvas data-clip-id={clip.id} className="waveform-canvas"
                                                        style={{ width: `${waveFullW}px`, transform: `translateX(${waveTx}px)` }} />
                                                    <span className="clip-text clip-text-over-waveform">{media?.filename ?? ''}</span>
                                                    {clip.speed !== 1 && <span style={{ position: 'absolute', right: 4, top: 2, fontSize: 10, color: 'var(--accent-amber)', fontWeight: 700 }}>{clip.speed}x</span>}
                                                    {/* 左右裁切拉桿 */}
                                                    <div className="clip-trim-handle clip-trim-left"
                                                        onMouseDown={(e) => handleClipTrim(e, clip.id, 'left')}
                                                        title="拖曳裁切開頭" />
                                                    <div className="clip-trim-handle clip-trim-right"
                                                        onMouseDown={(e) => handleClipTrim(e, clip.id, 'right')}
                                                        title="拖曳裁切結尾" />
                                                </div>
                                            );
                                        })}
                                        {timelineClips.length === 0 && (
                                            <div className="track-drop-hint">從左側媒體庫把影片拖到這裡</div>
                                        )}
                                    </div>
                                </div>

                                {/* 縮放軌：區段存在素材上（來源秒數），依各片段換算到時間軸顯示 */}
                                {mediaItems.some(m => m.info.width) && (
                                    <div className="track zoom-track">
                                        <div className="track-label zoom-track-label" style={{ width: LABEL_W }}>
                                            <span><ZoomIn aria-hidden /> 縮放</span>
                                            <span className="zoom-track-actions">
                                                <button className="zoom-mini-btn" title="在播放頭加入 3 秒、2 倍的縮放（選取後 Shift+點預覽畫面設定放大位置）"
                                                    onClick={(e) => { e.stopPropagation(); addZoomAtPlayhead(); }} aria-label="在播放頭加入縮放"><Plus aria-hidden /></button>
                                                <button className="zoom-mini-btn" title="依錄影時的滑鼠點擊自動加入縮放（限 LJ Cut 錄影）" disabled={zoomBusy}
                                                    onClick={(e) => { e.stopPropagation(); void autoZoom(); }} aria-label="依滑鼠點擊自動加入縮放"><MousePointerClick aria-hidden /></button>
                                            </span>
                                        </div>
                                        <div className="track-content" style={{ width: timelineWidth }}>
                                            {timelineClips.filter(c => c.trackIndex === 0).flatMap(clip => {
                                                const media = mediaItems.find(m => m.id === clip.mediaId);
                                                return (media?.zooms ?? []).filter((z: ZoomRegion) => z.start < clip.trimEnd && z.end > clip.trimStart).map((z: ZoomRegion) => {
                                                    const a = Math.max(z.start, clip.trimStart), b = Math.min(z.end, clip.trimEnd);
                                                    const left = toTimelineTime(clip, a) * pixelsPerSecond;
                                                    const width = Math.max(((b - a) / clip.speed) * pixelsPerSecond, 3);
                                                    const selected = z.id === selectedZoomId;
                                                    return (
                                                        <div key={`${clip.id}-${z.id}`} className={`track-clip zoom-clip ${selected ? 'selected' : ''}`}
                                                            role="button" tabIndex={0} aria-pressed={selected} aria-label={`縮放 ${z.scale} 倍`}
                                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).click(); } }}
                                                            style={{ left, width }}
                                                            onClick={(e) => { e.stopPropagation(); selectZoom(z.id); seekTo(toTimelineTime(clip, Math.min(b - 0.01, (z.start + z.end) / 2))); }}
                                                            title={`放大 ${z.scale}x　中心 (${z.x}, ${z.y})\n${formatTimestamp(z.start)} → ${formatTimestamp(z.end)}（原始影片時間）\n點一下在右欄編輯屬性`}>
                                                            <span className="clip-text">{z.scale}x</span>
                                                        </div>
                                                    );
                                                });
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* 標註軌：可多層重疊，重疊時自動分行顯示（後加的在上層） */}
                                {mediaItems.some(m => m.info.width) && (() => {
                                    const blocks = timelineClips.filter(c => c.trackIndex === 0).flatMap(clip => {
                                        const media = mediaItems.find(m => m.id === clip.mediaId);
                                        return (media?.overlays ?? []).filter((o: Overlay) => o.start < clip.trimEnd && o.end > clip.trimStart).map((o: Overlay) => {
                                            const a = Math.max(o.start, clip.trimStart), b = Math.min(o.end, clip.trimEnd);
                                            return { o, clip, a, b, left: toTimelineTime(clip, a) * pixelsPerSecond,
                                                width: Math.max(((b - a) / clip.speed) * pixelsPerSecond, 3) };
                                        });
                                    }).sort((p, q) => p.left - q.left);
                                    const rowEnds: number[] = [];
                                    const placed = blocks.map(blk => {
                                        let row = rowEnds.findIndex(end => end <= blk.left + 0.5);
                                        if (row < 0) { row = rowEnds.length; rowEnds.push(0); }
                                        rowEnds[row] = blk.left + blk.width;
                                        return { ...blk, row };
                                    });
                                    const rows = Math.max(1, rowEnds.length);
                                    const icon: Record<string, React.ReactNode> = { box: <Square aria-hidden />, arrow: <ArrowUpRight aria-hidden />, spotlight: <Focus aria-hidden />,
                                        step: <ListOrdered aria-hidden />, title: <Type aria-hidden />, html: <Code aria-hidden />, media: <ImageIcon aria-hidden /> };
                                    return (
                                        <div className="track overlay-track" style={{ height: Math.max(40, rows * 28 + 8) }}>
                                            <div className="track-label zoom-track-label" style={{ width: LABEL_W }}>
                                                <span><PenLine aria-hidden /> 標註</span>
                                                <input ref={assetInputRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/bmp,video/*,.gif"
                                                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addMediaFromFile(f); }} />
                                                <span className="add-menu-wrap">
                                                    <button className="zoom-mini-btn" aria-haspopup="menu" aria-expanded={overlayMenuOpen}
                                                        aria-label="在播放頭加入標註" title="在播放頭加入 3 秒的標註"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                            setOverlayMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 4 });
                                                            setOverlayMenuOpen(o => !o);
                                                        }}><Plus aria-hidden /></button>
                                                    {overlayMenuOpen && (
                                                        <div className="add-menu" role="menu" aria-label="加入標註" style={overlayMenuPos}
                                                            ref={overlayMenuRef}
                                                            onKeyDown={(e) => {
                                                                const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
                                                                const i = items.indexOf(document.activeElement as HTMLElement);
                                                                if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
                                                                else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
                                                                else if (e.key === 'Escape' || e.key === 'Tab') { e.stopPropagation(); setOverlayMenuOpen(false); }
                                                            }}>
                                                            {[...TEMPLATE_KINDS, 'media' as OverlayKind].map(k => (
                                                                <button key={k} role="menuitem" className="add-menu-item"
                                                                    onClick={(e) => { e.stopPropagation(); setOverlayMenuOpen(false); addOverlayAtPlayhead(k); }}>
                                                                    {k === 'media' ? '圖片／影片（子母畫面）…' : OVERLAY_LABEL[k]}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </span>
                                            </div>
                                            <div className="track-content" style={{ width: timelineWidth }}>
                                                {placed.map(({ o, clip, a, b, left, width, row }) => {
                                                    const selected = o.id === selectedOverlayId;
                                                    return (
                                                        <div key={`${clip.id}-${o.id}`} className={`track-clip overlay-clip kind-${o.kind} ${selected ? 'selected' : ''}`}
                                                            role="button" tabIndex={0} aria-pressed={selected} aria-label={`${OVERLAY_LABEL[o.kind]}${o.text ? `：${o.text}` : ''}`}
                                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).click(); } }}
                                                            style={{ left, width, top: 4 + row * 28, height: 24 }}
                                                            onClick={(e) => { e.stopPropagation(); selectOverlay(o.id); seekTo(toTimelineTime(clip, Math.min(b - 0.01, a + Math.min(0.6, (b - a) / 2)))); }}
                                                            title={`${OVERLAY_LABEL[o.kind]}${o.text ? `：${o.text}` : ''}\n${formatTimestamp(o.start)} → ${formatTimestamp(o.end)}（原始影片時間）\n點一下在右欄編輯屬性`}>
                                                            <span className="clip-text">{icon[o.kind]}{width >= 56 || selected ? ` ${o.text ?? OVERLAY_LABEL[o.kind]}` : null}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* 字幕軌 */}
                                <div className="track track-subtitle">
                                    <div className="track-label" style={{ width: LABEL_W }}><Captions aria-hidden />&nbsp;字幕</div>
                                    <div className="track-content" style={{ width: timelineWidth }}>
                                        {timelineClips.filter(c => c.trackIndex === 0 && c.segments.length > 0).map(clip =>
                                            clippedSegments(clip.segments, clip.trimStart, clip.trimEnd).map((seg) => {
                                                const left = toTimelineTime(clip, seg.start) * pixelsPerSecond;
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
                                                            seekTo((seg.start - clip.trimStart) / clip.speed + clip.startTime);
                                                        }}
                                                        title={`${formatTimestamp(seg.start)} → ${formatTimestamp(seg.end)}\n${seg.text}`}
                                                    >
                                                        <div className="cue-handle cue-handle-left"
                                                            onMouseDown={(e) => handleCueEdgeDrag(e, clip.id, seg.id, 'left')} />
                                                        <span className="clip-text">{seg.text}</span>
                                                        <div className="cue-handle cue-handle-right"
                                                            onMouseDown={(e) => handleCueEdgeDrag(e, clip.id, seg.id, 'right')} />
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
                                        onContextMenu={(e) => {
                                            // 右鍵點在播放線上 → 直接對「播放線下的片段」開分割選單
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const t = timelinePosRef.current;
                                            const clip = timelineClips.find(c => c.trackIndex === 0 && t >= c.startTime && t < c.startTime + c.duration);
                                            if (clip) {
                                                speedUndoPushedRef.current = false;
                                                setSpeedMenu({ clipId: clip.id, x: e.clientX, y: e.clientY, splitTime: t });
                                            }
                                        }}
                                    />
                                )}

                                {/* 吸附指示線 */}
                                {snapTime !== null && duration > 0 && (
                                    <div className="snap-line"
                                        style={{ left: snapTime * pixelsPerSecond + LABEL_W }} />
                                )}
                                </div>
                            </div>
                        </div>
                    )}
                </main>

                {/* 右側 Resize Handle */}
                <div className="resize-handle-v" onMouseDown={(e) => startResize('right', e)} />

                {/* 右側：字幕 */}
                <aside className="panel-right" style={{ width: rightWidth }} aria-label="字幕校對與屬性">
                    {(selectedOverlay || selectedZoom) && (
                        <OverlayInspector
                            key={selectedOverlay?.overlay.id ?? selectedZoom?.zoom.id}
                            media={(selectedOverlay ?? selectedZoom)!.media}
                            overlay={selectedOverlay?.overlay}
                            zoom={selectedOverlay ? undefined : selectedZoom?.zoom}
                            clips={timelineClips}
                            onOps={runZoomOps}
                            onClose={() => { setSelectedOverlayId(null); setSelectedZoomId(null); }}
                        />
                    )}
                    <div className="subtitle-header">
                        <h2>字幕</h2>
                        {segments.length > 0 && (
                            <span style={{ fontSize: 12, color: 'var(--fg-subtext0)' }}>{segments.length} 句</span>
                        )}
                    </div>
                    {segments.length > 0 && (
                        <div className="subtitle-toolbar">
                            <div className="st-row">
                                <button className="btn st-btn" onClick={handlePolishSubtitles} disabled={isPolishing || isTranscribing}
                                    title="AI 修錯字、去贅字、補標點（時間碼不變、Ctrl+Z 可復原）"><Sparkles aria-hidden />{isPolishing ? '潤飾中' : '潤飾'}</button>
                                <button className="btn st-btn" onClick={handleScanTypos} disabled={isScanningTypos}
                                    title="AI 掃描重複出現的可疑錯字，一鍵全部取代"><SpellCheck aria-hidden />{isScanningTypos ? '掃描中' : '掃錯字'}</button>
                                <button className="btn st-btn" onClick={handleScanFlow} disabled={isScanningFlow}
                                    title="AI 找出語意不通順的句子，點擊定位手動修改"><Brain aria-hidden />{isScanningFlow ? '掃描中' : '掃語意'}</button>
                                <button className={`btn st-btn ${showReplace ? 'on' : ''}`} aria-expanded={showReplace} onClick={() => setShowReplace(v => !v)}
                                    title="整條時間軸尋找並取代文字"><Replace aria-hidden />取代</button>
                            </div>
                            {(isPolishing || isScanningTypos || isScanningFlow) &&
                                <div className="progress-bar"><div className="fill loading" style={{ width: '100%' }} /></div>}
                            {showReplace && <div className="st-row">
                                <input value={typoFrom} onChange={e => setTypoFrom(e.target.value)} placeholder="錯字" aria-label="要取代的錯字" className="st-input" />
                                <span style={{ color: 'var(--fg-subtext0)', flexShrink: 0 }}>→</span>
                                <input value={typoTo} onChange={e => setTypoTo(e.target.value)} placeholder="正字" aria-label="取代成的正確文字" className="st-input" />
                                <button className="btn st-btn" disabled={!typoFrom} onClick={handleReplaceAll}
                                    title="整條時間軸所有出現處一次取代（Ctrl+Z 可復原）">全部取代</button>
                            </div>}
                            <details className="st-more">
                                <summary>複製、匯出 SRT 與重新分段</summary>
                                <div className="st-row">
                                    <button className="btn st-btn" onClick={() => handleCopySubtitles('text')} title="複製全部字幕文字（不含時間碼，貼給 AI 潤稿用）">
                                        {copyMsg === 'text' ? <><Check aria-hidden />已複製</> : <><Copy aria-hidden />全文</>}</button>
                                    <button className="btn st-btn" onClick={() => handleCopySubtitles('srt')} title="複製完整 SRT 內容（含時間碼）">
                                        {copyMsg === 'srt' ? <><Check aria-hidden />已複製</> : <><Copy aria-hidden />SRT</>}</button>
                                    <button className="btn st-btn" onClick={handleExportSrt} title="匯出 SRT 檔案到資料夾"><Download aria-hidden />SRT 檔</button>
                                </div>
                                <div className="st-row st-split">
                                    <label className="st-label" htmlFor="max-chars-per-cue">每段上限</label>
                                    <input id="max-chars-per-cue" type="number" min={5} max={50} value={subtitleStyle.maxCharsPerCue}
                                        onChange={e => setSubtitleStyle({ maxCharsPerCue: Number(e.target.value) })} />
                                    <span className="st-label">字</span>
                                    <button className="btn st-btn" onClick={handleResplit} title="依上限重新分段（可復原）">重新分段</button>
                                </div>
                            </details>
                            {typoSuggestions.length > 0 && (
                                <div className="st-list">
                                    <div className="st-list-head"><span>可疑錯字 {typoSuggestions.length} 組</span>
                                        <button className="btn btn-sm" onClick={() => { setTypoSuggestions([]); setTypoMsg(''); }}>清除</button></div>
                                    {typoSuggestions.map((t, i) => (
                                        <div key={`${t.wrong}-${i}`} className="st-item">
                                            <span className="st-item-text" title={`「${t.wrong}」→「${t.correct}」（出現 ${t.count} 處）`}>
                                                「{t.wrong}」→「{t.correct}」<span style={{ color: 'var(--fg-subtext0)' }}>({t.count})</span>
                                            </span>
                                            <button className="btn st-btn" onClick={() => handleApplySuggestion(i)}>取代</button>
                                        </div>
                                    ))}
                                    <button className="btn btn-primary st-btn" style={{ justifyContent: 'center' }}
                                        onClick={handleApplyAllSuggestions}><CheckCheck aria-hidden />全部套用（{typoSuggestions.length} 組）</button>
                                </div>
                            )}
                            {typoMsg && <StatusText className="st-msg" text={typoMsg} />}
                            {flowIssues.length > 0 && (
                                <div className="st-list" style={{ maxHeight: 170, overflowY: 'auto' }}>
                                    <div className="st-list-head"><span>語意不順 {flowIssues.length} 句（點一下跳過去）</span>
                                        <button className="btn btn-sm" onClick={() => { setFlowIssues([]); setFlowMsg(''); }}>清除</button></div>
                                    {flowIssues.map((it, i) => (
                                        <div key={`${it.clipId}-${it.segId}-${i}`} className="st-item st-flow"
                                            onClick={() => handleLocateIssue(it)} title="點擊定位到此字幕（清單捲過去、播放頭跳到該句）">
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div className="st-item-text">{it.text}</div>
                                                <div style={{ fontSize: 12, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 4 }}><TriangleAlert aria-hidden style={{ width: 12, height: 12 }} />{it.reason} · {formatTimestamp(it.tl)}</div>
                                            </div>
                                            <button className="btn st-btn" onClick={(e) => { e.stopPropagation(); setFlowIssues(l => l.filter((_, j) => j !== i)); }}
                                                title="已處理，從清單移除" aria-label="已處理，從清單移除"><Check aria-hidden /></button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {flowMsg && <StatusText className="st-msg" text={flowMsg} />}
                        </div>
                    )}
                    <div className="subtitle-list" ref={subtitleListRef} role="list" aria-label="字幕清單">
                        {segments.length === 0 ? (
                            <div className="empty-state">
                                <p>尚無字幕</p>
                                <p style={{ fontSize: 12 }}>匯入影片後，到左側「辨識」頁籤按「開始辨識」</p>
                            </div>
                        ) : (
                            <>
                                {segments.map((seg) => (
                                    <div key={seg.id}
                                        data-seg-id={seg.id}
                                        className={`subtitle-item ${seg.id === activeSegmentId ? 'active' : ''} ${selectedSegIds.has(seg.id) ? 'selected' : ''}`}
                                        role="listitem" tabIndex={seg.id === activeSegmentId || (activeSegmentId == null && seg === segments[0]) ? 0 : -1}
                                        aria-current={seg.id === activeSegmentId ? 'true' : undefined}
                                        aria-label={`第 ${seg.id + 1} 句，${formatTimestamp(seg.start)}：${seg.text}`}
                                        onKeyDown={(e) => {
                                            if (e.target !== e.currentTarget) return;          // 編輯中的文字框不攔截
                                            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                                e.preventDefault();
                                                const sib = (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
                                                if (sib?.classList.contains('subtitle-item')) sib.focus();
                                            } else if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleSubtitleItemClick(seg.id, e as unknown as React.MouseEvent);
                                            }
                                        }}
                                        onClick={(e) => handleSubtitleItemClick(seg.id, e)}>
                                        <div className="index">{seg.id + 1}</div>
                                        <div className="content">
                                            <div className="time-range">
                                                {formatTimestamp(seg.start)} → {formatTimestamp(seg.end)}
                                            </div>
                                            {seg.id === activeSegmentId && !selectedSegIds.has(seg.id) ? (
                                                <textarea value={seg.text} aria-label={`第 ${seg.id + 1} 句字幕文字`} aria-describedby="sub-edit-hint"
                                                    onFocus={pushUndo}
                                                    onChange={(e) => updateSegment(seg.id, { text: e.target.value })}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' && !e.shiftKey) {
                                                            e.preventDefault();
                                                            const pos = (e.target as HTMLTextAreaElement).selectionStart;
                                                            handleSplitCue(seg.id, pos);
                                                        }
                                                    }}
                                                    onClick={(e) => e.stopPropagation()} rows={2} />
                                            ) : null}
                                            {seg.id === activeSegmentId && !selectedSegIds.has(seg.id) ? (
                                                <div className="sub-edit-row">
                                                    <div className="sub-edit-hint" id="sub-edit-hint">Enter 分成兩句 · Ctrl＋點其他句可多選</div>
                                                    <button className="btn btn-sm btn-danger-soft" onClick={(e) => { e.stopPropagation(); handleCutSegments(new Set([seg.id])); }}
                                                        title="把這一句對應的影片剪掉（Ctrl+Z 可復原）"><Scissors aria-hidden />剪掉這句</button>
                                                </div>
                                            ) : (
                                                <div className="text">{seg.text}</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {/* 懸浮合併按鈕 */}
                                {selectedSegIds.size > 0 && (() => {
                                    const maxId = Math.max(...Array.from(selectedSegIds));
                                    const anchorEl = subtitleListRef.current?.querySelector(`[data-seg-id="${maxId}"]`) as HTMLElement | null;
                                    const listEl = subtitleListRef.current;
                                    if (!anchorEl || !listEl) return null;
                                    const anchorRect = anchorEl.getBoundingClientRect();
                                    const listRect = listEl.getBoundingClientRect();
                                    const top = anchorRect.bottom - listRect.top + listEl.scrollTop + 4;
                                    return (
                                        <div className="merge-float-btn" style={{ top }} role="toolbar" aria-label="選取的字幕">
                                            {canMergeSelected && <button className="btn" onClick={handleMergeSelected}>合併 {mergeIds.size} 句</button>}
                                            <button className="btn btn-danger-soft" onClick={() => handleCutSegments(mergeIds)}
                                                title="把這幾句對應的影片剪掉（Ctrl+Z 可復原）"><Scissors aria-hidden />剪掉這 {mergeIds.size} 句</button>
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

    // ── 在播放點分割片段 ──
    const handleSplitClip = useCallback((clipId: string, T: number) => {
        const clip = timelineClips.find(c => c.id === clipId);
        if (!clip) return;
        const eps = 0.001;
        if (T <= clip.startTime + eps || T >= clip.startTime + clip.duration - eps) {
            notify('請在片段中間的位置按右鍵再分割');
            return;
        }
        // 時間軸時間 → 媒體時間（segments 的 start/end 為媒體時間）
        const [left, right] = splitClip(clip, toSourceTime(clip, T), crypto.randomUUID());
        pushUndo();
        // 左段：縮到切點
        updateClip(clip.id, left);
        // 右段：新片段（共用同一 mediaId）
        addClip(right);
        setSpeedMenu(null);
    }, [timelineClips, updateClip, addClip, pushUndo]);

    // ── 倍速右鍵選單 portal（放在最外層避免被截斷） ──
    const speedMenuClip = speedMenu ? timelineClips.find(c => c.id === speedMenu.clipId) : null;
    // 右鍵點到的位置是否落在該片段中間（決定「分割」可否點）
    const splitT = speedMenu?.splitTime ?? -1;
    const canSplitMenuClip = !!speedMenuClip
        && splitT > speedMenuClip.startTime + 0.001
        && splitT < speedMenuClip.startTime + speedMenuClip.duration - 0.001;

    const exportDialogRef = useRef<HTMLDivElement>(null);
    useDialog(exportDialogRef, showExportModal);

    // ── 剪輯快捷鍵（Esc 在輸入框內也有效；其餘在輸入框內不攔截）──
    //   S 在播放頭分割｜Delete 刪除選取的標註／縮放／片段（可 Ctrl+Z 復原）｜←/→ 逐格、Shift+←/→ 1 秒
    //   J 倒退 5 秒｜K 暫停｜L 播放｜Home/End 跳到頭尾｜Ctrl+＋/－ 縮放時間軸｜Esc 關閉對話框與選單、取消選取
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement;
            if (e.key === 'Escape') {
                if (speedMenu) { setSpeedMenu(null); return; }
                if (showExportModal) { setShowExportModal(false); return; }
                if (showYtUpload) return;   // 由上傳對話框自己處理（上傳中不能關）
                if (showHelp) { setShowHelp(false); return; }
                if (showSettings) { setShowSettings(false); return; }
                if (showRecSettings) { setShowRecSettings(false); return; }
                if (selectedOverlayId || selectedZoomId) { setSelectedOverlayId(null); setSelectedZoomId(null); }
                return;
            }
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return;
            if (showExportModal || showYtUpload || showSettings || showRecSettings || showHelp) return;
            if (e.key === '?') { e.preventDefault(); setShowHelp(true); return; }
            if (el.closest?.('[role="tablist"], .subtitle-list, .speed-menu, .project-file, .add-menu, .ai-status-wrap')) return;   // 這些區塊自己處理方向鍵
            const t = timelinePosRef.current;
            if (e.ctrlKey || e.metaKey) {
                if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(z => Math.min(z * 1.25, 50)); }
                else if (e.key === '-') { e.preventDefault(); setZoom(z => Math.max(z * 0.8, 0.1)); }
                return;
            }
            if (e.altKey) return;
            const fps = 30;
            switch (e.key) {
                case 's': case 'S': {
                    const clip = timelineClips.find(c => c.trackIndex === 0 && t > c.startTime && t < c.startTime + c.duration);
                    if (clip) { e.preventDefault(); handleSplitClip(clip.id, t); }
                    return;
                }
                case 'Delete': case 'Backspace': {
                    if (selectedOverlayId) { e.preventDefault(); if (runZoomOps([{ type: 'delete_overlay', overlayId: selectedOverlayId }])) { setSelectedOverlayId(null); toast('info', '已刪除標註', [{ label: '復原', run: handleUndo }], { key: 'history' }); } }
                    else if (selectedZoomId) { e.preventDefault(); if (runZoomOps([{ type: 'delete_zoom', zoomId: selectedZoomId }])) { setSelectedZoomId(null); toast('info', '已刪除縮放', [{ label: '復原', run: handleUndo }], { key: 'history' }); } }
                    else if (e.key === 'Delete' && activeClipId && el.closest?.('.video-clip')) {
                        e.preventDefault(); handleClipDelete(activeClipId); toast('info', '已刪除片段', [{ label: '復原', run: handleUndo }], { key: 'history' });
                    }
                    return;
                }
                case 'ArrowLeft': case 'ArrowRight': {
                    e.preventDefault();
                    const step = (e.shiftKey ? 1 : 1 / fps) * (e.key === 'ArrowLeft' ? -1 : 1);
                    seekTo(Math.max(0, Math.min(duration, t + step)));
                    return;
                }
                case 'j': case 'J': e.preventDefault(); seekTo(Math.max(0, t - 5)); return;
                case 'k': case 'K': e.preventDefault(); if (isPlaying) togglePlay(); return;
                case 'l': case 'L': e.preventDefault(); if (!isPlaying) togglePlay(); return;
                case 'Home': e.preventDefault(); seekTo(0); return;
                case 'End': e.preventDefault(); seekTo(duration); return;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [speedMenu, showExportModal, showYtUpload, showSettings, showRecSettings, showHelp, selectedOverlayId, selectedZoomId,
        activeClipId, timelineClips, duration, isPlaying, handleSplitClip, handleClipDelete, runZoomOps, seekTo, togglePlay]);

    return (
        <>
            {mainJsx}
            <Toaster />
            {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
            {speedMenu && speedMenuClip && (
                <SpeedMenu
                    clip={speedMenuClip}
                    x={speedMenu.x}
                    y={speedMenu.y}
                    canSplit={canSplitMenuClip}
                    splitTime={splitT}
                    onSplit={() => handleSplitClip(speedMenuClip.id, splitT)}
                    onDelete={() => { handleClipDelete(speedMenuClip.id); toast('info', '已刪除片段', [{ label: '復原', run: handleUndo }], { key: 'history' }); }}
                    onSetSpeed={(id, sp) => {
                        if (!speedUndoPushedRef.current) { speedUndoPushedRef.current = true; pushUndo(); }
                        setClipSpeed(id, sp);
                    }}
                    onClose={() => setSpeedMenu(null)}
                />
            )}
            {backendBooting && (
                <div className="boot-splash">
                    <div className="boot-splash-logo">LJCUT</div>
                    <div className="progress-bar" style={{ width: 220 }}>
                        <div className="fill loading" style={{ width: '100%' }} />
                    </div>
                    <div className="boot-splash-text">正在啟動後端服務…</div>
                    <div className="boot-splash-hint">首次啟動需要載入 AI 模型，可能需要 30 秒～1 分鐘</div>
                </div>
            )}

            {exportProgress >= 0 && <ExportProgress progress={exportProgress} etaSeconds={exportEta} stage={exportStage} onCancel={() => { void api.cancelExport(); }} />}
            {exportDone && <ExportProgress progress={100} done={{
                path: exportDone, duration: formatTime(duration),
                subs: timelineClips.reduce((n, c) => n + (c.trackIndex === 0 ? c.segments.length : 0), 0), burned: burnSubs,
            }} onClose={() => setExportDone(null)}
                onOpenFolder={async () => {
                    try {
                        const { open } = await import('@tauri-apps/plugin-shell');
                        await open(exportDone.replace(/[\\/][^\\/]+$/, ''));
                    } catch (e) { notify(`開啟資料夾失敗：${e}`); }
                }}
                onUpload={() => { setExportDone(null); setShowYtUpload(true); }} />}

            {/* 匯出影片設定彈窗 */}
            {showExportModal && (
                <div className="modal-overlay" onClick={() => setShowExportModal(false)}>
                    <div className="modal-box" ref={exportDialogRef} role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={e => e.stopPropagation()} style={{ maxWidth: 430 }}>
                        <div className="modal-header">
                            <h2 id="export-title">匯出影片</h2>
                            <button className="btn" onClick={() => setShowExportModal(false)} style={{ padding: '4px 6px' }} aria-label="關閉" title="關閉（Esc）"><X aria-hidden /></button>
                        </div>
                        <div className="style-row" title="關閉＝匯出乾淨畫面（推薦：YouTube 觀眾用 CC 字幕，之後改錯字免重傳影片）；開啟＝字幕燒進畫面">
                            <label htmlFor="export-burn">燒入字幕到畫面</label>
                            <label className="toggle-switch">
                                <input id="export-burn" type="checkbox" checked={burnSubs} onChange={e => setBurnSubs(e.target.checked)} />
                                <span className="toggle-slider" />
                            </label>
                        </div>
                        {(() => {
                            const main = timelineClips.filter(c => c.trackIndex === 0);
                            const subs = main.reduce((n, c) => n + c.segments.length, 0);
                            const intro = main.some(c => c.bookend === 'intro'), outro = main.some(c => c.bookend === 'outro');
                            const mediaIds = new Set(main.map(c => c.mediaId));
                            const used = mediaItems.filter(m => mediaIds.has(m.id));
                            const zooms = used.reduce((n, m) => n + (m.zooms?.length ?? 0), 0);
                            const overlays = used.reduce((n, m) => n + (m.overlays?.length ?? 0), 0);
                            return (
                                <dl className="export-summary">
                                    <dt>成品長度</dt><dd>{formatTime(duration)}</dd>
                                    <dt>片頭／片尾</dt><dd>{intro ? '有' : '無'}／{outro ? '有' : '無'}
                                        {controlWorkspace && (!intro || !outro) && <button type="button" className="link-btn" onClick={() => {
                                            setShowExportModal(false); setLeftTab('media');
                                            setTimeout(() => document.getElementById('bookend-section')?.scrollIntoView({ block: 'center' }), 50);
                                        }}>到左側設定</button>}</dd>
                                    <dt>字幕</dt><dd>{subs} 句{subs === 0 ? '（上傳時不會有 CC）' : ''}</dd>
                                    <dt>縮放／標註</dt><dd>{zooms} 段／{overlays} 個</dd>
                                    <dt>存檔位置</dt><dd>{settings.outputDir ? `${settings.outputDir}（開始後可改）` : '按「開始匯出」後選擇'}</dd>
                                </dl>
                            );
                        })()}
                        {!burnSubs && (
                            <div style={{ fontSize: 12, color: 'var(--accent-green)', padding: '2px 0 6px' }}>
                                乾淨畫面匯出：上傳 YouTube 時會自動掛 SRT 字幕（CC）
                            </div>
                        )}
                        {burnSubs && (
                            <>
                                <div className="style-row">
                                    <label htmlFor="burn-font">字形</label>
                                    <select id="burn-font" value={subtitleStyle.fontName}
                                        onChange={e => setSubtitleStyle({ fontName: e.target.value })}>
                                        <option value="Microsoft JhengHei">微軟正黑體</option>
                                        <option value="DFKai-SB">標楷體</option>
                                        <option value="Microsoft YaHei">微軟雅黑</option>
                                        <option value="Noto Sans TC">Noto Sans TC</option>
                                        <option value="Arial">Arial</option>
                                    </select>
                                </div>
                                <div className="style-row">
                                    <label htmlFor="burn-size">字體大小</label>
                                    <input id="burn-size" type="number" min={8} max={72} value={subtitleStyle.fontSize}
                                        onChange={e => setSubtitleStyle({ fontSize: Number(e.target.value) })} />
                                </div>
                                <div className="style-row">
                                    <label htmlFor="burn-outline">外框粗細</label>
                                    <input id="burn-outline" type="number" min={0} max={5} value={subtitleStyle.outlineWidth}
                                        onChange={e => setSubtitleStyle({ outlineWidth: Number(e.target.value) })} />
                                </div>
                                <div className="style-row">
                                    <label htmlFor="burn-bg">文字背景</label>
                                    <label className="toggle-switch">
                                        <input id="burn-bg" type="checkbox" checked={subtitleStyle.bgEnabled}
                                            onChange={e => setSubtitleStyle({ bgEnabled: e.target.checked })} />
                                        <span className="toggle-slider" />
                                    </label>
                                </div>
                                {subtitleStyle.bgEnabled && (
                                    <div className="style-row">
                                        <label htmlFor="burn-opacity">透明度</label>
                                        <input id="burn-opacity" type="range" min={0} max={100} value={subtitleStyle.bgOpacity}
                                            onChange={e => setSubtitleStyle({ bgOpacity: Number(e.target.value) })} />
                                        <span className="opacity-val">{subtitleStyle.bgOpacity}%</span>
                                    </div>
                                )}
                            </>
                        )}
                        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
                            onClick={() => { setShowExportModal(false); handleExportVideo(); }}>
                            <Clapperboard aria-hidden />開始匯出
                        </button>
                    </div>
                </div>
            )}

            {showYtUpload && lastExport && (
                <YouTubeUploadModal
                    videoPath={lastExport}
                    stale={exportStale}
                    projectSubtitleCount={timelineClips.filter(c => c.trackIndex === 0).reduce((n, c) => n + c.segments.length, 0)}
                    onReexport={() => { setShowYtUpload(false); setShowExportModal(true); }}
                    publicationId={publicationId}
                    defaultTitle={(primaryMedia?.filename || 'LJCUT 影片').replace(/\.[^.]+$/, '')}
                    defaultDescription={''}
                    thumbnailTime={currentTime}
                    onClose={() => setShowYtUpload(false)}
                />
            )}
        </>
    );
}
