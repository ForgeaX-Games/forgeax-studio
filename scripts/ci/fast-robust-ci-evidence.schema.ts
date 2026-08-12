export const FAST_ROBUST_CI_EVIDENCE_VERSION = 1 as const;

type RecordValue = Record<string, unknown>;

const fail = (path: string, message: string): never => {
  throw new Error(`fast-robust-ci schema: ${path} ${message}`);
};

function object(value: unknown, path: string, keys: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  const record = value as RecordValue;
  const expected = new Set(keys);
  const actual = Object.keys(record);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const unknown = actual.filter((key) => !expected.has(key));
  if (missing.length > 0) fail(path, `missing ${missing.join(',')}`);
  if (unknown.length > 0) fail(path, `has unknown ${unknown.join(',')}`);
  return record;
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as RecordValue;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value as unknown[];
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
  return (value as string).trim();
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value as boolean;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be finite');
  return value as number;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const result = number(value, path);
  if (result < 0) fail(path, 'must be non-negative');
  return result;
}

function nullableNonNegativeNumber(value: unknown, path: string): number | null {
  return value === null ? null : nonNegativeNumber(value, path);
}

function integer(value: unknown, path: string): number {
  const result = number(value, path);
  if (!Number.isInteger(result)) fail(path, 'must be an integer');
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result <= 0) fail(path, 'must be positive');
  return result;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result < 0) fail(path, 'must be non-negative');
  return result;
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  return value === null ? null : positiveInteger(value, path);
}

function enumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  const result = text(value, path);
  if (!values.includes(result as T)) fail(path, `must be one of ${values.join('|')}`);
  return result as T;
}

function nullableEnumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T | null {
  return value === null ? null : enumValue(value, path, values);
}

function sha(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[0-9a-f]{40}$/.test(result)) fail(path, 'must be a lowercase git SHA');
  return result;
}

function nullableSha(value: unknown, path: string): string | null {
  return value === null ? null : sha(value, path);
}

function stringList(value: unknown, path: string): string[] {
  return list(value, path).map((item, index) => text(item, `${path}[${index}]`));
}

function parseSourceRef(value: unknown, path: string): SourceRef {
  const item = object(value, path, ['path', 'sha256', 'kind', 'bytes']);
  const kind = enumValue(item.kind, `${path}.kind`, ['workflow', 'ruleset', 'runs', 'jobs', 'artifacts', 'submodules', 'workspace', 'transfer'] as const);
  const sha256 = text(item.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${path}.sha256`, 'must be a lowercase SHA-256');
  return { path: text(item.path, `${path}.path`), sha256, kind, bytes: nonNegativeInteger(item.bytes, `${path}.bytes`) };
}

function parseRunner(value: unknown, path: string): Runner {
  const item = object(value, path, ['kind', 'labels', 'expression']);
  return {
    kind: enumValue(item.kind, `${path}.kind`, ['labels', 'expression', 'missing'] as const),
    labels: stringList(item.labels, `${path}.labels`),
    expression: nullableText(item.expression, `${path}.expression`),
  };
}

function parseJob(value: unknown, path: string): Job {
  const item = object(value, path, ['key', 'name', 'needs', 'runner', 'timeoutMinutes', 'context', 'eventNames', 'trustBoundary', 'permissions', 'secrets']);
  return {
    key: text(item.key, `${path}.key`),
    name: text(item.name, `${path}.name`),
    needs: stringList(item.needs, `${path}.needs`),
    runner: parseRunner(item.runner, `${path}.runner`),
    timeoutMinutes: item.timeoutMinutes === null ? null : positiveInteger(item.timeoutMinutes, `${path}.timeoutMinutes`),
    context: text(item.context, `${path}.context`),
    eventNames: stringList(item.eventNames, `${path}.eventNames`),
    trustBoundary: enumValue(item.trustBoundary, `${path}.trustBoundary`, ['pull-request', 'trusted-base', 'post-merge-observer', 'base-owned', 'unknown'] as const),
    permissions: stringList(item.permissions, `${path}.permissions`),
    secrets: enumValue(item.secrets, `${path}.secrets`, ['unavailable', 'available', 'event-dependent', 'unknown'] as const),
  };
}

function parseWorkflow(value: unknown, path: string): Workflow {
  const item = object(value, path, ['path', 'name', 'events', 'trustBoundary', 'permissions', 'jobs']);
  const jobs = list(item.jobs, `${path}.jobs`).map((job, index) => parseJob(job, `${path}.jobs[${index}]`));
  if (jobs.length === 0) fail(`${path}.jobs`, 'must not be empty');
  return {
    path: text(item.path, `${path}.path`),
    name: text(item.name, `${path}.name`),
    events: stringList(item.events, `${path}.events`),
    trustBoundary: enumValue(item.trustBoundary, `${path}.trustBoundary`, ['pull-request', 'trusted-base', 'post-merge-observer', 'base-owned', 'unknown'] as const),
    permissions: stringList(item.permissions, `${path}.permissions`),
    jobs,
  };
}

function parseNeedsEdge(value: unknown, path: string): NeedsEdge {
  const item = object(value, path, ['workflowPath', 'fromJob', 'toJob']);
  return { workflowPath: text(item.workflowPath, `${path}.workflowPath`), fromJob: text(item.fromJob, `${path}.fromJob`), toJob: text(item.toJob, `${path}.toJob`) };
}

function parseJobEdge(value: unknown, path: string): JobEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'context']);
  return { workflowPath: text(item.workflowPath, `${path}.workflowPath`), jobKey: text(item.jobKey, `${path}.jobKey`), context: text(item.context, `${path}.context`) };
}

function parseRunnerEdge(value: unknown, path: string): RunnerEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'runnerKind', 'labels', 'expression']);
  return {
    workflowPath: text(item.workflowPath, `${path}.workflowPath`),
    jobKey: text(item.jobKey, `${path}.jobKey`),
    runnerKind: enumValue(item.runnerKind, `${path}.runnerKind`, ['labels', 'expression', 'missing'] as const),
    labels: stringList(item.labels, `${path}.labels`),
    expression: nullableText(item.expression, `${path}.expression`),
  };
}

function parseTimeoutEdge(value: unknown, path: string): TimeoutEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'timeoutMinutes']);
  return { workflowPath: text(item.workflowPath, `${path}.workflowPath`), jobKey: text(item.jobKey, `${path}.jobKey`), timeoutMinutes: item.timeoutMinutes === null ? null : positiveInteger(item.timeoutMinutes, `${path}.timeoutMinutes`) };
}

function parseContextEdge(value: unknown, path: string): ContextEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'context', 'required']);
  return { workflowPath: text(item.workflowPath, `${path}.workflowPath`), jobKey: text(item.jobKey, `${path}.jobKey`), context: text(item.context, `${path}.context`), required: boolean(item.required, `${path}.required`) };
}

function parseEventEdge(value: unknown, path: string): EventEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'event']);
  return { workflowPath: text(item.workflowPath, `${path}.workflowPath`), jobKey: text(item.jobKey, `${path}.jobKey`), event: text(item.event, `${path}.event`) };
}

function parseTrustEdge(value: unknown, path: string): TrustEdge {
  const item = object(value, path, ['workflowPath', 'jobKey', 'boundary', 'secrets', 'permissions']);
  return {
    workflowPath: text(item.workflowPath, `${path}.workflowPath`),
    jobKey: text(item.jobKey, `${path}.jobKey`),
    boundary: enumValue(item.boundary, `${path}.boundary`, ['pull-request', 'trusted-base', 'post-merge-observer', 'base-owned', 'unknown'] as const),
    secrets: enumValue(item.secrets, `${path}.secrets`, ['unavailable', 'available', 'event-dependent', 'unknown'] as const),
    permissions: stringList(item.permissions, `${path}.permissions`),
  };
}

function parseControlPlane(value: unknown, path: string): ControlPlane {
  const item = object(value, path, ['workflows', 'requiredContexts', 'edges']);
  const workflows = list(item.workflows, `${path}.workflows`).map((workflow, index) => parseWorkflow(workflow, `${path}.workflows[${index}]`));
  if (workflows.length === 0) fail(`${path}.workflows`, 'must not be empty');
  const edges = object(item.edges, `${path}.edges`, ['jobs', 'needs', 'runners', 'timeouts', 'contexts', 'events', 'trust']);
  return {
    workflows,
    requiredContexts: stringList(item.requiredContexts, `${path}.requiredContexts`),
    edges: {
      jobs: list(edges.jobs, `${path}.edges.jobs`).map((edge, index) => parseJobEdge(edge, `${path}.edges.jobs[${index}]`)),
      needs: list(edges.needs, `${path}.edges.needs`).map((edge, index) => parseNeedsEdge(edge, `${path}.edges.needs[${index}]`)),
      runners: list(edges.runners, `${path}.edges.runners`).map((edge, index) => parseRunnerEdge(edge, `${path}.edges.runners[${index}]`)),
      timeouts: list(edges.timeouts, `${path}.edges.timeouts`).map((edge, index) => parseTimeoutEdge(edge, `${path}.edges.timeouts[${index}]`)),
      contexts: list(edges.contexts, `${path}.edges.contexts`).map((edge, index) => parseContextEdge(edge, `${path}.edges.contexts[${index}]`)),
      events: list(edges.events, `${path}.edges.events`).map((edge, index) => parseEventEdge(edge, `${path}.edges.events[${index}]`)),
      trust: list(edges.trust, `${path}.edges.trust`).map((edge, index) => parseTrustEdge(edge, `${path}.edges.trust[${index}]`)),
    },
  };
}

function parseRecursivePin(value: unknown, path: string): RecursivePin {
  const item = object(value, path, ['path', 'sha', 'marker', 'materialized', 'ownerManifestStatus']);
  return {
    path: text(item.path, `${path}.path`),
    sha: sha(item.sha, `${path}.sha`),
    marker: enumValue(item.marker, `${path}.marker`, ['clean', 'modified', 'uninitialized', 'conflicted'] as const),
    materialized: boolean(item.materialized, `${path}.materialized`),
    ownerManifestStatus: enumValue(item.ownerManifestStatus, `${path}.ownerManifestStatus`, ['available', 'unavailable', 'not-found'] as const),
  };
}

function parseWorkspaceOwner(value: unknown, path: string): WorkspaceOwner {
  const item = object(value, path, ['workspacePattern', 'manifestPath', 'packageName', 'owner', 'status']);
  return {
    workspacePattern: text(item.workspacePattern, `${path}.workspacePattern`),
    manifestPath: nullableText(item.manifestPath, `${path}.manifestPath`),
    packageName: nullableText(item.packageName, `${path}.packageName`),
    owner: text(item.owner, `${path}.owner`),
    status: enumValue(item.status, `${path}.status`, ['resolved', 'unavailable'] as const),
  };
}

function parseCensus(value: unknown, path: string): Census {
  const item = object(value, path, ['recursivePins', 'workspaceOwners']);
  const pins = object(item.recursivePins, `${path}.recursivePins`, ['declaredCount', 'materializedCount', 'entries']);
  const workspace = object(item.workspaceOwners, `${path}.workspaceOwners`, ['declarationCount', 'entries', 'ownerCounts']);
  const ownerCounts = record(workspace.ownerCounts, `${path}.workspaceOwners.ownerCounts`);
  const parsedOwnerCounts = Object.fromEntries(Object.entries(ownerCounts).map(([owner, count]) => [owner, nonNegativeInteger(count, `${path}.workspaceOwners.ownerCounts.${owner}`)]));
  return {
    recursivePins: {
      declaredCount: nonNegativeInteger(pins.declaredCount, `${path}.recursivePins.declaredCount`),
      materializedCount: nonNegativeInteger(pins.materializedCount, `${path}.recursivePins.materializedCount`),
      entries: list(pins.entries, `${path}.recursivePins.entries`).map((entry, index) => parseRecursivePin(entry, `${path}.recursivePins.entries[${index}]`)),
    },
    workspaceOwners: {
      declarationCount: nonNegativeInteger(workspace.declarationCount, `${path}.workspaceOwners.declarationCount`),
      entries: list(workspace.entries, `${path}.workspaceOwners.entries`).map((entry, index) => parseWorkspaceOwner(entry, `${path}.workspaceOwners.entries[${index}]`)),
      ownerCounts: parsedOwnerCounts,
    },
  };
}

function parseStepFact(value: unknown, path: string): StepFact {
  const item = object(value, path, ['name', 'conclusion', 'completedAt']);
  return { name: text(item.name, `${path}.name`), conclusion: nullableText(item.conclusion, `${path}.conclusion`), completedAt: nullableText(item.completedAt, `${path}.completedAt`) };
}

function parseJobFact(value: unknown, path: string): JobFact {
  const item = object(value, path, ['id', 'name', 'status', 'conclusion', 'runnerName', 'runnerGroup', 'labels', 'createdAt', 'startedAt', 'completedAt', 'steps', 'failureOwnership']);
  return {
    id: positiveInteger(item.id, `${path}.id`),
    name: text(item.name, `${path}.name`),
    status: nullableText(item.status, `${path}.status`),
    conclusion: nullableText(item.conclusion, `${path}.conclusion`),
    runnerName: nullableText(item.runnerName, `${path}.runnerName`),
    runnerGroup: nullableText(item.runnerGroup, `${path}.runnerGroup`),
    labels: stringList(item.labels, `${path}.labels`),
    createdAt: nullableText(item.createdAt, `${path}.createdAt`),
    startedAt: nullableText(item.startedAt, `${path}.startedAt`),
    completedAt: nullableText(item.completedAt, `${path}.completedAt`),
    steps: list(item.steps, `${path}.steps`).map((step, index) => parseStepFact(step, `${path}.steps[${index}]`)),
    failureOwnership: nullableEnumValue(item.failureOwnership, `${path}.failureOwnership`, ['repository', 'transport', 'external', 'unknown'] as const),
  };
}

function parseArtifactFact(value: unknown, path: string): ArtifactFact {
  const item = object(value, path, ['id', 'name', 'sizeBytes', 'createdAt', 'expired', 'workflowRunId']);
  return {
    id: positiveInteger(item.id, `${path}.id`),
    name: text(item.name, `${path}.name`),
    sizeBytes: nonNegativeInteger(item.sizeBytes, `${path}.sizeBytes`),
    createdAt: nullableText(item.createdAt, `${path}.createdAt`),
    expired: boolean(item.expired, `${path}.expired`),
    workflowRunId: item.workflowRunId === null ? null : positiveInteger(item.workflowRunId, `${path}.workflowRunId`),
  };
}

function parseFailureFact(value: unknown, path: string): FailureFact {
  const item = object(value, path, ['status', 'occurredAt', 'secondsFromAdmission', 'jobName', 'stepName', 'ownership', 'noClaimReason']);
  const status = enumValue(item.status, `${path}.status`, ['claimed', 'candidate-no-claim', 'not-observed', 'invalid'] as const);
  const ownership = enumValue(item.ownership, `${path}.ownership`, ['repository', 'transport', 'external', 'unknown'] as const);
  const result: FailureFact = {
    status,
    occurredAt: nullableText(item.occurredAt, `${path}.occurredAt`),
    secondsFromAdmission: nullableNonNegativeNumber(item.secondsFromAdmission, `${path}.secondsFromAdmission`),
    jobName: nullableText(item.jobName, `${path}.jobName`),
    stepName: nullableText(item.stepName, `${path}.stepName`),
    ownership,
    noClaimReason: nullableText(item.noClaimReason, `${path}.noClaimReason`),
  };
  if (result.status === 'claimed' && (result.secondsFromAdmission === null || result.occurredAt === null || result.ownership !== 'repository')) {
    fail(path, 'claimed failure needs repository ownership and timing');
  }
  return result;
}

function parseTiming(value: unknown, path: string): Timing {
  const item = object(value, path, ['admissionSeconds', 'queueProxySeconds', 'activeDurationSeconds', 'artifactReadySeconds', 'firstDecisiveFailure']);
  return {
    admissionSeconds: nullableNonNegativeNumber(item.admissionSeconds, `${path}.admissionSeconds`),
    queueProxySeconds: nullableNonNegativeNumber(item.queueProxySeconds, `${path}.queueProxySeconds`),
    activeDurationSeconds: nullableNonNegativeNumber(item.activeDurationSeconds, `${path}.activeDurationSeconds`),
    artifactReadySeconds: nullableNonNegativeNumber(item.artifactReadySeconds, `${path}.artifactReadySeconds`),
    firstDecisiveFailure: parseFailureFact(item.firstDecisiveFailure, `${path}.firstDecisiveFailure`),
  };
}

function parseRunFact(value: unknown, path: string): RunFact {
  const item = object(value, path, ['runId', 'runAttempt', 'event', 'status', 'conclusion', 'headSha', 'headBranch', 'createdAt', 'startedAt', 'updatedAt', 'rosterKey', 'runnerClassKey', 'outcomeKey', 'jobsTerminal', 'jobs', 'artifacts', 'timing', 'eligibility']);
  const eligibility = object(item.eligibility, `${path}.eligibility`, ['comparable', 'reasons']);
  return {
    runId: positiveInteger(item.runId, `${path}.runId`),
    runAttempt: nullablePositiveInteger(item.runAttempt, `${path}.runAttempt`),
    event: nullableText(item.event, `${path}.event`),
    status: nullableText(item.status, `${path}.status`),
    conclusion: nullableText(item.conclusion, `${path}.conclusion`),
    headSha: nullableSha(item.headSha, `${path}.headSha`),
    headBranch: nullableText(item.headBranch, `${path}.headBranch`),
    createdAt: nullableText(item.createdAt, `${path}.createdAt`),
    startedAt: nullableText(item.startedAt, `${path}.startedAt`),
    updatedAt: nullableText(item.updatedAt, `${path}.updatedAt`),
    rosterKey: nullableText(item.rosterKey, `${path}.rosterKey`),
    runnerClassKey: nullableText(item.runnerClassKey, `${path}.runnerClassKey`),
    outcomeKey: nullableText(item.outcomeKey, `${path}.outcomeKey`),
    jobsTerminal: boolean(item.jobsTerminal, `${path}.jobsTerminal`),
    jobs: list(item.jobs, `${path}.jobs`).map((job, index) => parseJobFact(job, `${path}.jobs[${index}]`)),
    artifacts: list(item.artifacts, `${path}.artifacts`).map((artifact, index) => parseArtifactFact(artifact, `${path}.artifacts[${index}]`)),
    timing: parseTiming(item.timing, `${path}.timing`),
    eligibility: { comparable: boolean(eligibility.comparable, `${path}.eligibility.comparable`), reasons: stringList(eligibility.reasons, `${path}.eligibility.reasons`) },
  };
}

function parseComparableSample(value: unknown, path: string): ComparableSample {
  const item = object(value, path, ['runId', 'event', 'runAttempt', 'rosterKey', 'runnerClassKey', 'admissionSeconds', 'queueProxySeconds', 'activeDurationSeconds', 'artifactReadySeconds', 'firstDecisiveFailure', 'noClaimReasons']);
  return {
    runId: positiveInteger(item.runId, `${path}.runId`),
    event: text(item.event, `${path}.event`),
    runAttempt: positiveInteger(item.runAttempt, `${path}.runAttempt`),
    rosterKey: text(item.rosterKey, `${path}.rosterKey`),
    runnerClassKey: text(item.runnerClassKey, `${path}.runnerClassKey`),
    admissionSeconds: nullableNonNegativeNumber(item.admissionSeconds, `${path}.admissionSeconds`),
    queueProxySeconds: nullableNonNegativeNumber(item.queueProxySeconds, `${path}.queueProxySeconds`),
    activeDurationSeconds: nullableNonNegativeNumber(item.activeDurationSeconds, `${path}.activeDurationSeconds`),
    artifactReadySeconds: nullableNonNegativeNumber(item.artifactReadySeconds, `${path}.artifactReadySeconds`),
    firstDecisiveFailure: parseFailureFact(item.firstDecisiveFailure, `${path}.firstDecisiveFailure`),
    noClaimReasons: stringList(item.noClaimReasons, `${path}.noClaimReasons`),
  };
}

function parseNoClaimReason(value: unknown, path: string): NoClaimReason {
  const item = object(value, path, ['code', 'count', 'runIds', 'detail']);
  return { code: text(item.code, `${path}.code`), count: nonNegativeInteger(item.count, `${path}.count`), runIds: list(item.runIds, `${path}.runIds`).map((runId, index) => positiveInteger(runId, `${path}.runIds[${index}]`)), detail: text(item.detail, `${path}.detail`) };
}

function parseHistory(value: unknown, path: string): History {
  const item = object(value, path, ['workflow', 'rawRunCount', 'rawJobRunCount', 'rawArtifactRunCount', 'canonicalTopology', 'runs', 'comparableSamples', 'population']);
  if (item.workflow !== '.github/workflows/ci.yml') fail(`${path}.workflow`, 'must be .github/workflows/ci.yml');
  const topology = object(item.canonicalTopology, `${path}.canonicalTopology`, ['rosterKey', 'runnerClassKey', 'event', 'runAttempt']);
  const population = object(item.population, `${path}.population`, ['requiredMinimum', 'sampleCount', 'status', 'noClaimReasons']);
  if (population.requiredMinimum !== 20) fail(`${path}.population.requiredMinimum`, 'must be 20');
  const sampleCount = nonNegativeInteger(population.sampleCount, `${path}.population.sampleCount`);
  const status = enumValue(population.status, `${path}.population.status`, ['pass', 'no-claim'] as const);
  if (status === 'pass' && sampleCount < 20) fail(`${path}.population`, 'pass requires at least 20 comparable samples');
  return {
    workflow: '.github/workflows/ci.yml',
    rawRunCount: nonNegativeInteger(item.rawRunCount, `${path}.rawRunCount`),
    rawJobRunCount: nonNegativeInteger(item.rawJobRunCount, `${path}.rawJobRunCount`),
    rawArtifactRunCount: nonNegativeInteger(item.rawArtifactRunCount, `${path}.rawArtifactRunCount`),
    canonicalTopology: {
      rosterKey: nullableText(topology.rosterKey, `${path}.canonicalTopology.rosterKey`),
      runnerClassKey: nullableText(topology.runnerClassKey, `${path}.canonicalTopology.runnerClassKey`),
      event: nullableText(topology.event, `${path}.canonicalTopology.event`),
      runAttempt: nullablePositiveInteger(topology.runAttempt, `${path}.canonicalTopology.runAttempt`),
    },
    runs: list(item.runs, `${path}.runs`).map((run, index) => parseRunFact(run, `${path}.runs[${index}]`)),
    comparableSamples: list(item.comparableSamples, `${path}.comparableSamples`).map((sample, index) => parseComparableSample(sample, `${path}.comparableSamples[${index}]`)),
    population: {
      requiredMinimum: 20,
      sampleCount,
      status,
      noClaimReasons: list(population.noClaimReasons, `${path}.population.noClaimReasons`).map((reason, index) => parseNoClaimReason(reason, `${path}.population.noClaimReasons[${index}]`)),
    },
  };
}

function parseTransferDecision(value: unknown, path: string): TransferDecision {
  const item = object(value, path, ['id', 'source', 'decision', 'evidence', 'originalFalsifier', 'studioDelta', 'focusedTransferProof']);
  const evidence = stringList(item.evidence, `${path}.evidence`);
  if (evidence.length === 0) fail(`${path}.evidence`, 'must not be empty');
  return {
    id: text(item.id, `${path}.id`),
    source: enumValue(item.source, `${path}.source`, ['engine', 'studio'] as const),
    decision: enumValue(item.decision, `${path}.decision`, ['reuse', 'adapt', 'reject', 'defer'] as const),
    evidence,
    originalFalsifier: text(item.originalFalsifier, `${path}.originalFalsifier`),
    studioDelta: text(item.studioDelta, `${path}.studioDelta`),
    focusedTransferProof: text(item.focusedTransferProof, `${path}.focusedTransferProof`),
  };
}

export const TransferDecisionSchema = {
  parse(value: unknown): TransferDecision {
    return parseTransferDecision(value, 'transferDecision');
  },
};

function parseProvenance(value: unknown, path: string): Provenance {
  const item = object(value, path, ['studioSha', 'studioOriginMainSha', 'studioRemoteMainSha', 'engineEvidenceSha', 'engineRemoteMainSha', 'collectedAt', 'worktreeDirty']);
  return {
    studioSha: sha(item.studioSha, `${path}.studioSha`),
    studioOriginMainSha: sha(item.studioOriginMainSha, `${path}.studioOriginMainSha`),
    studioRemoteMainSha: nullableSha(item.studioRemoteMainSha, `${path}.studioRemoteMainSha`),
    engineEvidenceSha: sha(item.engineEvidenceSha, `${path}.engineEvidenceSha`),
    engineRemoteMainSha: nullableSha(item.engineRemoteMainSha, `${path}.engineRemoteMainSha`),
    collectedAt: text(item.collectedAt, `${path}.collectedAt`),
    worktreeDirty: boolean(item.worktreeDirty, `${path}.worktreeDirty`),
  };
}

export interface SourceRef { path: string; sha256: string; kind: SourceRefKind; bytes: number }
export type SourceRefKind = 'workflow' | 'ruleset' | 'runs' | 'jobs' | 'artifacts' | 'submodules' | 'workspace' | 'transfer';
export interface Runner { kind: 'labels' | 'expression' | 'missing'; labels: string[]; expression: string | null }
export interface Job { key: string; name: string; needs: string[]; runner: Runner; timeoutMinutes: number | null; context: string; eventNames: string[]; trustBoundary: TrustBoundary; permissions: string[]; secrets: SecretAvailability }
export interface Workflow { path: string; name: string; events: string[]; trustBoundary: TrustBoundary; permissions: string[]; jobs: Job[] }
export type TrustBoundary = 'pull-request' | 'trusted-base' | 'post-merge-observer' | 'base-owned' | 'unknown';
export type SecretAvailability = 'unavailable' | 'available' | 'event-dependent' | 'unknown';
export interface NeedsEdge { workflowPath: string; fromJob: string; toJob: string }
export interface JobEdge { workflowPath: string; jobKey: string; context: string }
export interface RunnerEdge { workflowPath: string; jobKey: string; runnerKind: Runner['kind']; labels: string[]; expression: string | null }
export interface TimeoutEdge { workflowPath: string; jobKey: string; timeoutMinutes: number | null }
export interface ContextEdge { workflowPath: string; jobKey: string; context: string; required: boolean }
export interface EventEdge { workflowPath: string; jobKey: string; event: string }
export interface TrustEdge { workflowPath: string; jobKey: string; boundary: TrustBoundary; secrets: SecretAvailability; permissions: string[] }
export interface ControlPlane { workflows: Workflow[]; requiredContexts: string[]; edges: { jobs: JobEdge[]; needs: NeedsEdge[]; runners: RunnerEdge[]; timeouts: TimeoutEdge[]; contexts: ContextEdge[]; events: EventEdge[]; trust: TrustEdge[] } }
export interface RecursivePin { path: string; sha: string; marker: 'clean' | 'modified' | 'uninitialized' | 'conflicted'; materialized: boolean; ownerManifestStatus: 'available' | 'unavailable' | 'not-found' }
export interface WorkspaceOwner { workspacePattern: string; manifestPath: string | null; packageName: string | null; owner: string; status: 'resolved' | 'unavailable' }
export interface Census { recursivePins: { declaredCount: number; materializedCount: number; entries: RecursivePin[] }; workspaceOwners: { declarationCount: number; entries: WorkspaceOwner[]; ownerCounts: Record<string, number> } }
export interface StepFact { name: string; conclusion: string | null; completedAt: string | null }
export interface JobFact { id: number; name: string; status: string | null; conclusion: string | null; runnerName: string | null; runnerGroup: string | null; labels: string[]; createdAt: string | null; startedAt: string | null; completedAt: string | null; steps: StepFact[]; failureOwnership: 'repository' | 'transport' | 'external' | 'unknown' | null }
export interface ArtifactFact { id: number; name: string; sizeBytes: number; createdAt: string | null; expired: boolean; workflowRunId: number | null }
export interface FailureFact { status: 'claimed' | 'candidate-no-claim' | 'not-observed' | 'invalid'; occurredAt: string | null; secondsFromAdmission: number | null; jobName: string | null; stepName: string | null; ownership: 'repository' | 'transport' | 'external' | 'unknown'; noClaimReason: string | null }
export interface Timing { admissionSeconds: number | null; queueProxySeconds: number | null; activeDurationSeconds: number | null; artifactReadySeconds: number | null; firstDecisiveFailure: FailureFact }
export interface RunFact { runId: number; runAttempt: number | null; event: string | null; status: string | null; conclusion: string | null; headSha: string | null; headBranch: string | null; createdAt: string | null; startedAt: string | null; updatedAt: string | null; rosterKey: string | null; runnerClassKey: string | null; outcomeKey: string | null; jobsTerminal: boolean; jobs: JobFact[]; artifacts: ArtifactFact[]; timing: Timing; eligibility: { comparable: boolean; reasons: string[] } }
export interface ComparableSample { runId: number; event: string; runAttempt: number; rosterKey: string; runnerClassKey: string; admissionSeconds: number | null; queueProxySeconds: number | null; activeDurationSeconds: number | null; artifactReadySeconds: number | null; firstDecisiveFailure: FailureFact; noClaimReasons: string[] }
export interface NoClaimReason { code: string; count: number; runIds: number[]; detail: string }
export interface History { workflow: '.github/workflows/ci.yml'; rawRunCount: number; rawJobRunCount: number; rawArtifactRunCount: number; canonicalTopology: { rosterKey: string | null; runnerClassKey: string | null; event: string | null; runAttempt: number | null }; runs: RunFact[]; comparableSamples: ComparableSample[]; population: { requiredMinimum: 20; sampleCount: number; status: 'pass' | 'no-claim'; noClaimReasons: NoClaimReason[] } }
export interface TransferDecision { id: string; source: 'engine' | 'studio'; decision: 'reuse' | 'adapt' | 'reject' | 'defer'; evidence: string[]; originalFalsifier: string; studioDelta: string; focusedTransferProof: string }
export interface Provenance { studioSha: string; studioOriginMainSha: string; studioRemoteMainSha: string | null; engineEvidenceSha: string; engineRemoteMainSha: string | null; collectedAt: string; worktreeDirty: boolean }
export interface FastRobustCiEvidence { schemaVersion: 1; collector: 'forgeax-studio-fast-robust-ci'; provenance: Provenance; controlPlane: ControlPlane; census: Census; history: History; transferDecisions: TransferDecision[]; rawInputs: { directory: string | null; files: SourceRef[] } }

export function parseFastRobustCiEvidence(value: unknown): FastRobustCiEvidence {
  const item = object(value, 'evidence', ['schemaVersion', 'collector', 'provenance', 'controlPlane', 'census', 'history', 'transferDecisions', 'rawInputs']);
  if (item.schemaVersion !== FAST_ROBUST_CI_EVIDENCE_VERSION) fail('evidence.schemaVersion', 'must be version 1');
  if (item.collector !== 'forgeax-studio-fast-robust-ci') fail('evidence.collector', 'has the wrong collector name');
  const rawInputs = object(item.rawInputs, 'evidence.rawInputs', ['directory', 'files']);
  const transferDecisions = list(item.transferDecisions, 'evidence.transferDecisions').map((decision, index) => parseTransferDecision(decision, `evidence.transferDecisions[${index}]`));
  if (transferDecisions.length < 18) fail('evidence.transferDecisions', 'requires at least 18 methods');
  return {
    schemaVersion: 1,
    collector: 'forgeax-studio-fast-robust-ci',
    provenance: parseProvenance(item.provenance, 'evidence.provenance'),
    controlPlane: parseControlPlane(item.controlPlane, 'evidence.controlPlane'),
    census: parseCensus(item.census, 'evidence.census'),
    history: parseHistory(item.history, 'evidence.history'),
    transferDecisions,
    rawInputs: {
      directory: nullableText(rawInputs.directory, 'evidence.rawInputs.directory'),
      files: list(rawInputs.files, 'evidence.rawInputs.files').map((file, index) => parseSourceRef(file, `evidence.rawInputs.files[${index}]`)),
    },
  };
}
