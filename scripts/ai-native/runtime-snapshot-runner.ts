import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalSha256,
  sha256,
  stablePrettyJson,
  type RuntimeSnapshotProfile,
} from './runtime-snapshot-core.ts';
import { loadBaselineApproval, type LoadedBaselineApproval } from './baseline-approval.ts';
import {
  immutablePinProvesOrchestratorAncestry,
  observeRuntimePin,
  resolveRuntimePinSource,
} from './runtime-artifact-integrity.ts';
import { loadValidatedRuntimeProfile } from './runtime-profile-terminal-registry.ts';

export interface RuntimeSnapshotRunnerArgs {
  mode: 'development' | 'formal';
  profilePath: string;
  snapshotPath: string;
  reportPath: string;
  noGit: boolean;
}

interface ChildCapture {
  bytes: Uint8Array;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PinGateResult {
  requiredAncestor: string;
  orchestratorGitlink: string;
  arrived: boolean;
  verification: 'git-ancestry' | 'immutable-pin-git-ancestry-proof';
  pinSchemaVersion: 3;
  ancestryProof: {
    requiredAncestor: string;
    verifiedGitlink: string;
    verification: 'git-merge-base-is-ancestor';
  };
  expectedBunVersion: string;
  bunVersionMatches: boolean;
  scannerInputFingerprintMatches: boolean;
  scannerConfigurationFingerprintMatches: boolean;
  reasonCodes: string[];
  baselineApproval: LoadedBaselineApproval;
}

const CHILD_TIMEOUT_MS = 60_000;

export function normalizeChildSummary(output: string, repoRoot: string, isolationRoot: string): string {
  return output
    .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/gm, '[<TIME>]')
    .split(isolationRoot).join('<ISOLATION_ROOT>')
    .split(repoRoot).join('<REPO_ROOT>');
}

export function parseRuntimeSnapshotRunnerArgs(argv: string[]): RuntimeSnapshotRunnerArgs {
  let mode: RuntimeSnapshotRunnerArgs['mode'] = 'development';
  let profilePath = '';
  let snapshotPath = '';
  let reportPath = '';
  let noGit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--mode') {
      const value = next();
      if (value !== 'development' && value !== 'formal') throw new Error(`invalid runner mode: ${value}`);
      mode = value;
    } else if (arg === '--profile') profilePath = next();
    else if (arg === '--snapshot') snapshotPath = next();
    else if (arg === '--report') reportPath = next();
    else if (arg === '--no-git') noGit = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!profilePath || !snapshotPath || !reportPath) {
    throw new Error('--profile, --snapshot, and --report are required');
  }
  return {
    mode,
    profilePath: resolve(profilePath),
    snapshotPath: resolve(snapshotPath),
    reportPath: resolve(reportPath),
    noGit,
  };
}

function gitResult(repoRoot: string, args: string[], cwd = repoRoot): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

export function evaluatePinGate(
  repoRoot: string,
  requiredAncestor: string,
  pinSource: string = resolveRuntimePinSource(repoRoot),
): PinGateResult {
  const observation = observeRuntimePin(repoRoot, pinSource);
  const lsTree = gitResult(repoRoot, ['ls-tree', 'HEAD', 'packages/orchestrator']);
  if (lsTree.exitCode !== 0) throw new Error(`could not read orchestrator gitlink: ${lsTree.stderr}`);
  const match = /^160000 commit ([0-9a-f]{40})\tpackages\/orchestrator$/.exec(lsTree.stdout);
  if (!match) throw new Error(`unexpected orchestrator gitlink row: ${lsTree.stdout}`);
  const orchestratorGitlink = match[1]!;
  const proofMatches = immutablePinProvesOrchestratorAncestry(
    observation.pin,
    requiredAncestor,
    orchestratorGitlink,
  );
  const ancestry = gitResult(
    repoRoot,
    ['merge-base', '--is-ancestor', requiredAncestor, orchestratorGitlink],
    resolve(repoRoot, 'packages/orchestrator'),
  );
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
    throw new Error(`orchestrator ancestry check failed: ${ancestry.stderr}`);
  }
  return {
    requiredAncestor,
    orchestratorGitlink,
    arrived: ancestry.exitCode === 0 && proofMatches,
    verification: 'git-ancestry',
    pinSchemaVersion: observation.pin.schema_version,
    ancestryProof: {
      requiredAncestor: observation.pin.orchestrator_ancestry_proof.required_ancestor,
      verifiedGitlink: observation.pin.orchestrator_ancestry_proof.verified_gitlink,
      verification: observation.pin.orchestrator_ancestry_proof.verification,
    },
    expectedBunVersion: observation.expectedBunVersion,
    bunVersionMatches: observation.bunVersionMatches,
    scannerInputFingerprintMatches: observation.scannerInputFingerprintMatches,
    scannerConfigurationFingerprintMatches: observation.scannerConfigurationFingerprintMatches,
    reasonCodes: observation.reasonCodes,
    baselineApproval: loadBaselineApproval(repoRoot, observation.pin.baseline_id, pinSource),
  };
}

export async function evaluateImmutablePinGate(
  repoRoot: string,
  requiredAncestor: string,
  pinSource: string,
): Promise<PinGateResult> {
  const observation = observeRuntimePin(repoRoot, pinSource);
  const raw = observation.pin;
  const combo = raw.scanned_product_combo;
  const orchestratorGitlink = combo?.orchestrator;
  if (!orchestratorGitlink || !/^[0-9a-f]{40}$/.test(orchestratorGitlink)) {
    throw new Error(`immutable runtime pin has no valid orchestrator entry: ${pinSource}`);
  }
  for (const [name, sha] of Object.entries(combo)) {
    if (!name || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`immutable runtime pin has invalid product combo entry ${name}: ${sha}`);
    }
  }
  return {
    requiredAncestor,
    orchestratorGitlink,
    arrived: immutablePinProvesOrchestratorAncestry(raw, requiredAncestor, orchestratorGitlink),
    verification: 'immutable-pin-git-ancestry-proof',
    pinSchemaVersion: raw.schema_version,
    ancestryProof: {
      requiredAncestor: raw.orchestrator_ancestry_proof.required_ancestor,
      verifiedGitlink: raw.orchestrator_ancestry_proof.verified_gitlink,
      verification: raw.orchestrator_ancestry_proof.verification,
    },
    expectedBunVersion: observation.expectedBunVersion,
    bunVersionMatches: observation.bunVersionMatches,
    scannerInputFingerprintMatches: observation.scannerInputFingerprintMatches,
    scannerConfigurationFingerprintMatches: observation.scannerConfigurationFingerprintMatches,
    reasonCodes: observation.reasonCodes,
    baselineApproval: loadBaselineApproval(repoRoot, raw.baseline_id, pinSource),
  };
}

export function assertByteIdentical(left: Uint8Array, right: Uint8Array): void {
  if (left.byteLength !== right.byteLength || !left.every((byte, index) => byte === right[index])) {
    throw new Error(
      `runtime snapshots are not byte-identical: first=${sha256(left)} second=${sha256(right)}`,
    );
  }
}

export function assertCaptureEligibility(
  mode: RuntimeSnapshotRunnerArgs['mode'],
  eligibility: { eligible?: unknown; blockers?: unknown },
): void {
  if (eligibility.eligible !== true) {
    throw new Error(
      `${mode} snapshot is not eligible and has no complete waiver: `
      + `${JSON.stringify(eligibility.blockers ?? [])}`,
    );
  }
}

async function runChild(
  repoRoot: string,
  profile: RuntimeSnapshotProfile,
  profilePath: string,
  pinSource: string,
  noGit: boolean,
): Promise<ChildCapture> {
  const isolationRoot = await mkdtemp(join(tmpdir(), 'forgeax-runtime-snapshot-'));
  const projectRoot = join(isolationRoot, 'project');
  const userRoot = join(isolationRoot, 'user');
  const homeRoot = join(isolationRoot, 'home');
  const processTempRoot = join(isolationRoot, 'tmp');
  const outputPath = join(isolationRoot, 'snapshot.json');
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(userRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
    mkdir(processTempRoot, { recursive: true }),
  ]);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SHELL: process.env.SHELL ?? '/bin/sh',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    XDG_CONFIG_HOME: join(homeRoot, '.config'),
    XDG_CACHE_HOME: join(homeRoot, '.cache'),
    XDG_DATA_HOME: join(homeRoot, '.local', 'share'),
    TMPDIR: processTempRoot,
    FORGEAX_PROJECT_ROOT: projectRoot,
    FORGEAX_USER_DIR: userRoot,
    FORGEAX_SAFE_BOOT: '1',
    FORGEAX_KERNEL_IMPL: profile.kernel.provider_id,
    FORGEAX_LANG: 'zh',
    FORGEAX_RUNTIME_PIN_SOURCE: pinSource,
    FORGEAX_RUNTIME_NO_GIT: noGit ? '1' : '0',
  };
  try {
    const processHandle = Bun.spawn([
      process.execPath,
      resolve(repoRoot, 'scripts/ai-native/runtime-snapshot-worker.ts'),
      '--profile',
      profilePath,
      '--output',
      outputPath,
      '--mode',
      'verify',
    ], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      processHandle.kill('SIGTERM');
    }, CHILD_TIMEOUT_MS);
    timeout.unref?.();
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    clearTimeout(timeout);
    if (timedOut) {
      throw new Error(`runtime snapshot child exceeded ${CHILD_TIMEOUT_MS}ms and was terminated`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `runtime snapshot child failed (${exitCode})\nstdout:\n${stdout.trim()}\nstderr:\n${stderr.trim()}`,
      );
    }
    return {
      bytes: await readFile(outputPath),
      stdout: normalizeChildSummary(stdout, repoRoot, isolationRoot),
      stderr: normalizeChildSummary(stderr, repoRoot, isolationRoot),
      exitCode,
    };
  } finally {
    await rm(isolationRoot, { recursive: true, force: true });
  }
}

export function sealRuntimeSnapshot(
  workerBytes: Uint8Array,
  captureMode: RuntimeSnapshotRunnerArgs['mode'],
): Uint8Array {
  const raw = JSON.parse(new TextDecoder().decode(workerBytes)) as Record<string, unknown>;
  const reproductionKey = raw.reproduction_key;
  if (!reproductionKey || typeof reproductionKey !== 'object' || Array.isArray(reproductionKey)) {
    throw new Error('runtime snapshot worker emitted no reproduction_key');
  }
  const sealedKey = { ...(reproductionKey as Record<string, unknown>) };
  delete sealedKey.runtime_environment;
  sealedKey.capture_mode = captureMode;
  raw.schema_version = 2;
  raw.capture_mode = captureMode;
  raw.reproduction_key = sealedKey;
  raw.reproduction_key_sha256 = canonicalSha256(sealedKey);
  return new TextEncoder().encode(stablePrettyJson(raw));
}

export function captureModeFromTraversedGuard(traversedFormalGuard: boolean): RuntimeSnapshotRunnerArgs['mode'] {
  return traversedFormalGuard ? 'formal' : 'development';
}

export async function runRuntimeSnapshot(
  args: RuntimeSnapshotRunnerArgs,
  options: { repoRoot?: string } = {},
): Promise<void> {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dir, '../..'));
  const pinSource = resolveRuntimePinSource(repoRoot);
  const { profile, profileRaw } = loadValidatedRuntimeProfile(repoRoot, args.profilePath, pinSource);
  const pinGate = args.noGit
    ? await evaluateImmutablePinGate(repoRoot, profile.formal_gate.required_orchestrator_ancestor, pinSource)
    : evaluatePinGate(repoRoot, profile.formal_gate.required_orchestrator_ancestor, pinSource);
  let traversedFormalGuard = false;
  if (args.mode === 'formal') {
    if (profile.status !== 'approved') throw new Error('formal snapshot requires an approved profile');
    if (!pinGate.arrived) throw new Error('formal snapshot blocked: required orchestrator pin has not arrived');
    traversedFormalGuard = true;
  }
  const derivedCaptureMode = captureModeFromTraversedGuard(traversedFormalGuard);

  const first = await runChild(repoRoot, profile, args.profilePath, pinSource, args.noGit);
  const second = await runChild(repoRoot, profile, args.profilePath, pinSource, args.noGit);
  const firstBytes = sealRuntimeSnapshot(first.bytes, derivedCaptureMode);
  const secondBytes = sealRuntimeSnapshot(second.bytes, derivedCaptureMode);
  assertByteIdentical(firstBytes, secondBytes);
  const snapshot = JSON.parse(new TextDecoder().decode(firstBytes)) as {
    formal_eligibility?: { eligible?: unknown; blockers?: unknown; waived_blockers?: unknown };
    tool_accounting?: { complete?: unknown };
    reproduction_key_sha256?: unknown;
    runtime_environment?: { bun_version?: unknown };
  };
  if (snapshot.tool_accounting?.complete !== true) {
    throw new Error('runtime snapshot tool accounting is incomplete');
  }
  if (typeof snapshot.reproduction_key_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.reproduction_key_sha256)) {
    throw new Error('runtime snapshot has no valid reproduction_key_sha256');
  }
  if (snapshot.runtime_environment?.bun_version !== Bun.version) {
    throw new Error(
      `runtime snapshot Bun version mismatch: expected=${Bun.version} actual=${String(snapshot.runtime_environment?.bun_version)}`,
    );
  }
  const snapshotFormalEligibility = snapshot.formal_eligibility;
  if (!snapshotFormalEligibility) throw new Error('runtime snapshot has no formal eligibility result');
  assertCaptureEligibility(args.mode, snapshotFormalEligibility);

  await Promise.all([
    mkdir(dirname(args.snapshotPath), { recursive: true }),
    mkdir(dirname(args.reportPath), { recursive: true }),
  ]);
  await writeFile(args.snapshotPath, firstBytes);
  const { baselineApproval, ...reportedPinGate } = pinGate;
  const baselineApprovalStatus = baselineApproval.status;
  const formalIntegrityRejected = args.mode === 'formal' && pinGate.reasonCodes.length > 0;
  const report = {
    schema_version: 2,
    mode: args.mode,
    status: args.mode === 'formal' ? 'FORMAL_CAPTURED' : 'DEVELOPMENT_VERIFIED',
    formal_record: args.mode === 'formal',
    profile_id: profile.profile_id,
    profile_status: profile.status,
    coverage_tier: args.mode === 'development' || baselineApprovalStatus !== 'approved' || formalIntegrityRejected
      ? 'provisional'
      : Array.isArray(snapshotFormalEligibility.waived_blockers)
        && snapshotFormalEligibility.waived_blockers.length > 0
        ? 'formal-with-waiver'
        : 'formal',
    reproduction_key_sha256: snapshot.reproduction_key_sha256,
    runtime_environment: { bun_version: Bun.version },
    baseline_approval: {
      baseline_id: baselineApproval.baseline_id,
      baseline_bytes_sha256: baselineApproval.baseline_bytes_sha256,
      status: baselineApproval.status,
      decision_evidence: baselineApproval.decision_evidence,
      decision_evidence_sha256: baselineApproval.decision_evidence_sha256,
      approved_content_commit: baselineApproval.approved_content_commit,
      approval_manifest_raw_sha256: baselineApproval.approval_manifest_raw_sha256,
      approval_scope_sha256: baselineApproval.approval_scope_sha256,
      approval_package_raw_sha256: baselineApproval.approval_package_raw_sha256,
    },
    profile_path: relative(repoRoot, args.profilePath),
    snapshot_path: relative(repoRoot, args.snapshotPath),
    profile_sha256: sha256(profileRaw),
    clean_processes: 2,
    byte_identical: true,
    snapshot_sha256: sha256(firstBytes),
    snapshot_bytes: firstBytes.byteLength,
    pin_gate: reportedPinGate,
    child_processes: [first, second].map((child, index) => ({
      index: index + 1,
      exit_code: child.exitCode,
      stdout_sha256: sha256(child.stdout),
      stderr_sha256: sha256(child.stderr),
    })),
    formal_eligibility: snapshotFormalEligibility,
  };
  await writeFile(args.reportPath, stablePrettyJson(report), 'utf8');
  process.stdout.write(
    `runtime snapshot ${report.status}: ${report.snapshot_sha256} (${report.snapshot_bytes} bytes)\n`,
  );
}

if (import.meta.main) {
  await runRuntimeSnapshot(parseRuntimeSnapshotRunnerArgs(process.argv.slice(2)));
}
