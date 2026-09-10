import { afterEach, describe, expect, test } from 'bun:test';
import { buildAuthorization, cosHost, presignGetUrl, resolveCosConfig } from '../src/gen/cos';

const COS_VARS = ['FORGEAX_COS_BUCKET', 'FORGEAX_COS_REGION', 'FORGEAX_COS_SECRET_ID', 'FORGEAX_COS_SECRET_KEY'] as const;
const ORIGINAL = Object.fromEntries(COS_VARS.map((k) => [k, process.env[k]] as const));

afterEach(() => {
  for (const k of COS_VARS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

const CFG = { bucket: 'demo-1250000000', region: 'ap-guangzhou', secretId: 'AKIDexample', secretKey: 'sekret' };

describe('resolveCosConfig', () => {
  test('is undefined until every variable is present', () => {
    for (const k of COS_VARS) delete process.env[k];
    expect(resolveCosConfig()).toBeUndefined();
    process.env.FORGEAX_COS_BUCKET = CFG.bucket;
    process.env.FORGEAX_COS_REGION = CFG.region;
    process.env.FORGEAX_COS_SECRET_ID = CFG.secretId;
    expect(resolveCosConfig()).toBeUndefined();
    process.env.FORGEAX_COS_SECRET_KEY = CFG.secretKey;
    expect(resolveCosConfig()).toEqual(CFG);
  });
});

describe('COS v5 signing', () => {
  test('host follows the bucket.cos.region.myqcloud.com shape', () => {
    expect(cosHost(CFG)).toBe('demo-1250000000.cos.ap-guangzhou.myqcloud.com');
  });

  test('authorization is deterministic and carries the expected fields for a fixed clock', () => {
    const now = 1_700_000_000;
    const auth = buildAuthorization(CFG, { method: 'get', pathname: '/a/b.png', nowSec: now, expiresSec: 3600 });
    const again = buildAuthorization(CFG, { method: 'get', pathname: '/a/b.png', nowSec: now, expiresSec: 3600 });
    expect(auth).toBe(again);
    const parsed = Object.fromEntries(auth.split('&').map((p) => p.split('=') as [string, string]));
    expect(parsed['q-ak']).toBe(CFG.secretId);
    expect(parsed['q-sign-algorithm']).toBe('sha1');
    expect(parsed['q-sign-time']).toBe(`${now - 60};${now + 3600}`);
    expect(parsed['q-key-time']).toBe(parsed['q-sign-time']);
    expect(parsed['q-signature']).toMatch(/^[a-f0-9]{40}$/);
  });

  test('presigned GET url points at the object and appends the signature', () => {
    const url = presignGetUrl(CFG, 'forgeax/demo/input.png', 3600, 1_700_000_000);
    expect(url.startsWith('https://demo-1250000000.cos.ap-guangzhou.myqcloud.com/forgeax/demo/input.png?')).toBe(true);
    expect(url).toContain('q-signature=');
    expect(url).toContain(`q-ak=${CFG.secretId}`);
  });
});
