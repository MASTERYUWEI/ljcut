/* 預覽時播放配樂：跟著時間軸播放頭走，音量用和匯出同一份壓低包絡（audioMix.ts）。
   不出現在畫面上；偏差超過 0.25 秒才重新對位，避免一直跳。 */
import { useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { duckEnvelope, musicGainAt, musicTimeAt } from '../audioMix';

export function MusicPreview() {
    const music = useStore(s => s.audioMix.music);
    const clips = useStore(s => s.timelineClips);
    const t = useStore(s => s.currentTime);
    const playing = useStore(s => s.isPlaying);
    const total = useStore(s => s.getDuration());
    const ref = useRef<HTMLAudioElement>(null);
    const env = useMemo(() => duckEnvelope(clips, music), [clips, music]);

    useEffect(() => {
        const a = ref.current;
        if (!a) return;
        const pos = music ? musicTimeAt(music, t) : null;
        if (!music || !playing || pos === null || t >= total) { if (!a.paused) a.pause(); return; }
        a.volume = Math.min(1, musicGainAt(music, env, t, total));   // 瀏覽器音量上限 1；超過 1 的增益只在匯出生效
        if (a.paused) { try { a.currentTime = pos; } catch { /* 尚未載入 */ } void a.play().catch(() => { /* 使用者尚未互動 */ }); }
        else if (Math.abs(a.currentTime - pos) > 0.25) { try { a.currentTime = pos; } catch { /* ignore */ } }
    }, [music, env, t, playing, total]);

    return music ? <audio ref={ref} src={api.mediaUrl(music.asset.url)} preload="auto" hidden /> : null;
}
