import { describe, expect, test } from 'bun:test';
import { CI_REQUIRED_CONTEXTS, type CiGovernanceExpectation } from './ci-contract.ts';
import { compareLiveRulesets, evaluateLiveRulesetResponses, probeLiveRulesets, type ObservedRuleset } from './ci-ruleset.ts';

const expected: CiGovernanceExpectation = {
  repository: 'ForgeaX-Games/forgeax-studio',
  ref: 'main',
  enforcement: 'active',
  bypassActors: [],
  currentUserCanBypass: 'never',
};

function ruleset(overrides: Partial<ObservedRuleset> = {}): ObservedRuleset {
  return {
    id: '16532229',
    source: 'repository',
    enforcement: 'active',
    bypassActors: [],
    currentUserCanBypass: 'never',
    appliesToRef: true,
    contexts: [...CI_REQUIRED_CONTEXTS],
    contextSource: 'repository:ruleset:16532229',
    ...overrides,
  };
}

describe('read-only live ruleset probe', () => {
  test('aligns only one unambiguous active source for every exact context', () => {
    const result = compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: '2026-08-10T00:00:00Z', responseIdentity: 'fresh-response', rulesets: [ruleset()] }, expected);
    expect(result.status).toBe('aligned');
    expect(result.observation?.responseIdentity).toBe('fresh-response');
    expect(result.recoveryActions).toEqual([]);

    expect(compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'r2', rulesets: [ruleset({ contexts: [...CI_REQUIRED_CONTEXTS, 'renamed'] })] }, expected).status).toBe('misaligned');
    expect(compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'r3', rulesets: [ruleset(), ruleset({ id: 'shadow', contextSource: 'organization:ruleset:shadow' })] }, expected).status).toBe('misaligned');
    expect(compareLiveRulesets({ repository: expected.repository, ref: expected.ref, observedAt: 'now', responseIdentity: 'r4', rulesets: [ruleset({ enforcement: 'evaluate' })] }, expected).status).toBe('misaligned');
  });

  test('returns unverified for authentication failure and sends only GET requests', async () => {
    const http = evaluateLiveRulesetResponses({ repository: expected.repository, ref: expected.ref, responses: [
      { source: 'repository', response: { status: 403, body: { message: 'forbidden' }, request: { path: '/repos/ForgeaX-Games/forgeax-studio/rulesets', method: 'GET' } } },
      { source: 'organization', response: { status: 200, body: [], request: { path: '/orgs/ForgeaX-Games/rulesets', method: 'GET' } } },
    ] });
    expect(http.status).toBe('unverified');
    expect(http.recoveryActions.every((action) => action.argv || action.manualHandoff)).toBe(true);

    const paths: string[] = [];
    const probe = await probeLiveRulesets({
      repository: expected.repository,
      now: () => '2026-08-10T00:00:00Z',
      client: { get: async (path) => { paths.push(path); return { status: 200, body: [], request: { path, method: 'GET' } }; } },
    });
    expect(probe.status).toBe('misaligned');
    expect(paths).toEqual([
      '/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true',
      '/orgs/ForgeaX-Games/rulesets?includes_parents=true',
    ]);
  });

  test('resolves metadata-only lists through source-specific detail reads', async () => {
    const paths: string[] = [];
    const repositoryDetail = {
      id: 16532229,
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: CI_REQUIRED_CONTEXTS.map((context) => ({ context })) } }],
      bypass_actors: [],
      current_user_can_bypass: 'never',
    };
    const organizationDetail = {
      id: 16532053,
      enforcement: 'active',
      conditions: { ref_name: { include: [], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
      bypass_actors: [],
    };
    const bodies: Record<string, unknown> = {
      '/repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true': [{ id: 16532229 }],
      '/orgs/ForgeaX-Games/rulesets?includes_parents=true': [{ id: 16532053 }],
      '/repos/ForgeaX-Games/forgeax-studio/rulesets/16532229': repositoryDetail,
      '/orgs/ForgeaX-Games/rulesets/16532053': organizationDetail,
    };
    const result = await probeLiveRulesets({
      repository: expected.repository,
      now: () => '2026-08-10T00:00:00Z',
      client: { get: async (path) => { paths.push(path); return { status: 200, body: bodies[path], request: { path, method: 'GET' } }; } },
    });
    expect(result.status).toBe('aligned');
    expect(result.observation?.rulesets.find((item) => item.source === 'repository')?.contexts).toEqual([...CI_REQUIRED_CONTEXTS]);
    expect(result.observation?.rulesets.find((item) => item.source === 'organization')?.currentUserCanBypass).toBe('never');
    expect(paths).toEqual(expect.arrayContaining(Object.keys(bodies)));
  });

  test('fails closed when a listed ruleset detail cannot be read', async () => {
    const result = await probeLiveRulesets({
      repository: expected.repository,
      client: { get: async (path) => ({
        status: path.includes('/rulesets/16532229') ? 404 : 200,
        body: path.includes('?includes_parents=true') ? [{ id: path.startsWith('/repos/') ? 16532229 : 16532053 }] : { id: 16532053 },
        request: { path, method: 'GET' },
      }) },
    });
    expect(result.status).toBe('unverified');
    expect(result.code).toBe('recursive-input.ci.live-ruleset-http-404');
  });

  test('fails closed for incomplete or non-read-only live responses', () => {
    const incomplete = evaluateLiveRulesetResponses({
      repository: expected.repository,
      ref: expected.ref,
      responses: [
        { source: 'repository', response: { status: 200, body: {}, request: { path: '/rulesets', method: 'GET' } } },
        { source: 'organization', response: { status: 200, body: [], request: { path: '/rulesets', method: 'GET' } } },
      ],
    });
    expect(incomplete.status).toBe('unverified');
    expect(incomplete.code).toBe('recursive-input.ci.live-ruleset-incomplete-response');
    expect(incomplete.expected).toHaveProperty('readOnly', true);

    const mutating = evaluateLiveRulesetResponses({
      repository: expected.repository,
      ref: expected.ref,
      responses: [
        { source: 'repository', response: { status: 200, body: [], request: { path: '/rulesets', method: 'GET' } } },
        { source: 'organization', response: { status: 200, body: [], request: { path: '/rulesets', method: 'POST' as 'GET' } } },
      ],
    });
    expect(mutating.status).toBe('unverified');
    expect(mutating.code).toBe('recursive-input.ci.live-ruleset-non-readonly-request');
  });
});
