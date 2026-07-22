/**
 * Golden-case authoring contract.
 *
 * L4a cases call deterministic HTTP/tool seams directly and assert an exact
 * result. L4b cases execute the real `packages/orchestrator/bin/forge run --json`
 * binary through `ctx.runCli()`, pin `kernel`, and assert event ordering/final
 * state rather than model text.
 */
import type { GoldenApi } from '../lib/api.ts';
import type {
  FetchLike,
  StreamEvent,
} from '../lib/sse.ts';

export type GoldenMode = 'l4a' | 'l4b';

export interface GoldenKernel {
  providerId: string;
  model: string;
}

export interface GoldenArtifacts {
  slug: string;
  sid?: string;
}

export interface GoldenCaseState {
  /** Retrieve the private value returned by a named step. */
  value<T = unknown>(stepName: string): T;
  /** Every event parsed from ctx.runCli() stdout during this case. */
  readonly events: readonly StreamEvent[];
}

export interface GoldenCliRunOptions {
  prompt: string;
  agentId: string;
  timeoutMs?: number;
}

export interface GoldenCliRunResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  events: StreamEvent[];
}

/** Narrow subprocess seam: production uses Bun.spawn; runner.spec injects fakes. */
export interface GoldenCliProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export type GoldenCliSpawner = (
  command: readonly string[],
  options: { cwd: string },
) => GoldenCliProcess;

export interface GoldenCaseContext {
  readonly mode: GoldenMode;
  readonly baseUrl: string;
  readonly serverPort: number;
  readonly projectRoot: string;
  readonly slug: string;
  readonly sid?: string;
  readonly api: GoldenApi;
  readonly fetch: FetchLike;

  /** Record a created session immediately so crash recovery can remove it. */
  recordSession(sid: string): Promise<void>;

  /** L4b transport. Session/server/--json are runner-owned and cannot drift. */
  runCli(options: GoldenCliRunOptions): Promise<GoldenCliRunResult>;
}

export interface GoldenStepResult<T = unknown> {
  /** Kept in memory for later assertions; never copied into the report. */
  value?: T;
  /** Compact, JSON-safe diagnostic material written into report.steps[]. */
  evidence?: unknown;
}

export interface GoldenStep {
  name: string;
  run(ctx: GoldenCaseContext, state: GoldenCaseState):
    | GoldenStepResult
    | Promise<GoldenStepResult>;
}

export interface GoldenAssertion {
  name: string;
  /** Return compact evidence on success; throw GoldenAssertionError on fail. */
  check(ctx: GoldenCaseContext, state: GoldenCaseState): unknown | Promise<unknown>;
}

/** Declarative event matcher reserved for L4b allowed-partial-order checks. */
export interface GoldenEventMatcher {
  /** SSE event name, for example `tool-call`, `tool-result`, or `done`. */
  event: string;
  /** Optional recursive exact subset matched against the parsed event data. */
  data?: Record<string, unknown>;
}

/** `before` must occur before `after`; unrelated events may interleave. */
export interface GoldenPartialOrderConstraint {
  name: string;
  before: GoldenEventMatcher;
  after: GoldenEventMatcher;
}

export interface GoldenCaseDefinition {
  name: string;
  description: string;
  modes: readonly GoldenMode[];
  /** Required by the runner whenever mode=l4b. */
  kernel?: GoldenKernel;
  setup?(ctx: GoldenCaseContext, state: GoldenCaseState):
    | GoldenStepResult
    | Promise<GoldenStepResult>;
  steps: readonly GoldenStep[];
  asserts?: readonly GoldenAssertion[];
  partialOrder?: readonly GoldenPartialOrderConstraint[];
  teardown?(ctx: GoldenCaseContext, state: GoldenCaseState):
    | GoldenStepResult
    | Promise<GoldenStepResult>;
}

export class GoldenAssertionError extends Error {
  readonly evidence?: unknown;

  constructor(message: string, evidence?: unknown) {
    super(message);
    this.name = 'GoldenAssertionError';
    this.evidence = evidence;
  }
}

export function assertGolden(
  condition: unknown,
  message: string,
  evidence?: unknown,
): asserts condition {
  if (!condition) throw new GoldenAssertionError(message, evidence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecursiveSubset(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => isRecursiveSubset(actual[index], item));
  }
  if (!isRecord(expected) || !isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) => (
    Object.hasOwn(actual, key) && isRecursiveSubset(actual[key], value)
  ));
}

function matchesEvent(event: StreamEvent, matcher: GoldenEventMatcher): boolean {
  return event.event === matcher.event
    && (matcher.data === undefined || isRecursiveSubset(event.data, matcher.data));
}

/** Assert each declared dependency while allowing unrelated events to interleave. */
export function assertAllowedPartialOrder(
  events: readonly StreamEvent[],
  constraints: readonly GoldenPartialOrderConstraint[],
): void {
  for (const constraint of constraints) {
    const beforeMatches: number[] = [];
    const afterMatches: number[] = [];
    events.forEach((event, index) => {
      if (matchesEvent(event, constraint.before)) beforeMatches.push(index);
      if (matchesEvent(event, constraint.after)) afterMatches.push(index);
    });
    const ordered = beforeMatches.some((before) => afterMatches.some((after) => before < after));
    if (!ordered) {
      throw new GoldenAssertionError(
        `partial-order constraint "${constraint.name}" was not satisfied`,
        {
          constraint,
          beforeMatches,
          afterMatches,
          eventNames: events.map((event) => event.event),
        },
      );
    }
  }
}

/*
Example case shape:

export default {
  name: 'create-game',
  description: 'Agent creates one game through the orchestration layer.',
  modes: ['l4b'],
  kernel: { providerId: 'claude-code', model: 'locked-model-id' },
  steps: [
    {
      name: 'ask agent to create game',
      async run(ctx) {
        const turn = await ctx.runCli({
          prompt: `Create ${ctx.slug}`,
          agentId: 'forge',
        });
        return { value: turn, evidence: { eventCount: turn.events.length } };
      },
    },
  ],
  asserts: [
    {
      name: 'game reaches expected terminal state',
      async check(ctx) {
        // Assert files/API state here. Never assert generated prose.
        return { slug: ctx.slug };
      },
    },
  ],
  partialOrder: [
    {
      name: 'create precedes terminal event',
      before: { event: 'tool-call', data: { name: 'ui_invoke' } },
      after: { event: 'done' },
    },
  ],
} satisfies GoldenCaseDefinition;
*/
