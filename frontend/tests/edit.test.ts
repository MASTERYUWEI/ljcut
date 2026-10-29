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

test('zoom: easing math, add/edit/delete ops, media-level storage survives ripple, validation', async () => {
    const { zoomAt } = await import('../src/zoom');
    const z = [{ id: 'z', start: 2, end: 6, x: 0.9, y: 0.1, scale: 2, ease: 0.5 }];
    assert.deepEqual(zoomAt(z, 1), { scale: 1, x: 0.5, y: 0.5 });
    assert.equal(zoomAt(z, 2.25).scale, 1.5);                 // 緩動中點
    const hold = zoomAt(z, 4);
    assert.equal(hold.scale, 2);
    assert.deepEqual([hold.x, hold.y], [0.75, 0.25]);          // 夾在畫面內：放大 2 倍時中心最多到 0.25/0.75
    assert.equal(zoomAt(z, 6).scale, 1);                       // 右開區間
    assert.equal(zoomAt([{ ...z[0], end: 2.6 }], 2.3).scale, 2); // 短區段緩動縮成一半長度

    const p:any = project(); p.mediaItems[0].info.width = 1920; p.mediaItems[0].info.height = 1080;
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const ids = (() => { let i = 0; return () => `id${i++}`; })();
    const d = evaluatePlan(p, 0, { ...plan(), operations: [
        op({ type: 'add_zoom', start: 5, end: 7, x: 0.2, y: 0.3, scale: 2.5 }),
        op({ type: 'ripple_delete', start: 1, end: 3 }),
    ] } as any, ids);
    const zooms = d.next.mediaItems[0].zooms!;
    assert.deepEqual(zooms.map(z => [z.start, z.end, z.x, z.y, z.scale]), [[5, 7, 0.2, 0.3, 2.5]]);
    assert.deepEqual((d.changes[0] as any).timeline, [[5, 7]]);
    assert.equal(p.mediaItems[0].zooms, undefined);            // 輸入不變
    const zid = zooms[0].id;
    const e = evaluatePlan(d.next, 0, { ...plan(), operations: [op({ type: 'edit_zoom', zoomId: zid, scale: 3, end: 7.5 })] } as any, ids);
    assert.deepEqual([e.next.mediaItems[0].zooms![0].scale, e.next.mediaItems[0].zooms![0].end], [3, 7.5]);
    const del = evaluatePlan(e.next, 0, { ...plan(), operations: [op({ type: 'delete_zoom', zoomId: zid })] } as any, ids);
    assert.deepEqual(del.next.mediaItems[0].zooms, []);
    const bad = (o:any, code:string) => assert.throws(() => evaluatePlan(d.next, 0, { ...plan(), operations: [op(o)] } as any, ids), { code });
    bad({ type: 'add_zoom', start: 6, end: 7.5 }, 'INVALID_ZOOM');          // 與既有區段重疊
    bad({ type: 'add_zoom', start: 0.1, end: 0.3 }, 'INVALID_ZOOM');        // 太短
    bad({ type: 'add_zoom', start: 0, end: 1, scale: 9 }, 'INVALID_ZOOM');
    bad({ type: 'add_zoom', start: 0, end: 1, x: 2 }, 'INVALID_ZOOM');
    bad({ type: 'edit_zoom', zoomId: 'nope', scale: 2 }, 'ZOOM_NOT_FOUND');
    bad({ type: 'add_zoom', start: 1.5, end: 2.5 }, 'CLIP_NOT_FOUND');      // 1–3 已被剪掉
    const audio:any = project();
    assert.throws(() => evaluatePlan(audio, 0, { ...plan(), operations: [op({ type: 'add_zoom', start: 1, end: 2 })] } as any, ids), { code: 'UNSUPPORTED_MEDIA' });
});

test('overlays: multi-layer add/edit/delete, validation, follow ripple, animation matches backend', async () => {
    const { overlayAnim } = await import('../src/overlay');
    const p:any = project(); p.mediaItems[0].info.width = 1920; p.mediaItems[0].info.height = 1080;
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const ids = (() => { let i = 0; return () => `ov${i++}`; })();
    const d = evaluatePlan(p, 0, { ...plan(), operations: [
        op({ type: 'add_overlay', kind: 'spotlight', start: 4, end: 7, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
        op({ type: 'add_overlay', kind: 'box', start: 5, end: 6, x: 0.12, y: 0.12, w: 0.2, h: 0.2, text: '這裡' }),   // 與聚光燈重疊 = 多層
        op({ type: 'add_overlay', kind: 'step', start: 5, end: 6, x: 0.5, y: 0.5, text: '1', color: 'blue' }),
        op({ type: 'ripple_delete', start: 1, end: 3 }),
    ] } as any, ids);
    const list = d.next.mediaItems[0].overlays!;
    assert.deepEqual(list.map(o => o.kind), ['spotlight', 'box', 'step']);   // 順序 = 圖層，後面在上
    assert.deepEqual((d.changes[1] as any).timeline, [[5, 6]]);               // 新增當下（同批刪除之前）
    const right = d.next.timelineClips.find(c => c.trimStart === 3)!;
    assert.equal(toTimelineTime(right, list[1].start), 3);                    // 剪掉 2 秒後：來源 5 秒 → 成品 3 秒
    const boxId = list[1].id;
    const e = evaluatePlan(d.next, 0, { ...plan(), operations: [op({ type: 'edit_overlay', overlayId: boxId, color: 'yellow', x: 0.5 })] } as any, ids);
    assert.deepEqual([e.next.mediaItems[0].overlays![1].color, e.next.mediaItems[0].overlays![1].x], ['yellow', 0.5]);
    const del = evaluatePlan(e.next, 0, { ...plan(), operations: [op({ type: 'delete_overlay', overlayId: boxId })] } as any, ids);
    assert.equal(del.next.mediaItems[0].overlays!.length, 2);
    const bad = (o:any, code:string) => assert.throws(() => evaluatePlan(d.next, 0, { ...plan(), operations: [op(o)] } as any, ids), { code });
    bad({ type: 'add_overlay', kind: 'laser', start: 4, end: 5 }, 'INVALID_OVERLAY');
    bad({ type: 'add_overlay', kind: 'box', start: 4, end: 5, x: 0.9, w: 0.5, h: 0.1 }, 'INVALID_OVERLAY');   // 超出畫面
    bad({ type: 'add_overlay', kind: 'step', start: 4, end: 5 }, 'INVALID_OVERLAY');                         // 步驟需要編號
    bad({ type: 'add_overlay', kind: 'title', start: 4, end: 5, text: 'a\nb' }, 'INVALID_OVERLAY');
    bad({ type: 'edit_overlay', overlayId: 'nope', x: 0.1 }, 'OVERLAY_NOT_FOUND');
    // 與後端 anim_state 相同的數值
    const o:any = { kind: 'box', start: 1, end: 3 };
    assert.deepEqual(overlayAnim(o, 1), { opacity: 0, scale: 0.8, slide: 0 });
    assert.deepEqual(overlayAnim(o, 2), { opacity: 1, scale: 1, slide: 0 });
    assert.ok(Math.abs(overlayAnim(o, 2.9).opacity - 0.5) < 1e-9);
    assert.equal(overlayAnim({ kind: 'title', start: 0, end: 2 } as any, 0).slide, -40);
});

test('html overlays: add/edit layer, validation, no template animation', async () => {
    const { overlayAnim, isContentOverlay } = await import('../src/overlay');
    const p:any = project(); p.mediaItems[0].info.width = 1920; p.mediaItems[0].info.height = 1080;
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const ids = (() => { let i = 0; return () => `h${i++}`; })();
    const d = evaluatePlan(p, 0, { ...plan(), operations: [op({ type: 'add_overlay', kind: 'html', start: 1, end: 4, html: '<div>hi</div>', text: '片頭動畫' })] } as any, ids);
    const h = d.next.mediaItems[0].overlays![0];
    assert.equal(h.html, '<div>hi</div>');
    assert.equal(isContentOverlay(h), false);                                   // 預設固定在畫面上
    const e = evaluatePlan(d.next, 0, { ...plan(), operations: [op({ type: 'edit_overlay', overlayId: h.id, layer: 'content' })] } as any, ids);
    assert.equal(isContentOverlay(e.next.mediaItems[0].overlays![0]), true);
    assert.deepEqual(overlayAnim(h, 1), { opacity: 1, scale: 1, slide: 0 });   // HTML 自己控制進出場
    const bad = (o:any) => assert.throws(() => evaluatePlan(p, 0, { ...plan(), operations: [op(o)] } as any, ids), { code: 'INVALID_OVERLAY' });
    bad({ type: 'add_overlay', kind: 'html', start: 1, end: 4 });
    bad({ type: 'add_overlay', kind: 'html', start: 1, end: 4, html: 'x', layer: 'top' });
    bad({ type: 'add_overlay', kind: 'html', start: 0, end: 7.9, html: 'x'.repeat(200_001) });
});

test('media (picture-in-picture) overlays: geometry matches backend, time mapping, validation', async () => {
    const { mediaGeometry, mediaTime, overlayAnim } = await import('../src/overlay');
    const asset = { id: 'a_0123456789ab', type: 'video' as const, filename: 'cam.mp4', url: '/uploads/assets/a_0123456789ab.mp4', width: 1280, height: 720, duration: 5 };
    const p:any = project(); p.mediaItems[0].info.width = 1920; p.mediaItems[0].info.height = 1080;
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const ids = (() => { let i = 0; return () => `m${i++}`; })();
    const d = evaluatePlan(p, 0, { ...plan(), operations: [op({ type: 'add_overlay', kind: 'media', start: 1, end: 7, x: 0.6, y: 0.6, asset, offset: 2 })] } as any, ids);
    const m = d.next.mediaItems[0].overlays![0];
    assert.equal(m.w, 0.3);
    assert.deepEqual(mediaGeometry(m, 1920, 1080), { left: 1152, top: 648, width: 576, height: 324, radius: 16 });   // 與後端測試同值
    assert.deepEqual(mediaGeometry({ ...m, shape: 'circle' }, 1920, 1080), { left: 1152, top: 648, width: 576, height: 576, radius: 288 });
    assert.equal(mediaTime(m, 2), 3);                       // offset 2 + (2-1)
    assert.ok(Math.abs(mediaTime(m, 6.9) - 4.95) < 1e-9);   // 超過素材長度：停在最後一格
    assert.ok(Math.abs(mediaTime({ ...m, loop: true }, 6) - 2) < 1e-9);   // 循環：(2+5) % 5
    assert.deepEqual(overlayAnim(m, 1), { opacity: 0, scale: 1, slide: 0 });
    const bad = (o:any) => assert.throws(() => evaluatePlan(p, 0, { ...plan(), operations: [op(o)] } as any, ids), { code: 'INVALID_OVERLAY' });
    bad({ type: 'add_overlay', kind: 'media', start: 1, end: 3 });
    bad({ type: 'add_overlay', kind: 'media', start: 1, end: 3, asset: { ...asset, id: '../etc' } });
    bad({ type: 'add_overlay', kind: 'media', start: 1, end: 3, asset, volume: 2 });
    bad({ type: 'add_overlay', kind: 'media', start: 1, end: 3, asset, shape: 'star' });
});

test('edit_overlay: null clears an optional field (inspector clears caption text)', () => {
    const p:any = project(); p.mediaItems[0].info.width = 1920; p.mediaItems[0].info.height = 1080;
    const op = (o:any) => ({ trackId: 'video-main' as const, timeDomain: 'source' as const, ...o });
    const ids = (() => { let i = 0; return () => `c${i++}`; })();
    const d = evaluatePlan(p, 0, { ...plan(), operations: [op({ type: 'add_overlay', kind: 'box', start: 1, end: 3, x: .1, y: .1, w: .2, h: .2, text: '說明' })] } as any, ids);
    const id = d.next.mediaItems[0].overlays![0].id;
    const e = evaluatePlan(d.next, 0, { ...plan(), operations: [op({ type: 'edit_overlay', overlayId: id, text: null, color: 'blue' })] } as any, ids);
    const o = e.next.mediaItems[0].overlays![0];
    assert.equal('text' in o, false);
    assert.equal(o.color, 'blue');
});
