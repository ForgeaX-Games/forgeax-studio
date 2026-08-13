import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const commonRoot = resolve(root, '../common');
const dist = resolve(root, 'dist');
const require = createRequire(import.meta.url);

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

rmSync(dist, { recursive: true, force: true });
run(process.execPath, ['build.mjs'], commonRoot);
run('bun', ['build', 'src/index.ts', 'src/platform-map.ts', '--root', 'src', '--outdir', 'dist', '--target', 'node', '--format', 'esm', '--packages', 'external']);
run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json']);

const commonDeclarations = resolve(dist, 'common');
mkdirSync(commonDeclarations, { recursive: true });
for (const entry of readdirSync(resolve(commonRoot, 'dist'))) {
  if (entry.endsWith('.d.ts')) cpSync(resolve(commonRoot, 'dist', entry), resolve(commonDeclarations, entry));
}
writeFileSync(resolve(dist, 'index.d.ts'), `export type * from './common/index';
export { PLATFORM_PACKAGES, loadPlatformPackage, platformPackageName } from './platform-map';
import type { GameRuntimeDistribution } from './common/distribution';
export declare const runtimeDistribution: GameRuntimeDistribution;
export declare const ensureRuntime: GameRuntimeDistribution['ensureRuntime'];
export declare const resolveInstalledRuntime: GameRuntimeDistribution['resolveInstalledRuntime'];
export declare const runtimeCacheRoot: GameRuntimeDistribution['runtimeCacheRoot'];
export declare const launcherForRuntime: GameRuntimeDistribution['launcherForRuntime'];
export declare const runtimeEnvironment: GameRuntimeDistribution['runtimeEnvironment'];
export declare const allocatePort: GameRuntimeDistribution['allocatePort'];
export declare const allocateRuntimePorts: GameRuntimeDistribution['allocateRuntimePorts'];
export declare const loadRuntimeManifest: GameRuntimeDistribution['loadRuntimeManifest'];
export declare const engineSdkRoot: GameRuntimeDistribution['engineSdkRoot'];
export declare const installEngineSdk: GameRuntimeDistribution['installEngineSdk'];
export default runtimeDistribution;
`);

const output = readFileSync(resolve(dist, 'index.js'), 'utf8');
for (const packageName of [
  '@forgeax/game-runtime-darwin-arm64',
  '@forgeax/game-runtime-win32-x64',
  '@forgeax/game-runtime-linux-x64',
]) {
  if (!output.includes(packageName)) throw new Error(`Universal build lost optional package import: ${packageName}`);
}
if (output.includes('@forgeax/game-runtime-common')) throw new Error('Universal runtime code imports common directly');
for (const required of ['index.js', 'index.d.ts', 'platform-map.js', 'platform-map.d.ts']) {
  if (!existsSync(resolve(dist, required))) throw new Error(`missing Universal build output: ${required}`);
}
