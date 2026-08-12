import { describe, expect, test } from 'bun:test';
import { loadPlatformPackage, platformPackageName } from '../src/platform-map';

describe('Game Runtime Universal platform map', () => {
  test('maps exactly the three approved machines', () => {
    expect(platformPackageName({ platform: 'darwin', arch: 'arm64' })).toBe('@forgeax/game-runtime-darwin-arm64');
    expect(platformPackageName({ platform: 'win32', arch: 'x64' })).toBe('@forgeax/game-runtime-win32-x64');
    expect(platformPackageName({ platform: 'linux', arch: 'x64' })).toBe('@forgeax/game-runtime-linux-x64');
  });

  test('rejects unsupported platforms and architectures without fallback', () => {
    expect(() => platformPackageName({ platform: 'darwin', arch: 'x64' })).toThrow('unsupported Game Runtime platform: darwin/x64');
    expect(() => platformPackageName({ platform: 'linux', arch: 'arm64' })).toThrow('unsupported Game Runtime platform: linux/arm64');
    expect(() => platformPackageName({ platform: 'freebsd', arch: 'x64' })).toThrow('unsupported Game Runtime platform: freebsd/x64');
  });

  test('requests only the selected optional package', async () => {
    const requested: string[] = [];
    const module = { ensureRuntime: async () => 'runtime' };
    const loaded = await loadPlatformPackage({ platform: 'linux', arch: 'x64' }, async (name) => {
      requested.push(name);
      return module;
    });
    expect(requested).toEqual(['@forgeax/game-runtime-linux-x64']);
    expect(loaded).toBe(module);
  });

  test('diagnoses a missing optional package', async () => {
    await expect(loadPlatformPackage(
      { platform: 'win32', arch: 'x64' },
      async () => { throw new Error('ERR_MODULE_NOT_FOUND'); },
    )).rejects.toThrow('@forgeax/game-runtime-win32-x64 is not installed');
  });
});
