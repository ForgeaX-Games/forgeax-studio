import { lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type {
  ApiResponse,
  KernelToolCallResult,
} from '../lib/api.ts';
import { readKernelToolAudit } from '../lib/api.ts';
import type { StreamEvent } from '../lib/sse.ts';
import {
  assertGolden,
  type GoldenCaseContext,
  type GoldenCaseDefinition,
  type GoldenCliRunResult,
  type GoldenStepResult,
} from './_template.ts';

const AGENT_ID = 'forge';
const MODEL = 'claude-sonnet-5';
const CREATE_TOOL = 'ui_act_role_create';
const LIST_TOOL = 'ui_act_role_list';
const ROLE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const GOLDEN_ROLE_ID_RE = /^role-gc-[0-9a-f]{8}$/;

const CREATE_STEP = 'create role through kernel ui_invoke';
const AUDIT_STEP = 'assert kernel-tool audit for role.create';
const LIST_STEP = 'list roles after deterministic create';
const MODEL_STEP = 'model creates then lists the acceptance role';

interface RoleCreateResult {
  status: 'completed';
  stateDigest: {
    id: string;
    scope: string;
  };
  executedVia?: string;
}

interface RoleSummary {
  id: string;
  role: string;
  displayName: string;
  source: string;
}

interface RoleListResult {
  status: 'completed';
  stateDigest: {
    count: number;
    roles: RoleSummary[];
  };
  executedVia?: string;
}

interface KernelToolProbe<T> {
  response: ApiResponse<KernelToolCallResult<T>>;
  attempts: number;
}

interface RoleCreateStepValue {
  probe: KernelToolProbe<RoleCreateResult>;
  auditBaseline: { path: string | null; entryCount: number };
}

type RoleTeardownContext = Pick<GoldenCaseContext, 'baseUrl' | 'fetch' | 'slug'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function roleIdForSlug(slug: string): string {
  const segment = slug
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  const roleId = `role-${segment || 'golden'}`;
  assertGolden(ROLE_ID_RE.test(roleId), 'derived role id is not one safe segment', { slug, roleId });
  return roleId;
}

export function globalRolePackDir(roleId: string, homeDir = homedir()): string {
  assertGolden(ROLE_ID_RE.test(roleId), 'refusing to resolve an unsafe role pack id', { roleId });
  const root = resolve(homeDir, '.forgeax', 'extensions');
  const packDir = resolve(root, `agent-${roleId}`);
  assertGolden(dirname(packDir) === root, 'resolved role pack escaped the global extension root', {
    roleId,
    root,
    packDir,
  });
  return packDir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Strict L1 cleanup, exported only so runner.spec can exercise real filesystem semantics. */
export async function teardownRolePack(
  ctx: RoleTeardownContext,
  homeDir = homedir(),
): Promise<GoldenStepResult> {
  const roleId = roleIdForSlug(ctx.slug);
  // `gc-<8hex>` is the runner-owned namespace (the same ownership proof used
  // by generic game/session cleanup). Never recursively remove any other role.
  assertGolden(GOLDEN_ROLE_ID_RE.test(roleId), 'refusing to remove a non-golden role pack', {
    roleId,
  });
  // role.create omits scope in this case, so HostAuthoring selects global. Its
  // agent-${id} slug and platform-io's global layer root yield this exact L1 path.
  const packDir = globalRolePackDir(roleId, homeDir);
  const existedBefore = await pathExists(packDir);
  await rm(packDir, { recursive: true, force: true });
  assertGolden(!(await pathExists(packDir)), 'role pack still exists after teardown removal', {
    roleId,
    packDir,
  });

  // createAgentPack's duplicate check reads the in-process extension snapshot,
  // so deleting the directory is insufficient: explicitly rescan disk first.
  const response = await ctx.fetch(`${ctx.baseUrl}/api/extensions/reload`, { method: 'POST' });
  assertGolden(
    response.ok && response.status === 200,
    `POST /api/extensions/reload returned HTTP ${response.status}, expected 200`,
    { status: response.status },
  );
  const body = await response.json() as unknown;
  assertGolden(isRecord(body), 'extension reload returned a non-object body');
  assertGolden(Array.isArray(body.agents), 'extension reload body omitted agents[]', {
    keys: Object.keys(body),
  });
  assertGolden(Array.isArray(body.manifests), 'extension reload body omitted manifests[]', {
    keys: Object.keys(body),
  });

  const agentVisible = body.agents.some((entry) => (
    isRecord(entry)
    && isRecord(entry.definition)
    && entry.definition.id === roleId
  ));
  const extensionId = `@user/agent-${roleId}`;
  const manifestVisible = body.manifests.some((entry) => (
    isRecord(entry) && entry.id === extensionId
  ));
  assertGolden(!agentVisible && !manifestVisible, 'deleted role remained visible after extension reload', {
    roleId,
    extensionId,
    agentVisible,
    manifestVisible,
    generation: body.generation,
  });

  return {
    evidence: {
      roleId,
      scope: 'global',
      packDir,
      existedBefore,
      diskExists: false,
      reload: {
        status: response.status,
        generation: body.generation,
        agentVisible,
        manifestVisible,
      },
    },
  };
}

function requireSid(sid: string | undefined): string {
  assertGolden(typeof sid === 'string' && sid.length > 0, 'role-slice setup did not record a sid');
  return sid;
}

function eventData(event: StreamEvent): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
}

/** Keep reports diagnostic without copying token text or the complete role roster. */
function summarizeEvent(event: StreamEvent): Record<string, unknown> {
  const data = eventData(event);
  const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result)
    ? data.result as Record<string, unknown>
    : undefined;
  const digest = result?.stateDigest && typeof result.stateDigest === 'object' && !Array.isArray(result.stateDigest)
    ? result.stateDigest as Record<string, unknown>
    : undefined;
  const args = data.args && typeof data.args === 'object' && !Array.isArray(data.args)
    ? data.args as Record<string, unknown>
    : undefined;
  return {
    event: event.event,
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
    ...(typeof data.providerId === 'string' ? { providerId: data.providerId } : {}),
    ...(typeof data.ok === 'boolean' ? { ok: data.ok } : {}),
    ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {}),
    ...(typeof args?.id === 'string' ? { argId: args.id } : {}),
    ...(typeof result?.status === 'string' ? { resultStatus: result.status } : {}),
    ...(typeof digest?.id === 'string' ? { resultId: digest.id } : {}),
    ...(typeof digest?.count === 'number' ? { resultCount: digest.count } : {}),
    ...(typeof data.message === 'string' ? { message: data.message.slice(0, 240) } : {}),
  };
}

async function waitForLiveKernelTool<T>(
  call: () => Promise<ApiResponse<KernelToolCallResult<T>>>,
): Promise<KernelToolProbe<T>> {
  let response: ApiResponse<KernelToolCallResult<T>> | undefined;
  for (let attempts = 1; attempts <= 25; attempts += 1) {
    response = await call();
    if (response.body?.ok || !response.body?.error?.includes('not live in session')) {
      return { response, attempts };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { response: response!, attempts: 25 };
}

const definition: GoldenCaseDefinition = {
  name: 'role-slice',
  description: 'M1 role catalog cold-start seam and native-kernel create/list acceptance.',
  modes: ['l4a', 'l4b'],
  kernel: { providerId: 'forgeax-core', model: MODEL },

  async setup(ctx) {
    const created = await ctx.api.createSession({
      displayName: `golden role slice ${ctx.slug}`,
      autoStart: true,
      bootstrapAgent: AGENT_ID,
    });
    assertGolden(
      created.ok && created.status === 200,
      `POST /api/sessions returned HTTP ${created.status}, expected 200`,
      { status: created.status, body: created.body },
    );
    const sid = requireSid(created.body.sid);
    assertGolden(
      created.body.bootstrappedAgent === AGENT_ID,
      `session bootstrapped ${String(created.body.bootstrappedAgent)}, expected ${AGENT_ID}`,
      created.body,
    );

    if (ctx.mode === 'l4a') {
      return {
        evidence: {
          sid,
          bootstrappedAgent: created.body.bootstrappedAgent,
          modelPin: 'not needed for deterministic L4a',
        },
      };
    }

    // Metadata alone is not a lock: persist the model in the exact agent.json
    // field consumed by composeTurnRequest before the forge-run-equivalent turn.
    const pinned = await ctx.api.setAgentModels(sid, AGENT_ID, [MODEL]);
    assertGolden(
      pinned.ok && pinned.status === 200,
      `set_agent_models returned HTTP ${pinned.status}, expected 200`,
      { status: pinned.status, body: pinned.body },
    );
    const command = pinned.body?.result;
    assertGolden(command?.ok === true, 'set_agent_models returned result.ok:false', pinned.body);
    assertGolden(
      command.data.selected === MODEL,
      `set_agent_models selected ${String(command.data.selected)}, expected ${MODEL}`,
      command.data,
    );
    return {
      evidence: {
        sid,
        bootstrappedAgent: created.body.bootstrappedAgent,
        modelPin: {
          status: pinned.status,
          resultOk: command.ok,
          selected: command.data.selected,
          restarted: command.data.restarted,
        },
      },
    };
  },

  steps: [
    {
      name: CREATE_STEP,
      async run(ctx) {
        if (ctx.mode !== 'l4a') return { evidence: { skipped: 'L4b model turn' } };
        const sid = requireSid(ctx.sid);
        const roleId = roleIdForSlug(ctx.slug);
        const auditBefore = await readKernelToolAudit(ctx.projectRoot, ctx.slug, sid);
        // The kernel-tool live gate only checks scheduler.getAgent(). Session
        // bootstrap attaches through the debounced tree watcher, so retry only
        // the transient not-live response; no model turn is needed to become live.
        const probe = await waitForLiveKernelTool(() => ctx.api.callKernelTool<RoleCreateResult>(sid, {
          agentPath: AGENT_ID,
          toolName: 'ui_invoke',
          args: {
            actionId: 'role.create',
            args: {
              id: roleId,
              persona: 'A focused acceptance teammate who verifies the M1 role slice.',
            },
          },
        }));
        const { response } = probe;
        const created = response.body?.result;
        assertGolden(response.status === 200 && response.ok, 'role.create was not HTTP 200', response);
        assertGolden(response.body?.ok === true, 'role.create outer result was not ok:true', response.body);
        assertGolden(created?.status === 'completed', 'role.create did not complete', created);
        assertGolden(created.executedVia === 'headless', 'role.create did not use the headless fallback', created);
        assertGolden(created.stateDigest.id === roleId, 'role.create returned the wrong role id', {
          expected: roleId,
          actual: created.stateDigest.id,
        });
        assertGolden(created.stateDigest.scope === 'global', 'role.create did not use global scope', created);
        return {
          value: {
            probe,
            auditBaseline: { path: auditBefore.path, entryCount: auditBefore.entries.length },
          } satisfies RoleCreateStepValue,
          evidence: {
            attempts: probe.attempts,
            status: response.status,
            ok: response.body?.ok,
            resultStatus: created.status,
            executedVia: created.executedVia,
            roleId: created.stateDigest.id,
            scope: created.stateDigest.scope,
          },
        };
      },
    },
    {
      name: AUDIT_STEP,
      async run(ctx, state) {
        if (ctx.mode !== 'l4a') return { evidence: { skipped: 'L4b model turn' } };
        const sid = requireSid(ctx.sid);
        const { probe, auditBaseline } = state.value<RoleCreateStepValue>(CREATE_STEP);
        const audit = await readKernelToolAudit(ctx.projectRoot, ctx.slug, sid);
        assertGolden(audit.path !== null, 'role.create produced no kernel-tool audit file', {
          probed: audit.probed,
        });
        assertGolden(
          auditBaseline.path === null || audit.path === auditBaseline.path,
          'role.create audit path changed after invocation',
          { before: auditBaseline.path, after: audit.path },
        );
        assertGolden(
          audit.entries.length >= auditBaseline.entryCount,
          'role.create audit was truncated during invocation',
          { before: auditBaseline.entryCount, after: audit.entries.length },
        );
        const appended = audit.entries.slice(auditBaseline.entryCount);
        const relevant = appended.filter((entry) => (
          entry.sid === sid
          && entry.agent === AGENT_ID
          && entry.tool === 'ui_invoke'
        ));
        assertGolden(relevant.length === probe.attempts, 'role.create attempts did not match appended audit rows', {
          attempts: probe.attempts,
          relevant,
        });
        const successful = relevant.filter((entry) => (
          entry.trustTier === 'own'
          && entry.allow === true
          && entry.ok === true
        ));
        assertGolden(successful.length === 1, 'role.create audit did not contain exactly one successful ui_invoke', {
          path: audit.path,
          relevant,
        });
        assertGolden(relevant.at(-1) === successful[0], 'successful role.create was not the final ui_invoke audit entry', {
          path: audit.path,
          relevant,
        });
        return {
          value: successful[0],
          evidence: {
            path: audit.path,
            entryCount: audit.entries.length,
            newEntryCount: appended.length,
            transientNotLiveCount: relevant.length - successful.length,
            entry: successful[0],
          },
        };
      },
    },
    {
      name: LIST_STEP,
      async run(ctx) {
        if (ctx.mode !== 'l4a') return { evidence: { skipped: 'L4b model turn' } };
        const sid = requireSid(ctx.sid);
        const roleId = roleIdForSlug(ctx.slug);
        const response = await ctx.api.callKernelTool<RoleListResult>(sid, {
          agentPath: AGENT_ID,
          // Keep the catalog-derived first-class name: preflight maps it back
          // to ui_invoke(role.list), proving the frozen catalog projection too.
          toolName: LIST_TOOL,
          args: {},
        });
        const listed = response.body?.result;
        assertGolden(response.status === 200 && response.ok, 'role.list was not HTTP 200', response);
        assertGolden(response.body?.ok === true, 'role.list outer result was not ok:true', response.body);
        assertGolden(listed?.status === 'completed', 'role.list did not complete', listed);
        assertGolden(listed.executedVia === 'headless', 'role.list did not use the headless fallback', listed);
        assertGolden(
          listed.stateDigest.count === listed.stateDigest.roles.length,
          'role.list count did not match roster length',
          { count: listed.stateDigest.count, roles: listed.stateDigest.roles.length },
        );
        assertGolden(
          listed.stateDigest.roles.some((role) => role.id === roleId),
          `role.list roster did not contain ${roleId}`,
          { roleId, count: listed.stateDigest.count },
        );
        return {
          value: response,
          evidence: {
            status: response.status,
            ok: response.body?.ok,
            resultStatus: listed?.status,
            executedVia: listed?.executedVia,
            roleCount: listed?.stateDigest?.count,
            contains: roleId,
          },
        };
      },
    },
    {
      name: MODEL_STEP,
      async run(ctx) {
        if (ctx.mode !== 'l4b') return { evidence: { skipped: 'deterministic L4a' } };
        requireSid(ctx.sid);
        const roleId = roleIdForSlug(ctx.slug);
        const turn = await ctx.runCli({
          agentId: AGENT_ID,
          prompt: [
            'Perform this acceptance workflow now using only the provided first-class UI tools.',
            `First call ${CREATE_TOOL} exactly once with id ${JSON.stringify(roleId)} and persona `
              + '"A focused acceptance teammate who verifies the M1 role slice.".',
            `Wait for that tool result to complete successfully, then call ${LIST_TOOL} exactly once.`,
            'Do not call ui_invoke, exec, Bash, shell, curl, or any other tool. Do not merely describe the calls.',
          ].join(' '),
          timeoutMs: 300_000,
        });
        const relevant = turn.events.filter((event) => (
          event.event === 'tool-call'
          || event.event === 'tool-result'
          || event.event === 'done'
          || event.event === 'error'
        ));
        return {
          value: turn,
          evidence: {
            exitCode: turn.exitCode,
            stderr: turn.stderr,
            eventCount: turn.events.length,
            eventNames: turn.events.map((event) => event.event),
            events: relevant.map(summarizeEvent),
          },
        };
      },
    },
  ],

  asserts: [
    {
      name: 'native model turn terminates without wire error',
      check(ctx, state) {
        if (ctx.mode !== 'l4b') return { skipped: true };
        const turn = state.value<GoldenCliRunResult>(MODEL_STEP);
        const errors = turn.events.filter((event) => event.event === 'error');
        assertGolden(turn.exitCode === 0, `forge run exited with code ${turn.exitCode}`, {
          exitCode: turn.exitCode,
          stderr: turn.stderr,
        });
        assertGolden(errors.length === 0, 'model turn emitted wire error', errors.map(summarizeEvent));
        assertGolden(turn.events.some((event) => event.event === 'done'), 'model turn emitted no done event');
        const relevantProviders = turn.events
          .filter((event) => event.event === 'tool-call' || event.event === 'tool-result' || event.event === 'done')
          .map((event) => eventData(event).providerId);
        assertGolden(
          relevantProviders.length > 0 && relevantProviders.every((id) => id === 'forgeax-core'),
          'model turn did not run entirely through the env-default forgeax-core kernel',
          { relevantProviders },
        );
        return {
          done: true,
          providerId: 'forgeax-core',
          modelPinnedInSetup: MODEL,
          relevantEventCount: relevantProviders.length,
        };
      },
    },
    {
      name: 'native role.create uses the run-derived id and completes',
      check(ctx, state) {
        if (ctx.mode !== 'l4b') return { skipped: true };
        const roleId = roleIdForSlug(ctx.slug);
        const turn = state.value<GoldenCliRunResult>(MODEL_STEP);
        const createCalls = turn.events.filter((event) => (
          event.event === 'tool-call' && eventData(event).name === CREATE_TOOL
        ));
        assertGolden(createCalls.length === 1, 'model did not call role.create exactly once', {
          count: createCalls.length,
          roleId,
        });
        const callData = eventData(createCalls[0]);
        const args = isRecord(callData.args) ? callData.args : {};
        assertGolden(args.id === roleId, 'role.create did not use the run-derived role id', {
          expected: roleId,
          actual: args.id,
        });
        const callId = callData.callId;
        assertGolden(typeof callId === 'string', 'role.create tool call had no callId');
        const createResult = turn.events.find((event) => (
          event.event === 'tool-result' && eventData(event).callId === callId
        ));
        assertGolden(createResult, 'role.create tool call had no matching tool-result', { callId });
        const resultData = eventData(createResult);
        const result = isRecord(resultData.result) ? resultData.result : {};
        const digest = isRecord(result.stateDigest) ? result.stateDigest : {};
        assertGolden(resultData.ok === true, 'role.create tool-result was not ok:true', summarizeEvent(createResult));
        assertGolden(result.status === 'completed', 'role.create tool-result did not complete', summarizeEvent(createResult));
        assertGolden(digest.id === roleId, 'role.create result id did not match the run-derived id', {
          expected: roleId,
          actual: digest.id,
        });
        assertGolden(digest.scope === 'global', 'role.create did not use the expected global scope', {
          roleId,
          scope: digest.scope,
        });
        const listCalls = turn.events.filter((event) => (
          event.event === 'tool-call' && eventData(event).name === LIST_TOOL
        ));
        assertGolden(listCalls.length === 1, 'model did not call role.list exactly once', {
          count: listCalls.length,
          roleId,
        });
        const createCallIndex = turn.events.indexOf(createCalls[0]);
        const createResultIndex = turn.events.indexOf(createResult);
        const listCallIndex = turn.events.indexOf(listCalls[0]);
        assertGolden(
          createCallIndex < createResultIndex && createResultIndex < listCallIndex,
          'run-owned role workflow violated create-call < create-result < list-call order',
          { roleId, createCallIndex, createResultIndex, listCallIndex },
        );
        return {
          callId,
          id: roleId,
          status: result.status,
          scope: digest.scope,
          order: { createCallIndex, createResultIndex, listCallIndex },
        };
      },
    },
    {
      name: 'native role.list completes with the created role in its roster',
      check(ctx, state) {
        if (ctx.mode !== 'l4b') return { skipped: true };
        const roleId = roleIdForSlug(ctx.slug);
        const turn = state.value<GoldenCliRunResult>(MODEL_STEP);
        const listCall = turn.events.find((event) => (
          event.event === 'tool-call' && eventData(event).name === LIST_TOOL
        ));
        const listCallId = listCall && eventData(listCall).callId;
        assertGolden(typeof listCallId === 'string', 'role.list tool call had no callId');
        const listResult = turn.events.find((event) => (
          event.event === 'tool-result' && eventData(event).callId === listCallId
        ));
        assertGolden(listResult, 'role.list tool call had no matching tool-result', { listCallId });
        const data = eventData(listResult);
        const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result)
          ? data.result as Record<string, unknown>
          : {};
        const digest = result.stateDigest
          && typeof result.stateDigest === 'object'
          && !Array.isArray(result.stateDigest)
          ? result.stateDigest as Record<string, unknown>
          : {};
        const roles = Array.isArray(digest.roles) ? digest.roles : [];
        assertGolden(data.ok === true, 'role.list tool-result was not ok:true', summarizeEvent(listResult));
        assertGolden(result.status === 'completed', 'role.list tool-result did not complete', summarizeEvent(listResult));
        assertGolden(
          roles.some((role) => (
            role && typeof role === 'object' && !Array.isArray(role)
            && (role as Record<string, unknown>).id === roleId
          )),
          `role.list roster did not contain ${roleId}`,
          { count: digest.count },
        );
        return { callId: listCallId, status: result.status, count: digest.count, contains: roleId };
      },
    },
  ],

  partialOrder: [
    {
      name: 'role.create call precedes its completed result',
      before: {
        event: 'tool-call',
        data: { name: CREATE_TOOL },
      },
      after: {
        event: 'tool-result',
        data: {
          ok: true,
          result: {
            status: 'completed',
            stateDigest: { scope: 'global' },
          },
        },
      },
    },
    {
      name: 'completed role.create precedes role.list call',
      before: {
        event: 'tool-result',
        data: {
          ok: true,
          result: {
            status: 'completed',
            stateDigest: { scope: 'global' },
          },
        },
      },
      after: { event: 'tool-call', data: { name: LIST_TOOL } },
    },
  ],

  async teardown(ctx) {
    return teardownRolePack(ctx);
  },
};

export default definition;
