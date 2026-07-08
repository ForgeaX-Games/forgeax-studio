// scripts/lib/git-credential.ts — resolve the credential rewrite strategy
// setup.ts / sync-harness use before fetching private submodules & harness.
//
// Extracted for testability. The functions here take an explicit environment +
// probe callback so specs can exercise every branch without a real SSH key or
// a real GitHub token.

import { spawnSync } from 'node:child_process';

export type CredentialBranch =
  | 'noop-parent-is-not-https'
  | 'ssh-rewrite'
  | 'pat-rewrite'
  | 'loud-warn-no-cred';

export interface CredentialConfig {
  branch: CredentialBranch;
  /** Extra env vars to merge into the child git process. Empty when branch is `noop-*` or `loud-*`. */
  gitConfig: Record<string, string>;
  /** Human-readable line to print when the branch demands it (only `ssh-rewrite`, `pat-rewrite`, `loud-warn-no-cred` set this). */
  message?: string;
}

export type SshProbe = () => boolean;

/**
 * Decide how to teach child git processes to auth against GitHub.
 *
 * Contract:
 * - parent origin not HTTPS github.com → nothing to do (submodules resolve via SSH parent, no rewrite needed).
 * - HTTPS parent + SSH key working     → set `url.git@github.com:.insteadOf=https://github.com/`.
 * - HTTPS parent + no SSH + token      → set `url.https://x-access-token:$TOKEN@github.com/.insteadOf=https://github.com/`.
 * - HTTPS parent + neither             → return a loud warning; the caller keeps going and lets git fail-fast.
 *
 * The returned `gitConfig` uses git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_N` /
 * `GIT_CONFIG_VALUE_N` env-var protocol (documented in `git-config(1)`), which
 * is scoped to the invoking process only — no on-disk config is mutated and no
 * token is written anywhere.
 */
export function resolveCredentialConfig(
  parentOrigin: string,
  env: NodeJS.ProcessEnv,
  sshProbe: SshProbe,
): CredentialConfig {
  const parentIsHttps = /^https:\/\/github\.com\//i.test(parentOrigin);
  if (!parentIsHttps) return { branch: 'noop-parent-is-not-https', gitConfig: {} };

  if (sshProbe()) {
    return {
      branch: 'ssh-rewrite',
      gitConfig: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
      message: 'GitHub SSH key detected — using SSH for private submodules',
    };
  }

  const tok = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (tok) {
    return {
      branch: 'pat-rewrite',
      gitConfig: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.https://x-access-token:${tok}@github.com/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
      message: 'GH_TOKEN detected — using PAT for private submodules',
    };
  }

  return {
    branch: 'loud-warn-no-cred',
    gitConfig: {},
    message:
      'Parent repo cloned over HTTPS and no GitHub SSH key / GH_TOKEN found.\n' +
      '    Private submodule fetches will fail without a credential prompt (which is disabled).\n' +
      '    Fix one of:\n' +
      '      • Configure a GitHub SSH key (recommended), or\n' +
      '      • Export GH_TOKEN=<personal-access-token> and re-run, or\n' +
      '      • git remote set-url origin git@github.com:ForgeaX-Games/forgeax-studio.git',
  };
}

/** Real SSH probe used at runtime. Specs pass a stub instead. */
export function probeGitHubSsh(): boolean {
  const r = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', 'git@github.com'],
    { encoding: 'utf8' },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.includes('successfully authenticated');
}

/**
 * Base env every child git call in setup / sync-harness should inherit. Blocks
 * interactive TTY prompts, GUI credential helpers, and non-BatchMode SSH — all
 * so a misconfigured host **fails fast** instead of hanging on stdin.
 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

/** Prefix that neutralises any system credential helper for one git invocation. */
export const NO_CRED_ARGV = ['-c', 'credential.helper='] as const;

/**
 * Rewrite an HTTPS github.com URL into whatever form the caller can auth against
 * *right now*: SSH if a key is present, PAT if a token is exported, else the
 * original HTTPS (the caller must be prepared for git to fail fast).
 *
 * This is the same policy as `resolveCredentialConfig`, but expressed as a URL
 * transform for scripts (sync-harness) that build a clone URL up-front rather
 * than relying on git's insteadOf rewrite.
 *
 * Accepts already-tokenized inputs (`https://x-access-token:$OLD@github.com/…`)
 * — strips the embedded token before re-injecting the current one, so a token
 * rotation actually takes effect on a repo cloned with a stale PAT baked into
 * its remote URL.
 */
export function rewriteCloneUrl(
  httpsUrl: string,
  env: NodeJS.ProcessEnv,
  sshProbe: SshProbe,
): { url: string; strategy: 'ssh' | 'pat' | 'https-noauth' } {
  // Normalize away any pre-embedded token so downstream rewrites operate on a
  // clean `https://github.com/…` shape.
  const canonical = httpsUrl.replace(
    /^https:\/\/x-access-token:[^@]+@github\.com\//,
    'https://github.com/',
  );
  if (!canonical.startsWith('https://github.com/')) return { url: httpsUrl, strategy: 'https-noauth' };
  if (sshProbe()) return { url: canonical.replace('https://github.com/', 'git@github.com:'), strategy: 'ssh' };
  const tok = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (tok) {
    return {
      url: canonical.replace('https://github.com/', `https://x-access-token:${tok}@github.com/`),
      strategy: 'pat',
    };
  }
  return { url: canonical, strategy: 'https-noauth' };
}
