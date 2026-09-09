import { describe, expect, test } from 'bun:test';
import { CI_REQUIRED_CONTEXTS, type CiGovernanceExpectation } from './ci-contract.ts';
import { compareLiveRulesets, evaluateLiveRulesetResponse, probeLiveRulesets, type ObservedRuleset } from './ci-ruleset.ts';

const expected: CiGovernanceExpectation = {
  repository: 'ForgeaX-Games/forgeax-studio',
  ref: 'main',
  enforcement: 'active',
  strictRequiredStatusChecks: false,
  bypassActors: [],
  currentUserCanBypass: 'never',
};

function ruleset(overrides: Partial<ObservedRuleset> = {}): ObservedRuleset {
  return {
    id: '16532229',
    source: 'repository',
    enforcement: 'active',
    strictRequiredStatusChecks: false,
    bypassActors: [],
    currentUserCanBypass: 'never',
    appliesToRef: true,
    contexts: [...CI_REQUIRED_CONTEXTS],
    contextSource: 'repository:ruleset:16532229',
    ...overrides,
  };
}

describe('read-only live ruleset probe', () => {
  test('reports an unavailable GitHub CLI as a transport failure instead of HTTP 0', () => {
    const result = evaluateLiveRulesetResponse({
      repository: expected.repository,
      ref: expected.ref,
      response: {
        status: 0,
        body: null,
        request: { path: '/repos/ForgeaX-Games/forgeax-studio/rulesets', method: 'GET' },
        transportError: { code: 'ENOENT', message: 'spawnSync gh ENOENT' },
      },
    });
    expect(result.status).toBe('unverified');
    expect(result.code).toBe('recursive-input.ci.live-ruleset-transport-unavailable');
    expect(result.actual).toHaveProperty('response.code', 'ENOENT');
  });

  test('fails closed for every required-context and governance drift class', () => {
    const result = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: '2026-08-10T00:00:00Z', responseIdentity: 'fresh-response', rulesets: [ruleset()] }, expected);
    expect(result.status).toBe('aligned');
    expect(result.observation?.responseIdentity).toBe('fresh-response');
    expect(result.recoveryActions).toEqual([]);

    const missing = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'missing', rulesets: [ruleset({ contexts: CI_REQUIRED_CONTEXTS.slice(0, -1) })] }, expected);
    expect(missing.status).toBe('misaligned');
    expect(missing.actual).toHaveProperty('missing', [CI_REQUIRED_CONTEXTS.at(-1)]);

    const extra = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'extra', rulesets: [ruleset({ contexts: [...CI_REQUIRED_CONTEXTS, 'unowned'] })] }, expected);
    expect(extra.status).toBe('misaligned');
    expect(extra.actual).toHaveProperty('extra', ['unowned']);

    const renamed = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'renamed', rulesets: [ruleset({ contexts: ['renamed', ...CI_REQUIRED_CONTEXTS.slice(1)] })] }, expected);
    expect(renamed.status).toBe('misaligned');
    expect(renamed.actual).toHaveProperty('missing', [CI_REQUIRED_CONTEXTS[0]]);
    expect(renamed.actual).toHaveProperty('extra', ['renamed']);

    const duplicate = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'duplicate', rulesets: [ruleset({ contexts: [...CI_REQUIRED_CONTEXTS, CI_REQUIRED_CONTEXTS[0]] })] }, expected);
    expect(duplicate.status).toBe('misaligned');
    expect(duplicate.actual).toHaveProperty('duplicate', [{ context: CI_REQUIRED_CONTEXTS[0], sources: ['repository:ruleset:16532229', 'repository:ruleset:16532229'] }]);

    const shadowed = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'shadowed', rulesets: [ruleset(), ruleset({ id: 'shadow', source: 'organization', contextSource: 'organization:ruleset:shadow', contexts: [CI_REQUIRED_CONTEXTS[0]] })] }, expected);
    expect(shadowed.status).toBe('misaligned');
    expect(shadowed.actual).toHaveProperty('duplicate', [expect.objectContaining({ context: CI_REQUIRED_CONTEXTS[0] })]);

    const inactive = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'inactive', rulesets: [ruleset({ enforcement: 'evaluate' })] }, expected);
    expect(inactive.status).toBe('misaligned');
    expect(inactive.actual).toHaveProperty('enforcement', [{ id: '16532229', source: 'repository', enforcement: 'evaluate' }]);

    const strict = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'strict', rulesets: [ruleset({ strictRequiredStatusChecks: true })] }, expected);
    expect(strict.status).toBe('misaligned');
    expect(strict.actual).toHaveProperty('strictRequiredStatusChecks', [true]);

    const bypass = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'bypass', rulesets: [ruleset({ bypassActors: ['actor:1'] })] }, expected);
    expect(bypass.status).toBe('misaligned');
    expect(bypass.actual).toHaveProperty('bypass', [{ ruleset: '16532229', actor: 'actor:1' }]);

    const bypassCapability = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'bypass-capability', rulesets: [ruleset({ currentUserCanBypass: 'always' })] }, expected);
    expect(bypassCapability.status).toBe('misaligned');
    expect(bypassCapability.actual).toHaveProperty('bypassCapability', [{ id: '16532229', value: 'always' }]);
  });

  test('returns unverified for authentication failure and sends only GET requests', async () => {
    const http = evaluateLiveRulesetResponse({
      repository: expected.repository,
      ref: expected.ref,
      response: { status: 403, body: { message: 'forbidden' }, request: { path: '/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true', method: 'GET' } },
    });
    expect(http.status).toBe('unverified');
    expect(http.recoveryActions.every((action) => action.argv || action.manualHandoff)).toBe(true);

    const paths: string[] = [];
    const probe = await probeLiveRulesets({
      repository: expected.repository,
      now: () => '2026-08-10T00:00:00Z',
      client: { get: async (path) => { paths.push(path); return { status: 200, body: [], request: { path, method: 'GET' } }; } },
    });
    expect(probe.status).toBe('misaligned');
    expect(paths).toEqual(['/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true']);
  });

  test('resolves repository and inherited rulesets through the repository applicable view', async () => {
    const paths: string[] = [];
    const repositoryDetail = {
      id: 16532229,
      source_type: 'Repository',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: CI_REQUIRED_CONTEXTS.map((context) => ({ context })) } }],
      bypass_actors: [],
      current_user_can_bypass: 'never',
    };
    const organizationDetail = {
      id: 16532053,
      source_type: 'Organization',
      enforcement: 'active',
      conditions: { ref_name: { include: [], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
      bypass_actors: [],
    };
    const bodies: Record<string, unknown> = {
      '/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true': [{ id: 16532229 }, { id: 16532053 }],
      '/repos/ForgeaX-Games/forgeax-studio/rulesets/16532229?includes_parents=true': repositoryDetail,
      '/repos/ForgeaX-Games/forgeax-studio/rulesets/16532053?includes_parents=true': organizationDetail,
    };
    const result = await probeLiveRulesets({
      repository: expected.repository,
      now: () => '2026-08-10T00:00:00Z',
      client: { get: async (path) => { paths.push(path); return { status: 200, body: bodies[path], request: { path, method: 'GET' } }; } },
    });
    expect(result.status).toBe('aligned');
    expect(result.observation?.rulesets.find((item) => item.source === 'repository')?.contexts).toEqual([...CI_REQUIRED_CONTEXTS]);
    expect(result.observation?.rulesets.find((item) => item.source === 'organization')?.currentUserCanBypass).toBe('never');
    expect(paths).toEqual(Object.keys(bodies));
    expect(paths.some((path) => path.startsWith('/orgs/'))).toBe(false);
  });

  test('fails closed when a listed ruleset detail cannot be read', async () => {
    const result = await probeLiveRulesets({
      repository: expected.repository,
      client: { get: async (path) => ({
        status: path.includes('/rulesets/16532229') ? 404 : 200,
        body: path.endsWith('/rulesets?includes_parents=true') ? [{ id: 16532229 }] : { id: 16532229, source_type: 'Repository' },
        request: { path, method: 'GET' },
      }) },
    });
    expect(result.status).toBe('unverified');
    expect(result.code).toBe('recursive-input.ci.live-ruleset-http-404');
  });

  test('fails closed for incomplete or non-read-only live responses', () => {
    const incomplete = evaluateLiveRulesetResponse({
      repository: expected.repository,
      ref: expected.ref,
      response: { status: 200, body: {}, request: { path: '/rulesets', method: 'GET' } },
    });
    expect(incomplete.status).toBe('unverified');
    expect(incomplete.code).toBe('recursive-input.ci.live-ruleset-incomplete-response');
    expect(incomplete.expected).toHaveProperty('readOnly', true);

    const mutating = evaluateLiveRulesetResponse({
      repository: expected.repository,
      ref: expected.ref,
      response: { status: 200, body: [], request: { path: '/rulesets', method: 'POST' as 'GET' } },
    });
    expect(mutating.status).toBe('unverified');
    expect(mutating.code).toBe('recursive-input.ci.live-ruleset-non-readonly-request');
  });

  test('fails closed when an applicable ruleset does not identify its governance source', () => {
    const result = evaluateLiveRulesetResponse({
      repository: expected.repository,
      ref: expected.ref,
      response: {
        status: 200,
        body: [{ id: 16532229, enforcement: 'active', rules: [], bypass_actors: [], current_user_can_bypass: 'never' }],
        request: { path: '/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true', method: 'GET' },
      },
    });
    expect(result.status).toBe('unverified');
    expect(result.code).toBe('recursive-input.ci.live-ruleset-incomplete-response');
  });
});
