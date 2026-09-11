import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = new URL('../node_modules/.cache/ljcut-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
const outfile = new URL('test.mjs', directory);
try {
    await build({ entryPoints: ['tests/edit.test.ts'], outfile: fileURLToPath(outfile),
        bundle: true, platform: 'node', format: 'esm', external: ['zustand', 'react'] });
    const result = spawnSync(process.execPath, ['--test', fileURLToPath(outfile)], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
} finally { await rm(outfile, { force: true }); }
