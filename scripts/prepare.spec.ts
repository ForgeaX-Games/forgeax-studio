import { describe, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PREPARE_ENGINE_BUILD_FILTERS } from './ci/build-engine-packages';
import { IDE_INTEGRATION_WORKSPACES } from './lib/ide-integration-workspace.ts';

const ROOT = resolve(import.meta.dir, '..');
const prepareSource = () => readFileSync(join(ROOT, 'scripts/prepare.ts'), 'utf8');
const buildExtensionsSource = () => readFileSync(join(ROOT, 'scripts/build-extensions.ts'), 'utf8');
const runSource = () => readFileSync(join(ROOT, 'scripts/run.ts'), 'utf8');
const studioViteSource = () => readFileSync(join(ROOT, 'packages/studio/vite.config.ts'), 'utf8');
const engineEntryFreshnessSource = () =>
  readFileSync(join(ROOT, 'scripts/lib/engine-entry-freshness.ts'), 'utf8');

describe('scripts/prepare.ts contracts', () => {
  it('does not run root bun install (lifecycle already did)', () => {
    const src = prepareSource();
    expect(src).not.toContain('bunInstallWithRetry(ROOT)');
    expect(src).not.toContain("run('bun', ['install'], { cwd: ROOT");
    expect(src).not.toContain("run('bun', ['install', '--frozen-lockfile'], { cwd: ROOT");
    expect(src).not.toMatch(/spawnSync\([^)]*bun[^)]*install[^)]*cwd:\s*ROOT/s);
  });
  it('honours FORGEAX_SKIP_PREPARE and FORGEAX_FORCE_PREPARE', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_PREPARE');
    expect(src).toContain('FORGEAX_FORCE_PREPARE');
  });
  it('installs IDE product dependencies without preparing retired Marketplace source', () => {
    const src = prepareSource();
    expect(src).toContain("ensureManagedPackage('ide', true)");
    expect(src).not.toContain("cwd: ideDir");
    expect(IDE_INTEGRATION_WORKSPACES).toContain('../../packages/ide');
    expect(IDE_INTEGRATION_WORKSPACES).toContain('../../packages/ide/packages/*');
    expect(src).toContain("ok('@forgeax/ide integration workspace dependencies ready')");
    expect(src).not.toContain("join(ROOT, 'scripts/build-extensions.ts')");
    expect(src).not.toContain("join(ROOT, 'packages/marketplace/extensions')");
    expect(src).not.toContain('FORGEAX_SKIP_PLUGINS');
    expect(src).not.toContain('Marketplace Extension');
  });
  it('does not mistake an uninitialized non-recursive clone for integration-only CI', () => {
    const src = prepareSource();
    expect(src).toContain("const integrationOnly = process.env.FORGEAX_ROOT_INTEGRATION_ONLY === '1';");
    expect(src).not.toMatch(/integrationOnly\s*=\s*[\s\S]{0,200}packages\/server\/package\.json/);
  });
  it('installs the selected private server role dependencies during prepare', () => {
    const src = prepareSource();
    expect(src).toContain('resolveActiveServerRole');
    expect(src).toContain('if (!publicDistribution)');
    expect(src).toContain("activeServer.packageName !== '@forgeax/server'");
    expect(src).toContain("repairWindowsDirectoryAlias(join(activeServer.packageDir, 'patches'))");
    expect(src).toContain('prepareWindowsWorkspaceJunctions(activeServer.packageDir)');
    expect(src).toContain('bunWorkspaceInstallArgs()');
    expect(src).toContain('restoreWindowsDirectoryAlias(patchesAlias)');
    expect(src).toContain('cwd: activeServer.packageDir');
    expect(src).toContain('runtime dependencies ready');
  });
  it('installs the independently mounted IDE before start can invoke Vite', () => {
    const src = prepareSource();
    expect(src).toContain("ensureManagedPackage('ide', true)");
    expect(IDE_INTEGRATION_WORKSPACES).toContain('../../packages/ide');
    expect(src.indexOf("ensureManagedPackage('ide', true)")).toBeLessThan(
      src.indexOf("const ideSourceWorkspaceDir = join(ROOT, '.forgeax/ide-source-workspace')"),
    );
    expect(src).toContain("'[1c/5] Installing IDE integration workspace dependencies'");
    expect(src).toContain("ok('@forgeax/ide integration workspace dependencies ready')");
  });
  it('installs every package consumed from source by the IDE as one workspace', () => {
    const src = prepareSource();
    expect(src).toContain("const ideSourceWorkspaceDir = join(ROOT, '.forgeax/ide-source-workspace')");
    expect(IDE_INTEGRATION_WORKSPACES).toEqual(expect.arrayContaining([
      '../../packages/ide',
      '../../packages/ide/packages/*',
      '../../packages/cli',
      '../../packages/interface',
    ]));
    expect(src).toContain('writeIdeIntegrationWorkspaceManifest(ideSourceWorkspaceDir)');
    expect(src).toContain("'[1c/5] Installing IDE integration workspace dependencies'");
    expect(src).toContain('prepareWindowsWorkspaceJunctions(ideSourceWorkspaceDir)');
    expect(src).toContain('cwd: ideSourceWorkspaceDir');
    expect(src).toContain("ok('@forgeax/ide integration workspace dependencies ready')");
  });
  it('installs the Editor workspace before launching the Play runtime', () => {
    const src = prepareSource();
    expect(src).toContain("'[1e/5] Installing @forgeax/editor workspace dependencies'");
    expect(src).toContain('prepareWindowsWorkspaceJunctions(editorDir, process.platform, false)');
    expect(src).toContain("ok('@forgeax/editor workspace dependencies ready')");
    expect(src).toContain("const engineDir = join(editorDir, 'packages/engine')");
    expect(src).toContain("healDanglingEngineSymlinks(engineDir, process.platform === 'win32')");
    expect(src).toContain('removeWindowsWorkspaceNodeModulesBridges(editorDir, workspaceLinks)');
    expect(src).toContain('const repairedNestedLinks = repairWindowsNestedDirectoryLinks(enginePkgDir)');
    expect(src.indexOf('const repairedNestedLinks')).toBeGreaterThan(
      src.lastIndexOf("run('pnpm', ['install', '--frozen-lockfile']"),
    );
  });
  it('launches Play Runtime with the Editor-owned Vite CLI', () => {
    const src = runSource();
    expect(src).toContain("const editorDir = join(ROOT, 'packages/editor')");
    expect(src).toContain("const engineViteCli = join(editorDir, 'node_modules/vite/bin/vite.js')");
    expect(src).toContain("[engineViteCli, '--host', startup.engine.host");
    expect(src).not.toContain("['x', 'vite', '--host', startup.engine.host");
  });
  it('passes the IDE product root to the selected server runtime', () => {
    expect(runSource()).toContain('FORGEAX_PRODUCT_ROOT: ideDir');
  });
  it('consumes published shared contracts without reaching into the retired workspace', () => {
    const src = prepareSource();
    expect(src).not.toContain("join(ROOT, 'packages/contracts')");
    expect(src).not.toContain("spawnSync('node', ['scripts/build-packages.mjs']");
    expect(src).not.toContain('Building shared contracts');
    expect(src).toContain('Building @forgeax/cli (serve entry)');
  });
  it('covers assets-runtime in prepare and start engine entry gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-assets-runtime...');
    expect(run).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
  });
  it('covers every VFX package imported by editor config and runtime entry points', () => {
    const prepare = prepareSource();
    const run = runSource();
    for (const packageName of ['vfx', 'vfx-compiler', 'vfx-render']) {
      expect(prepare).toMatch(new RegExp(`engineEntryPkgs\\s*=\\s*\\[[\\s\\S]*['"]${packageName}['"]`));
      expect(run).toMatch(new RegExp(`engineEntryPkgs\\s*=\\s*\\[[\\s\\S]*['"]${packageName}['"]`));
      expect(PREPARE_ENGINE_BUILD_FILTERS).toContain(`@forgeax/engine-${packageName}...`);
    }
  });
  it('requires declaration outputs for engine entry freshness gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toContain('ENGINE_ENTRY_OUTPUTS');
    expect(prepare).toContain('areEnginePrepareArtifactsFresh(enginePkgDir, engineEntryPkgs, engineDeclarationSentinel)');
    expect(run).toContain('ENGINE_ENTRY_OUTPUTS');
    expect(run).toContain('isEngineEntryDistFresh(join(enginePkgDir, p), engineDeclarationSentinel)');
    expect(engineEntryFreshnessSource()).toContain("['index.mjs', 'index.d.ts']");
  });
  it('requires the DevKit CLI in the prepare build and cache gates', () => {
    const prepare = prepareSource();
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-devkit...');
    expect(prepare).toContain('areEnginePrepareArtifactsFresh(enginePkgDir, engineEntryPkgs, engineDeclarationSentinel)');
    expect(prepare).toContain("const engineDevkitCliPath = join(engineDevkitCliDir, 'dist', 'cli.mjs')");
    expect(prepare).toContain('collectMissingEngineArtifacts');
    expect(prepare).toContain('FORGEAX_FORCE_PREPARE=1 bun run prepare');
  });

  it('runs root prepare against a missing CLI and diagnoses an invalid CLI', { timeout: 30_000 }, () => {
    const cliPath = join(ROOT, 'packages/editor/packages/engine/packages/devkit/dist/cli.mjs');
    const hadOriginalCli = existsSync(cliPath);

    const sandbox = mkdtempSync(join(tmpdir(), 'forgeax-prepare-engine-cli-'));
    const binDir = join(sandbox, 'bin');
    const pnpmScript = join(binDir, 'pnpm.js');
    const pnpmPath = join(binDir, 'pnpm');
    const pnpmCmdPath = join(binDir, 'pnpm.cmd');
    const pnpmLog = join(sandbox, 'pnpm.log');
    const backupPath = join(sandbox, 'cli.mjs.backup');
    const enginePkgDir = join(ROOT, 'packages/editor/packages/engine/packages');
    const engineEntryPackages = [
      'app',
      'runtime',
      'ecs',
      'net',
      'font',
      'assets-runtime',
      'npc',
      'vfx',
      'vfx-compiler',
      'vfx-render',
      'vite-plugin-pack',
      'vite-plugin-shader',
    ];
    const setupFixtureFiles = [
      // Simulate a reused self-hosted runner retaining the deleted Contracts
      // submodule. Prepare must ignore this directory and consume npm packages.
      join(ROOT, 'packages/contracts/package.json'),
      join(ROOT, 'packages/contracts/scripts/build-packages.mjs'),
      join(ROOT, 'packages/cli/dist/cli/main.js'),
      join(enginePkgDir, 'wgpu-wasm/pkg/wgpu_wasm.js'),
      join(enginePkgDir, 'wgpu-wasm/pkg/wgpu_wasm_bg.wasm'),
      join(enginePkgDir, 'fbx/pkg/fbx-wasm.mjs'),
      join(enginePkgDir, 'fbx/pkg/fbx-wasm.wasm'),
      join(enginePkgDir, 'codec/pkg/basis_transcoder.mjs'),
      join(enginePkgDir, 'codec/pkg/basis_transcoder.wasm'),
      join(enginePkgDir, 'codec/pkg/encode/basis_encoder.mjs'),
      join(enginePkgDir, 'codec/pkg/encode/basis_encoder.wasm'),
      ...engineEntryPackages.flatMap((name) => [
        join(enginePkgDir, name, 'dist/index.mjs'),
        join(enginePkgDir, name, 'dist/index.d.ts'),
      ]),
      join(enginePkgDir, 'net-websocket/dist/browser.mjs'),
      join(enginePkgDir, 'net-websocket/dist/node.mjs'),
    ];
    const createdFixtureFiles: string[] = [];
    const createdFixtureDirs: string[] = [];
    const ensureFixtureDirectory = (path: string) => {
      if (existsSync(path)) return;
      const missing: string[] = [];
      let current = path;
      while (!existsSync(current) && current.startsWith(ROOT)) {
        missing.push(current);
        current = dirname(current);
      }
      mkdirSync(path, { recursive: true });
      createdFixtureDirs.push(...missing);
    };
    const ensureFixtureFile = (path: string) => {
      if (existsSync(path)) return;
      ensureFixtureDirectory(dirname(path));
      writeFileSync(path, 'prepare fixture\n');
      createdFixtureFiles.push(path);
    };
    mkdirSync(binDir, { recursive: true });
    writeFileSync(pnpmScript, [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2).join(' ');",
      "if (process.env.FORGEAX_TEST_PNPM_LOG) fs.appendFileSync(process.env.FORGEAX_TEST_PNPM_LOG, `${args}\\n`);",
      "if (process.env.FORGEAX_TEST_PNPM_WRITE_CLI === '1' && args.includes('build')) fs.writeFileSync(process.env.FORGEAX_TEST_DEVKIT_CLI, '#!/usr/bin/env node\\nconsole.log(\\\"Usage: forgeax\\\");\\n');",
    ].join('\n'));
    writeFileSync(pnpmPath, '#!/bin/sh\nexec node "$(dirname "$0")/pnpm.js" "$@"\n');
    writeFileSync(pnpmCmdPath, '@node "%~dp0pnpm.js" %*\r\n');
    chmodSync(pnpmPath, 0o755);

    const prepareEnv = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      FORGEAX_SKIP_BOOTSTRAP: '1',
      FORGEAX_SKIP_GAMES: '1',
      FORGEAX_SKIP_HARNESS: '1',
      FORGEAX_SKIP_PLUGINS: '1',
      FORGEAX_SKIP_SUBMODULE_INIT: '1',
      FORGEAX_SKIP_CLI_BUILD: '1',
      FORGEAX_TEST_DEVKIT_CLI: cliPath,
      FORGEAX_TEST_PNPM_LOG: pnpmLog,
    };
    const runPrepare = (writeCli: boolean, requireCompleteSetup: boolean) => spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/prepare.ts')],
      {
        cwd: ROOT,
        env: {
          ...prepareEnv,
          FORGEAX_REQUIRE_COMPLETE_SETUP: requireCompleteSetup ? '1' : '0',
          FORGEAX_TEST_PNPM_WRITE_CLI: writeCli ? '1' : '0',
        },
        encoding: 'utf8',
      },
    );

    try {
      ensureFixtureDirectory(dirname(cliPath));
      for (const path of setupFixtureFiles) ensureFixtureFile(path);
      // Cross-device-safe backup: the sandbox lives under tmpdir() which on
      // self-hosted CI runners is a different device from the repo checkout, so
      // renameSync fails with EXDEV. copy + unlink works across devices.
      if (hadOriginalCli) { copyFileSync(cliPath, backupPath); rmSync(cliPath); }
      const rebuilt = runPrepare(true, false);
      if (rebuilt.status !== 0) {
        throw new Error([
          `root prepare rebuild failed with status ${rebuilt.status}`,
          rebuilt.stdout,
          rebuilt.stderr,
          `pnpm trace:\n${existsSync(pnpmLog) ? readFileSync(pnpmLog, 'utf8') : '<missing>'}`,
        ].join('\n'));
      }
      expect(readFileSync(pnpmLog, 'utf8')).toContain('build');
      expect(existsSync(cliPath)).toBe(true);

      writeFileSync(cliPath, 'export const = ;\n');
      const rejected = runPrepare(false, true);
      expect(rejected.status).toBe(1);
      expect(readFileSync(cliPath, 'utf8')).toContain('export const = ;');
      expect(readFileSync(pnpmLog, 'utf8').split('\n').filter((line) => line.includes('build')).length)
        .toBeGreaterThanOrEqual(2);
    } finally {
      if (existsSync(cliPath)) rmSync(cliPath);
      if (hadOriginalCli && existsSync(backupPath)) { copyFileSync(backupPath, cliPath); rmSync(backupPath); }
      for (const path of createdFixtureFiles) {
        if (existsSync(path)) rmSync(path);
      }
      for (const path of createdFixtureDirs.reverse()) {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
  it('records a freshness sentinel after successful incremental declaration builds', () => {
    const src = prepareSource();
    expect(src).toContain(".forgeax/sentinels/engine-declarations.built");
    expect(src).toContain('if (declarationsBuilt)');
    expect(src).toContain('writeFileSync(engineDeclarationSentinel');
  });
  it('repairs @forgeax links in both the worktree root and Studio roots', () => {
    const src = prepareSource();
    expect(src).toMatch(
      /const forgeaxLinkRoots = \[[\s\S]*join\(ROOT, 'node_modules\/@forgeax'\)[\s\S]*join\(ROOT, 'packages\/studio\/node_modules\/@forgeax'\)/,
    );
    expect(src).toContain('ensureWorkspacePackageLink(linkPath, join(parent, e.name), ROOT, isWin)');
    expect(src).toContain('existing path is not a symlink; leaving it unchanged');
  });
  it('honours FORGEAX_SKIP_HARNESS (skip harness sync + skill install)', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_HARNESS');
    expect(src).toMatch(/FORGEAX_SKIP_HARNESS\s*===\s*['"]1['"]/);
  });
  it('skips only the nested Engine harness during Studio-owned engine installs', () => {
    const src = prepareSource();
    expect(src).toContain("const engineInstallEnv = { ...gitEnv, FORGEAX_SKIP_HARNESS_SYNC: '1' }");
    expect(src).toContain("run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir, env: engineInstallEnv })");
    expect(src).toContain("spawnSync('node', ['scripts/sync-harness.mjs'], {\n        stdio: 'inherit',\n        cwd: join(ROOT, 'packages', sub),\n        env: gitEnv,");
  });
  it('provisions toolchain via bootstrap.ts (gated) and keeps the hard gate', () => {
    const src = prepareSource();
    expect(src).toContain('bootstrap.ts');
    expect(src).toContain('FORGEAX_SKIP_BOOTSTRAP');
    expect(src).toContain("has('git')");
    expect(src).toContain("has('pnpm')");
  });
  it('preserves prebuilt-release wasm fetch + codec provisioning', () => {
    const src = prepareSource();
    expect(src).toContain('tryFetchWasm');
    expect(src).toContain('ensureEngineWgpuWasm');
    expect(src).toContain('@forgeax/engine-codec');
    expect(src).toContain('healDanglingEngineSymlinks');
  });
  it('treats the scaffold NPC adapter as a required cached engine entry', () => {
    const src = prepareSource();
    expect(src).toMatch(/engineEntryPkgs\s*=\s*\[[^\]]*['"]npc['"]/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-npc...');
  });
  it('builds the network packages required by the editor engine Vitest graph', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toMatch(/engineEntryPkgs\s*=\s*\[[\s\S]*['"]net['"]/);
    expect(run).toMatch(/engineEntryPkgs\s*=\s*\[[\s\S]*['"]net['"]/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-net...');
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-net-websocket...');
    expect(prepare).toContain("join(enginePkgDir, 'net-websocket', 'dist', 'browser.mjs')");
    expect(prepare).toContain("join(enginePkgDir, 'net-websocket', 'dist', 'node.mjs')");
  });
  it('delegates Extension package-manager selection while preserving normalized install credentials', () => {
    const prepare = prepareSource();
    const builder = buildExtensionsSource();
    expect(builder).toContain('extensionPackageManagerFallback');
    expect(builder).toContain('extensionPreparationCommands');
    expect(builder).toContain("join(d, 'bun.lock')");
    expect(builder).toContain('dependency install failed');
    expect(prepare).toContain('normalizePackageManagerRegistry');
    expect(prepare).toContain('npm_config_registry');
    expect(prepare).toContain('env: gitEnv');
    expect(builder).not.toContain("['install', '--ignore-scripts']");
  });
  it('does not retry optional headless renderers when their browser cache is unavailable', () => {
    const src = runSource();
    expect(src).toContain('hasPlaywrightHeadlessBrowser(p.dir)');
    expect(src).toContain('headless renderer skipped: Playwright browser unavailable');
    expect(src).toContain("chromium.launch({headless:true})");
  });
  it('keeps Studio config compatible with the current editor preset and diagnostics facade', () => {
    const src = studioViteSource();
    expect(src).toContain("from '../editor/scripts/vite/engine-vite-preset'");
    expect(src).toContain("'@forgeax/editor-core/diagnostics'");
    expect(src).toContain("packages/core/src/io/diagnostics.ts");
  });
  // Regression: Studio mounted the preview panel shells but never injected the
  // host preview viewports, so material/mesh/vfx previews rendered the
  // "not registered by the host" placeholder. The wiring must go through the
  // @forgeax/editor/previews facade subpath (boundary rule 6), at module scope.
  it('registers the editor preview viewports through the facade at module scope', () => {
    const src = readFileSync(join(ROOT, 'packages/studio/src/panels/editorRenderers.tsx'), 'utf8');
    expect(src).toContain("from '@forgeax/editor/previews'");
    expect(src).toContain('registerEditorPreviewViewports()');
    const editorPkg = JSON.parse(
      readFileSync(join(ROOT, 'packages/editor/package.json'), 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(editorPkg.exports?.['./previews']).toBe(
      './packages/edit-runtime/src/viewport/preview-registrations.ts',
    );
  });
  it('keeps explicit extension admission strict while core prepare artefacts remain required', () => {
    const prepare = prepareSource();
    const builder = buildExtensionsSource();
    expect(prepare).not.toContain("join(ROOT, 'scripts/build-extensions.ts')");
    expect(builder).toContain('dependency install failed');
    expect(builder).toContain('build failed');
    expect(builder).toContain('process.exit(failOnError && failed > 0 ? 1 : 0)');
    expect(prepare).toContain('formatMissingEngineArtifacts');
    expect(prepare).toContain('required CLI artefact missing after prepare');
  });
  it('builds the engine package imported by the new-game NPC template', () => {
    const src = prepareSource();
    expect(src).toContain("'npc'");
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-npc...');
  });
  it('runs Extension dependency installation before any conditional frontend build', () => {
    const src = buildExtensionsSource();
    expect(src).toContain("join(pluginsDir, '_shared')");
    expect(src.indexOf('const sharedPackagesDir')).toBeLessThan(
      src.indexOf('for (const e of readdirSync(pluginsDir'),
    );
    expect(src.indexOf('const okInstall = run')).toBeLessThan(src.indexOf('if (!buildCommandSpec)'));
    expect(src.indexOf('if (!buildCommandSpec)')).toBeLessThan(src.indexOf('run(buildCommand'));
  });
  it('does not bypass the asset-canvas plugin build', () => {
    const src = prepareSource();
    expect(src).not.toContain('localOnlyPluginRequirements');
    expect(src).not.toContain('local-only source dependency absent (skipped)');
  });
  it('treats an incomplete wgpu/codec pkg/ as stale (gates on the glue, not just .wasm)', () => {
    const src = prepareSource();
    // wgpuWasmStale must re-provision when the JS glue engine-app imports is
    // missing — not just when wgpu_wasm_bg.wasm is absent.
    expect(src).toContain('!existsSync(wasmArtefact) || !existsSync(wgpuJs)');
    // codec skip must gate on the .mjs loaders too, not only the .wasm binaries.
    expect(src).toContain('codecTranscoderMjs');
    expect(src).toContain('codecEncoderMjs');
  });
  it('updates submodules with credential-hardened env and reports at end', () => {
    const src = prepareSource();
    expect(src).not.toContain('submodule.recurse');
    expect(src).toContain("'submodule', 'update', '--init', '--recursive', ...depth, '--', path]");
    expect(src).not.toContain("fail('git submodule update failed.')");
    expect(src).toContain('formatPrepareReport');
  });
  it('protects dirty managed submodule checkouts during prepare materialization', () => {
    const src = prepareSource();
    expect(src).toContain('stashDirtyUpdateRepos');
    expect(src).toContain('restoreUpdateRepoStashes');
    expect(src.indexOf('stashDirtyUpdateRepos')).toBeLessThan(src.indexOf("'submodule', 'update', '--init', '--recursive'"));
    expect(src.lastIndexOf('restoreUpdateRepoStashes')).toBeGreaterThan(src.indexOf("'submodule', 'update', '--init', '--recursive'"));
    expect(src).toContain('preserved local checkout before prepare submodule update');
  });

  it('can trust the parallel worktree bootstrap instead of repeating serial submodule init', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_SUBMODULE_INIT');
    expect(src).toContain('materialized by bun fx worktree');
  });
  it('prints per-submodule start/end diagnostics with exit and duration', () => {
    const src = prepareSource();
    expect(src).toContain('[submodule:start]');
    expect(src).toContain('[submodule:end]');
    expect(src).toContain('duration_ms=');
  });
  it('prints bun fx start as the next step, no auto-start', () => {
    const src = prepareSource();
    expect(src).toContain('bun fx start');
    expect(src).not.toContain("['fx', 'start']");
  });
  it('does not require Git metadata when preparing the public distribution', () => {
    const src = prepareSource();
    expect(src).toContain('if (publicDistribution)');
    expect(src).toContain('recursive input result skipped (public distribution has no Git metadata)');
    expect(src.indexOf('recursive input result skipped')).toBeLessThan(src.indexOf('writeRecursiveInputResult(ROOT)'));
  });
  it('scaffolds .env silently without readline key prompt', () => {
    const src = prepareSource();
    expect(src).not.toContain('createInterface');
    expect(src).not.toContain('ANTHROPIC_API_KEY (Enter to skip)');
  });
});
