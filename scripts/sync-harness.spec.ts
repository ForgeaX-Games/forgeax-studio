// @ts-nocheck
// Verifies scripts/sync-harness.mjs's resolveCloneUrl branch table without
// touching the network or a real SSH agent.
import { describe, expect, it } from 'bun:test';
import { resolveCloneUrl } from './sync-harness.mjs';

const trueProbe = () => true;
const falseProbe = () => false;
const captureWarn = () => {
  const buf: string[] = [];
  return { warn: (msg: string) => buf.push(msg), buf };
};

describe('sync-harness resolveCloneUrl', () => {
  const HTTPS = 'https://github.com/ForgeaX-Games/forgeax-studio-harness.git';

  it('non-github url: returned unchanged, https-noauth', () => {
    const { warn } = captureWarn();
    const r = resolveCloneUrl('https://gitlab.example/foo.git', {}, trueProbe, warn);
    expect(r).toEqual({ url: 'https://gitlab.example/foo.git', strategy: 'https-noauth' });
  });

  it('SSH probe true: HTTPS → git@github.com:...', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, {}, trueProbe, warn);
    expect(r.strategy).toBe('ssh');
    expect(r.url).toBe('git@github.com:ForgeaX-Games/forgeax-studio-harness.git');
    expect(buf).toEqual([]);
  });

  it('SSH probe false + GH_TOKEN: HTTPS → https://x-access-token:TOK@github.com/...', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, { GH_TOKEN: 'ghp_pat' }, falseProbe, warn);
    expect(r.strategy).toBe('pat');
    expect(r.url).toBe('https://x-access-token:ghp_pat@github.com/ForgeaX-Games/forgeax-studio-harness.git');
    expect(buf).toEqual([]);
  });

  it('SSH probe false + GITHUB_TOKEN (fallback env name): PAT rewrite', () => {
    const { warn } = captureWarn();
    const r = resolveCloneUrl(HTTPS, { GITHUB_TOKEN: 'ghs_pat' }, falseProbe, warn);
    expect(r.strategy).toBe('pat');
    expect(r.url).toBe('https://x-access-token:ghs_pat@github.com/ForgeaX-Games/forgeax-studio-harness.git');
  });

  it('SSH probe false + no token: original HTTPS, https-noauth, warns exactly once', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, {}, falseProbe, warn);
    expect(r).toEqual({ url: HTTPS, strategy: 'https-noauth' });
    expect(buf).toHaveLength(1);
    expect(buf[0]).toMatch(/no GitHub SSH key or GH_TOKEN detected/);
  });
});
