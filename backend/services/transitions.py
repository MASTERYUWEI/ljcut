"""Fixed, persisted dip transitions; durations are output/timeline seconds."""
import math

COLORS = {'fade-black':'black', 'fade-gray':'0x808080', 'fade-white':'white'}


def transition_of(clip):
    return clip.get('transition_in', clip.get('transitionIn'))


def duration_of(clip):
    return clip.get('output_duration', clip.get('duration', 0))


def validate_transitions(clips):
    for i, clip in enumerate(clips):
        t = transition_of(clip)
        if t is None:
            continue
        if (not isinstance(t, dict) or not isinstance(t.get('kind'),str) or t['kind'] not in COLORS
                or type(t.get('duration')) not in (int,float) or not math.isfinite(t['duration'])
                or not .2 <= t['duration'] <= 1.5):
            raise ValueError('轉場需為淡黑、柔灰或淡白，長度 0.2–1.5 秒')
        half = t['duration']/2
        if i == 0:
            continue
        if half > min(duration_of(clip), duration_of(clips[i-1])):
            raise ValueError('轉場超出相鄰片段範圍')
        previous = transition_of(clips[i-1]) if i > 1 else None
        if previous and previous['duration']/2 + half > duration_of(clips[i-1]):
            raise ValueError('片段太短，轉場範圍重疊')


def transition_filters(clips, i):
    video, audio = [], []
    incoming = transition_of(clips[i]) if i > 0 else None
    outgoing = transition_of(clips[i+1]) if i+1 < len(clips) else None
    for direction, t in [('in',incoming),('out',outgoing)]:
        if t is None:
            continue
        half = t['duration']/2
        start = 0 if direction=='in' else duration_of(clips[i])-half
        video.append(f"fade=t={direction}:st={start:.9f}:d={half:.9f}:color={COLORS[t['kind']]}")
        audio.append(f'afade=t={direction}:st={start:.9f}:d={half:.9f}:curve=tri')
    return video, audio
