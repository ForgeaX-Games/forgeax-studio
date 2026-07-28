import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalRolePackDir,
  roleIdForSlug,
  teardownRolePack,
} from './cases/role-slice.ts';
import smokeToolsList from './cases/smoke-tools-list.ts';
import {
  assertAllowedPartialOrder,
  assertGolden,
  GoldenAssertionError,
  type GoldenCaseContext,
  type GoldenCaseDefinition,
  type GoldenCaseState,
  type GoldenCliProcess,
  type GoldenCliSpawner,
} from './cases/_template.ts';
import { readKernelToolAudit } from './lib/api.ts';
import {
  CliChatTimeoutError,
  postCliChat,
  readEventStream,
  type FetchLike,
} from './lib/sse.ts';
import {
  assertLockedProviderOnWire,
  buildGoldenServerManifest,
  createCliCaptureProxy,
  launchGoldenServer,
  lockAgentModelFile,
  MODEL_EXECUTION_M3_CLOSURE,
  MODEL_EXECUTION_WAIVER_NOTE,
  verifyAgentModelFileLock,
  waitForTurnModelEvidence,
  type GoldenL4bEvidenceAdapter,
} from './lib/l4b-evidence.ts';
import {
  buildGoldenCliEnvironment,
  cleanupGoldenArtifacts,
  cleanupStaleGoldenRuns,
  GOLDEN_SLUG_RE,
  loadGoldenCase,
  makeGoldenSlug,
  parseRunnerArgs,
  runGoldenCase,
} from './runner.ts';

const tempRoots = new Set<string>();

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'golden-runner-'));
  tempRoots.add(root);
  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function completedCliProcess(
  stdout: string,
  options: { stderr?: string; exitCode?: number } = {},
): GoldenCliProcess {
  return {
    stdout: textStream(stdout),
    stderr: textStream(options.stderr ?? ''),
    exited: Promise.resolve(options.exitCode ?? 0),
    kill() {},
  };
}

function fakeL4bHarness(model = 'locked-model'): Pick<
  Parameters<typeof runGoldenCase>[1],
  'manageServer' | 'launchServer' | 'l4bEvidenceAdapter' | 'verifyTurnModelEvidence'
> {
  const lock = {
    sid: 's-fixture',
    agentId: 'forge',
    model,
    agentJsonFile: '/fixture/agent.json',
    previousModel: null,
    writtenModel: model,
    configSha256: 'fixture-config-sha',
  };
  const adapter: GoldenL4bEvidenceAdapter = {
    async lockAgentModel(input) {
      return {
        ...lock,
        sid: input.sid,
        agentId: input.agentId,
        model: input.model,
        writtenModel: input.model,
      };
    },
    async verifyAgentModelLock(evidence) { return evidence; },
    async readAgentLedger() { return { files: [], events: [] }; },
    async createCliCaptureProxy(targetBaseUrl) {
      return {
        baseUrl: targetBaseUrl,
        capturedCallId: () => 'turn-call-fixture',
        close() {},
      };
    },
  };
  return {
    manageServer: true,
    async launchServer(options) {
      const port = 28900;
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        startup: {
          manifest: buildGoldenServerManifest({
            projectRoot: options.projectRoot,
            port,
            kernel: options.kernel,
          }),
          readyAfterMs: 0,
          healthStatus: 200,
        },
        async stop() {
          return {
            exitCode: 0,
            forced: false,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      };
    },
    l4bEvidenceAdapter: adapter,
    async verifyTurnModelEvidence(input) {
      return {
        callId: input.callId,
        correlationMethod: 'runner-injected-nonce+isolated-ledger-delta',
        correlationNonceSha256: 'fixture-nonce-sha',
        requestedModel: input.expectedModel,
        userEventOffset: 0,
        assistantEventOffset: 1,
        ledgerEventCountBefore: 0,
        ledgerEventCountAfter: 2,
        ledgerFiles: ['/fixture/events-1.jsonl'],
        promptSha256: 'fixture-prompt-sha',
      };
    },
  };
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe('runner report and exit semantics', () => {
  it('rejects L4b when runner-owned server evidence is disabled', async () => {
    const definition = {
      name: 'l4b-no-server-evidence',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      steps: [],
    } satisfies GoldenCaseDefinition;

    await expect(runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      manageServer: false,
      manageArtifacts: false,
      projectRoot: fixtureRoot(),
      slugFactory: () => 'gc-0a0b0c0d',
    })).rejects.toThrow(/runner-owned server/i);
  });

  it('uses a frozen deep clone of the validated L4b kernel definition', async () => {
    const definition = {
      name: 'l4b-frozen-kernel',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      steps: [],
    } satisfies GoldenCaseDefinition;
    const harness = fakeL4bHarness();
    const baseLaunch = harness.launchServer!;
    let launchedKernel: { model: string; frozen: boolean } | undefined;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...harness,
      async launchServer(options) {
        definition.kernel.model = 'mutated-after-validation';
        launchedKernel = {
          model: options.kernel.model,
          frozen: Object.isFrozen(options.kernel),
        };
        return baseLaunch(options);
      },
      manageArtifacts: false,
      projectRoot: fixtureRoot(),
      slugFactory: () => 'gc-0e0f1011',
    });

    expect(launchedKernel).toEqual({ model: 'locked-model', frozen: true });
    expect(outcome.report.kernel).toEqual({ providerId: 'locked-provider', model: 'locked-model' });
  });

  it('runs the L4a smoke case with fake fetch and emits a structured pass report', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body ? { body } : {}) });
      if (url.endsWith('/api/tools') && method === 'GET') {
        return jsonResponse({
          tools: [
            { id: 'lowpoly:projects.list', exposedToAI: true, hasHandler: true },
            { id: 'private:tool', exposedToAI: false, hasHandler: true },
          ],
        });
      }
      if (url.endsWith('/api/tools/call') && method === 'POST') {
        return jsonResponse({ ok: true, result: [{ id: 'project-1' }] });
      }
      return jsonResponse({ error: 'not found' }, 404);
    };

    const times = [1_700_000_000_000, 1_700_000_000_025];
    const outcome = await runGoldenCase(smokeToolsList, {
      mode: 'l4a',
      serverPort: 28900,
      projectRoot: fixtureRoot(),
      fetchImpl,
      manageArtifacts: false,
      slugFactory: () => 'gc-01020304',
      now: () => times.shift() ?? 1_700_000_000_025,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toMatchObject({
      case: 'smoke-tools-list',
      mode: 'l4a',
      runCompleted: true,
      startedAt: '2023-11-14T22:13:20.000Z',
      durationMs: 25,
      metadata: { slug: 'gc-01020304' },
    });
    expect(outcome.report.kernel).toBeUndefined();
    expect(smokeToolsList.probeTool).toBe('lowpoly:projects.list');
    expect(outcome.report.steps.length).toBeGreaterThanOrEqual(7);
    expect(outcome.report.steps.every((step) => (
      typeof step.name === 'string'
      && typeof step.ok === 'boolean'
      && Object.hasOwn(step, 'evidence')
    ))).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      body: {
        toolId: 'lowpoly:projects.list',
        args: {},
        caller: { kind: 'user' },
      },
    });
  });

  it('returns exit 1 for an assertion failure', async () => {
    const definition = {
      name: 'assert-failure',
      description: 'fixture',
      modes: ['l4a'],
      steps: [{ name: 'seed', run: () => ({ value: 1, evidence: { value: 1 } }) }],
      asserts: [{
        name: 'fails',
        check: () => assertGolden(false, 'expected assertion failure', { actual: 1 }),
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4a',
      serverPort: 18900,
      projectRoot: fixtureRoot(),
      manageArtifacts: false,
      slugFactory: () => 'gc-aabbccdd',
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.runCompleted).toBe(false);
    expect(outcome.report.failure).toEqual({
      kind: 'assertion',
      message: 'expected assertion failure',
    });
  });

  it('returns exit 2 for a transport/environment failure', async () => {
    const definition = {
      name: 'environment-failure',
      description: 'fixture',
      modes: ['l4a'],
      steps: [{
        name: 'network',
        run: () => { throw new Error('server unavailable'); },
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4a',
      serverPort: 18900,
      projectRoot: fixtureRoot(),
      manageArtifacts: false,
      slugFactory: () => 'gc-11223344',
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.failure).toEqual({
      kind: 'environment',
      message: 'server unavailable',
    });
  });

  it('reports a teardown assertion as a case failure instead of swallowing it', async () => {
    const definition = {
      name: 'teardown-failure',
      description: 'fixture',
      modes: ['l4a'],
      steps: [],
      teardown: () => {
        assertGolden(false, 'strict teardown failed');
        return {};
      },
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4a',
      serverPort: 18900,
      projectRoot: fixtureRoot(),
      manageArtifacts: false,
      slugFactory: () => 'gc-12345678',
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.runCompleted).toBe(false);
    expect(outcome.report.failure).toEqual({
      kind: 'assertion',
      message: 'strict teardown failed',
    });
    expect(outcome.report.steps).toContainEqual({
      name: 'case teardown',
      ok: false,
      evidence: { error: 'strict teardown failed', type: 'GoldenAssertionError' },
    });
  });

  it('executes L4b through the CLI seam and checks nested partial order', async () => {
    let spawned: { command: readonly string[]; cwd: string } | undefined;
    const stdout = [
      { event: 'tool-call', data: { type: 'tool-call', providerId: 'locked-provider', name: 'ui_act_role_create', callId: 'c1', args: { id: 'm1-forge-accept' } } },
      { event: 'tool-result', data: { type: 'tool-result', providerId: 'locked-provider', callId: 'c1', ok: true, result: { status: 'completed', stateDigest: { id: 'm1-forge-accept', scope: 'global' }, executedVia: 'headless' } } },
      { event: 'tool-call', data: { type: 'tool-call', providerId: 'locked-provider', name: 'ui_act_role_list', callId: 'c2', args: {} } },
      { event: 'done', data: { type: 'done', providerId: 'locked-provider', stopReason: 'end_turn' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const spawnCli: GoldenCliSpawner = (command, options) => {
      spawned = { command, cwd: options.cwd };
      return completedCliProcess(`${stdout}\n`, { stderr: 'cli diagnostic\n' });
    };
    const definition = {
      name: 'l4b-skeleton',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-cli-fixture');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          const result = await ctx.runCli({
            prompt: 'perform the operation',
            agentId: 'forge',
            timeoutMs: 1_000,
          });
          return {
            value: result,
            evidence: {
              exitCode: result.exitCode,
              stderr: result.stderr,
              events: result.events.map((event) => event.event),
            },
          };
        },
      }],
      asserts: [{
        name: 'terminal event exists',
        check(_ctx, state) {
          assertGolden(state.events.some((event) => event.event === 'done'), 'done missing');
          return { done: true };
        },
      }],
      partialOrder: [
        {
          name: 'create call precedes its completed result',
          before: { event: 'tool-call', data: { name: 'ui_act_role_create' } },
          after: {
            event: 'tool-result',
            data: {
              result: {
                status: 'completed',
                stateDigest: { id: 'm1-forge-accept' },
              },
            },
          },
        },
        {
          name: 'create completion precedes list call',
          before: {
            event: 'tool-result',
            data: {
              result: {
                status: 'completed',
                stateDigest: { id: 'm1-forge-accept' },
              },
            },
          },
          after: { event: 'tool-call', data: { name: 'ui_act_role_list' } },
        },
      ],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli,
      manageArtifacts: false,
      slugFactory: () => 'gc-55667788',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.kernel).toEqual({
      providerId: 'locked-provider',
      model: 'locked-model',
    });
    expect(spawned).toEqual({
      command: [
        './packages/orchestrator/bin/forge',
        'run',
        '--json',
        expect.stringMatching(
          /^perform the operation\n\n\[forgeax-golden-correlation-nonce:[0-9a-f-]+\]$/,
        ),
        '--agent',
        'forge',
        '--session',
        's-cli-fixture',
        '--server',
        'http://127.0.0.1:28900',
      ],
      cwd: expect.any(String),
    });
    expect(outcome.report.steps).toContainEqual({
      name: 'model turn',
      ok: true,
      evidence: {
        exitCode: 0,
        stderr: 'cli diagnostic\n',
        events: ['tool-call', 'tool-result', 'tool-call', 'done'],
      },
    });
    expect(outcome.report.steps).toContainEqual({
      name: 'assert: l4b verification completeness',
      ok: true,
      evidence: {
        bl2Verdict: 'PARTIAL',
        providerVerified: 'PASS',
        requestedModelVerified: 'PASS',
        modelExecutedVerified: 'WAIVED',
        modelExecutionWaiver: MODEL_EXECUTION_WAIVER_NOTE,
        m3Closure: MODEL_EXECUTION_M3_CLOSURE,
      },
    });
    expect(outcome.report.verification).toMatchObject({
      bl2Verdict: 'PARTIAL',
      providerVerified: 'PASS',
      requestedModelVerified: 'PASS',
      modelExecutedVerified: 'WAIVED',
      modelExecutionWaiver: MODEL_EXECUTION_WAIVER_NOTE,
      m3Closure: MODEL_EXECUTION_M3_CLOSURE,
    });
    expect(outcome.report).toHaveProperty('runCompleted', true);
    expect(outcome.report).not.toHaveProperty('pass');
    expect((outcome.report as unknown as Record<string, unknown>).BL2).toBeUndefined();
    expect(outcome.report.steps).toContainEqual({
      name: 'assert: allowed partial order',
      ok: true,
      evidence: null,
    });
  });

  it('fails the case on a non-zero CLI exit and archives stderr', async () => {
    const definition = {
      name: 'cli-nonzero',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-cli-nonzero');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          await ctx.runCli({ prompt: 'perform the operation', agentId: 'forge' });
          return {};
        },
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli: () => completedCliProcess(`${JSON.stringify({
        event: 'done',
        data: { type: 'done', providerId: 'locked-provider' },
      })}\n`, { stderr: 'api_key=super-secret-cli-value\n', exitCode: 7 }),
      manageArtifacts: false,
      slugFactory: () => 'gc-66778899',
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.runCompleted).toBe(false);
    expect(outcome.report.failure).toEqual({
      kind: 'assertion',
      message: 'forge run exited with code 7',
    });
    expect(outcome.report.steps).toContainEqual({
      name: 'model turn',
      ok: false,
      evidence: {
        error: 'forge run exited with code 7',
        type: 'GoldenAssertionError',
        detail: expect.objectContaining({
          exitCode: 7,
          stderr: 'api_key=<redacted>\n',
        }),
      },
    });
  });

  it('tolerates noisy JSONL while preserving later CLI events', async () => {
    const definition = {
      name: 'cli-jsonl-tolerance',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-cli-jsonl');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          const result = await ctx.runCli({ prompt: 'x', agentId: 'forge' });
          return { evidence: { eventNames: result.events.map((event) => event.event) } };
        },
      }],
      asserts: [{
        name: 'valid events survive noise',
        check(_ctx, state) {
          const names = state.events.map((event) => event.event);
          assertGolden(names.includes('tool-call') && names.includes('done'), 'valid CLI events missing', names);
          return { names };
        },
      }],
    } satisfies GoldenCaseDefinition;

    const noisy = [
      'not-json',
      '',
      JSON.stringify({ event: 'tool-call', data: { providerId: 'locked-provider', name: 'ui_act_role_create' } }),
      '',
      JSON.stringify({ event: 'done', data: { type: 'done', providerId: 'locked-provider' } }),
    ].join('\r\n');
    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli: () => completedCliProcess(noisy),
      manageArtifacts: false,
      slugFactory: () => 'gc-778899aa',
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.steps).toContainEqual({
      name: 'model turn',
      ok: true,
      evidence: { eventNames: ['message', 'tool-call', 'done'] },
    });
  });

  it('fails when the observed provider differs from the declared lock', async () => {
    const definition = {
      name: 'provider-mismatch',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-provider-mismatch');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          await ctx.runCli({ prompt: 'x', agentId: 'forge' });
          return {};
        },
      }],
    } satisfies GoldenCaseDefinition;
    const stdout = `${JSON.stringify({
      event: 'done',
      data: { type: 'done', providerId: 'unexpected-provider' },
    })}\n`;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli: () => completedCliProcess(stdout),
      manageArtifacts: false,
      slugFactory: () => 'gc-78899aab',
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.failure).toEqual({
      kind: 'assertion',
      message: 'model turn did not stay on locked provider locked-provider',
    });
  });

  it('kills a timed-out CLI process and fails the case', async () => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let killSignal: number | undefined;
    const cliProcess: GoldenCliProcess = {
      stdout: new ReadableStream({ start(controller) { stdoutController = controller; } }),
      stderr: new ReadableStream({ start(controller) { stderrController = controller; } }),
      // Exercise total-timeout semantics: the process has exited, but inherited
      // pipes remain open and must not make the runner hang forever.
      exited: Promise.resolve(0),
      kill(signal) {
        killSignal = signal;
        stdoutController.close();
        stderrController.close();
      },
    };
    const definition = {
      name: 'cli-timeout',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-cli-timeout');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          await ctx.runCli({ prompt: 'hang', agentId: 'forge', timeoutMs: 5 });
          return {};
        },
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli: () => cliProcess,
      manageArtifacts: false,
      slugFactory: () => 'gc-8899aabb',
    });

    expect(killSignal).toBe(9);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.failure?.message).toContain('exceeded total timeout 5ms');
    expect(outcome.report.steps.find((step) => step.name === 'model turn')?.evidence).toMatchObject({
      detail: { timeoutMs: 5, killed: true, killSignal: 9, exitCode: 0 },
    });
  });

  it('rejects an invalid CLI timeout before spawning a process', async () => {
    let spawned = false;
    const definition = {
      name: 'cli-invalid-timeout',
      description: 'fixture',
      modes: ['l4b'],
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      setup: async (ctx) => {
        await ctx.recordSession('s-cli-invalid-timeout');
        return {};
      },
      steps: [{
        name: 'model turn',
        async run(ctx) {
          await ctx.runCli({ prompt: 'x', agentId: 'forge', timeoutMs: 0 });
          return {};
        },
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4b',
      serverPort: 0,
      ...fakeL4bHarness(),
      projectRoot: fixtureRoot(),
      spawnCli: () => {
        spawned = true;
        return completedCliProcess('');
      },
      manageArtifacts: false,
      slugFactory: () => 'gc-99aabbcc',
    });

    expect(spawned).toBe(false);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.failure?.message).toBe('CLI timeoutMs must be a positive finite number');
  });

  it('records a sid returned by the session API in report metadata', async () => {
    const fetchImpl: FetchLike = async (input, init) => {
      expect(String(input)).toEndWith('/api/sessions');
      expect(init?.method).toBe('POST');
      return jsonResponse({ sid: 's-created', bootstrappedAgent: 'forge' });
    };
    const definition = {
      name: 'session-metadata',
      description: 'fixture',
      modes: ['l4a'],
      steps: [{
        name: 'create session',
        async run(ctx) {
          const response = await ctx.api.createSession({ displayName: 'golden' });
          return { value: response, evidence: { status: response.status } };
        },
      }],
    } satisfies GoldenCaseDefinition;

    const outcome = await runGoldenCase(definition, {
      mode: 'l4a',
      serverPort: 28900,
      projectRoot: fixtureRoot(),
      fetchImpl,
      manageArtifacts: false,
      slugFactory: () => 'gc-99887766',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.metadata).toEqual({ slug: 'gc-99887766', sid: 's-created' });
  });
});

describe('L4b fail-closed evidence', () => {
  it('uses an explicit CLI environment allowlist', () => {
    expect(buildGoldenCliEnvironment({
      PATH: '/bin',
      HOME: '/home/you',
      NO_COLOR: '1',
      GOLDEN_TEST_API_KEY: 'must-not-pass',
      FORGEAX_PROVIDER_API: 'must-not-pass',
    })).toEqual({
      PATH: '/bin',
      HOME: '/home/you',
      NO_COLOR: '1',
    });
  });

  it('checks every attributable wire event and rejects missing or zero attribution', () => {
    expect(() => assertLockedProviderOnWire([
      { event: 'token', data: { type: 'token', text: 'x' }, raw: '' },
      { event: 'done', data: { type: 'done', providerId: 'locked-provider' }, raw: '' },
    ], 'locked-provider')).toThrow('did not stay on locked provider locked-provider');

    expect(() => assertLockedProviderOnWire([
      { event: 'message', data: 'diagnostic only', raw: 'diagnostic only' },
    ], 'locked-provider')).toThrow('zero provider-attributable wire events');
  });

  it('atomically replaces model fallback arrays with one string and detects overwrite', async () => {
    const root = fixtureRoot();
    const sid = 's-model-lock';
    const agentDir = join(root, '.forgeax', 'games', 'acceptance', 'sessions', sid, 'agents', 'forge');
    const agentJson = join(agentDir, 'agent.json');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(agentJson, JSON.stringify({
      role: 'main',
      models: { model: ['old-primary', 'old-fallback'] },
    }, null, 2));

    const locked = await lockAgentModelFile({
      projectRoot: root,
      sid,
      agentId: 'forge',
      model: 'locked-model',
    });
    const afterWrite = JSON.parse(readFileSync(agentJson, 'utf8')) as {
      models: { model: unknown };
    };
    expect(afterWrite.models.model).toBe('locked-model');
    expect(Array.isArray(afterWrite.models.model)).toBe(false);
    expect(locked.previousModel).toEqual(['old-primary', 'old-fallback']);
    await expect(verifyAgentModelFileLock(locked)).resolves.toMatchObject({
      writtenModel: 'locked-model',
    });

    writeFileSync(agentJson, JSON.stringify({ role: 'main', models: { model: ['overwritten'] } }));
    await expect(verifyAgentModelFileLock(locked)).rejects.toThrow(
      'agent model lock was overwritten during the turn',
    );
    await expect(lockAgentModelFile({
      projectRoot: root,
      sid,
      agentId: '../forge',
      model: 'locked-model',
    })).rejects.toThrow('unsafe agent id');
  });

  it('does not claim callId-level ledger correlation when ledger rows carry no callId', async () => {
    const correlationNonce = 'nonce-fixture-123';
    const correlatedPrompt = `perform the operation\n\n[forgeax-golden-correlation-nonce:${correlationNonce}]`;
    const before = { files: ['/fixture/events-1.jsonl'], events: [] };
    const after = {
      files: ['/fixture/events-1.jsonl'],
      events: [
        { type: 'user_input', payload: { content: correlatedPrompt } },
        { type: 'hook:turnStart', payload: { providerId: 'locked-provider' } },
        { type: 'hook:assistantMessage', payload: { model: 'locked-model' } },
        { type: 'hook:turnEnd', payload: { reason: 'end_turn' } },
      ],
    };
    const evidence = await waitForTurnModelEvidence({
      read: async () => after,
      before,
      prompt: correlatedPrompt,
      expectedModel: 'locked-model',
      callId: 'turn-call-123',
      correlationNonce,
      timeoutMs: 10,
    });
    expect(evidence).toMatchObject({
      callId: 'turn-call-123',
      correlationMethod: 'runner-injected-nonce+isolated-ledger-delta',
      correlationNonceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestedModel: 'locked-model',
      userEventOffset: 0,
      assistantEventOffset: 2,
    });

    await expect(waitForTurnModelEvidence({
      read: async () => ({
        ...after,
        events: [
          { type: 'user_input', payload: { content: 'perform the operation' } },
          ...after.events.slice(1),
        ],
      }),
      before,
      prompt: correlatedPrompt,
      expectedModel: 'locked-model',
      callId: 'turn-call-123',
      correlationNonce,
      timeoutMs: 10,
    })).rejects.toThrow('timed out waiting for ledger-backed requested-model evidence');
  });

  it('captures the real forge-run request callId through a one-turn loopback proxy', async () => {
    let proxyFetch: ((request: Request) => Promise<Response>) | undefined;
    let stopped = false;
    const proxy = await createCliCaptureProxy('http://target.invalid', {
      async fetchImpl(_input, init) {
        return new Response(String(init?.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      serve(options) {
        proxyFetch = options.fetch;
        return {
          port: 29875,
          stop() { stopped = true; },
        };
      },
    });
    try {
      const response = await proxyFetch!(new Request(`${proxy.baseUrl}/api/cli/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x', callId: 'captured-call-id' }),
      }));
      expect(response.status).toBe(200);
      expect(proxy.capturedCallId()).toBe('captured-call-id');
    } finally {
      proxy.close();
    }
    expect(stopped).toBe(true);
  });

  it('owns server env, readiness, logs, and teardown without persisting secrets', async () => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    let captured: {
      command: readonly string[];
      env: Record<string, string | undefined>;
    } | undefined;
    const previousTestKey = process.env.GOLDEN_TEST_API_KEY;
    process.env.GOLDEN_TEST_API_KEY = 'super-secret-golden-value';
    let runtime: Awaited<ReturnType<typeof launchGoldenServer>>;
    try {
      runtime = await launchGoldenServer({
        projectRoot: fixtureRoot(),
        requestedPort: 0,
        reservePort: async () => 29876,
        kernel: { providerId: 'locked-provider', model: 'locked-model' },
        fetchImpl: async () => jsonResponse({ status: 'ok' }),
        now: (() => {
          const times = [100, 125];
          return () => times.shift() ?? 125;
        })(),
        spawnServer(command, options) {
          captured = { command, env: options.env };
          const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
          return {
            stdout: new ReadableStream({ start(controller) { stdoutController = controller; } }),
            stderr: new ReadableStream({ start(controller) { stderrController = controller; } }),
            exited,
            kill() {
              stdoutController.enqueue(new TextEncoder().encode(
                'server stopped super-secret-golden-value Authorization: Bearer bearer-from-log api_key=query-secret\n',
              ));
              stdoutController.close();
              stderrController.close();
              resolveExit(0);
            },
          };
        },
      });
    } finally {
      if (previousTestKey === undefined) delete process.env.GOLDEN_TEST_API_KEY;
      else process.env.GOLDEN_TEST_API_KEY = previousTestKey;
    }

    expect(runtime.startup.manifest).toEqual(buildGoldenServerManifest({
      projectRoot: runtime.startup.manifest.environment.FORGEAX_PROJECT_ROOT,
      port: runtime.port,
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
    }));
    expect(captured?.env.FORGEAX_KERNEL).toBe('kernel');
    expect(captured?.env.FORGEAX_KERNEL_IMPL).toBe('locked-provider');
    expect(captured?.env.FORGEAX_SERVER_PORT).toBe(String(runtime.port));
    expect(captured?.env.FORGEAX_NO_KERNEL).toBeUndefined();
    expect(JSON.stringify(runtime.startup.manifest)).not.toContain('API_KEY');

    const stopped = await runtime.stop();
    expect(stopped).toMatchObject({ exitCode: 0, forced: false });
    expect(stopped.stdout).toContain('server stopped');
    expect(stopped.stdout).not.toContain('super-secret-golden-value');
    expect(stopped.stdout).not.toContain('bearer-from-log');
    expect(stopped.stdout).not.toContain('query-secret');
    expect(stopped.stdout.match(/<redacted>/g)?.length).toBe(3);
  });

  it('rejects a fixed port for the runner-owned L4b server', async () => {
    await expect(launchGoldenServer({
      projectRoot: fixtureRoot(),
      requestedPort: 29876,
      kernel: { providerId: 'locked-provider', model: 'locked-model' },
      fetchImpl: async () => jsonResponse({ status: 'ok' }),
      spawnServer() {
        return {
          stdout: textStream(),
          stderr: textStream(),
          exited: Promise.resolve(0),
          kill() {},
        };
      },
    })).rejects.toThrow('must request port 0');
  });

  it('does not leak a secret prefix when the secret crosses the log cap boundary', async () => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    const secret = 'boundary-crossing-secret-value';
    const previousTestKey = process.env.GOLDEN_TEST_API_KEY;
    process.env.GOLDEN_TEST_API_KEY = secret;
    let runtime: Awaited<ReturnType<typeof launchGoldenServer>>;
    try {
      runtime = await launchGoldenServer({
        projectRoot: fixtureRoot(),
        requestedPort: 0,
        reservePort: async () => 29877,
        kernel: { providerId: 'locked-provider', model: 'locked-model' },
        fetchImpl: async () => jsonResponse({ status: 'ok' }),
        spawnServer() {
          const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
          return {
            stdout: new ReadableStream({ start(controller) { stdoutController = controller; } }),
            stderr: textStream(),
            exited,
            kill() {
              const prefixBytes = 256 * 1024 - 4;
              stdoutController.enqueue(new TextEncoder().encode(`${'x'.repeat(prefixBytes)}${secret}`));
              stdoutController.close();
              resolveExit(0);
            },
          };
        },
      });
    } finally {
      if (previousTestKey === undefined) delete process.env.GOLDEN_TEST_API_KEY;
      else process.env.GOLDEN_TEST_API_KEY = previousTestKey;
    }

    const stopped = await runtime.stop();
    expect(stopped.stdout.slice(-32)).not.toContain(secret.slice(0, 4));
    expect(stopped.stdout).not.toContain(secret);
    expect(stopped.stdoutTruncated).toBe(true);
  });
});

describe('allowed partial order assertions', () => {
  it('throws GoldenAssertionError with match evidence when events are reversed', () => {
    const events = [
      {
        event: 'tool-call',
        data: { type: 'tool-call', name: 'ui_act_role_list' },
        raw: '{"type":"tool-call","name":"ui_act_role_list"}',
      },
      {
        event: 'tool-result',
        data: { type: 'tool-result', result: { status: 'completed' } },
        raw: '{"type":"tool-result","result":{"status":"completed"}}',
      },
    ];

    let caught: unknown;
    try {
      assertAllowedPartialOrder(events, [{
        name: 'completion precedes list',
        before: { event: 'tool-result', data: { result: { status: 'completed' } } },
        after: { event: 'tool-call', data: { name: 'ui_act_role_list' } },
      }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoldenAssertionError);
    expect((caught as GoldenAssertionError).evidence).toMatchObject({
      beforeMatches: [1],
      afterMatches: [0],
      eventNames: ['tool-call', 'tool-result'],
    });
  });
});

describe('runner isolation', () => {
  it('builds gc-<8hex> slugs from four random bytes', () => {
    const first = makeGoldenSlug(Uint8Array.from([0x00, 0x01, 0xab, 0xff]));
    const second = makeGoldenSlug(Uint8Array.from([0x10, 0x20, 0x30, 0x40]));
    expect(first).toBe('gc-0001abff');
    expect(second).toBe('gc-10203040');
    expect(first).not.toBe(second);
    expect(GOLDEN_SLUG_RE.test(first)).toBe(true);
  });

  it('removes only the owned game, both session layouts, and matching active pointer', async () => {
    const root = fixtureRoot();
    const slug = 'gc-deadbeef';
    const sid = 's-golden-fixture';
    const gameDir = join(root, '.forgeax', 'games', slug);
    const flatSession = join(root, '.forgeax', 'sessions', sid);
    const unrelated = join(root, '.forgeax', 'games', 'real-game');
    mkdirSync(join(gameDir, 'sessions', sid), { recursive: true });
    mkdirSync(flatSession, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(root, '.forgeax', 'active-game.json'), JSON.stringify({ version: 1, slug }));

    const apiCalls: string[] = [];
    const evidence = await cleanupGoldenArtifacts({
      projectRoot: root,
      slug,
      sid,
      api: {
        async deleteSession(value) {
          apiCalls.push(`session:${value}`);
          return { status: 200, ok: true, body: { ok: true } };
        },
        async deleteGame(value) {
          apiCalls.push(`game:${value}`);
          return { status: 404, ok: false, body: { error: 'not found' } };
        },
      },
    });

    expect(apiCalls).toEqual([`session:${sid}`, `game:${slug}`]);
    expect(existsSync(gameDir)).toBe(false);
    expect(existsSync(flatSession)).toBe(false);
    expect(existsSync(join(root, '.forgeax', 'active-game.json'))).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(evidence.warnings).toEqual([]);
  });

  it('refuses to clean a non-golden slug', async () => {
    const root = fixtureRoot();
    const userGame = join(root, '.forgeax', 'games', 'real-game');
    mkdirSync(userGame, { recursive: true });
    await expect(cleanupGoldenArtifacts({
      projectRoot: root,
      slug: 'real-game',
    })).rejects.toThrow('refusing to clean non-golden slug');
    expect(existsSync(userGame)).toBe(true);
  });

  it('recovers a dead prior run from its state record', async () => {
    const root = fixtureRoot();
    const slug = 'gc-cafebabe';
    const sid = 's-dead-run';
    const statePath = join(root, '.forgeax', 'golden-runner', 'runs', 'dead.json');
    mkdirSync(join(root, '.forgeax', 'games', slug, 'sessions', sid), { recursive: true });
    mkdirSync(join(root, '.forgeax', 'sessions', sid), { recursive: true });
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      runId: 'dead-run',
      pid: 999999,
      case: 'fixture',
      slug,
      sid,
      startedAt: new Date(0).toISOString(),
    }));

    const result = await cleanupStaleGoldenRuns({
      projectRoot: root,
      isProcessAlive: () => false,
    });
    expect(result.cleaned).toEqual(['dead-run']);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(join(root, '.forgeax', 'games', slug))).toBe(false);
    expect(existsSync(join(root, '.forgeax', 'sessions', sid))).toBe(false);
  });

  it('still removes an owned game when a stale record has an unsafe sid', async () => {
    const root = fixtureRoot();
    const slug = 'gc-abcdef12';
    const statePath = join(root, '.forgeax', 'golden-runner', 'runs', 'bad-sid.json');
    mkdirSync(join(root, '.forgeax', 'games', slug), { recursive: true });
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      runId: 'bad-sid-run',
      pid: 999999,
      case: 'fixture',
      slug,
      sid: '../../user-session',
      startedAt: new Date(0).toISOString(),
    }));

    const result = await cleanupStaleGoldenRuns({
      projectRoot: root,
      isProcessAlive: () => false,
    });
    expect(result.cleaned).toEqual(['bad-sid-run']);
    expect(result.warnings.some((warning) => warning.includes('unsafe sid'))).toBe(true);
    expect(existsSync(join(root, '.forgeax', 'games', slug))).toBe(false);
  });
});

describe('role-slice repeatability', () => {
  it('executes L4a as role.create, audit assertion, then role.list containing the role', async () => {
    const root = fixtureRoot();
    const slug = 'gc-01020304';
    const sid = 's-role-l4a';
    const roleId = roleIdForSlug(slug);
    const auditPath = join(
      root,
      '.forgeax',
      'games',
      'actual-active-game',
      'sessions',
      sid,
      'kernel-tool-audit.jsonl',
    );
    mkdirSync(join(auditPath, '..'), { recursive: true });
    writeFileSync(auditPath, `${JSON.stringify({
      sid,
      agent: 'forge',
      tool: 'ui_invoke',
      trustTier: 'own',
      allow: true,
      ok: true,
      durationMs: 1,
      ts: 1,
    })}\n`);
    const definition = await loadGoldenCase('role-slice');
    const [createStep, auditStep, listStep] = [
      'create role through kernel ui_invoke',
      'assert kernel-tool audit for role.create',
      'list roles after deterministic create',
    ].map((name) => definition.steps.find((step) => step.name === name));
    expect(createStep).toBeDefined();
    expect(auditStep).toBeDefined();
    expect(listStep).toBeDefined();

    const calls: Array<{ sid: string; body: Record<string, unknown> }> = [];
    const context = {
      mode: 'l4a',
      projectRoot: root,
      slug,
      sid,
      api: {
        async callKernelTool(callSid: string, body: Record<string, unknown>) {
          calls.push({ sid: callSid, body });
          if (body.toolName === 'ui_invoke') {
            return {
              status: 200,
              ok: true,
              body: {
                ok: true,
                result: {
                  status: 'completed',
                  executedVia: 'headless',
                  stateDigest: { id: roleId, scope: 'global' },
                },
              },
            };
          }
          return {
            status: 200,
            ok: true,
            body: {
              ok: true,
              result: {
                status: 'completed',
                executedVia: 'headless',
                stateDigest: {
                  count: 2,
                  roles: [
                    { id: 'forge', role: 'main', displayName: 'Forge', source: 'builtin' },
                    { id: roleId, role: 'custom', displayName: roleId, source: 'user' },
                  ],
                },
              },
            },
          };
        },
      },
    } as unknown as GoldenCaseContext;
    const outputs = new Map<string, unknown>();
    const state = {
      value: <T>(name: string) => outputs.get(name) as T,
      events: [],
    } satisfies GoldenCaseState;

    const created = await createStep!.run(context, state);
    outputs.set(createStep!.name, created.value);
    writeFileSync(auditPath, `${JSON.stringify({
      sid,
      agent: 'forge',
      tool: 'ui_invoke',
      trustTier: 'own',
      allow: true,
      ok: true,
      durationMs: 1,
      ts: 2,
    })}\n`, { flag: 'a' });
    const audited = await auditStep!.run(context, state);
    outputs.set(auditStep!.name, audited.value);
    const listed = await listStep!.run(context, state);

    expect(calls).toEqual([
      {
        sid,
        body: {
          agentPath: 'forge',
          toolName: 'ui_invoke',
          args: {
            actionId: 'role.create',
            args: {
              id: roleId,
              persona: 'A focused acceptance teammate who verifies the M1 role slice.',
            },
          },
        },
      },
      { sid, body: { agentPath: 'forge', toolName: 'ui_act_role_list', args: {} } },
    ]);
    expect(audited.evidence).toMatchObject({
      path: auditPath,
      newEntryCount: 1,
      entry: { sid, tool: 'ui_invoke', allow: true, ok: true, ts: 2 },
    });
    expect(listed.evidence).toMatchObject({ contains: roleId, resultStatus: 'completed' });
  });

  it('fails L4a before role.list when the role.create audit entry is missing', async () => {
    const definition = await loadGoldenCase('role-slice');
    const auditStep = definition.steps.find((step) => (
      step.name === 'assert kernel-tool audit for role.create'
    ));
    expect(auditStep).toBeDefined();
    await expect(auditStep!.run({
      mode: 'l4a',
      projectRoot: fixtureRoot(),
      slug: 'gc-1234abcd',
      sid: 's-missing-audit',
    } as GoldenCaseContext, {
      value: () => ({ auditBaseline: { path: null, entryCount: 0 } }),
      events: [],
    } as GoldenCaseState)).rejects.toThrow(
      'role.create produced no kernel-tool audit file',
    );
  });

  it('derives a safe, run-owned role id and uses it in the L4b request', async () => {
    expect(roleIdForSlug('gc-01020304')).toBe('role-gc-01020304');
    expect(roleIdForSlug('GC bad/slug!?')).toBe('role-gc-bad-slug');

    const definition = await loadGoldenCase('role-slice');
    const modelStep = definition.steps.find((step) => (
      step.name === 'model creates then lists the acceptance role'
    ));
    expect(modelStep).toBeDefined();
    let message = '';
    await modelStep!.run({
      mode: 'l4b',
      slug: 'gc-aabbccdd',
      sid: 's-role-slice',
      runCli: async (options) => {
        message = options.prompt;
        return {
          callId: 'turn-role-fixture',
          command: [],
          exitCode: 0,
          stdout: '',
          stderr: '',
          events: [],
        };
      },
    } as GoldenCaseContext, {} as GoldenCaseState);

    expect(message).toContain('id "role-gc-aabbccdd"');
    expect(message).not.toContain('m1-forge-accept');
  });

  it('binds workflow ordering to the run-owned create result instead of an unrelated result', async () => {
    const slug = 'gc-aabbccdd';
    const roleId = roleIdForSlug(slug);
    const definition = await loadGoldenCase('role-slice');
    const assertion = definition.asserts?.find((item) => (
      item.name === 'native role.create uses the run-derived id and completes'
    ));
    expect(assertion).toBeDefined();
    const events = [
      {
        event: 'tool-call',
        data: { name: 'ui_act_role_create', callId: 'create-1', args: { id: roleId } },
        raw: '',
      },
      {
        event: 'tool-result',
        data: {
          callId: 'unrelated-1',
          ok: true,
          result: { status: 'completed', stateDigest: { scope: 'global' } },
        },
        raw: '',
      },
      { event: 'tool-call', data: { name: 'ui_act_role_list', callId: 'list-1' }, raw: '' },
      {
        event: 'tool-result',
        data: {
          callId: 'create-1',
          ok: true,
          result: { status: 'completed', stateDigest: { id: roleId, scope: 'global' } },
        },
        raw: '',
      },
    ];
    let caught: unknown;
    try {
      await assertion!.check(
        { mode: 'l4b', slug } as GoldenCaseContext,
        {
          value: () => ({ command: [], exitCode: 0, stdout: '', stderr: '', events }),
          events,
        } as GoldenCaseState,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoldenAssertionError);
    expect((caught as Error).message).toContain('create-call < create-result < list-call');
  });

  it('deletes the exact global pack, reloads, and confirms the role disappeared', async () => {
    const home = fixtureRoot();
    const slug = 'gc-0badc0de';
    const roleId = roleIdForSlug(slug);
    const packDir = globalRolePackDir(roleId, home);
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'forgeax-extension.json'), '{}\n');
    const calls: Array<{ url: string; method: string }> = [];

    const result = await teardownRolePack({
      baseUrl: 'http://127.0.0.1:28900',
      slug,
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return jsonResponse({
          generation: 7,
          agents: [{ definition: { id: 'forge' } }],
          manifests: [{ id: '@builtin/forge' }],
        });
      },
    }, home);

    expect(existsSync(packDir)).toBe(false);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:28900/api/extensions/reload',
      method: 'POST',
    }]);
    expect(result.evidence).toMatchObject({
      roleId,
      scope: 'global',
      packDir,
      existedBefore: true,
      diskExists: false,
      reload: {
        status: 200,
        generation: 7,
        agentVisible: false,
        manifestVisible: false,
      },
    });
  });

  it('fails strict teardown when the reloaded snapshot still exposes the role', async () => {
    const home = fixtureRoot();
    const slug = 'gc-feedface';
    const roleId = roleIdForSlug(slug);
    const packDir = globalRolePackDir(roleId, home);
    mkdirSync(packDir, { recursive: true });

    await expect(teardownRolePack({
      baseUrl: 'http://127.0.0.1:28900',
      slug,
      fetch: async () => jsonResponse({
        generation: 8,
        agents: [{ definition: { id: roleId } }],
        manifests: [],
      }),
    }, home)).rejects.toThrow('deleted role remained visible after extension reload');
    expect(existsSync(packDir)).toBe(false);
  });
});

describe('API stream and audit helpers', () => {
  it('parses chunked CRLF SSE and terminal events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: token\r\ndata: {"type":"tok'));
        controller.enqueue(encoder.encode('en","text":"hi"}\r\n\r\nevent: done\r\n'));
        controller.enqueue(encoder.encode('data: {"type":"done","stopReason":"end_turn"}\r\n\r\n'));
        controller.close();
      },
    });
    const events = await readEventStream(body);
    expect(events.map((event) => event.event)).toEqual(['token', 'done']);
    expect(events[0].data).toMatchObject({ type: 'token', text: 'hi' });
  });

  it('parses plain JSONL as events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"thinking","text":"x"}\n'));
        controller.enqueue(encoder.encode('{"event":"done","data":{"type":"done"}}\n'));
        controller.close();
      },
    });
    const events = await readEventStream(body);
    expect(events.map((event) => event.event)).toEqual(['thinking', 'done']);
    expect(events[1].data).toEqual({ type: 'done' });
  });

  it('enforces a total timeout even when injected fetch ignores AbortSignal', async () => {
    const fetchImpl: FetchLike = () => new Promise<Response>(() => {});
    await expect(postCliChat({
      baseUrl: 'http://127.0.0.1:28900',
      body: { message: 'hang' },
      timeoutMs: 5,
      fetchImpl,
    })).rejects.toBeInstanceOf(CliChatTimeoutError);
  });

  it('reads canonical audit JSONL before the flat fallback', async () => {
    const root = fixtureRoot();
    const slug = 'gc-1234abcd';
    const sid = 's-audit';
    const canonical = join(
      root,
      '.forgeax',
      'games',
      slug,
      'sessions',
      sid,
      'kernel-tool-audit.jsonl',
    );
    mkdirSync(join(canonical, '..'), { recursive: true });
    writeFileSync(canonical, `${JSON.stringify({
      sid,
      agent: 'forge',
      tool: 'template:echo',
      trustTier: 'own',
      allow: true,
      ok: true,
      durationMs: 1,
      ts: 2,
    })}\n`);

    const audit = await readKernelToolAudit(root, slug, sid);
    expect(audit.path).toBe(canonical);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ tool: 'template:echo', allow: true, ok: true });
    expect(readFileSync(canonical, 'utf8')).toContain('template:echo');
  });

  it('discovers an audit under the session-bound game when the runner slug differs', async () => {
    const root = fixtureRoot();
    const sid = 's-bound-audit';
    const actual = join(
      root,
      '.forgeax',
      'games',
      'actual-active-game',
      'sessions',
      sid,
      'kernel-tool-audit.jsonl',
    );
    mkdirSync(join(actual, '..'), { recursive: true });
    writeFileSync(actual, `${JSON.stringify({
      sid,
      agent: 'forge',
      tool: 'ui_invoke',
      trustTier: 'own',
      allow: true,
      ok: true,
      durationMs: 1,
      ts: 2,
    })}\n`);

    const audit = await readKernelToolAudit(root, 'gc-aabbccdd', sid);
    expect(audit.path).toBe(actual);
    expect(audit.entries).toHaveLength(1);
    expect(audit.probed[0]).toContain('gc-aabbccdd');
  });

  it('discovers an audit through a symlinked session-bound game', async () => {
    const root = fixtureRoot();
    const sid = 's-symlink-audit';
    const target = join(root, 'shared-game');
    const gamesRoot = join(root, '.forgeax', 'games');
    const linkedGame = join(gamesRoot, 'linked-game');
    const actual = join(target, 'sessions', sid, 'kernel-tool-audit.jsonl');
    mkdirSync(join(actual, '..'), { recursive: true });
    mkdirSync(gamesRoot, { recursive: true });
    symlinkSync(target, linkedGame, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(actual, `${JSON.stringify({
      sid,
      agent: 'forge',
      tool: 'ui_invoke',
      trustTier: 'own',
      allow: true,
      ok: true,
      durationMs: 1,
      ts: 2,
    })}\n`);

    const audit = await readKernelToolAudit(root, 'gc-aabbccdd', sid);
    expect(audit.path).toBe(join(linkedGame, 'sessions', sid, 'kernel-tool-audit.jsonl'));
    expect(audit.entries).toHaveLength(1);
  });
});

describe('CLI argument parsing', () => {
  it('loads the role-slice case with both tiers and the native kernel lock', async () => {
    const definition = await loadGoldenCase('role-slice');
    expect(definition).toMatchObject({
      name: 'role-slice',
      modes: ['l4a', 'l4b'],
      kernel: { providerId: 'forgeax-core', model: 'claude-sonnet-5' },
    });
    expect(definition.partialOrder).toHaveLength(2);
    expect(typeof definition.teardown).toBe('function');
  });

  it('uses FORGEAX_SERVER_PORT unless --server-port overrides it', () => {
    expect(parseRunnerArgs(['--case', 'smoke-tools-list'], {
      FORGEAX_SERVER_PORT: '28900',
    })).toMatchObject({ serverPort: 28900, mode: 'l4a' });
    expect(() => parseRunnerArgs([
      '--case', 'smoke-tools-list',
      '--server-port', '29900',
      '--mode', 'l4b',
    ], { FORGEAX_SERVER_PORT: '28900' })).toThrow('must request port 0');
    expect(parseRunnerArgs([
      '--case', 'role-slice',
      '--mode', 'l4b',
    ], { FORGEAX_SERVER_PORT: '28900' })).toMatchObject({
      serverPort: 0,
      mode: 'l4b',
    });
  });
});
