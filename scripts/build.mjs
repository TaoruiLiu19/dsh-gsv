import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const output = join(root, 'lib');
if (process.argv[2] === 'clean') {
  if (existsSync(output)) {
    const stat = lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, realpathSync(output)) !== 'lib') {
      throw new Error('Refusing to clean an unexpected build output directory');
    }
    rmSync(output, { recursive: true, force: true });
  }
} else {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', join(root, 'tsconfig.json')],
    { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const file of ['client.js', 'client.d.ts']) copyFileSync(join(root, 'client', file), join(output, file));
}
