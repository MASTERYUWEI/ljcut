/* 專案聲音設定：配樂（一條，鋪滿整段時間軸）、旁白時自動壓低、匯出平台響度。
   壓低包絡在這裡算一次，預覽（<audio> 音量）和匯出（後端 audio_mix.render_music）都用同一組關鍵點線性內插，
   所以預覽聽到的和成品一致。 */
import { timelineSegments } from './editCore';
import type { TimelineClip } from './types';

export * from './audioCheck';
import type { MusicTrack, AudioMix } from './audioCheck';

/** 時間軸上有旁白的區間（字幕合併，間隔 < 0.6 秒的視為同一段，避免句間一直上下抽動） */
export function speechSpans(clips: TimelineClip[], gap = 0.6): [number, number][] {
    const segs = timelineSegments(clips).map(s => [s.start, s.end] as [number, number]).sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const [s, e] of segs) {
        const last = out[out.length - 1];
        if (last && s - last[1] < gap) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

/** 壓低包絡關鍵點 [時間軸秒, dB]（遞增、可直接送後端）。不壓低時回傳 []。 */
export function duckEnvelope(clips: TimelineClip[], music: MusicTrack | undefined): [number, number][] {
    if (!music?.duck || music.duckDb <= 0) return [];
    // 間隔短於「回升＋下降」的旁白合併成一段，所以相鄰兩段的斜坡不會重疊
    const spans = speechSpans(clips, music.attack + music.release + 0.3);
    const pts: [number, number][] = [];
    const d = -music.duckDb;
    for (const [s, e] of spans) {
        const a = Math.max(0, s - music.attack), b = e + music.release;
        pts.push([a, 0], [Math.max(a, s), d], [Math.max(s, e), d], [b, 0]);
    }
    // 保證時間嚴格遞增（後端驗證）
    const clean: [number, number][] = [];
    for (const p of pts) {
        const r: [number, number] = [Math.round(p[0] * 1000) / 1000, p[1]];
        if (clean.length && r[0] <= clean[clean.length - 1][0]) r[0] = clean[clean.length - 1][0] + 0.001;
        clean.push(r);
    }
    return clean;
}

/** 包絡在時間 t 的 dB（與後端 numpy.interp 相同：頭尾外插為端點值） */
export function envelopeAt(pts: [number, number][], t: number): number {
    if (!pts.length) return 0;
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
            const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
            return x1 === x0 ? y1 : y0 + (y1 - y0) * (t - x0) / (x1 - x0);
        }
    }
    return pts[pts.length - 1][1];
}

/** 預覽：時間軸 t 時配樂該播到素材第幾秒；超過且不循環回傳 null（不出聲） */
export function musicTimeAt(m: MusicTrack, t: number): number | null {
    const pos = m.offset + t, dur = m.asset.duration;
    if (pos < dur) return pos;
    if (!m.loop) return null;
    // 和後端一致：第一輪從 offset 播到結尾，之後每輪從 0 開始
    return (pos - dur) % dur;
}

/** 預覽音量（線性）：音量 × 壓低 × 淡入淡出 */
export function musicGainAt(m: MusicTrack, env: [number, number][], t: number, total: number): number {
    let g = m.volume * Math.pow(10, envelopeAt(env, t) / 20);
    if (m.fadeIn > 0 && t < m.fadeIn) g *= t / m.fadeIn;
    const end = m.loop ? total : Math.min(total, m.asset.duration - m.offset);
    if (m.fadeOut > 0 && t > end - m.fadeOut) g *= Math.max(0, (end - t) / m.fadeOut);
    return Math.max(0, g);
}

/** 匯出 payload（前後端共用一份包絡） */
export function exportAudioMix(mix: AudioMix | undefined, clips: TimelineClip[]) {
    if (!mix || (mix.loudness === 'off' && !mix.music)) return undefined;
    return { loudness: mix.loudness, music: mix.music ? { ...mix.music, envelope: duckEnvelope(clips, mix.music) } : undefined };
}
