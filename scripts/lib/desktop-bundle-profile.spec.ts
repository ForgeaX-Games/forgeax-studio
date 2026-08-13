import { describe, expect, it } from 'bun:test';
import {
  assertDesktopBundleManifest,
  desktopBundleCapabilities,
  desktopBundleManifest,
  desktopBundleServerProfile,
  resolveDesktopBundleProfile,
} from './desktop-bundle-profile.ts';

describe('desktop bundle profile', () => {
  it('defaults to full and accepts only the two explicit profile ids', () => {
    expect(resolveDesktopBundleProfile({})).toBe('full');
    expect(resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: '' })).toBe('full');
    expect(resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: 'lite' })).toBe('lite');
    expect(resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: 'full' })).toBe('full');
    expect(resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: ' lite ' })).toBe('lite');
  });

  it('fails explicitly for an unknown profile', () => {
    expect(() => resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: 'lightweight' }))
      .toThrow('FORGEAX_DESKTOP_BUNDLE must be one of lite, full');
    expect(() => resolveDesktopBundleProfile({ FORGEAX_DESKTOP_BUNDLE: 'FULL' }))
      .toThrow('FORGEAX_DESKTOP_BUNDLE must be one of lite, full');
  });

  it('maps each desktop bundle to its packaged server role', () => {
    expect(desktopBundleServerProfile('lite')).toBe('base');
    expect(desktopBundleServerProfile('full')).toBe('auto');
    expect(desktopBundleServerProfile(resolveDesktopBundleProfile({}))).toBe('auto');
    expect(() => desktopBundleServerProfile('unknown' as never))
      .toThrow('desktop bundle profile must be one of lite, full');
  });

  it('keeps the capability shape stable across profiles', () => {
    expect(desktopBundleCapabilities('lite')).toEqual({
      sampleGames: false,
      productExtensions: false,
      productWorkbenchHost: false,
      agentExtensions: true,
    });
    expect(desktopBundleCapabilities('full')).toEqual({
      sampleGames: true,
      productExtensions: true,
      productWorkbenchHost: true,
      agentExtensions: true,
    });
    expect(Object.keys(desktopBundleCapabilities('lite')).sort()).toEqual(
      Object.keys(desktopBundleCapabilities('full')).sort(),
    );
  });

  it('emits and validates the stable manifest contract', () => {
    const manifest = desktopBundleManifest('full');
    expect(manifest).toEqual({
      schemaVersion: 1,
      id: 'full',
      capabilities: {
        sampleGames: true,
        productExtensions: true,
        productWorkbenchHost: true,
        agentExtensions: true,
      },
    });
    expect(() => assertDesktopBundleManifest(manifest)).not.toThrow();
    expect(() => assertDesktopBundleManifest({ ...manifest, id: 'unknown' })).toThrow('invalid');
    expect(() => assertDesktopBundleManifest({ ...manifest, unexpected: true })).toThrow('invalid');
    expect(() => assertDesktopBundleManifest({
      ...manifest,
      capabilities: { ...manifest.capabilities, sampleGames: false },
    })).toThrow('do not match');
  });
});
