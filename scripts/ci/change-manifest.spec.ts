import { describe, expect, it } from 'bun:test';
import {
  buildChangeManifest,
  computeInputDigest,
  type InputDigestFacts,
} from './change-manifest';

const identity = {
  eventName: 'pull_request',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  trustScope: 'ordinary-ci',
} as const;

describe('immutable CI change manifest', () => {
  it('keeps docs-only draft heads on the fast lane without heavy or Runtime work', () => {
    const manifest = buildChangeManifest({
      ...identity,
      draft: true,
      changedPaths: ['docs/architecture.md', 'README.md'],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });

    expect(manifest.mode).toBe('draft-fast');
    expect(manifest.studioQa).toEqual({ run: false, deterministicSamples: 1, soakSamples: 3 });
    expect(manifest.runtime).toMatchObject({
      changeClass: 'none',
      run: false,
      runCommon: false,
      runUniversal: false,
      runNative: false,
      platforms: [],
    });
    expect(manifest.heavy.run).toBe(false);
  });

  it('runs only universal/common closure for universal JavaScript changes', () => {
    const manifest = buildChangeManifest({
      ...identity,
      draft: false,
      changedPaths: ['packages/game-runtime/universal/src/index.ts'],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });

    expect(manifest.mode).toBe('full');
    expect(manifest.runtime).toMatchObject({
      changeClass: 'universal-js',
      run: true,
      runCommon: false,
      runUniversal: true,
      runNative: false,
      platforms: [],
    });
  });

  it('runs common and universal without native platforms for common-only changes', () => {
    const manifest = buildChangeManifest({
      ...identity,
      draft: false,
      changedPaths: ['packages/game-runtime/common/src/index.ts'],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });

    expect(manifest.runtime).toMatchObject({
      changeClass: 'common',
      runCommon: true,
      runUniversal: true,
      runNative: false,
      platforms: [],
    });
  });

  it('expands a platform change only to that platform and shared dependencies', () => {
    const manifest = buildChangeManifest({
      ...identity,
      draft: false,
      changedPaths: ['packages/game-runtime/darwin-arm64/build.mjs'],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });

    expect(manifest.runtime).toMatchObject({
      changeClass: 'platform-specific',
      runCommon: true,
      runUniversal: true,
      runNative: true,
      platforms: ['darwin-arm64'],
    });
  });

  it('fails closed to the full matrix for workflow, security, release, and non-PR events', () => {
    for (const changedPaths of [
      ['.github/workflows/ci.yml'],
      ['bun.lock'],
      ['packages/editor'],
    ]) {
      const manifest = buildChangeManifest({
        ...identity,
        draft: false,
        changedPaths,
        inputDigest: `sha256:${'c'.repeat(64)}`,
      });
      expect(manifest.runtime.changeClass).toBe('full-release');
      expect(manifest.runtime.platforms).toEqual(['darwin-arm64', 'win32-x64', 'linux-x64']);
    }

    const security = buildChangeManifest({
      ...identity,
      draft: false,
      changedPaths: ['scripts/check-release-secrets.mjs'],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(security.runtime.changeClass).toBe('packaging-security');
    expect(security.runtime.platforms).toEqual(['darwin-arm64', 'win32-x64', 'linux-x64']);

    const push = buildChangeManifest({
      ...identity,
      eventName: 'push',
      draft: false,
      changedPaths: [],
      inputDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(push.runtime.changeClass).toBe('full-release');
  });

  it('makes inputDigest sensitive to every declared prepared-input identity', () => {
    const base: InputDigestFacts = {
      headSha: 'a'.repeat(40),
      recursiveGitlinks: ['packages/editor d4a93f46c369a21310a5a2ff6c8ed33449b4f4c8'],
      lockfileDigest: `sha256:${'b'.repeat(64)}`,
      toolchain: { bun: '1.3.14', node: '22', pnpm: '11.7.0' },
      trustScope: 'ordinary-ci',
    };
    const baseline = computeInputDigest(base);
    expect(baseline).toMatch(/^sha256:[a-f0-9]{64}$/);

    for (const changed of [
      { ...base, headSha: 'c'.repeat(40) },
      { ...base, recursiveGitlinks: ['packages/editor deadbeef'] },
      { ...base, lockfileDigest: `sha256:${'d'.repeat(64)}` },
      { ...base, toolchain: { ...base.toolchain, bun: '1.3.15' } },
      { ...base, trustScope: 'trusted-base-ci' },
    ]) {
      expect(computeInputDigest(changed)).not.toBe(baseline);
    }
  });
});
