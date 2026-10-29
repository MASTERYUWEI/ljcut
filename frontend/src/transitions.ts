import type { TimelineClip } from './types';
export const TRANSITIONS = {
    'fade-black': { label: '淡黑', color: '#000000' },
    'fade-gray': { label: '柔灰', color: '#808080' },
    'fade-white': { label: '淡白', color: '#ffffff' },
} as const;
export type TransitionKind = keyof typeof TRANSITIONS;
/** A dip spans both sides of the cut, without overlapping/removing source time. */
export function transitionVisual(clips: TimelineClip[], time: number) {
    const ordered = [...clips].sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < ordered.length; i++) {
        const right = ordered[i], left = ordered[i - 1], t = right.transitionIn;
        if (!t || Math.abs(left.startTime + left.duration - right.startTime) > 1e-6) continue;
        const half = t.duration / 2, distance = Math.abs(time - right.startTime);
        if (distance <= half) return { color: TRANSITIONS[t.kind].color, opacity: 1 - distance / half };
    }
    return { color: '#000000', opacity: 0 };
}
