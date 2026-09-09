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
  transportError?: { code?: string; message: string };
};

export type RulesetClient = {
  get(path: string): Promise<RulesetResponse>;
};

export type ObservedRuleset = {
  id: string;
  source: 'repository' | 'organization' | 'enterprise';
  name?: string;
  enforcement: string;
  strictRequiredStatusChecks?: boolean;
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

function rulesetSource(value: unknown): ObservedRuleset['source'] | undefined {
  if (value === 'Repository') return 'repository';
  if (value === 'Organization') return 'organization';
  if (value === 'Enterprise') return 'enterprise';
  return undefined;
}

function parseRuleset(value: unknown, ref: string): ObservedRuleset | undefined {
  const input = record(value);
  if (typeof input.id !== 'number' && typeof input.id !== 'string') return undefined;
  const source = rulesetSource(input.source_type);
  if (!source) return undefined;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const required = rules.filter((rule) => record(rule).type === 'required_status_checks');
  const contexts = required.flatMap((rule) => stringList(record(record(rule).parameters).required_status_checks));
  const strictRequiredStatusChecks = required.length > 0
    ? required.every((rule) => record(record(rule).parameters).strict_required_status_checks_policy === true)
    : undefined;
  const conditions = record(input.conditions);
  return {
    id: String(input.id),
    source,
    name: typeof input.name === 'string' ? input.name : undefined,
    enforcement: typeof input.enforcement === 'string' ? input.enforcement : 'unknown',
    strictRequiredStatusChecks,
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

function rulesetDetailPath(repository: string, id: string): string {
  return `/repos/${repository}/rulesets/${id}?includes_parents=true`;
}

function listedRulesetIds(response: RulesetResponse): string[] | undefined {
  if (!Array.isArray(response.body)) return undefined;
  const ids = response.body.map((item) => record(item).id);
  if (ids.some((id) => typeof id !== 'number' && typeof id !== 'string')) return undefined;
  return ids.map(String);
}

async function resolveRulesetDetails(
  repository: string,
  response: RulesetResponse,
  client: RulesetClient,
): Promise<RulesetResponse> {
  const ids = listedRulesetIds(response);
  if (ids === undefined || response.status < 200 || response.status >= 300) return response;
  const detailRequests = ids.map((id) => ({ path: rulesetDetailPath(repository, id), method: 'GET' as const }));
  const details = await Promise.all(detailRequests.map((request) => client.get(request.path)));
  const allRequests = [...requestsOf(response), ...details.flatMap(requestsOf)];
  const bad = details.find((detail) => detail.status < 200 || detail.status >= 300);
  if (bad) return { status: bad.status, body: bad.body, request: response.request, requests: allRequests, transportError: bad.transportError };
  return { status: 200, body: details.map((detail) => detail.body), request: response.request, requests: allRequests };
}

function resolveRulesetDetailsSync(
  repository: string,
  response: RulesetResponse,
  get: (path: string) => RulesetResponse,
): RulesetResponse {
  const ids = listedRulesetIds(response);
  if (ids === undefined || response.status < 200 || response.status >= 300) return response;
  const detailRequests = ids.map((id) => ({ path: rulesetDetailPath(repository, id), method: 'GET' as const }));
  const details = detailRequests.map((request) => get(request.path));
  const allRequests = [...requestsOf(response), ...details.flatMap(requestsOf)];
  const bad = details.find((detail) => detail.status < 200 || detail.status >= 300);
  if (bad) return { status: bad.status, body: bad.body, request: response.request, requests: allRequests, transportError: bad.transportError };
  return { status: 200, body: details.map((detail) => detail.body), request: response.request, requests: allRequests };
}

export function evaluateLiveRulesetResponse(options: {
  repository: string;
  ref: string;
  response: RulesetResponse;
  now?: string;
  expected?: CiGovernanceExpectation;
}): LiveRulesetResult {
  const requests = requestsOf(options.response);
  if (options.response.transportError) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-transport-unavailable', { transport: 'gh', available: true }, options.response.transportError);
  }
  if (requests.some((request) => request.method !== 'GET')) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-non-readonly-request', 'all ruleset requests must be GET', requests);
  }
  if (options.response.status < 200 || options.response.status >= 300) {
    return unverifiedLiveResult(options.repository, options.ref, `recursive-input.ci.live-ruleset-http-${options.response.status}`, { status: options.response.status, response: options.response.body }, options.response.request);
  }
  if (!Array.isArray(options.response.body)) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-incomplete-response', 'the applicable repository ruleset endpoint must return an array', options.response.body);
  }
  const raw = options.response.body;
  const parsedRulesets = raw.map((item: unknown) => parseRuleset(item, options.ref));
  if (parsedRulesets.some((item) => !item)) {
    return unverifiedLiveResult(options.repository, options.ref, 'recursive-input.ci.live-ruleset-incomplete-response', 'every ruleset must expose id, source_type, enforcement, bypass, and current-user bypass fields', raw);
  }
  const rulesets = parsedRulesets.filter((item): item is ObservedRuleset => Boolean(item));
  const observation: LiveRulesetObservation = {
    repository: options.repository,
    ref: options.ref,
    observedAt: options.now ?? new Date().toISOString(),
    responseIdentity: sha256(JSON.stringify(options.response.body)),
    rulesets,
  };
  return compareLiveRulesets(observation, options.expected ?? {
    repository: options.repository,
    ref: 'main',
    enforcement: 'active',
    strictRequiredStatusChecks: false,
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
  const repositoryList = await options.client.get(`/repos/${options.repository}/rulesets?includes_parents=true`);
  const response = await resolveRulesetDetails(options.repository, repositoryList, options.client);
  return evaluateLiveRulesetResponse({ repository: options.repository, ref, response, now: (options.now ?? (() => new Date().toISOString()))(), expected: options.expected });
}

/** Synchronous AI-CLI adapter. Each invocation reads the repository's fresh, applicable ruleset view. */
export function probeLiveRulesetsSync(options: {
  repository: string;
  ref?: string;
  token: string;
  now?: () => string;
  expected?: CiGovernanceExpectation;
}): LiveRulesetResult {
  const ref = options.ref ?? 'main';
  const path = `/repos/${options.repository}/rulesets?includes_parents=true`;
  const get = (path: string): RulesetResponse => {
    const result = spawnSync('gh', ['api', '--include', path], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: options.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      return {
        status: 0,
        body: null,
        request: { path, method: 'GET' as const },
        transportError: {
          code: 'code' in result.error ? String(result.error.code) : undefined,
          message: result.error.message,
        },
      };
    }
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
  const response = resolveRulesetDetailsSync(options.repository, get(path), get);
  return evaluateLiveRulesetResponse({ repository: options.repository, ref, response, now: (options.now ?? (() => new Date().toISOString()))(), expected: options.expected });
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
  const strictRequiredStatusChecks = applicable
    .map((ruleset) => ruleset.strictRequiredStatusChecks)
    .filter((value): value is boolean => value !== undefined);
  const aligned = observation.repository === expected.repository
    && observation.ref === expected.ref
    && applicable.length > 0
    && missing.length === 0
    && extra.length === 0
    && duplicate.length === 0
    && enforcement.every((item) => item.enforcement === expected.enforcement)
    && strictRequiredStatusChecks.length > 0
    && strictRequiredStatusChecks.every((value) => value === expected.strictRequiredStatusChecks)
    && bypass.length === 0
    && bypassCapability.every((item) => item.value === expected.currentUserCanBypass);
  const actual = { repository: observation.repository, ref: observation.ref, applicableRulesets: applicable, missing, extra, duplicate, enforcement, strictRequiredStatusChecks, bypass, bypassCapability };
  return {
    status: aligned ? 'aligned' : 'misaligned',
    code: aligned ? 'recursive-input.ci.live-ruleset-aligned' : 'recursive-input.ci.live-ruleset-misaligned',
    expected: { repository: expected.repository, ref: expected.ref, contexts: CI_REQUIRED_CONTEXTS, enforcement: expected.enforcement, strictRequiredStatusChecks: expected.strictRequiredStatusChecks, bypassActors: expected.bypassActors, currentUserCanBypass: expected.currentUserCanBypass },
    actual,
    observation,
    recoveryActions: aligned ? [] : [{ actionId: 'manual-governance-review', manualHandoff: 'A human must review the live ruleset mismatch; this command never mutates governance.' }],
  };
}
