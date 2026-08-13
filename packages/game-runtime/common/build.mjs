import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

run('bun', ['build', 'src/index.ts', '--outdir', 'dist', '--target', 'node', '--format', 'esm', '--packages', 'external']);
run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json']);

for (const output of ['dist/index.js', 'dist/index.d.ts']) {
  if (!existsSync(resolve(root, output))) throw new Error(`missing build output: ${output}`);
}
