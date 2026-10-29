import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBookends, evaluatePlan, evaluateTransitions, splitClip, timelineSegments, toSourceTime, toTimelineTime } from '../src/editCore';
import { transitionVisual } from '../src/transitions';
import { useStore } from '../src/store';
import { applyPlan, dryRun, dryRunBookends, dryRunTransitions, readState, redo, replaceProject, undo } from '../src/editSession';

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

test('transitions choose once, preserve timeline and subtitles, survive undo/redo, reject stale and oversized effects', () => {
    const p:any = project();
    p.timelineClips[0].bookend='intro';
    p.timelineClips.push({...p.timelineClips[0],id:'main',bookend:undefined,startTime:8,segments:[{id:0,start:1,end:2,text:'完整保留'}]});
    const d=evaluateTransitions(p,'random',.6,()=>.5);
    assert.equal(d.next.timelineClips[1].transitionIn?.kind,'fade-gray');
    assert.equal(d.afterDuration,16);
    assert.deepEqual(timelineSegments(d.next.timelineClips),timelineSegments(p.timelineClips));
    assert.equal(transitionVisual(d.next.timelineClips,8).opacity,1);
    assert(Math.abs(transitionVisual(d.next.timelineClips,7.85).opacity-.5)<1e-6);
    assert.equal(transitionVisual(d.next.timelineClips,8.5).opacity,0);
    assert.equal(p.timelineClips[1].transitionIn,undefined);
    assert.throws(()=>evaluateTransitions(p,'random',20),{code:'INVALID_TRANSITION'});
    assert.equal(splitClip(d.next.timelineClips[1],4,'split')[1].transitionIn,undefined);
    replaceProject(p,version());
    const before=readState();const draft=dryRunTransitions(version(),'random',.6);
    assert.deepEqual(before,readState());
    applyPlan({...version(),dryRunId:draft.dryRunId,confirmed:true});
    const applied=readState();
    undo();assert.deepEqual(readState().timelineClips,before.timelineClips);
    redo();assert.deepEqual(readState().timelineClips,applied.timelineClips);
    const stale=dryRunTransitions(version(),'fade-white',.6),expected=version();
    useStore.getState().updateClip('main',{segments:[]});
    assert.throws(()=>applyPlan({...expected,dryRunId:stale.dryRunId,confirmed:true}),{code:'STALE_PROJECT'});
});

test('bookends preserve trimmed/sped source subtitles, draft atomicity, versions and batch undo/redo', () => {
    const p: any = project();
    p.timelineClips[0] = { ...p.timelineClips[0], trimStart: 2, trimEnd: 8, speed: 2, duration: 3,
        segments: [{id: 0, start: 3, end: 5, text: '測試字幕'}] };
    p.mediaItems[0].transcript = {language:'zh', segments:[{id:0, start:3, end:5, text:'原始逐字稿'}]};
    const intro = { ...p.mediaItems[0], id:'intro', url:'/uploads/intro.mp4', filename:'intro.mp4',
        info:{duration:2, width:320, height:180}, transcript:undefined };
    const outro = { ...intro, id:'outro', url:'/uploads/outro.mp4', filename:'outro.mp4', info:{duration:1, width:320, height:180} };
    replaceProject(p, version());
    const before = readState();
    const d = dryRunBookends(version(), intro, outro);
    assert.deepEqual(readState(), before);
    assert.equal(d.afterDuration, 6);
    assert.throws(() => applyPlan({...version(),dryRunId:d.dryRunId,confirmed:false}), {code:'CONFIRMATION_REQUIRED'});
    applyPlan({...version(),dryRunId:d.dryRunId,confirmed:true});
    const after = readState();
    assert.equal(after.timelineClips[1].id,'clip1');
    assert.deepEqual(after.timelineClips[1].segments, before.timelineClips[0].segments);
    assert.deepEqual(after.mediaItems[0].transcript, before.mediaItems[0].transcript);
    assert.equal(timelineSegments(after.timelineClips)[0].start,2.5);
    assert.equal(timelineSegments(after.timelineClips)[0].end,3.5);
    assert.throws(() => dryRunBookends(version(),intro,outro), {code:'BOOKENDS_ALREADY_PRESENT'});
    undo(); assert.deepEqual(readState().timelineClips,before.timelineClips);
    assert.deepEqual(readState().mediaItems,before.mediaItems);
    redo(); assert.deepEqual(readState().timelineClips,after.timelineClips);
    undo();
    const stale = dryRunBookends(version(),intro,outro);
    const expected = version();
    useStore.getState().updateClip('clip1', {segments:[]});
    assert.throws(() => applyPlan({...expected,dryRunId:stale.dryRunId,confirmed:true}), {code:'STALE_PROJECT'});
    assert.throws(() => evaluateBookends(p,undefined,undefined,()=> 'x'), {code:'BOOKENDS_REQUIRED'});
    assert.throws(() => evaluateBookends(p,{...intro,info:{duration:-1,width:320,height:180}},undefined,()=> 'x'), {code:'INVALID_MEDIA'});
});

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

// ── AI 剪輯動作：split / set_speed / move_clip / delete_clip / edit_subtitle / delete_subtitle ──
const op = (o: any) => ({ clipId: 'clip1', trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
const run = (p: any, ops: any[]) => {
    let n = 0;
    return evaluatePlan(p, 0, { sessionId: 's', projectId: 'project-fixture', expectedRevision: 0, timeUnit: 'seconds', operations: ops },
        () => `new${++n}`);
};

test('set_speed speeds a middle range, keeps subtitles on source time, relays out contiguously', () => {
    const p: any = project();
    p.timelineClips[0].segments = [{ id: 0, start: 1, end: 2, text: '前段' }, { id: 1, start: 6.5, end: 7.5, text: '後段' }];
    const r = run(p, [op({ type: 'set_speed', start: 2, end: 6, speed: 4 })]);
    const clips = [...r.next.timelineClips].sort((a, b) => a.startTime - b.startTime);
    assert.deepEqual(clips.map(c => [c.trimStart, c.trimEnd, c.speed, c.startTime]),
        [[0, 2, 1, 0], [2, 6, 4, 2], [6, 8, 1, 3]]);
    assert.equal(r.afterDuration, 5);                         // 8 秒 → 2 + 1 + 2
    assert.equal((r.changes[0] as any).savedSeconds, 3);
    const subs = timelineSegments(r.next.timelineClips);
    assert.deepEqual(subs.map(s => [s.text, s.start, s.end]), [['前段', 1, 2], ['後段', 3.5, 4.5]]);
    assert.throws(() => run(project(), [op({ type: 'set_speed', start: 2, end: 6, speed: 0.5 })]), { code: 'INVALID_SPEED' });
});

test('split then move_clip reorders, delete_clip ripples, bookends stay locked', () => {
    const r = run(project(), [op({ type: 'split', at: 3 })]);
    const [a, b] = [...r.next.timelineClips].sort((x, y) => x.startTime - y.startTime);
    assert.deepEqual([a.trimEnd, b.trimStart, b.startTime], [3, 3, 3]);
    const moved = evaluatePlan(r.next, 0, { sessionId: 's', projectId: 'project-fixture', expectedRevision: 0, timeUnit: 'seconds',
        operations: [op({ type: 'move_clip', clipId: b.id, toIndex: 0 })] }, () => 'x');
    const order = [...moved.next.timelineClips].sort((x, y) => x.startTime - y.startTime);
    assert.deepEqual(order.map(c => [c.id, c.startTime]), [[b.id, 0], [a.id, 5]]);
    const del = evaluatePlan(moved.next, 0, { sessionId: 's', projectId: 'project-fixture', expectedRevision: 0, timeUnit: 'seconds',
        operations: [op({ type: 'delete_clip', clipId: b.id })] }, () => 'y');
    assert.deepEqual(del.next.timelineClips.map(c => [c.id, c.startTime]), [[a.id, 0]]);
    assert.equal(del.afterDuration, 3);
    const withIntro: any = project();
    withIntro.timelineClips[0].bookend = 'intro';
    withIntro.timelineClips.push({ ...withIntro.timelineClips[0], id: 'main', bookend: undefined, startTime: 8 });
    assert.throws(() => run(withIntro, [op({ type: 'move_clip', clipId: 'main', toIndex: 0 })]), { code: 'BOOKEND_LOCKED' });
    assert.throws(() => run(withIntro, [op({ type: 'move_clip', toIndex: 1 })]), { code: 'BOOKEND_LOCKED' });
});

test('edit_subtitle / delete_subtitle change text only and reject markup', () => {
    const p: any = project();
    p.timelineClips[0].segments = [{ id: 0, start: 1, end: 2, text: '組群參數', words: [{ word: '組', start: 1, end: 1.2, probability: .9 }] },
        { id: 1, start: 3, end: 4, text: '刪掉' }];
    const r = run(p, [op({ type: 'edit_subtitle', segmentId: 0, text: '族群參數' }), op({ type: 'delete_subtitle', segmentId: 1 })]);
    const segs = r.next.timelineClips[0].segments;
    assert.deepEqual(segs.map(s => [s.id, s.text, s.start, s.end]), [[0, '族群參數', 1, 2]]);
    assert.equal(segs[0].words, undefined);
    assert.equal(p.timelineClips[0].segments.length, 2);       // 原專案不被改動
    assert.throws(() => run(p, [op({ type: 'edit_subtitle', segmentId: 0, text: '{\b1}粗體' })]), { code: 'UNSUPPORTED_SUBTITLE_TEXT' });
    assert.throws(() => run(p, [op({ type: 'edit_subtitle', segmentId: 9, text: 'x' })]), { code: 'SUBTITLE_NOT_FOUND' });
});

test('omitted clipId locates the clip by source time, even after earlier ops split it in the same batch', () => {
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const q:any = { ...plan(), operations: [
        op({ type: 'ripple_delete', start: 1, end: 2 }),
        op({ type: 'set_speed', start: 5, end: 7, speed: 2 }),   // 原 clip1 已被切開，需自動找到右半段
        op({ type: 'split', at: 3 }),
    ] };
    const d = evaluatePlan(project(), 0, q, (() => { let i = 0; return () => `n${i++}`; })());
    assert.equal(d.afterDuration, 8 - 1 - 1);
    assert.deepEqual(d.next.timelineClips.map(c => [c.trimStart, c.trimEnd, c.speed]),
        [[0,1,1],[2,3,1],[3,5,1],[5,7,2],[7,8,1]]);
    const gone:any = { ...plan(), operations: [op({ type: 'ripple_delete', start: 1, end: 2 }), op({ type: 'split', at: 1.5 })] };
    assert.throws(() => evaluatePlan(project(), 0, gone, () => 'x'), { code: 'CLIP_NOT_FOUND' });
    const twice:any = project(); twice.timelineClips.push({ ...twice.timelineClips[0], id: 'clip2', startTime: 8 });
    assert.throws(() => evaluatePlan(twice, 0, { ...plan(), operations: [op({ type: 'split', at: 4 })] } as any, () => 'x'), { code: 'CLIP_AMBIGUOUS' });
    assert.throws(() => evaluatePlan(project(), 0, { ...plan(), operations: [op({ type: 'delete_clip' })] } as any, () => 'x'), { code: 'CLIP_REQUIRED' });
});
