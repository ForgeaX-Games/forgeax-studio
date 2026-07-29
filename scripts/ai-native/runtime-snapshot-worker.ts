import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { createForgeaxApp } from '../../packages/orchestrator/src/app.ts';
import { hostToolSpecsForAgent } from '../../packages/orchestrator/src/api/lib/host-tools-for-agent.ts';
import { getExtensionSnapshot } from '../../packages/orchestrator/src/extensions/registry.ts';
import { getPathManager } from '../../packages/orchestrator/src/fs/path-manager.ts';
import { catalogAll } from '../../packages/orchestrator/src/kernel/action-catalog.ts';
import { composeTurnRequest } from '../../packages/orchestrator/src/kernel/compose-turn-request.ts';
import { resolveKernel } from '../../packages/orchestrator/src/kernel/resolve-kernel.ts';
import { getSessionManager } from '../../packages/orchestrator/src/core/session-manager.ts';
import { loadAgentRecord } from '../../packages/orchestrator/src/soul/index.ts';
import type { ToolDescriptor } from '../../packages/orchestrator/src/tools/registry.ts';
import { registerForgeaxCoreKernel } from '../../packages/server/src/kernel/forgeax-core-adapter.ts';
import { GameSessionLayout } from '../../packages/server/src/studio-session-layout.ts';
import { getActiveGame, setActiveGame } from '../../packages/server/src/game/active-game.ts';
import { GameSystemPromptComposer } from '../../packages/server/src/game/system-prompt-composer.ts';
import { studioHostTools } from '../../packages/server/src/game/host-tools.ts';
import {
  accountFinalTools,
  canonicalSha256,
  firstClassToolName,
  formalEligibility,
  hostToolWireName,
  normalizeDynamicValues,
  sha256,
  skillToolName,
  stablePrettyJson,
  stableStringify,
  type RuntimeFinalTool,
  type RuntimeRawPluginTool,
} from './runtime-snapshot-core.ts';
import { loadRuntimePin, resolveRuntimePinSource } from './runtime-artifact-integrity.ts';
import { loadValidatedRuntimeProfile } from './runtime-profile-terminal-registry.ts';

interface WorkerArgs {
  profilePath: string;
  outputPath: string;
  mode: 'discover' | 'verify';
}

export function runtimeSnapshotLayerForOrigin(
  origin: 'builtin' | 'user' | 'project',
): 'L0' | null {
  return origin === 'builtin' ? 'L0' : null;
}

function parseArgs(argv: string[]): WorkerArgs {
  let profilePath = '';
  let outputPath = '';
  let mode: WorkerArgs['mode'] = 'verify';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--profile') profilePath = next();
    else if (arg === '--output') outputPath = next();
    else if (arg === '--mode') {
      const value = next();
      if (value !== 'discover' && value !== 'verify') throw new Error(`invalid worker mode: ${value}`);
      mode = value;
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!profilePath || !outputPath) throw new Error('--profile and --output are required');
  return { profilePath: resolve(profilePath), outputPath: resolve(outputPath), mode };
}

function gitText(repoRoot: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function comboPin(repoRoot: string): Promise<{
  root: string;
  submodules: Record<string, string>;
  dirty: boolean;
}> {
  const pinSource = resolveRuntimePinSource(repoRoot, process.env.FORGEAX_RUNTIME_PIN_SOURCE);
  if (process.env.FORGEAX_RUNTIME_NO_GIT === '1') {
    const raw = loadRuntimePin(repoRoot, pinSource);
    const combo = raw.scanned_product_combo;
    if (!combo?.studio) throw new Error(`runtime snapshot immutable pin is malformed: ${pinSource}`);
    const submodules = Object.fromEntries(
      Object.entries(combo)
        .filter(([name]) => name !== 'studio')
        .map(([name, sha]) => [`packages/${name.replaceAll(':', '/')}`, sha])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return { root: combo.studio, submodules, dirty: raw.dirty !== false };
  }
  const submodules: Record<string, string> = {};
  for (const line of gitText(repoRoot, ['submodule', 'status', '--recursive']).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^.([0-9a-f]{40})\s+(\S+)/.exec(line);
    if (match) submodules[match[2]!] = match[1]!;
  }
  return {
    root: gitText(repoRoot, ['rev-parse', 'HEAD']),
    submodules: Object.fromEntries(Object.entries(submodules).sort(([left], [right]) => left.localeCompare(right))),
    dirty: gitText(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0,
  };
}

function allowDeny(agentJson: Record<string, unknown>): { allow: string[]; deny: string[] } {
  const kits = agentJson.kits && typeof agentJson.kits === 'object' && !Array.isArray(agentJson.kits)
    ? agentJson.kits as Record<string, unknown>
    : {};
  const config = kits.config && typeof kits.config === 'object' && !Array.isArray(kits.config)
    ? kits.config as Record<string, unknown>
    : {};
  const hostTools = config['host-tools'] && typeof config['host-tools'] === 'object'
    && !Array.isArray(config['host-tools'])
    ? config['host-tools'] as Record<string, unknown>
    : {};
  const clean = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').sort()
    : [];
  return { allow: clean(hostTools.allow), deny: clean(hostTools.deny) };
}

function assertStringArrayEqual(actual: string[], expected: string[], label: string): void {
  if (stableStringify(actual) !== stableStringify([...expected].sort())) {
    throw new Error(`${label} mismatch: expected=${stableStringify(expected)} actual=${stableStringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, '../..');
  const projectRoot = resolve(process.env.FORGEAX_PROJECT_ROOT ?? '');
  const userRoot = resolve(process.env.FORGEAX_USER_DIR ?? '');
  const homeRoot = resolve(process.env.HOME ?? '');
  const tempRoot = resolve(process.env.TMPDIR ?? '');
  if (!process.env.FORGEAX_PROJECT_ROOT || !process.env.FORGEAX_USER_DIR) {
    throw new Error('worker requires isolated FORGEAX_PROJECT_ROOT and FORGEAX_USER_DIR');
  }
  if (process.env.FORGEAX_SAFE_BOOT !== '1') {
    throw new Error('worker requires FORGEAX_SAFE_BOOT=1 for the L0-only standard plugin profile');
  }
  const pinSource = resolveRuntimePinSource(repoRoot, process.env.FORGEAX_RUNTIME_PIN_SOURCE);
  const { profile, profileRaw } = loadValidatedRuntimeProfile(repoRoot, args.profilePath, pinSource);
  if (process.env.FORGEAX_KERNEL_IMPL !== profile.kernel.provider_id) {
    throw new Error('worker kernel env does not match profile.kernel.provider_id');
  }

  const gameDir = resolve(projectRoot, '.forgeax', 'games', profile.fixture.game_slug);
  await mkdir(gameDir, { recursive: true });
  setActiveGame(projectRoot, profile.fixture.game_slug);
  registerForgeaxCoreKernel();
  const productHostTools = studioHostTools();
  const { app } = await createForgeaxApp({
    instanceRoot: projectRoot,
    systemPromptComposer: new GameSystemPromptComposer({ serverPort: 'snapshot', interfacePort: 'snapshot' }),
    hostTools: productHostTools,
    sessionLayoutFactory: (root) => new GameSessionLayout(root, (candidate) => getActiveGame(candidate ?? root)),
    stateRootFactory: (root) => resolve(root, '.forgeax', 'state'),
  });

  let sid = '';
  try {
    const createResponse = await app.request('http://runtime-snapshot.local/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: profile.fixture.session_alias,
        autoStart: true,
        bootstrapAgent: profile.agent.id,
      }),
    });
    if (!createResponse.ok) throw new Error(`session fixture creation failed: HTTP ${createResponse.status}`);
    const created = await createResponse.json() as { sid?: unknown; bootstrappedAgent?: unknown };
    if (typeof created.sid !== 'string' || created.bootstrappedAgent !== profile.agent.id) {
      throw new Error(`session fixture scaffold mismatch: ${stableStringify(created)}`);
    }
    sid = created.sid;

    const agentJsonFile = getPathManager().session(sid).agent(profile.agent.id).agentJson();
    const agentJsonRaw = await readFile(agentJsonFile, 'utf8');
    const agentJson = JSON.parse(agentJsonRaw) as Record<string, unknown>;
    const hostToolPolicy = allowDeny(agentJson);
    assertStringArrayEqual(hostToolPolicy.allow, profile.agent.expected_host_tool_allow, 'agent host-tool allow');
    assertStringArrayEqual(hostToolPolicy.deny, profile.agent.expected_host_tool_deny, 'agent host-tool deny');

    const record = await loadAgentRecord(profile.agent.id, {
      projectRoot,
      game: profile.fixture.game_slug,
    });
    if (record.trustTier !== profile.agent.expected_trust_tier || record.source !== profile.agent.expected_source) {
      throw new Error(
        `agent record mismatch: expected ${profile.agent.expected_source}/${profile.agent.expected_trust_tier}, `
        + `actual ${record.source}/${record.trustTier}`,
      );
    }

    const extraTools = hostToolSpecsForAgent(sid, profile.agent.id);
    const selectedKernel = resolveKernel(profile.agent.id, profile.kernel.provider_id);
    if (selectedKernel.id !== profile.kernel.provider_id) {
      throw new Error(
        `runtime snapshot kernel mismatch: expected=${profile.kernel.provider_id} actual=${selectedKernel.id}`,
      );
    }
    let runTurnInvoked = false;
    const guardedKernel = new Proxy(selectedKernel, {
      get(target, property, receiver) {
        if (property === 'runTurn') {
          return () => {
            runTurnInvoked = true;
            throw new Error('runtime snapshot crossed the runTurn boundary');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const turnRequest = await composeTurnRequest({
      message: profile.fixture.message,
      agentId: profile.agent.id,
      kernel: guardedKernel,
      threadId: profile.fixture.thread_id,
      sessionId: sid,
      callId: profile.fixture.call_id,
      ...(extraTools.length ? { extraTools } : {}),
    });
    if (runTurnInvoked) throw new Error('runtime snapshot invoked a model');

    const rawResponse = await app.request('http://runtime-snapshot.local/api/tools');
    if (!rawResponse.ok) throw new Error(`GET /api/tools failed: HTTP ${rawResponse.status}`);
    const rawBody = await rawResponse.json() as { tools?: ToolDescriptor[] };
    const rawTools = Array.isArray(rawBody.tools) ? rawBody.tools : [];
    const normalizedRawTools: RuntimeRawPluginTool[] = rawTools
      .map((tool) => ({
        id: tool.id,
        wireName: hostToolWireName(tool.id),
        extensionId: tool.extensionId,
        exposedToAI: tool.exposedToAI,
        hasHandler: tool.hasHandler === true,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    const catalog = [...catalogAll()];
    const catalogFirstClass = new Map(
      catalog.filter((entry) => entry.firstClass === true).map((entry) => [firstClassToolName(entry.id), entry.id]),
    );
    const finalTools = (turnRequest.tools ?? []) as RuntimeFinalTool[];
    const accounted = accountFinalTools({
      finalTools,
      rawPluginTools: normalizedRawTools,
      sources: {
        builtin: new Set(['memory_search', 'remember', 'ui_snapshot', 'ui_invoke', 'ui_screenshot']),
        productShell: new Set(productHostTools.map((tool) => tool.name)),
        catalogFirstClass,
        plugin: new Set(extraTools.map((tool) => tool.name)),
        soulPack: new Set(record.tools.map((tool) => tool.name)),
        skill: new Set(record.skills.map((skill) => skillToolName(skill.skillId))),
      },
      accounting: profile.tool_accounting,
      allowUnresolved: args.mode === 'discover',
    });

    const extensions = getExtensionSnapshot();
    const manifests = await Promise.all(extensions.manifests.map(async (item) => ({
      id: item.manifest.id,
      version: item.manifest.version ?? null,
      layer: runtimeSnapshotLayerForOrigin(item.origin),
      origin: relative(repoRoot, item.originPath),
      content_sha256: sha256(await readFile(item.originPath, 'utf8')),
    })));
    manifests.sort((left, right) => left.id.localeCompare(right.id));
    if (manifests.some((manifest) => manifest.layer !== 'L0')) {
      throw new Error(`runtime snapshot loaded non-L0 manifest: ${stableStringify(manifests)}`);
    }

    const pin = await comboPin(repoRoot);
    const replacements: Array<readonly [string, string]> = [
      [projectRoot, '<PROJECT_ROOT>'],
      [userRoot, '<USER_ROOT>'],
      [homeRoot, '<HOME>'],
      [tempRoot, '<TMP_ROOT>'],
      [sid, profile.fixture.session_alias],
      [repoRoot, '<REPO_ROOT>'],
    ];
    const normalizedTurnRequest = normalizeDynamicValues(turnRequest, replacements);
    const reproductionKey = {
      profile_id: profile.profile_id,
      profile_sha256: sha256(profileRaw),
      agent: {
        id: profile.agent.id,
        trust_tier: record.trustTier,
        source: record.source,
        agent_json_sha256: sha256(agentJsonRaw),
        host_tools: hostToolPolicy,
        record_tools: record.tools.map((tool) => tool.name).sort(),
        record_skills: record.skills
          .map((skill) => ({
            skillId: skill.skillId,
            extensionId: skill.extensionId,
            kind: skill.kind,
            description_sha256: sha256(skill.description),
          }))
          .sort((left, right) => left.skillId.localeCompare(right.skillId)),
        persona_sha256: sha256(record.persona),
      },
      plugin_combination: {
        policy: profile.plugin_policy,
        manifests,
        manifest_set_sha256: canonicalSha256(manifests),
      },
      product_shell: {
        ...profile.product_shell,
        host_tools: productHostTools.map((tool) => tool.name).sort(),
        host_tools_sha256: canonicalSha256(productHostTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))),
      },
      action_catalog: {
        count: catalog.length,
        content_sha256: canonicalSha256(catalog),
      },
      combination_pin: pin,
      fixture: {
        game_slug: profile.fixture.game_slug,
        session_alias: profile.fixture.session_alias,
        thread_id: profile.fixture.thread_id,
        call_id: profile.fixture.call_id,
        ui_state: profile.ui_state,
      },
    };
    const eligibility = formalEligibility({
      profileStatus: profile.status,
      dirty: pin.dirty,
      unresolvedTools: accounted.unresolved,
      scanErrorCount: extensions.scanErrors.length,
      mergeIssueCount: extensions.mergeIssues.length,
      kindIssueCount: extensions.kinds.issues.filter((issue) => issue.kind === 'tool').length,
      kindIssues: extensions.kinds.issues.filter((issue) => issue.kind === 'tool'),
      waiver: profile.formal_gate.waiver,
    });
    const snapshot = {
      schema_version: 1,
      profile_id: profile.profile_id,
      profile_sha256: sha256(profileRaw),
      capture_mode: 'worker-verified',
      reproduction_key_sha256: canonicalSha256(reproductionKey),
      reproduction_key: reproductionKey,
      runtime_environment: {
        bun_version: Bun.version,
      },
      kernel_selection: {
        requested_provider_id: profile.kernel.provider_id,
        resolved_provider_id: selectedKernel.id,
      },
      execution_boundary: {
        stopped_before: 'AgentKernel.runTurn',
        run_turn_invoked: false,
        model_calls: 0,
      },
      route_assembly: {
        chain: ['hostToolSpecsForAgent', 'extraTools', 'composeTurnRequest'],
        normalized_turn_request_sha256: canonicalSha256(normalizedTurnRequest),
        normalized_system_prompt_sha256: canonicalSha256(
          (normalizedTurnRequest as { systemPrompt?: unknown }).systemPrompt ?? null,
        ),
      },
      raw_tool_catalog: normalizedRawTools,
      final_tools: accounted.rows,
      raw_final_difference: {
        raw_count: normalizedRawTools.length,
        final_count: accounted.rows.length,
        allowed_plugin_wire_names: extraTools.map((tool) => tool.name).sort(),
        raw_only: normalizedRawTools
          .map((tool) => tool.wireName)
          .filter((name) => !accounted.rows.some((row) => row.name === name))
          .sort(),
      },
      tool_accounting: {
        complete: accounted.unresolved.length === 0,
        unresolved: accounted.unresolved,
      },
      extension_diagnostics: {
        scan_errors: extensions.scanErrors,
        merge_issues: extensions.mergeIssues,
        kind_issues: extensions.kinds.issues,
        formal_blocking_kind_issues: extensions.kinds.issues.filter((issue) => issue.kind === 'tool'),
      },
      formal_eligibility: eligibility,
    };
    const normalizedSnapshot = normalizeDynamicValues(snapshot, replacements);
    await mkdir(dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, stablePrettyJson(normalizedSnapshot), 'utf8');
  } finally {
    if (sid) await getSessionManager().delete(sid).catch(() => {});
    await getSessionManager().shutdown().catch(() => {});
    await rm(resolve(projectRoot, '.forgeax', 'active-game.json'), { force: true }).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
