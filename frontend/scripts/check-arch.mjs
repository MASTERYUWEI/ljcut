// 前端架構守門（借鏡 Editkin 的 architecture-check，自寫）：
// 1) 不准有循環引用（只看會在執行時載入的 import；`import type` 不算）
// 2) 分層：核心邏輯（純函式／狀態）不准引用 React、元件或 App；元件不准引用 App
// 3) 主 bundle 大小預算：npm run build 之後檢查（--bundle）
// 失敗時結束碼非 0，列出違規的檔案與路徑。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const args = process.argv.slice(2);
const srcDir = args.includes('--src') ? resolve(args[args.indexOf('--src') + 1]) : src;

// 核心層：不碰畫面，可以被測試直接載入
const CORE = ['editCore', 'editSession', 'planAudit', 'review', 'audioMix', 'audioCheck', 'overlay', 'zoom', 'transitions', 'types', 'store', 'utils', 'proxy'];
// 主 bundle 預算（KB，未壓縮）：2026-11-21 現況約 506 KB，留約 10% 空間
const BUNDLE_BUDGET_KB = Number(process.env.LJCUT_BUNDLE_BUDGET_KB || 560);

function walk(dir) {
    return readdirSync(dir).flatMap(n => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
    });
}
function resolveImport(from, spec) {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec);
    for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')])
        if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
}
const runtimeImports = (code) => {
    const out = [];
    // import x from '…'、import { a } from '…'、export { a } from '…'、import '…'；排除 import type / export type
    const re = /^\s*(import|export)\s+(?!type\s)([^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
    for (let m; (m = re.exec(code));) {
        const clause = m[2] ?? '';
        // import { type A, type B } from … 全部是型別 → 不算
        const names = clause.match(/\{([^}]*)\}/)?.[1];
        const defaultOrNs = clause.replace(/\{[^}]*\}/, '').replace(/from\s+$/, '').replace(/[\s,]/g, '');
        if (names && !defaultOrNs && names.split(',').every(n => !n.trim() || /^type\s/.test(n.trim()))) continue;
        out.push(m[3]);
    }
    for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ dynamic: m[1] });
    return out;
};

const files = walk(srcDir);
const graph = new Map();
const external = new Map();
for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const deps = [], ext = [];
    for (const spec of runtimeImports(code)) {
        if (typeof spec === 'object') continue;   // 動態 import 是延遲載入，不構成循環
        const r = resolveImport(f, spec);
        if (r) deps.push(r); else ext.push(spec);
    }
    graph.set(f, deps); external.set(f, ext);
}
const rel = p => relative(srcDir, p).split(sep).join('/');
const stem = p => rel(p).replace(/\.(tsx?)$/, '');
const problems = [];

// 1) 循環
const color = new Map(), stack = [];
const cycles = new Set();
function dfs(n) {
    color.set(n, 1); stack.push(n);
    for (const d of graph.get(n) ?? []) {
        if (color.get(d) === 1) cycles.add(stack.slice(stack.indexOf(d)).concat(d).map(rel).join(' → '));
        else if (!color.get(d)) dfs(d);
    }
    stack.pop(); color.set(n, 2);
}
for (const f of files) if (!color.get(f)) dfs(f);
for (const c of cycles) problems.push(`循環引用：${c}`);

// 2) 分層
for (const [f, deps] of graph) {
    const s = stem(f);
    const isCore = CORE.includes(s);
    for (const d of deps) {
        const t = stem(d);
        if (t === 'App' && s !== 'main') problems.push(`分層：${rel(f)} 引用了 App（只有 main.tsx 可以）`);
        if (isCore && (t.startsWith('components/') || t === 'App')) problems.push(`分層：核心 ${rel(f)} 引用了畫面層 ${rel(d)}`);
    }
    if (isCore && (external.get(f) ?? []).some(e => e === 'react' || e.startsWith('react-dom') || e === 'lucide-react'))
        problems.push(`分層：核心 ${rel(f)} 引用了 React（核心要能在 node 測試裡直接跑）`);
}

// 3) bundle 預算
if (args.includes('--bundle')) {
    const dist = join(root, 'dist', 'assets');
    if (!existsSync(dist)) problems.push('bundle：找不到 dist/assets，先跑 npm run build');
    else {
        const js = readdirSync(dist).filter(n => n.endsWith('.js')).map(n => ({ n, kb: statSync(join(dist, n)).size / 1024 })).sort((a, b) => b.kb - a.kb);
        const main = js[0];
        if (main) console.log(`bundle：最大 ${main.n} ${main.kb.toFixed(0)} KB（預算 ${BUNDLE_BUDGET_KB} KB）`);
        if (main && main.kb > BUNDLE_BUDGET_KB) problems.push(`bundle：${main.n} ${main.kb.toFixed(0)} KB 超過預算 ${BUNDLE_BUDGET_KB} KB`);
    }
}

if (problems.length) {
    console.error(`架構檢查失敗（${problems.length} 項）：\n- ` + problems.join('\n- '));
    process.exit(1);
}
console.log(`架構檢查通過：${files.length} 個檔案，無循環引用、無跨層引用`);
