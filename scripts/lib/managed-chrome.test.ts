import { describe, expect, test } from 'bun:test';
import {
  findPageTarget,
  managedChromeProfile,
  reuseManagedChrome,
  wantsManagedChrome,
  type ChromeTarget,
} from './managed-chrome';

const page = (id: string, url: string): ChromeTarget => ({ id, type: 'page', url });

describe('managedChromeProfile', () => {
  test('uses an explicit isolation override', () => {
    expect(managedChromeProfile({ FORGEAX_CHROME_PROFILE: '/tmp/forgeax-browser-test' })).toBe('/tmp/forgeax-browser-test');
  });
});

describe('wantsManagedChrome', () => {
  test('keeps the signed-in user Chrome as the default', () => {
    expect(wantsManagedChrome([])).toBe(false);
    expect(wantsManagedChrome(['--managed'])).toBe(true);
  });
});

describe('findPageTarget', () => {
  test('matches the same Studio page with a trailing slash', () => {
    expect(findPageTarget([page('studio', 'http://localhost:18920/')], 'http://localhost:18920')?.id).toBe('studio');
  });

  test('does not select another Studio port', () => {
    expect(findPageTarget([page('other', 'http://localhost:38920/')], 'http://localhost:18920')).toBeNull();
  });
});

describe('reuseManagedChrome', () => {
  test('reports unavailable when no managed browser endpoint exists', async () => {
    expect(await reuseManagedChrome('/path/that/does/not/exist', 'http://localhost:18920')).toBe('unavailable');
  });
});
