import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CI_REQUIRED_CONTEXTS, type CiGovernanceExpectation, type CiManifest } from './ci-contract.ts';

export type RulesetRequest = {
  path: string;
  method: 'GET';
  headers?: Record<string, string>;
};

export type RulesetResponse = {
  status: number;
  body: unknown;
  request: RulesetRequest;
  requests?: RulesetRequest[];
};

export type RulesetClient = {
  get(path: string): Promise<RulesetResponse>;
};

export type ObservedRuleset = {
  id: string;
  source: 'repository' | 'organization';
  name?: string;
  enforcement: string;
  bypassActors: string[];
  currentUserCanBypass: string;
  appliesToRef: boolean;
  contexts: string[];
  contextSource: string;
};

export type LiveRulesetObservation = {
  repository: string;
  ref: string;
  observedAt: string;
  responseIdentity: string;
  rulesets: ObservedRuleset[];
};

export type LiveRulesetResult = {
  status: 'aligned' | 'misaligned' | 'unverified';
  code: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  observation?: LiveRulesetObservation;
  recoveryActions: Array<{ actionId: string; argv?: string[]; manualHandoff?: string }>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item : record(item).context).filter((item): item is string => typeof item === 'string');
}

function appliesToRef(conditions: Record<string, unknown>, ref: string): boolean {
  const refs = record(conditions.ref_name);
  const include = stringList(refs.include);
  if (include.length === 0) return true;
  return include.includes(ref) || include.includes(`refs/heads/${ref}`) || include.includes('~ALL') || include.includes('~DEFAULT_BRANCH');
}

function parseRuleset(value: unknown, source: 'repository' | 'organization', ref: string): ObservedRuleset | undefined {
  const input = record(value);
  if (typeof input.id !== 'number' && typeof input.id !== 'string') return undefined;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const required = rules.filter((rule) => record(rule).type === 'required_status_checks');
  const contexts = required.flatMap((rule) => stringList(record(record(rule).parameters).required_status_checks));
  const conditions = record(input.conditions);
  return {
    id: String(input.id),
    source,
    name: typeof input.name === 'string' ? input.name : undefined,
    enforcement: typeof input.enforcement === 'string' ? input.enforcement : 'unknown',
    bypassActors: Array.isArray(input.bypass_actors) ? input.bypass_actors.map((actor) => JSON.stringify(actor)).sort() : [],
    currentUserCanBypass: typeof input.current_user_can_bypass === 'string'
      ? input.current_user_can_bypass
      : Array.isArray(input.bypass_actors) && input.bypass_actors.length === 0 ? 'never' : 'unknown',
    appliesToRef: appliesToRef(conditions, ref),
    contexts,
    contextSource: `${source}:ruleset:${String(input.id)}`,
  };
}

function requestsOf(response: RulesetResponse): RulesetRequest[] {
  return response.requests ?? [response.request];
}

function rulesetDetailPath(repository: string, source: 'repository' | 'organization', id: string): string {
  return source === 'repository'
    ? `/repos/${repository}/rulesets/${id}`
    : `/orgs/${repository.split('/')[0]}/rulesets/${id}`;
}

function listedRulesetIds(response: RulesetResponse): string[] | undefined {
  if (!Array.isArray(response.body)) return undefined;
  const ids = response.body.map((item) => record(item).id);
  if (ids.some((id) => typeof id !== 'number' && typeof id !== 'string')) return undefined;
  return ids.map(String);
}

async function resolveRulesetDetails(
  repository: string,
  source: 'repository' | 'organization',
  response: RulesetResponse,
  client: RulesetClient,
): Promise<RulesetResponse> {
  const ids = listedRulesetIds(response);
  if (ids === undefined || response.status < 200 || response.status >= 300) return response;
  const detailRequests = ids.map((id) => ({ path: rulesetDetailPath(repository, source, id), method: 'GET' as const }));
  const details = await Promise.all(detailRequests.map((request) => client.get(request.path)));
  const allRequests = [...requestsOf(response), ...details.flatMap(requestsOf)];
  const bad = details.find((detail) => detail.status < 200 || detail.status >= 300);
  if (bad) return { status: bad.status, body: bad.body, request: response.request, requests: allRequests };
  return { status: 200, body: details.map((detail) => detail.body), request: response.request, requests: allRequests };
}

function resolveRulesetDetailsSync(
  repository: string,
  source: 'repository' | 'organization',
  response: RulesetResponse,
  get: (path: string) => RulesetResponse,
): RulesetResponse {
  const ids = listedRulesetIds(response);
  if (ids === undefined || response.status < 200 || response.status >= 300) return response;
  const detailRequests = ids.map((id) => ({ path: rulesetDetailPath(repository, source, id), method: 'GET' as const }));
  const details = detailRequests.map((request) => get(request.path));
  const allRequests = [...requestsOf(response), ...details.flatMap(requestsOf)];
  const bad = details.find((detail) => detail.status < 200 || detail.status >= 300);
  if (bad) return { status: bad.status, body: bad.body, request: response.request, requests: allRequests };
  return { status: 200, body: details.map((detail) => detail.body), request: response.request, requests: allRequests };
}

export function evaluateLiveRulesetResponses(options: {
  repository: string;
  ref: string;
  responses: Array<{ source: 'repository' | 'organization'; response: RulesetResponse }>;
  now?: string;
  expected?: CiGovernanceExpectation;
}): LiveRulesetResult {
  const expectedSources = new Set(['repository', 'organization']);
  if (options.responses.length !== expectedSources.size || new Set(options.responses.map((item) => item.source)).size !== expectedSources.size) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-incomplete-response', 'both repository and organization ruleset responses are required', options.responses);
  }
  const requests = options.responses.flatMap(({ response }) => requestsOf(response));
  if (requests.some((request) => request.method !== 'GET')) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-non-readonly-request', 'all ruleset requests must be GET', requests);
  }
  const bad = options.responses.find(({ response }) => response.status < 200 || response.status >= 300);
  if (bad) {
    return unverifiedLiveResult(options.repository, options.ref, `recursive-input.ci.live-ruleset-http-${bad.response.status}`, { status: bad.response.status, response: bad.response.body }, bad.response.request);
  }
  if (options.responses.some(({ response }) => !Array.isArray(response.body))) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-incomplete-response', 'ruleset endpoints must return arrays', options.responses.map(({ response }) => response.body));
  }
  const raw = options.responses.map(({ response }) => response.body);
  const parsedRulesets = options.responses.flatMap(({ source, response }) => (response.body as unknown[]).map((item: unknown) => parseRuleset(item, source, options.ref)));
  if (parsedRulesets.some((item) => !item)) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-incomplete-response', 'every ruleset must expose id, enforcement, bypass, and current-user bypass fields', raw);
  }
  const rulesets = parsedRulesets.filter((item): item is ObservedRuleset => Boolean(item));
  const observation: LiveRulesetObservation = {
    repository: options.repository,
    ref: options.ref,
    observedAt: options.now ?? new Date().toISOString(),
    responseIdentity: sha256(JSON.stringify(raw)),
    rulesets,
  };
  return compareLiveRulesets(observation, options.expected ?? {
    repository: options.repository,
    ref: 'main',
    enforcement: 'active',
    bypassActors: [],
    currentUserCanBypass: 'never',
  });
}

function unverifiedLiveResult(repository: string, ref: string, code: string, expected: unknown, actual: unknown): LiveRulesetResult {
  return {
    status: 'unverified',
    code,
    expected: { repository, ref, readOnly: true, response: expected },
    actual: { response: actual },
    recoveryActions: [
      { actionId: 'retry-live-ruleset-read', argv: ['bun', 'fx', 'recursive-inputs', 'status', '--scope', 'ci', '--live-ruleset'] },
      { actionId: 'manual-live-evidence-handoff', manualHandoff: 'A human with GitHub read permission must provide a fresh ruleset response.' },
    ],
  };
}

export function createGitHubRulesetClient(token: string, fetchImpl: typeof fetch = fetch): RulesetClient {
  return {
    async get(path: string): Promise<RulesetResponse> {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body, request: { path, method: 'GET' } };
    },
  };
}

export async function probeLiveRulesets(options: {
  repository: string;
  ref?: string;
  client: RulesetClient;
  now?: () => string;
  expected?: CiGovernanceExpectation;
}): Promise<LiveRulesetResult> {
  const ref = options.ref ?? 'main';
  const [repositoryList, organizationList] = await Promise.all([
    options.client.get(`/repos/${options.repository}/rulesets?includes_parents=true`),
    options.client.get(`/orgs/${options.repository.split('/')[0]}/rulesets?includes_parents=true`),
  ]);
  const [repositoryResponse, organizationResponse] = await Promise.all([
    resolveRulesetDetails(options.repository, 'repository', repositoryList, options.client),
    resolveRulesetDetails(options.repository, 'organization', organizationList, options.client),
  ]);
  const responses = [
    { source: 'repository' as const, response: repositoryResponse },
    { source: 'organization' as const, response: organizationResponse },
  ];
  return evaluateLiveRulesetResponses({ repository: options.repository, ref, responses, now: (options.now ?? (() => new Date().toISOString()))(), expected: options.expected });
}

/** Synchronous AI-CLI adapter. Each invocation performs two fresh, read-only gh GETs. */
export function probeLiveRulesetsSync(options: {
  repository: string;
  ref?: string;
  token: string;
  now?: () => string;
  expected?: CiGovernanceExpectation;
}): LiveRulesetResult {
  const ref = options.ref ?? 'main';
  const paths = [
    `/repos/${options.repository}/rulesets?includes_parents=true`,
    `/orgs/${options.repository.split('/')[0]}/rulesets?includes_parents=true`,
  ] as const;
  const get = (path: string): RulesetResponse => {
    const result = spawnSync('gh', ['api', '--include', path], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: options.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const statusMatches = [...stdout.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)];
    const status = Number(statusMatches.at(-1)?.[1] ?? 0);
    const separator = Math.max(stdout.lastIndexOf('\r\n\r\n'), stdout.lastIndexOf('\n\n'));
    const bodyText = separator >= 0 ? stdout.slice(separator + (stdout[separator] === '\r' ? 4 : 2)).trim() : stdout.trim();
    let body: unknown = bodyText || stderr || null;
    try { body = bodyText ? JSON.parse(bodyText) : body; } catch { /* preserve diagnostic text */ }
    return { status, body, request: { path, method: 'GET' as const } };
  };
  const listResponses = paths.map(get);
  const responses = listResponses.map((response, index) => ({
    source: (index === 0 ? 'repository' : 'organization') as 'repository' | 'organization',
    response: resolveRulesetDetailsSync(options.repository, index === 0 ? 'repository' : 'organization', response, get),
  }));
  return evaluateLiveRulesetResponses({ repository: options.repository, ref, responses, now: (options.now ?? (() => new Date().toISOString()))(), expected: options.expected });
}

export function compareLiveRulesets(observation: LiveRulesetObservation, expected: CiGovernanceExpectation): LiveRulesetResult {
  const applicable = observation.rulesets.filter((ruleset) => ruleset.appliesToRef);
  const contexts = applicable.flatMap((ruleset) => ruleset.contexts);
  const sources = new Map<string, string[]>();
  for (const ruleset of applicable) {
    for (const context of ruleset.contexts) sources.set(context, [...(sources.get(context) ?? []), ruleset.contextSource]);
  }
  const missing = CI_REQUIRED_CONTEXTS.filter((context) => !sources.has(context));
  const extra = contexts.filter((context) => !CI_REQUIRED_CONTEXTS.includes(context as (typeof CI_REQUIRED_CONTEXTS)[number]));
  const duplicate = [...sources.entries()].filter(([, contextSources]) => contextSources.length !== 1).map(([context, contextSources]) => ({ context, sources: contextSources }));
  const enforcement = applicable.map((ruleset) => ({ id: ruleset.id, source: ruleset.source, enforcement: ruleset.enforcement }));
  const bypass = applicable.flatMap((ruleset) => ruleset.bypassActors.map((actor) => ({ ruleset: ruleset.id, actor })));
  const bypassCapability = applicable.map((ruleset) => ({ id: ruleset.id, value: ruleset.currentUserCanBypass }));
  const aligned = observation.repository === expected.repository
    && observation.ref === expected.ref
    && applicable.length > 0
    && missing.length === 0
    && extra.length === 0
    && duplicate.length === 0
    && enforcement.every((item) => item.enforcement === expected.enforcement)
    && bypass.length === 0
    && bypassCapability.every((item) => item.value === expected.currentUserCanBypass);
  const actual = { repository: observation.repository, ref: observation.ref, applicableRulesets: applicable, missing, extra, duplicate, enforcement, bypass, bypassCapability };
  return {
    status: aligned ? 'aligned' : 'misaligned',
    code: aligned ? 'recursive-input.ci.live-ruleset-aligned' : 'recursive-input.ci.live-ruleset-misaligned',
    expected: { repository: expected.repository, ref: expected.ref, contexts: CI_REQUIRED_CONTEXTS, enforcement: expected.enforcement, bypassActors: expected.bypassActors, currentUserCanBypass: expected.currentUserCanBypass },
    actual,
    observation,
    recoveryActions: aligned ? [] : [{ actionId: 'manual-governance-review', manualHandoff: 'A human must review the live ruleset mismatch; this command never mutates governance.' }],
  };
}
