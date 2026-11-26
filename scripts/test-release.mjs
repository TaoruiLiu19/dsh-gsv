import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const pnpm = process.env.npm_execpath;
if (!pnpm || !/\.(?:[cm]?js|exe)$/i.test(pnpm)) {
  throw new Error('Run this task with pnpm test:release');
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, { cwd: repo, stdio: 'inherit', windowsHide: true, ...options });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Command exited with ${child.status ?? child.signal}`);
}

function packageManager(args, options) {
  if (/\.exe$/i.test(pnpm)) run(pnpm, args, options);
  else run(process.execPath, [pnpm, ...args], options);
}

const root = mkdtempSync(join(tmpdir(), 'dsh-gsv-package-'));
try {
  run(process.execPath, ['scripts/build.mjs', 'clean']);
  assert.equal(existsSync(join(repo, 'lib')), false);
  run(process.execPath, ['scripts/build.mjs']);
  run(process.execPath, ['scripts/verify-manifest.mjs']);
  packageManager(['pack', '--pack-destination', root]);
  const archives = readdirSync(root).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);

  let harness = process.env.DSH_GSV_TEST_HARNESS;
  if (!harness) {
    const runtime = join(root, 'runtime');
    mkdirSync(runtime);
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ private: true }));
    packageManager(['add', '@deepseek-ai/dsh@0.2.2-rc.1', '--ignore-scripts'], { cwd: runtime });
    harness = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
  run(process.execPath, ['--test', 'tests/harness.test.mjs'], {
    env: { ...process.env, DSH_GSV_TEST_HARNESS: resolve(harness), DSH_GSV_TEST_TARBALL: join(root, archives[0]) },
  });
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
