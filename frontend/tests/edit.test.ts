import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePlan, splitClip, timelineSegments, toSourceTime, toTimelineTime } from '../src/editCore';
import { useStore } from '../src/store';
import { applyPlan, dryRun, readState, redo, replaceProject, undo } from '../src/editSession';

const project = () => ({ schemaVersion: 1 as const, projectId: 'project-fixture', language: 'zh',
    subtitleStyle: { ...useStore.getState().subtitleStyle }, mediaItems: [{ id: 'media1', filename: 'test.mp4', url: '/uploads/media1.mp4',
        info: { duration: 8, size_mb: 1, fps: 30 }, waveformPeaks: [] }],
    timelineClips: [{ id: 'clip1', mediaId: 'media1', trackIndex: 0, startTime: 0, trimStart: 0, trimEnd: 8,
        speed: 1, duration: 8, segments: [] }] });
const plan = (revision=0) => ({ sessionId: readState().sessionId, projectId: 'project-fixture', expectedRevision: revision, timeUnit: 'seconds' as const,
    operations: [{ type: 'add_subtitle' as const, clipId: 'clip1', trackId: 'video-main' as const, timeDomain: 'source' as const,
        start: 4.5, end: 5.5, text: '保留操作畫面' },
    { type: 'ripple_delete' as const, clipId: 'clip1', trackId: 'video-main' as const, timeDomain: 'source' as const,
        start: 2, end: 4 }] });
const version = () => ({ sessionId: readState().sessionId, projectId: readState().projectId, expectedRevision: readState().revision });

test('source mapping, ripple delete and linked subtitle clipping; input is unchanged', () => {
    const p: any = project();
    p.mediaItems[0].transcript={language:'zh',segments:[{id:0,start:0.123,end:7.891,text:'原始辨識'}]};
    const original = structuredClone(p);
    const r = evaluatePlan(p, 0, plan(), () => 'right');
    assert.deepEqual(p, original);
    assert.equal(r.afterDuration, 6);
    assert.deepEqual(r.next.mediaItems[0].transcript,p.mediaItems[0].transcript);
    assert.deepEqual(r.next.timelineClips.map(c => [c.trimStart, c.trimEnd, c.startTime, c.duration]), [[0,2,0,2],[4,8,2,4]]);
    assert.deepEqual(timelineSegments(r.next.timelineClips).map(s => [s.start,s.end,s.text]), [[2.5,3.5,'保留操作畫面']]);
    const c = { ...r.next.timelineClips[1], speed: 2, duration: 2 };
    assert.equal(toSourceTime(c, 3), 6);
    assert.equal(toTimelineTime(c, 6), 3);
});
test('shared split clips segment and word bounds with nonzero trims', () => {
    const c = { ...project().timelineClips[0], trimStart: 2, duration: 6,
        segments: [{id: 0, start: 1, end: 6, text: 'test', words: [{word:'test',start:1,end:6,probability:.9}]}] };
    const [a,b] = splitClip(c, 4, 'right');
    assert.deepEqual([a.segments[0].start,a.segments[0].end,b.segments[0].start,b.segments[0].end], [2,4,4,6]);
    assert.equal(a.segments[0].words![0].start,2);
});
test('invalid, missing, stale, uncertain and unsupported layouts are rejected atomically', () => {
    for (const alter of [
        (q:any) => {q.operations[1].end=10;},
        (q:any) => {q.operations[1].start=NaN;},
        (q:any) => {q.operations[1].clipId='missing';},
        (q:any) => {q.operations[1].review='needs_review';},
        (q:any) => {q.operations[1].timeDomain='timeline';},
        (q:any) => {q.expectedRevision=3;},
    ]) {
        const q=plan(); alter(q); const p=project();
        assert.throws(() => evaluatePlan(p,0,q,()=> 'right'));
        assert.deepEqual(p,project());
    }
    const p=project(); p.timelineClips[0].mediaId='missing';
    assert.throws(() => evaluatePlan(p,0,plan(),()=> 'right'), {code:'MEDIA_NOT_FOUND'});
    p.timelineClips[0].mediaId='media1'; p.timelineClips[0].startTime=1;
    assert.throws(() => evaluatePlan(p,0,plan(),()=> 'right'), {code:'UNSUPPORTED_LAYOUT'});
});
test('dry-run no mutation, batch undo/redo, stable IDs, manual edits invalidate proposals and redo', () => {
    replaceProject(project(), version());
    const before=readState();
    assert.throws(() => dryRun({ ...plan(before.revision), sessionId:'previous-session' }), {code:'STALE_PROJECT'});
    const d=dryRun(plan(before.revision));
    assert.deepEqual(readState(),before);
    applyPlan({dryRunId:d.dryRunId,...version(),confirmed:true});
    const applied=readState();
    assert.equal(applied.timelineDuration,6);
    undo(); assert.deepEqual(readState().timelineClips,before.timelineClips);
    redo(); assert.deepEqual(readState().timelineClips,applied.timelineClips);
    undo();
    const stale=dryRun(plan(readState().revision));
    const oldVersion=version();
    useStore.getState().updateClip('clip1',{trimEnd:7,duration:7});
    assert.throws(() => applyPlan({dryRunId:stale.dryRunId,...oldVersion,confirmed:true}), {code:'STALE_PROJECT'});
    assert.equal(readState().canRedo,false);
});
