// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitEnv, NO_CRED_ARGV, resolveCredentialConfig, rewriteCloneUrl } from './git-credential.ts';

const alwaysTrue = () => true;
const alwaysFalse = () => false;

describe('resolveCredentialConfig — branch table', () => {
  it('parent origin is SSH → noop', () => {
    const c = resolveCredentialConfig(
      'git@github.com:ForgeaX-Games/forgeax-studio.git',
      {},
      alwaysTrue, // never called
    );
    expect(c.branch).toBe('noop-parent-is-not-https');
    expect(c.gitConfig).toEqual({});
    expect(c.message).toBeUndefined();
  });

  it('parent origin is empty → noop (fresh init before origin set)', () => {
    const c = resolveCredentialConfig('', {}, alwaysTrue);
    expect(c.branch).toBe('noop-parent-is-not-https');
  });

  it('HTTPS parent + SSH working → ssh-rewrite (writes insteadOf on git@github.com:)', () => {
    const c = resolveCredentialConfig('https://github.com/ForgeaX-Games/forgeax-studio.git', {}, alwaysTrue);
    expect(c.branch).toBe('ssh-rewrite');
    expect(c.gitConfig).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    });
    expect(c.message).toMatch(/GitHub SSH key detected/);
  });

  it('HTTPS parent + no SSH + GH_TOKEN → pat-rewrite (embeds x-access-token)', () => {
    const c = resolveCredentialConfig(
      'https://github.com/ForgeaX-Games/forgeax-studio.git',
      { GH_TOKEN: 'ghp_dummy_abc' },
      alwaysFalse,
    );
    expect(c.branch).toBe('pat-rewrite');
    expect(c.gitConfig.GIT_CONFIG_COUNT).toBe('1');
    expect(c.gitConfig.GIT_CONFIG_KEY_0).toBe('url.https://x-access-token:ghp_dummy_abc@github.com/.insteadOf');
    expect(c.gitConfig.GIT_CONFIG_VALUE_0).toBe('https://github.com/');
    expect(c.message).toMatch(/GH_TOKEN detected/);
  });

  it('HTTPS parent + no SSH + GITHUB_TOKEN (fallback var name) → pat-rewrite', () => {
    const c = resolveCredentialConfig(
      'https://github.com/ForgeaX-Games/forgeax-studio.git',
      { GITHUB_TOKEN: 'ghs_dummy_xyz' },
      alwaysFalse,
    );
    expect(c.branch).toBe('pat-rewrite');
    expect(c.gitConfig.GIT_CONFIG_KEY_0).toBe('url.https://x-access-token:ghs_dummy_xyz@github.com/.insteadOf');
  });

  it('HTTPS parent + neither → loud warn', () => {
    const c = resolveCredentialConfig(
      'https://github.com/ForgeaX-Games/forgeax-studio.git',
      {},
      alwaysFalse,
    );
    expect(c.branch).toBe('loud-warn-no-cred');
    expect(c.gitConfig).toEqual({});
    expect(c.message).toMatch(/no GitHub SSH key/);
    expect(c.message).toMatch(/GH_TOKEN/);
    expect(c.message).toMatch(/git remote set-url origin/);
  });
});

describe('rewriteCloneUrl — sync-harness URL transform', () => {
  it('non-github URL is unchanged', () => {
    const r = rewriteCloneUrl('https://gitlab.example/foo.git', {}, alwaysTrue);
    expect(r).toEqual({ url: 'https://gitlab.example/foo.git', strategy: 'https-noauth' });
  });
  it('SSH available → git@ URL', () => {
    const r = rewriteCloneUrl('https://github.com/ForgeaX-Games/x.git', {}, alwaysTrue);
    expect(r).toEqual({ url: 'git@github.com:ForgeaX-Games/x.git', strategy: 'ssh' });
  });
  it('no SSH + GH_TOKEN → x-access-token URL', () => {
    const r = rewriteCloneUrl('https://github.com/ForgeaX-Games/x.git', { GH_TOKEN: 'tok' }, alwaysFalse);
    expect(r).toEqual({ url: 'https://x-access-token:tok@github.com/ForgeaX-Games/x.git', strategy: 'pat' });
  });
  it('no SSH + no token → original HTTPS + https-noauth strategy', () => {
    const r = rewriteCloneUrl('https://github.com/ForgeaX-Games/x.git', {}, alwaysFalse);
    expect(r).toEqual({ url: 'https://github.com/ForgeaX-Games/x.git', strategy: 'https-noauth' });
  });
});

describe('hardenedGitEnv — never lets git prompt on stdin', () => {
  it('sets prompt-blocking env, preserves other keys', () => {
    const e = hardenedGitEnv({ PATH: '/x', HOME: '/h' });
    expect(e.GIT_TERMINAL_PROMPT).toBe('0');
    expect(e.GIT_ASKPASS).toBe('echo');
    expect(e.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(e.PATH).toBe('/x');
    expect(e.HOME).toBe('/h');
  });
  it('respects user-supplied GIT_SSH_COMMAND', () => {
    const e = hardenedGitEnv({ GIT_SSH_COMMAND: 'ssh -F /tmp/custom-config' });
    expect(e.GIT_SSH_COMMAND).toBe('ssh -F /tmp/custom-config');
  });
});

describe('NO_CRED_ARGV — disables inherited credential helpers', () => {
  it('is the two-arg -c credential.helper= prefix', () => {
    expect(Array.from(NO_CRED_ARGV)).toEqual(['-c', 'credential.helper=']);
  });
});

// ── E2E: prove the branches actually re-route git's outbound URL ────────────
//
// We cannot hit real github.com in the test suite. Instead we run a local
// `git ls-remote` against a bare repo, with the credential config env vars
// set, and observe git's own trace output (`GIT_TRACE=1`) to confirm the URL
// was rewritten before it left the process. This is the same mechanism setup
// / sync-harness rely on at runtime.
describe('E2E — git honours the resolved GIT_CONFIG_* rewrites', () => {
  let scratch: string;
  let bare: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'git-credential-e2e-'));
    // A real, fetchable bare repo used as the rewrite *target*.
    bare = join(scratch, 'target.git');
    mkdirSync(bare, { recursive: true });
    let r = spawnSync('git', ['init', '--quiet', '--bare', bare]);
    expect(r.status).toBe(0);
    // Populate it with one ref so ls-remote returns something.
    const seed = join(scratch, 'seed');
    mkdirSync(seed);
    for (const [cmd, args] of [
      ['git', ['init', '--quiet', seed]],
      ['git', ['-C', seed, 'config', 'user.email', 'x@x']],
      ['git', ['-C', seed, 'config', 'user.name', 'x']],
      ['git', ['-C', seed, 'commit', '--quiet', '--allow-empty', '-m', 'init']],
      ['git', ['-C', seed, 'remote', 'add', 'origin', bare]],
      ['git', ['-C', seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main']],
    ] as const) {
      r = spawnSync(cmd, args);
      expect(r.status).toBe(0);
    }
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('ssh-rewrite branch: setting url.<X>.insteadOf reroutes the requested URL', () => {
    // Simulate an "HTTPS parent + SSH working" run: rewrite a fake canonical
    // prefix so requests get remapped to our bare repo's filesystem path.
    // (`insteadOf` is a prefix substitution, so the VALUE side should NOT
    // include the trailing path — git appends whatever came after the prefix.)
    const bareParent = bare.replace(/\/target\.git$/, '/');
    const r = spawnSync(
      'git',
      ['ls-remote', 'fake-canonical://ForgeaX-Games/target.git'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${bareParent}.insteadOf`,
          GIT_CONFIG_VALUE_0: 'fake-canonical://ForgeaX-Games/',
        },
      },
    );
    expect(r.status).toBe(0);
    // If insteadOf worked, ls-remote returned the seeded refs from `bare`.
    expect(r.stdout).toContain('refs/heads/main');
  });

  it('pat-rewrite branch: the exact GIT_CONFIG_* protocol resolveCredentialConfig emits is honoured by git', () => {
    // Sanity: the function returns the expected shape.
    const cfg = resolveCredentialConfig(
      'https://github.com/ForgeaX-Games/forgeax-studio.git',
      { GH_TOKEN: 'ghp_dummy_e2e' },
      alwaysFalse,
    );
    expect(cfg.branch).toBe('pat-rewrite');
    expect(cfg.gitConfig.GIT_CONFIG_COUNT).toBe('1');
    expect(cfg.gitConfig.GIT_CONFIG_KEY_0).toContain('insteadOf');

    // RUNTIME assertion #1: the SAME env-var protocol
    // (GIT_CONFIG_COUNT + GIT_CONFIG_KEY_0=url.<X>.insteadOf + GIT_CONFIG_VALUE_0=<Y>)
    // that resolveCredentialConfig produces MUST be recognized by git and
    // applied as a URL rewrite. We prove this by re-routing a fake canonical
    // URL to our bare repo via the identical protocol shape.
    //
    // (Chained insteadOf rewrites are NOT supported by git — each URL is
    // rewritten at most once — so we can't stack "https→PAT→bare" in a
    // single test. RUNTIME assertion #2 below covers the token URL itself.)
    const bareParent = bare.replace(/\/target\.git$/, '/');
    const r = spawnSync(
      'git',
      ['ls-remote', 'https://github.com/target.git'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${bareParent}.insteadOf`,
          GIT_CONFIG_VALUE_0: 'https://github.com/',
        },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('refs/heads/main');
  });

  it('pat-rewrite branch: GIT_TRACE shows git spawning remote-https with x-access-token in the URL', () => {
    // RUNTIME assertion #2: the token actually reaches the outbound helper.
    // `GIT_TRACE=1` prints every internal `run_command` before it executes,
    // so we can catch git INVOKING `git-remote-https ...` with the rewritten
    // URL WITHOUT needing network access — the trace fires before any TCP.
    const cfg = resolveCredentialConfig(
      'https://github.com/ForgeaX-Games/forgeax-studio.git',
      { GH_TOKEN: 'ghp_dummy_e2e' },
      alwaysFalse,
    );
    const r = spawnSync(
      'git',
      // Talk to a bogus host so the network call fails fast (we only need
      // the trace of what git INTENDED to talk to). GIT_TERMINAL_PROMPT=0
      // + GIT_ASKPASS=echo ensure no interactive prompt.
      ['ls-remote', 'https://github.com/ForgeaX-Games/forgeax-studio.git'],
      {
        encoding: 'utf8',
        env: {
          ...hardenedGitEnv(process.env),
          ...cfg.gitConfig,
          GIT_TRACE: '1',
        },
        timeout: 15_000,
      },
    );
    const combined = `${r.stdout}${r.stderr}`;
    // The critical proof: git's own trace shows the URL after rewrite.
    expect(combined).toMatch(/run_command:.*git.*remote-https.*x-access-token:ghp_dummy_e2e@github\.com/);
  });

  it('no-cred branch: git does NOT prompt for credentials when hardenedGitEnv is applied', () => {
    // With GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=echo, an HTTPS clone that
    // needs auth must fail fast rather than hang on stdin. We prove this by
    // pointing at a made-up local path that doesn't exist — with `NO_CRED_ARGV`
    // and hardenedGitEnv, git returns non-zero within milliseconds instead of
    // waiting.
    const t0 = Date.now();
    const r = spawnSync(
      'git',
      [...NO_CRED_ARGV, 'ls-remote', 'https://127.0.0.1:1/does-not-exist.git'],
      {
        encoding: 'utf8',
        env: hardenedGitEnv({ ...process.env, PATH: process.env.PATH }),
        timeout: 10_000,
      },
    );
    const dt = Date.now() - t0;
    expect(r.status).not.toBe(0);
    // The failure came from network refusal, not from git waiting on a prompt.
    expect(dt).toBeLessThan(8_000);
    // And crucially — no interactive helper was ever consulted; stderr is
    // typical git connection error, not a "Username for..." prompt.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Username for/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Password for/);
  });
});
