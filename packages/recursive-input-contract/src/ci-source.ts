import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadCiContractFiles, type CiConsumerDeclaration, type CiManifest } from './ci-contract.ts';
import { runCiConsumer, type CiExecutionContext, type CiConsumerExecution } from './validator.ts';

export type CiSourceCall = {
  workflow: string;
  consumerId: string;
  trustScope: 'ordinary-ci' | 'trusted-base-ci';
  actionIndex: number;
  firstSourceWorkIndex: number;
  validationIndex: number;
};

export type CiSourceInspection = {
  calls: CiSourceCall[];
  outsideContract: string[];
  errors: string[];
  sourceDigests: Record<string, string>;
};

function jobBlock(source: string, job: string): string {
  const start = source.search(new RegExp(`^  ${job}:\\n`, 'm'));
  if (start < 0) return '';
  const next = source.slice(start + 1).search(/^  [a-zA-Z0-9_-]+:\n/m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

function firstIndex(source: string, needles: string[]): number {
  const executableSource = source.replace(/^[ \t]*#.*$/gm, (line) => ' '.repeat(line.length));
  const indexes = needles.map((needle) => executableSource.indexOf(needle)).filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function canonicalWorkflowPath(workflow: string): string {
  return workflow.startsWith('scripts/mirror/ci/')
    ? `.github/workflows/${workflow.slice('scripts/mirror/ci/'.length)}`
    : workflow;
}

type ParsedStep = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type ParsedWorkflow = {
  jobs?: Record<string, { steps?: ParsedStep[] }>;
};

function parseWorkflow(source: string, workflow: string): ParsedWorkflow | undefined {
  try {
    const parsed = Bun.YAML.parse(source) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('workflow root must be an object');
    }
    return parsed as ParsedWorkflow;
  } catch (error) {
    return undefined;
  }
}

function consumerForSource(manifest: CiManifest, workflow: string, source: string): CiConsumerDeclaration[] {
  const canonical = canonicalWorkflowPath(workflow);
  return manifest.consumers.filter((consumer) => consumer.workflow === canonical && jobBlock(source, consumer.job));
}

export function inspectCiSources(
  sources: Record<string, string>,
  manifest: CiManifest = loadCiContractFiles().manifest,
  producerSource = '',
): CiSourceInspection {
  const calls: CiSourceCall[] = [];
  const errors: string[] = [];
  const governedPaths = new Set([
    ...manifest.consumers.map((consumer) => consumer.workflow),
    ...manifest.consumers.map((consumer) => consumer.workflow.replace('.github/workflows/', 'scripts/mirror/ci/')),
  ]);
  for (const [workflow, source] of Object.entries(sources)) {
    const parsed = parseWorkflow(source, workflow);
    if (!parsed) {
      errors.push(`recursive-input.ci.workflow-schema-invalid: ${workflow}`);
      continue;
    }
    const consumers = consumerForSource(manifest, workflow, source);
    const canonical = canonicalWorkflowPath(workflow);
    const jobs = parsed.jobs ?? {};
    const actualContractCalls: Array<{ job: string; consumerId: string; trustScope: string; index: number; step: ParsedStep }> = [];
    for (const [job, definition] of Object.entries(jobs)) {
      for (const [index, step] of (definition.steps ?? []).entries()) {
        const values = step.with ?? {};
        const contractMode = typeof values['contract-mode'] === 'string' ? values['contract-mode'] : undefined;
        if (!contractMode || !['ordinary-ci', 'trusted-base'].includes(contractMode)) continue;
        actualContractCalls.push({
          job,
          consumerId: typeof values['consumer-id'] === 'string' ? values['consumer-id'] : '',
          trustScope: typeof values['trust-scope'] === 'string' ? values['trust-scope'] : '',
          index,
          step,
        });
      }
    }
    const declaredForWorkflow = manifest.consumers.filter((consumer) => consumer.workflow === canonical);
    const declaredIds = new Set(declaredForWorkflow.map((consumer) => consumer.consumerId));
    for (const actual of actualContractCalls) {
      if (!declaredIds.has(actual.consumerId)) errors.push(`recursive-input.ci.undeclared-source-call: ${workflow}#${actual.job}:${actual.consumerId || 'missing-consumer-id'}`);
      if (actual.consumerId && actualContractCalls.filter((candidate) => candidate.consumerId === actual.consumerId).length > 1) {
        errors.push(`recursive-input.ci.duplicate-source-call: ${actual.consumerId}`);
      }
    }
    for (const declaration of declaredForWorkflow) {
      if (!actualContractCalls.some((actual) => actual.consumerId === declaration.consumerId && actual.job === declaration.job)) {
        errors.push(`recursive-input.ci.missing-source-call: ${declaration.consumerId}`);
      }
    }
    if (consumers.length === 0) {
      continue;
    }
    for (const consumer of consumers) {
      const block = jobBlock(source, consumer.job);
      const actual = actualContractCalls.find((candidate) => candidate.consumerId === consumer.consumerId && candidate.job === consumer.job);
      const actionNeedle = consumer.trustScope === 'trusted-base-ci'
        ? './.trusted-base/.github/actions/fetch-submodules'
        : './.github/actions/fetch-submodules';
      const actionIndex = actual && actual.step.uses === actionNeedle ? actual.index : -1;
      const sourceWorkIndex = (jobs[consumer.job]?.steps ?? []).findIndex((step) => typeof step.run === 'string' && step.run.includes(consumer.sourceWork));
      const actionOwnsValidation = producerSource.includes('validateCiResult')
        && producerSource.includes('sourceWork')
        && producerSource.includes('CONTRACT_CONSUMER_ID');
      const validationIndex = actionOwnsValidation && actual ? actionIndex : -1;
      if (actionIndex < 0) errors.push(`recursive-input.ci.missing-producer-call: ${consumer.consumerId}`);
      if (!actual || actual.consumerId !== consumer.consumerId) errors.push(`recursive-input.ci.missing-consumer-identity: ${consumer.consumerId}`);
      if (actual && actual.trustScope !== consumer.trustScope) errors.push(`recursive-input.ci.trust-scope-drift: ${consumer.consumerId}`);
      if (sourceWorkIndex < 0) errors.push(`recursive-input.ci.missing-source-work: ${consumer.consumerId}`);
      if (validationIndex < 0 || (sourceWorkIndex >= 0 && validationIndex > sourceWorkIndex)) errors.push(`recursive-input.ci.validator-not-before-work: ${consumer.consumerId}`);
      calls.push({
        workflow,
        consumerId: consumer.consumerId,
        trustScope: consumer.trustScope,
        actionIndex,
        firstSourceWorkIndex: sourceWorkIndex,
        validationIndex,
      });
    }
  }
  const outsideContract = Object.keys(sources).filter((path) => !governedPaths.has(path));
  const sourceDigests = Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, createHash('sha256').update(content, 'utf8').digest('hex')]));
  return { calls, outsideContract, errors, sourceDigests };
}

export function inspectCiSourceFiles(root: string, manifest?: CiManifest): CiSourceInspection {
  const loaded = manifest ?? loadCiContractFiles(root).manifest;
  const paths: string[] = [];
  for (const directory of ['.github/workflows', 'scripts/mirror/ci']) {
    const absolute = join(root, directory);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/.test(entry.name)) paths.push(join(directory, entry.name));
    }
  }
  const sources = Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const producerSource = readFileSync(join(root, '.github/actions/fetch-submodules/action.yml'), 'utf8');
  const inspection = inspectCiSources(sources, loaded, producerSource);
  inspection.sourceDigests['.github/actions/fetch-submodules/action.yml'] = createHash('sha256').update(producerSource, 'utf8').digest('hex');
  for (const context of loaded.requiredContexts) {
    const source = sources[context.source];
    if (!source) {
      inspection.errors.push(`recursive-input.ci.missing-context-source: ${context.name}`);
      continue;
    }
    if (!source.includes(`name: ${context.name}`)) inspection.errors.push(`recursive-input.ci.context-name-drift: ${context.name}`);
    if (!jobBlock(source, context.job).includes(`name: ${context.name}`)) inspection.errors.push(`recursive-input.ci.context-job-drift: ${context.name}`);
  }
  return inspection;
}

export function executeValidatedCiConsumer<T>(candidate: unknown, context: CiExecutionContext, work: () => T, manifest?: CiManifest): CiConsumerExecution<T> {
  return runCiConsumer(candidate, context, work, manifest);
}
