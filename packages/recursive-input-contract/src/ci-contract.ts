import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_CLASSES, TRUST_SCOPES, type InputClass, type TrustScope } from './schema.ts';

export const CI_MANIFEST_VERSION = 'recursive-input-ci.v1' as const;
export const CI_OUTPUT_CONTRACT_VERSION = 'recursive-input-ci-result.v1' as const;
export const CI_SCHEMA_ID = 'urn:forgeax:recursive-input-ci-contract:v1' as const;
export const CI_STATUS_VALUES = ['ready', 'non-ready', 'unverified'] as const;
export const CI_EXTERNAL_STATUS_VALUES = ['aligned', 'misaligned', 'unverified', 'not-checked'] as const;
export const CI_EXIT_CODES = { ready: 0, usage: 2, nonReady: 3, unsupported: 4, internal: 1 } as const;
export const CI_ERROR_CODES = [
  'recursive-input.ci.manifest-invalid',
  'recursive-input.ci.schema-invalid',
  'recursive-input.ci.duplicate-producer',
  'recursive-input.ci.conflicting-owner',
  'recursive-input.ci.unknown-producer',
  'recursive-input.ci.unsupported-output-version',
  'recursive-input.producer-mismatch',
  'recursive-input.output-contract-version-mismatch',
  'recursive-input.repository-mismatch',
  'recursive-input.revision-mismatch',
  'recursive-input.run-mismatch',
  'recursive-input.attempt-mismatch',
  'recursive-input.job-mismatch',
  'recursive-input.trust-scope-mismatch',
  'recursive-input.input-provenance-mismatch',
  'recursive-input.schema-invalid',
  'recursive-input.ci.consumer-work-suppressed',
  'recursive-input.ci.live-ruleset-misaligned',
  'recursive-input.ci.live-ruleset-unverified',
] as const;

export const CI_REQUIRED_CONTEXTS = [
  'typecheck + build + script smoke',
  'SFC-07 stable aggregate',
  'Runtime validation aggregate',
  'dependency-cruiser boundary lint',
  'mirror dry-run (assemble + scrub + gate)',
  'submodule pin reachability + main-ancestry',
  'mirror publish dry-run (external push)',
  'every commit has a human author',
] as const;
export type CiRequiredContext = (typeof CI_REQUIRED_CONTEXTS)[number];
export type CiTrustScope = Extract<TrustScope, 'ordinary-ci' | 'trusted-base-ci'>;

export type CiProducerDeclaration = {
  producerId: string;
  owner: string;
  inputClasses: InputClass[];
  trustScopes: CiTrustScope[];
  outputContractVersion: typeof CI_OUTPUT_CONTRACT_VERSION;
};

export type CiConsumerDeclaration = {
  consumerId: string;
  producerId: string;
  trustScope: CiTrustScope;
  workflow: string;
  job: string;
  validationBoundary: 'before first source-owned command';
  sourceWork: string;
};

export type CiContextDeclaration = {
  name: CiRequiredContext;
  source: string;
  job: string;
  reporter: 'thin-reporter' | 'direct';
};

export type CiGovernanceExpectation = {
  repository: string;
  ref: 'main';
  enforcement: 'active';
  bypassActors: string[];
  currentUserCanBypass: 'never';
};

export type CiManifest = {
  specVersion: 1;
  manifestVersion: typeof CI_MANIFEST_VERSION;
  outputContractVersion: typeof CI_OUTPUT_CONTRACT_VERSION;
  scope: 'recursive-input-direct-consumers';
  producers: CiProducerDeclaration[];
  consumers: CiConsumerDeclaration[];
  requiredContexts: CiContextDeclaration[];
  governance: CiGovernanceExpectation;
};

export type CiContractError = {
  code: string;
  path: string;
  message: string;
};

export type CiManifestValidation = {
  ok: boolean;
  errors: CiContractError[];
};

export function validateCiSchemaDocument(value: unknown): CiManifestValidation {
  const errors: CiContractError[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, ['$schema', '$id', 'title', 'type', 'additionalProperties', 'required', 'properties'])) {
    return { ok: false, errors: [error('recursive-input.ci.schema-invalid', '$', 'CI schema must be a closed Draft 2020-12 object')] };
  }
  if (value.$schema !== 'https://json-schema.org/draft/2020-12/schema') errors.push(error('recursive-input.ci.schema-invalid', '$.$schema', 'must use Draft 2020-12'));
  if (value.$id !== CI_SCHEMA_ID) errors.push(error('recursive-input.ci.schema-invalid', '$.$id', `must be ${CI_SCHEMA_ID}`));
  if (value.type !== 'object' || value.additionalProperties !== false) errors.push(error('recursive-input.ci.schema-invalid', '$', 'root schema must be a closed object'));
  const required = Array.isArray(value.required) ? value.required : [];
  for (const key of REQUIRED_MANIFEST_KEYS) if (!required.includes(key)) errors.push(error('recursive-input.ci.schema-invalid', '$.required', `missing ${key}`));
  if (!isRecord(value.properties)) {
    errors.push(error('recursive-input.ci.schema-invalid', '$.properties', 'must declare root properties'));
  } else {
    for (const key of REQUIRED_MANIFEST_KEYS) if (!(key in value.properties)) errors.push(error('recursive-input.ci.schema-invalid', `$.properties.${key}`, 'required field has no schema declaration'));
  }
  validateClosedSchemaNodes(value, '$', errors);
  return { ok: errors.length === 0, errors };
}

export type CiContractFiles = {
  manifestPath: string;
  schemaPath: string;
  manifest: CiManifest;
  schema: Record<string, unknown>;
  manifestDigest: string;
  schemaDigest: string;
};

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_MANIFEST_KEYS = ['specVersion', 'manifestVersion', 'outputContractVersion', 'scope', 'producers', 'consumers', 'requiredContexts', 'governance'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validateClosedSchemaNodes(value: unknown, path: string, errors: CiContractError[]): void {
  if (!isRecord(value)) return;
  if (value.type === 'object') {
    if (value.additionalProperties !== false) errors.push(error('recursive-input.ci.schema-invalid', path, 'every object schema must be closed'));
    if (!isRecord(value.properties)) errors.push(error('recursive-input.ci.schema-invalid', `${path}.properties`, 'object schema must declare properties'));
    else for (const [key, child] of Object.entries(value.properties)) validateClosedSchemaNodes(child, `${path}.properties.${key}`, errors);
  }
  if (Array.isArray(value.items)) {
    for (const [index, child] of value.items.entries()) validateClosedSchemaNodes(child, `${path}.items[${index}]`, errors);
  } else if (value.items) {
    validateClosedSchemaNodes(value.items, `${path}.items`, errors);
  }
}

function error(code: string, path: string, message: string): CiContractError {
  return { code, path, message };
}

function stringArray(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((item) => typeof item === 'string' && allowed.includes(item));
}

function validateProducer(value: unknown, index: number): CiContractError[] {
  const path = `producers[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ['producerId', 'owner', 'inputClasses', 'trustScopes', 'outputContractVersion'])) {
    return [error('recursive-input.ci.manifest-invalid', path, 'producer declaration is not closed or is missing')];
  }
  const errors: CiContractError[] = [];
  for (const key of ['producerId', 'owner', 'outputContractVersion']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) errors.push(error('recursive-input.ci.producer-invalid', `${path}.${key}`, 'must be a non-empty string'));
  }
  if (!stringArray(value.inputClasses, INPUT_CLASSES)) errors.push(error('recursive-input.ci.producer-invalid', `${path}.inputClasses`, 'must contain supported unique input classes'));
  if (!stringArray(value.trustScopes, ['ordinary-ci', 'trusted-base-ci'])) errors.push(error('recursive-input.ci.producer-invalid', `${path}.trustScopes`, 'must contain supported unique trust scopes'));
  if (value.outputContractVersion !== CI_OUTPUT_CONTRACT_VERSION) errors.push(error('recursive-input.ci.unsupported-output-version', `${path}.outputContractVersion`, `must be ${CI_OUTPUT_CONTRACT_VERSION}`));
  return errors;
}

export function validateCiManifest(value: unknown): CiManifestValidation {
  const errors: CiContractError[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, REQUIRED_MANIFEST_KEYS)) {
    return { ok: false, errors: [error('recursive-input.ci.manifest-invalid', '$', 'manifest is not a closed object')] };
  }
  if (value.specVersion !== 1) errors.push(error('recursive-input.ci.manifest-invalid', '$.specVersion', 'must be 1'));
  if (value.manifestVersion !== CI_MANIFEST_VERSION) errors.push(error('recursive-input.ci.manifest-invalid', '$.manifestVersion', `must be ${CI_MANIFEST_VERSION}`));
  if (value.outputContractVersion !== CI_OUTPUT_CONTRACT_VERSION) errors.push(error('recursive-input.ci.unsupported-output-version', '$.outputContractVersion', `must be ${CI_OUTPUT_CONTRACT_VERSION}`));
  if (value.scope !== 'recursive-input-direct-consumers') errors.push(error('recursive-input.ci.scope-invalid', '$.scope', 'must remain recursive-input-direct-consumers'));

  if (!Array.isArray(value.producers) || value.producers.length === 0) {
    errors.push(error('recursive-input.ci.manifest-invalid', '$.producers', 'must be non-empty'));
  } else {
    value.producers.forEach((producer, index) => errors.push(...validateProducer(producer, index)));
    const ids = value.producers.filter(isRecord).map((producer) => producer.producerId).filter((id): id is string => typeof id === 'string');
    for (const id of new Set(ids.filter((candidate, index) => ids.indexOf(candidate) !== index))) errors.push(error('recursive-input.ci.duplicate-producer', '$.producers', `duplicate producerId ${id}`));
    const owners = new Map<string, string>();
    for (const producer of value.producers) {
      if (!isRecord(producer) || typeof producer.producerId !== 'string' || typeof producer.owner !== 'string') continue;
      const previous = owners.get(producer.producerId);
      if (previous && previous !== producer.owner) errors.push(error('recursive-input.ci.conflicting-owner', '$.producers', `producerId ${producer.producerId} has conflicting owners`));
      owners.set(producer.producerId, producer.owner);
    }
  }

  if (!Array.isArray(value.consumers) || value.consumers.length === 0) {
    errors.push(error('recursive-input.ci.manifest-invalid', '$.consumers', 'must be non-empty'));
  } else {
    const consumerIds: string[] = [];
    value.consumers.forEach((consumer, index) => {
      const path = `consumers[${index}]`;
      if (!isRecord(consumer) || !hasOnlyKeys(consumer, ['consumerId', 'producerId', 'trustScope', 'workflow', 'job', 'validationBoundary', 'sourceWork'])) {
        errors.push(error('recursive-input.ci.consumer-invalid', path, 'consumer declaration is not closed or is missing'));
        return;
      }
      for (const key of ['consumerId', 'producerId', 'workflow', 'job', 'sourceWork']) {
        if (typeof consumer[key] !== 'string' || consumer[key].length === 0) errors.push(error('recursive-input.ci.consumer-invalid', `${path}.${key}`, 'must be a non-empty string'));
      }
      if (consumer.validationBoundary !== 'before first source-owned command') errors.push(error('recursive-input.ci.consumer-invalid', `${path}.validationBoundary`, 'must validate before source-owned work'));
      if (consumer.trustScope !== 'ordinary-ci' && consumer.trustScope !== 'trusted-base-ci') errors.push(error('recursive-input.ci.consumer-invalid', `${path}.trustScope`, 'must be an allowed CI trust scope'));
      if (typeof consumer.consumerId === 'string') consumerIds.push(consumer.consumerId);
      const producer = typeof consumer.producerId === 'string'
        ? (value.producers as unknown[]).find((candidate) => isRecord(candidate) && candidate.producerId === consumer.producerId)
        : undefined;
      if (!producer || !isRecord(producer)) {
        if (typeof consumer.producerId === 'string') errors.push(error('recursive-input.ci.unknown-producer', `${path}.producerId`, `unknown producer ${consumer.producerId}`));
      } else {
        if (!Array.isArray(producer.trustScopes) || !producer.trustScopes.includes(consumer.trustScope)) errors.push(error('recursive-input.ci.consumer-trust-mismatch', `${path}.trustScope`, 'consumer trust scope must be declared by its producer'));
        if (producer.outputContractVersion !== value.outputContractVersion) errors.push(error('recursive-input.ci.consumer-version-mismatch', `${path}.producerId`, 'consumer must use the manifest output contract version'));
      }
    });
    for (const id of new Set(consumerIds.filter((candidate, index) => consumerIds.indexOf(candidate) !== index))) errors.push(error('recursive-input.ci.duplicate-consumer', '$.consumers', `duplicate consumerId ${id}`));
  }

  if (!Array.isArray(value.requiredContexts) || value.requiredContexts.length !== CI_REQUIRED_CONTEXTS.length) {
    errors.push(error('recursive-input.ci.context-set-invalid', '$.requiredContexts', 'must contain exactly the canonical required contexts'));
  } else {
    const contexts = value.requiredContexts as unknown[];
    const names = contexts.map((context) => isRecord(context) ? context.name : undefined);
    if (new Set(names).size !== names.length) errors.push(error('recursive-input.ci.duplicate-context', '$.requiredContexts', 'context names must be unique'));
    const sourceJobs = contexts.map((context) => isRecord(context) ? `${context.source}#${context.job}` : undefined);
    if (new Set(sourceJobs).size !== sourceJobs.length) errors.push(error('recursive-input.ci.duplicate-context-source', '$.requiredContexts', 'each context must have one unique source/job owner'));
    CI_REQUIRED_CONTEXTS.forEach((name, index) => {
      const context = contexts[index];
      if (!isRecord(context) || !hasOnlyKeys(context, ['name', 'source', 'job', 'reporter'])) {
        errors.push(error('recursive-input.ci.context-invalid', `requiredContexts[${index}]`, 'context declaration must be closed'));
        return;
      }
      if (context.name !== name) errors.push(error('recursive-input.ci.context-set-invalid', `requiredContexts[${index}].name`, `must be ${name}`));
      for (const key of ['source', 'job']) if (typeof context[key] !== 'string' || context[key].length === 0) errors.push(error('recursive-input.ci.context-invalid', `requiredContexts[${index}].${key}`, 'must be a non-empty string'));
      if (context.reporter !== 'thin-reporter' && context.reporter !== 'direct') errors.push(error('recursive-input.ci.context-invalid', `requiredContexts[${index}].reporter`, 'must be thin-reporter or direct'));
    });
  }

  if (!isRecord(value.governance) || !hasOnlyKeys(value.governance, ['repository', 'ref', 'enforcement', 'bypassActors', 'currentUserCanBypass'])) {
    errors.push(error('recursive-input.ci.governance-invalid', '$.governance', 'governance expectation is not closed'));
  } else {
    if (typeof value.governance.repository !== 'string' || value.governance.repository.length === 0) errors.push(error('recursive-input.ci.governance-invalid', '$.governance.repository', 'must be non-empty'));
    if (value.governance.ref !== 'main' || value.governance.enforcement !== 'active' || value.governance.currentUserCanBypass !== 'never') errors.push(error('recursive-input.ci.governance-invalid', '$.governance', 'must be active main enforcement with no bypass capability'));
    if (!Array.isArray(value.governance.bypassActors) || value.governance.bypassActors.length !== 0) errors.push(error('recursive-input.ci.governance-invalid', '$.governance.bypassActors', 'must be empty'));
  }
  return { ok: errors.length === 0, errors };
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function contractPaths(root?: string): { manifestPath: string; schemaPath: string } {
  const base = root
    ? (root.endsWith('/packages/recursive-input-contract') ? root : join(root, 'packages/recursive-input-contract'))
    : PACKAGE_ROOT;
  return {
    manifestPath: join(base, 'ci/producer-manifest.v1.json'),
    schemaPath: join(base, 'schema/recursive-input-ci-contract.v1.schema.json'),
  };
}

export function loadCiContractFiles(root?: string): CiContractFiles {
  const paths = contractPaths(root);
  const manifestBytes = readFileSync(paths.manifestPath, 'utf8');
  const schemaBytes = readFileSync(paths.schemaPath, 'utf8');
  const manifest = JSON.parse(manifestBytes) as unknown;
  const schema = JSON.parse(schemaBytes) as unknown;
  const schemaValidation = validateCiSchemaDocument(schema);
  if (!schemaValidation.ok) throw new Error(schemaValidation.errors.map((item) => `${item.code} ${item.path}: ${item.message}`).join('; '));
  const validation = validateCiManifest(manifest);
  if (!validation.ok) throw new Error(validation.errors.map((item) => `${item.code} ${item.path}: ${item.message}`).join('; '));
  return {
    ...paths,
    manifest: manifest as CiManifest,
    schema: schema as Record<string, unknown>,
    manifestDigest: sha256(manifestBytes),
    schemaDigest: sha256(schemaBytes),
  };
}

export function ciSchemaDiscovery(root?: string): Record<string, unknown> {
  const files = loadCiContractFiles(root);
  return {
    operation: 'schema',
    scope: 'ci',
    manifestPath: files.manifestPath,
    schemaPath: files.schemaPath,
    manifestDigest: files.manifestDigest,
    schemaDigest: files.schemaDigest,
    manifestVersion: files.manifest.manifestVersion,
    outputContractVersion: files.manifest.outputContractVersion,
    producers: files.manifest.producers,
    consumers: files.manifest.consumers,
    requiredContexts: files.manifest.requiredContexts,
    governance: files.manifest.governance,
    statuses: CI_STATUS_VALUES,
    externalStatuses: CI_EXTERNAL_STATUS_VALUES,
    exitCodes: CI_EXIT_CODES,
    errorCodes: CI_ERROR_CODES,
    trustScopes: TRUST_SCOPES.filter((scope): scope is CiTrustScope => scope !== 'local-fixed-worktree'),
    inputClasses: INPUT_CLASSES,
  };
}

export function producerForConsumer(manifest: CiManifest, consumerId: string): { producer: CiProducerDeclaration; consumer: CiConsumerDeclaration } | undefined {
  const consumer = manifest.consumers.find((candidate) => candidate.consumerId === consumerId);
  if (!consumer) return undefined;
  const producer = manifest.producers.find((candidate) => candidate.producerId === consumer.producerId);
  return producer ? { producer, consumer } : undefined;
}

export function ciFailureRecovery(code: string): { actionId: string; argv?: string[]; manualHandoff?: string }[] {
  if (code.includes('live') || code.includes('ruleset')) return [{ actionId: 'obtain-live-read-permission', argv: ['gh', 'api', 'repos/ForgeaX-Games/forgeax-studio/rulesets?includes_parents=true'] }, { actionId: 'manual-live-evidence-handoff', manualHandoff: 'A human with read permission must rerun the fresh ruleset probe.' }];
  if (code.includes('trust')) return [{ actionId: 'select-declared-trust-scope', argv: ['bun', 'fx', 'recursive-inputs', 'verify', '--scope', 'ci', '--trust-scope=<declared-scope>'] }, { actionId: 'materialize-current-execution-cold', argv: ['bun', 'fx', 'recursive-inputs', 'materialize', '--trust=<declared-scope>'] }];
  if (code.includes('interrupted') || code.includes('cancelled') || code.includes('materialization') || code.includes('cleanup') || code.includes('partial')) return [{ actionId: 'discard-partial-state', manualHandoff: 'Isolate the current result and temporary credential state; do not reuse it for the retry.' }, { actionId: 'materialize-current-execution-cold', argv: ['bun', 'fx', 'recursive-inputs', 'materialize', '--trust=<declared-scope>'] }];
  return [{ actionId: 'validate-canonical-contract', argv: ['bun', 'fx', 'recursive-inputs', 'schema', '--scope', 'ci'] }, { actionId: 'rerun-producer-workflow-cold', manualHandoff: 'Rerun the declared producer workflow for the current run after the canonical contract validates.' }];
}
