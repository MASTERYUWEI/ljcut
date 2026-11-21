/* ── 配音修正 API（後端 services/voice_review.py）── */
import { getBase } from './api';

export type VoiceStatus = 'pending' | 'ok' | 'bad';
export interface VoiceItem {
    id: string;
    seg: string;
    text: string;
    ai: string;
    status: VoiceStatus;
    note?: string;
    take?: string | null;
    take_seconds?: number;
    ai_seconds?: number;
}
export interface VoiceCounts { total: number; ok: number; bad: number; recorded: number }
export interface VoiceSessionInfo extends VoiceCounts { name: string; title: string }
export interface VoiceSession { title: string; model?: string; items: VoiceItem[]; counts: VoiceCounts }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${getBase()}/api/voice${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
    return body as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const voiceApi = {
    sessions: () => call<{ root: string; sessions: VoiceSessionInfo[] }>('/sessions'),
    session: (s: string) => call<VoiceSession>(`/session/${enc(s)}`),
    devices: () => call<{ devices: string[]; error?: string }>('/devices'),
    mark: (s: string, id: string, status: VoiceStatus, note?: string) =>
        call<{ item: VoiceItem; counts: VoiceCounts }>(`/mark/${enc(s)}/${enc(id)}`, post(note === undefined ? { status } : { status, note })),
    recordStart: (s: string, id: string, device: string) => call<{ recording: boolean }>(`/record/start/${enc(s)}/${enc(id)}`, post({ device })),
    recordStop: (discard = false) => call<{ saved: boolean; item?: VoiceItem; counts?: VoiceCounts }>('/record/stop', post({ discard })),
    recordStatus: () => call<{ recording: boolean; session?: string; item?: string; seconds?: number }>('/record/status'),
    deleteTake: (s: string, id: string) => call<{ item: VoiceItem; counts: VoiceCounts }>(`/take/${enc(s)}/${enc(id)}`, { method: 'DELETE' }),
    /** v 用來繞過瀏覽器快取（重錄後檔名不變） */
    audioUrl: (s: string, kind: 'ai' | 'takes', id: string, v = 0) => `${getBase()}/api/voice/audio/${enc(s)}/${kind}/${enc(id)}?v=${v}`,
};
