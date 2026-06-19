/* ── Zustand 狀態管理 ── */

import { create } from 'zustand';
import type { Segment, MediaItem, TimelineClip } from './types';

export interface SubtitleStyle {
    fontName: string;
    fontSize: number;
    outlineWidth: number;
    bgEnabled: boolean;
    bgOpacity: number; // 0-100
    posY: number; // 0-100 百分比，0=頂部，100=底部
    maxCharsPerCue: number; // 每段字幕最大字數
}

interface AppState {
    // 媒體庫
    mediaItems: MediaItem[];

    // 時間軸 clips
    timelineClips: TimelineClip[];

    // 當前選中的 clip
    activeClipId: string | null;

    // 字幕（向後相容 — 實際存在各 clip.segments 內）
    segments: Segment[];
    activeSegmentId: number | null;

    // 字幕樣式
    subtitleStyle: SubtitleStyle;

    // 播放
    currentTime: number;
    isPlaying: boolean;

    // 狀態
    isUploading: boolean;
    isTranscribing: boolean;
    language: string;

    // ── 衍生值 ──
    /** 時間軸總長度 = 所有 clip 的 max(startTime + duration) */
    getDuration: () => number;
    /** 取得當前選中 clip */
    getActiveClip: () => TimelineClip | null;

    // ── 媒體庫 Actions ──
    addMedia: (item: MediaItem) => void;
    removeMedia: (id: string) => void;
    updateMedia: (id: string, patch: Partial<MediaItem>) => void;

    // ── 時間軸 Clip Actions ──
    addClip: (clip: TimelineClip) => void;
    updateClip: (id: string, patch: Partial<TimelineClip>) => void;
    removeClip: (id: string) => void;
    setClipSpeed: (id: string, speed: number) => void;
    setActiveClipId: (id: string | null) => void;
    /** Undo 用：整批還原時間軸（並依 activeClipId 重新同步 segments） */
    restoreTimeline: (clips: TimelineClip[], activeClipId: string | null) => void;

    // ── Per-clip 字幕 Actions ──
    setClipSegments: (clipId: string, segments: Segment[]) => void;
    updateClipSegment: (clipId: string, segId: number, patch: Partial<Segment>) => void;

    // 字幕（向後相容包裝）
    setSegments: (segments: Segment[]) => void;
    updateSegment: (id: number, patch: Partial<Segment>) => void;
    setActiveSegment: (id: number | null) => void;
    setSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;

    // 播放
    setCurrentTime: (time: number) => void;
    setIsPlaying: (playing: boolean) => void;

    // 狀態
    setIsUploading: (uploading: boolean) => void;
    setIsTranscribing: (transcribing: boolean) => void;
    setLanguage: (lang: string) => void;
    reset: () => void;
}

const defaultStyle: SubtitleStyle = {
    fontName: 'Microsoft JhengHei',
    fontSize: 45,
    outlineWidth: 3,
    bgEnabled: true,
    bgOpacity: 35,
    posY: 90,
    maxCharsPerCue: 15,
};

const initialState = {
    mediaItems: [] as MediaItem[],
    timelineClips: [] as TimelineClip[],
    activeClipId: null as string | null,
    segments: [] as Segment[],
    activeSegmentId: null as number | null,
    subtitleStyle: { ...defaultStyle } as SubtitleStyle,
    currentTime: 0,
    isPlaying: false,
    isUploading: false,
    isTranscribing: false,
    language: 'zh',
};

export const useStore = create<AppState>((set, get) => ({
    ...initialState,

    getDuration: () => {
        const clips = get().timelineClips;
        if (clips.length === 0) return 0;
        return Math.max(...clips.map(c => c.startTime + c.duration));
    },

    getActiveClip: () => {
        const { activeClipId, timelineClips } = get();
        if (!activeClipId) return null;
        return timelineClips.find(c => c.id === activeClipId) ?? null;
    },

    // ── 媒體庫 ──
    addMedia: (item) => set((s) => {
        // 防重複：同一 file_id 不重複加入
        if (s.mediaItems.some(m => m.id === item.id)) return s;
        return { mediaItems: [...s.mediaItems, item] };
    }),
    removeMedia: (id) => set((s) => {
        const removedClipIds = new Set(s.timelineClips.filter(c => c.mediaId === id).map(c => c.id));
        const activeCleared = s.activeClipId && removedClipIds.has(s.activeClipId);
        return {
            mediaItems: s.mediaItems.filter(m => m.id !== id),
            timelineClips: s.timelineClips.filter(c => c.mediaId !== id),
            // 同步清空字幕和選中狀態
            activeClipId: activeCleared ? null : s.activeClipId,
            segments: activeCleared ? [] : s.segments,
            activeSegmentId: activeCleared ? null : s.activeSegmentId,
        };
    }),
    updateMedia: (id, patch) => set((s) => ({
        mediaItems: s.mediaItems.map(m => m.id === id ? { ...m, ...patch } : m),
    })),

    // ── 時間軸 Clips ──
    addClip: (clip) => set((s) => ({ timelineClips: [...s.timelineClips, clip] })),
    updateClip: (id, patch) => set((s) => ({
        timelineClips: s.timelineClips.map(c => c.id === id ? { ...c, ...patch } : c),
    })),
    removeClip: (id) => set((s) => ({
        timelineClips: s.timelineClips.filter(c => c.id !== id),
        // 如果刪除的是 activeClip，清空
        activeClipId: s.activeClipId === id ? null : s.activeClipId,
        // 同步清空 segments 向後相容欄位
        segments: s.activeClipId === id ? [] : s.segments,
    })),
    setClipSpeed: (id, speed) => set((s) => ({
        timelineClips: s.timelineClips.map(c => {
            if (c.id !== id) return c;
            const clampedSpeed = Math.max(1.0, Math.min(5.0, speed));
            return { ...c, speed: clampedSpeed, duration: (c.trimEnd - c.trimStart) / clampedSpeed };
        }),
    })),
    setActiveClipId: (id) => set((s) => {
        if (id === s.activeClipId) return s;
        const clip = id ? s.timelineClips.find(c => c.id === id) : null;
        return {
            activeClipId: id,
            // 同步全域 segments 向後相容
            segments: clip?.segments ?? [],
            activeSegmentId: null,
        };
    }),
    restoreTimeline: (clips, activeClipId) => set(() => {
        const active = activeClipId ? clips.find(c => c.id === activeClipId) : null;
        return {
            timelineClips: clips,
            activeClipId: active ? activeClipId : null,
            segments: active?.segments ?? [],
            activeSegmentId: null,
        };
    }),

    // ── Per-clip 字幕 ──
    setClipSegments: (clipId, segments) => set((s) => ({
        timelineClips: s.timelineClips.map(c =>
            c.id === clipId ? { ...c, segments } : c
        ),
        // 同步全域 segments
        segments: s.activeClipId === clipId ? segments : s.segments,
    })),
    updateClipSegment: (clipId, segId, patch) => set((s) => {
        const newClips = s.timelineClips.map(c => {
            if (c.id !== clipId) return c;
            return {
                ...c,
                segments: c.segments.map(seg =>
                    seg.id === segId ? { ...seg, ...patch } : seg
                ),
            };
        });
        const activeClipSegs = s.activeClipId === clipId
            ? (newClips.find(c => c.id === clipId)?.segments ?? s.segments)
            : s.segments;
        return { timelineClips: newClips, segments: activeClipSegs };
    }),

    // ── 字幕（向後相容包裝） ──
    setSegments: (segments) => set((s) => {
        // 也寫入 activeClip
        if (s.activeClipId) {
            return {
                segments,
                timelineClips: s.timelineClips.map(c =>
                    c.id === s.activeClipId ? { ...c, segments } : c
                ),
            };
        }
        return { segments };
    }),
    updateSegment: (id, patch) => set((s) => {
        const newSegments = s.segments.map(seg => seg.id === id ? { ...seg, ...patch } : seg);
        // 也更新 activeClip
        if (s.activeClipId) {
            return {
                segments: newSegments,
                timelineClips: s.timelineClips.map(c =>
                    c.id === s.activeClipId ? { ...c, segments: newSegments } : c
                ),
            };
        }
        return { segments: newSegments };
    }),
    setActiveSegment: (id) => set({ activeSegmentId: id }),
    setSubtitleStyle: (patch) => set((s) => ({ subtitleStyle: { ...s.subtitleStyle, ...patch } })),

    // ── 播放 ──
    setCurrentTime: (time) => set({ currentTime: time }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),

    // ── 狀態 ──
    setIsUploading: (uploading) => set({ isUploading: uploading }),
    setIsTranscribing: (transcribing) => set({ isTranscribing: transcribing }),
    setLanguage: (lang) => set({ language: lang }),
    reset: () => set(initialState),
}));
