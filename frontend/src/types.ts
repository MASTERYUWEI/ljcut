/* ── LJCUT 類型定義 ── */

export interface Segment {
    id: number;
    start: number;
    end: number;
    text: string;
    words?: WordInfo[];
}

export interface WordInfo {
    word: string;
    start: number;
    end: number;
    probability: number;
}

export interface MediaInfo {
    duration: number;
    size_mb: number;
    width?: number;
    height?: number;
    fps?: number;
    video_codec?: string;
    audio_codec?: string;
    sample_rate?: number;
}

// ── 媒體庫項目 ──
export interface MediaItem {
    id: string;             // fileId（後端回傳）
    filename: string;
    url: string;
    info: MediaInfo;
    waveformPeaks: number[];
    thumbnailUrl?: string;  // 影片首幀縮圖
}

// ── 時間軸 Clip ──
export interface TimelineClip {
    id: string;             // 唯一 ID（uuid）
    mediaId: string;        // 對應 MediaItem.id
    trackIndex: number;     // 0=影片軌, 1=字幕軌（保留）
    startTime: number;      // 在時間軸上的起始位置（秒）
    duration: number;       // clip 長度（秒）= (trimEnd - trimStart) / speed
    trimStart: number;      // 媒體內裁切起始（預設 0）
    trimEnd: number;        // 媒體內裁切結束（預設 = 媒體 duration）
    speed: number;          // 播放倍速 1.0 ~ 5.0，預設 1.0
    segments: Segment[];    // 該 clip 專屬字幕（時間相對於媒體本身）
}

export interface UploadResult {
    file_id: string;
    filename: string;
    path: string;
    url: string;
    info: MediaInfo;
}

export interface TranscribeResult {
    language: string;
    language_probability: number;
    duration: number;
    segments: Segment[];
}

// ── 設定 / 錄影選項 ──
export interface AppSettings {
    outputDir: string;
    srtDir: string;
}

export type RecQuality = '720p' | '1080p' | '4k';
export type RecFps = 24 | 30 | 60;

export interface RecOpts {
    sysAudio: boolean;
    mic: boolean;
    quality: RecQuality;
    fps: RecFps;
    micDevice: string;
    sysAudioDevice: string;
    micVol: number;
    sysVol: number;
    cursorGlow: boolean;
    clickEffect: boolean;
}

export interface MicDevice {
    deviceId: string;
    label: string;
}
