/* 專案聲音設定的型別與驗證（不依賴其他模組，editCore 驗證專案時用；計算在 audioMix.ts）。 */
export type LoudnessPreset = 'off' | 'youtube' | 'teaching';
export const LOUDNESS_LABEL: Record<LoudnessPreset, string> = { off: '不調整（保持原音量）', youtube: 'YouTube（−14 LUFS）', teaching: '教學／旁白（−16 LUFS）' };

export interface MusicAsset { id: string; filename: string; url: string; duration: number }
export interface MusicTrack {
    asset: MusicAsset;
    /** 線性音量 0–2（預設 0.25，配樂墊底） */
    volume: number;
    /** 配樂從第幾秒開始播 */
    offset: number;
    loop: boolean;
    fadeIn: number;
    fadeOut: number;
    /** 有旁白（字幕）時自動壓低 */
    duck: boolean;
    /** 壓低多少 dB（正數，例如 12） */
    duckDb: number;
    /** 壓低前預先下降、旁白結束後回升的秒數 */
    attack: number;
    release: number;
}
export interface AudioMix { loudness: LoudnessPreset; music?: MusicTrack }
/** 舊專案沒有聲音設定時：不調整（不改變以前匯出的結果） */
export const DEFAULT_MIX: AudioMix = { loudness: 'off' };
/** 新專案預設：教學／旁白 −16 LUFS */
export const NEW_PROJECT_MIX: AudioMix = { loudness: 'teaching' };
export const newMusic = (asset: MusicAsset): MusicTrack => ({ asset, volume: 0.25, offset: 0, loop: true, fadeIn: 0.5, fadeOut: 2,
    duck: true, duckDb: 12, attack: 0.25, release: 0.6 });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function checkAudioMix(m: unknown): string | null {
    if (m === undefined) return null;
    const a = m as AudioMix;
    if (!a || typeof a !== 'object' || !['off', 'youtube', 'teaching'].includes(a.loudness)) return '平台響度需為 off／youtube／teaching';
    if (a.music === undefined) return null;
    const t = a.music;
    if (!t.asset || typeof t.asset.id !== 'string' || !/^a_[0-9a-f]{12}$/.test(t.asset.id) || !finite(t.asset.duration) || t.asset.duration <= 0) return '配樂素材無效';
    if (![t.volume, t.offset, t.fadeIn, t.fadeOut, t.duckDb, t.attack, t.release].every(finite)) return '配樂數值無效';
    if (t.volume < 0 || t.volume > 2 || t.offset < 0 || t.duckDb < 0 || t.duckDb > 40 || t.attack < 0 || t.release < 0
        || t.attack > 5 || t.release > 5 || t.fadeIn < 0 || t.fadeOut < 0 || t.fadeIn > 30 || t.fadeOut > 30) return '配樂數值超出範圍';
    return null;
}

