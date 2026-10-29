// Isolated browser fixtures: no app server, real media, AI calls, or YouTube requests.
// NODE_PATH must include the already available Playwright package; no package install is needed.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true,
    ...(process.env.LJCUT_TEST_CHROMIUM ? { executablePath: process.env.LJCUT_TEST_CHROMIUM } : {}),
    args: ['--mute-audio'] });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bundle(contents, stubs) {
    const result = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' },
        bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: {'import.meta.hot':'undefined'},
        plugins: [{ name: 'isolated-boundaries', setup(b) {
            b.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'ts' }));
        } }] });
    return result.outputFiles[0].text;
}
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    // Accelerate only application poll delays, preserving ordinary async scheduling.
    await page.evaluate(() => {
        const original = window.setTimeout;
        window.setTimeout = (fn, delay, ...args) => original(fn, delay === 2000 || delay === 1500 ? 40 : delay, ...args);
        window.__pubs = { a: { id: 'a', batches: [], selected: null }, b: { id: 'b', batches: [], selected: null } };
        window.__batches = {};
        window.__calls = 0; window.__inflight = 0; window.__maxInflight = 0; window.__analyses = 0;
        window.__request = async path => {
            window.__calls++; window.__inflight++;
            window.__maxInflight = Math.max(window.__maxInflight, window.__inflight);
            const value = structuredClone(path.startsWith('/publications/') ? window.__pubs[path.split('/')[2]] : window.__batches[path.split('/')[2]]);
            await new Promise(r => original(r, window.__delay ?? 5));
            window.__inflight--;
            return value;
        };
    });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: await bundle(`
        import { createRoot } from 'react-dom/client';
        import { useState } from 'react';
        import { CoverPicker } from './src/components/CoverPicker';
        const root = createRoot(document.getElementById('root')!);
        function Harness({id}: {id:string}) {
            const [title, setTitle] = useState('使用者正在編輯的標題');
            return <><input aria-label="title" value={title} onChange={e=>setTitle(e.target.value)}/>
                <CoverPicker publication={window.__pubs[id]} disabled={false} onSelect={()=>{}}
                    onAnalysis={a=>{window.__analyses++;setTitle(a.title);}}/></>;
        }
        window.mount = id => root.render(<Harness id={id}/>);
        window.unmount = () => root.unmount();
        window.mount('a');`, {
        '../api': 'export const api = {outputUrl: value => value};',
        '../controlClient': 'export const controlRequest = path => window.__request(path);',
    }) });
    await page.getByText(/請 Codex 幫你剪輯時/).waitFor();
    await page.evaluate(() => {
        window.__batches.one = { id: 'one', status: 'awaiting_codex', items: [], errors: [], analysis: null };
        window.__pubs.a.batches.push('one');
    });
    await page.getByText(/已建立生成請求/).waitFor();
    await page.evaluate(() => {
        const b = window.__batches.one;
        b.status = 'ready'; b.items = Array.from({length:6}, (_,i) => ({file:'one-'+i, url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}));
        b.analysis = { summary: 'TEST', slogan: 'TEST', highlights: [], title: '不要覆寫使用者標題' };
        window.__pubs.a.selected = { ...b.items[1], batchId:'one' };
    });
    await page.getByRole('button', {name:'選用封面 6', exact:true}).waitFor();
    await page.getByAltText('將上傳的已選封面').waitFor();
    assert.equal(await page.locator('.cover-card').count(), 6);
    assert.equal(await page.getByLabel('title', {exact:true}).inputValue(), '使用者正在編輯的標題');
    assert.equal(await page.evaluate(() => window.__analyses), 0);
    await page.evaluate(() => {
        window.__batches.two = { id:'two', status:'awaiting_codex', items:[], errors:[], analysis:null };
        window.__pubs.a.batches.push('two');
    });
    await page.getByText(/已建立生成請求/).waitFor();
    assert.equal(await page.getByAltText('將上傳的已選封面').count(), 1);
    await page.evaluate(() => { window.__delay = 150; });
    await wait(350);
    assert.equal(await page.evaluate(() => window.__maxInflight), 1, 'poll requests must be sequential');
    // Switch while an older request is in flight; the new project must stay empty.
    await page.evaluate(() => window.mount('b'));
    await page.getByText(/請 Codex 幫你剪輯時/).waitFor();
    await wait(400);
    assert.equal(await page.locator('.cover-card').count(), 0);
    assert.equal(await page.getByAltText('將上傳的已選封面').count(), 0);
    assert.equal(await page.evaluate(() => window.__maxInflight), 1, 'publication switch must not overlap previous polling');
    await page.evaluate(() => window.unmount());
    await wait(200);
    const calls = await page.evaluate(() => window.__calls);
    await wait(200);
    assert.equal(await page.evaluate(() => window.__calls), calls, 'unmount must stop polling');
    assert.deepEqual(errors, []);
    await page.close();

    const exports = await browser.newPage();
    await exports.evaluate(() => {
        const original = window.setTimeout;
        window.setTimeout = (fn, delay, ...args) => original(fn, delay === 1500 ? 30 : delay, ...args);
        window.__state = { sessionId:'s', projectId:'p', revision:1 };
        window.crypto.randomUUID = () => 'fixture-client';
        window.__jobs = {}; window.__results = []; window.__serial = 0;
        window.addEventListener('ljcut-export-ready', e => window.__results.push(e.detail.id));
        window.fetch = async (url, opts = {}) => {
            let value;
            if (url.endsWith('/connect')) value = {token:'fixture-token', workspace:'fixture'};
            else if (url.endsWith('/poll')) value = null;
            else if (url.endsWith('/export')) {
                const id = 'job-'+(++window.__serial);
                value = window.__jobs[id] = { id, status:'running', publicationId:id, outputPath:id };
            } else if (url.includes('/jobs/')) value = window.__jobs[url.split('/').pop()];
            else throw Error('Unexpected request '+url);
            return new Response(JSON.stringify(value), {status:200, headers:{'Content-Type':'application/json'}});
        };
    });
    await exports.addScriptTag({ content: await bundle(`
        import { executeCommand, startControl } from './src/controlClient';
        window.start = startControl;
        window.exportVideo = () => executeCommand('export', {sessionId:window.__state.sessionId,
            projectId:window.__state.projectId, expectedRevision:window.__state.revision});`, {
        './api': 'export const api = {}; export const getBase = () => "http://fixture";',
        './store': 'export const useStore = { getState: () => ({isUploading:false,isTranscribing:false}) };',
        './editCore': 'export class EditError extends Error {} export const requireEdit=(v,...a)=>{if(!v)throw new Error(a.join());}; export const validateProject=()=>{}; export const toSourceTime=()=>0;',
        './editSession': `export const checkVersion = p => { const s=window.__state;
            if(p.sessionId!==s.sessionId||p.projectId!==s.projectId||p.expectedRevision!==s.revision)throw Error('STALE_PROJECT'); };
            export const projectData = () => ({projectId:window.__state.projectId});
            export const applyPlan=()=>{}, draftProject=()=>{},dryRun=()=>{},dryRunBookends=()=>{},dryRunTransitions=()=>{},readState=()=>{},redo=()=>{},replaceProject=()=>{},requestPreview=()=>{},undo=()=>{};`,
    }) });
    await exports.evaluate(() => window.start());
    const make = () => exports.evaluate(() => window.exportVideo());
    const finish = job => exports.evaluate(id => { window.__jobs[id].status='completed'; }, job.id);
    const old = await make(); const newer = await make();
    await finish(newer); await wait(100); await finish(old); await wait(100);
    assert.deepEqual(await exports.evaluate(() => window.__results), [newer.id], 'older completion cannot replace newer submitted export');
    for (const field of ['revision','projectId','sessionId']) {
        const job = await make();
        await exports.evaluate(key => { window.__state[key] = key==='revision' ? window.__state[key]+1 : window.__state[key]+'-new'; }, field);
        await finish(job); await wait(100);
    }
    assert.deepEqual(await exports.evaluate(() => window.__results), [newer.id], 'stale version, project and session must not publish completion');
    const current = await make(); await finish(current); await wait(100);
    assert.deepEqual(await exports.evaluate(() => window.__results), [newer.id,current.id]);
    console.log(JSON.stringify({passed:true, externalBatchDiscovery:true, externalRefresh:true,
        selectedPreserved:true, titlePreserved:true, sequentialPolling:true, unmountStopsPolling:true,
        staleExportRejected:true, newestExportWins:true, realAiCalls:false, realYoutubeUpload:false}));
} finally { await browser.close(); }
