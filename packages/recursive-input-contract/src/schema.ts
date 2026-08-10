export const SCHEMA_ID = 'urn:forgeax:recursive-input-result:v1' as const;
export const SCHEMA_VERSION = 1 as const;
export const DIGEST_ALGORITHM = 'sha256' as const;

export const INPUT_CLASSES = [
  'source',
  'dependency-installation',
  'toolchain',
  'large-file-storage',
  'build-output',
] as const;
export type InputClass = (typeof INPUT_CLASSES)[number];

export const TRUST_SCOPES = [
  'local-fixed-worktree',
  'ordinary-ci',
  'trusted-base-ci',
] as const;
export type TrustScope = (typeof TRUST_SCOPES)[number];

export const READINESS_STATUSES = [
  'ready',
  'not-requested',
  'unknown',
  'stale',
  'partial',
  'mismatched',
  'unavailable',
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export type RecursivePin = {
  path: string;
  pin: string;
};

export type SourceIdentity = {
  repository: string;
  revision: string;
};

export type RecursiveInputContent = {
  sourceIdentity: SourceIdentity;
  recursivePins: RecursivePin[];
  requestedInputClasses: InputClass[];
  inputDigest: string;
  digestAlgorithm: typeof DIGEST_ALGORITHM;
};

export type CheckoutIdentity = SourceIdentity;

export type CredentialCleanup = {
  status: 'passed' | 'failed' | 'unknown';
};

export type RecursiveInputProvenance = {
  producer: string;
  job: string;
  attempt: string;
  trustScope: TrustScope;
  checkoutIdentity: CheckoutIdentity;
  credentialCleanup: CredentialCleanup;
};

export type InputReadiness = {
  status: ReadinessStatus;
};

export type ReadinessByClass = Record<InputClass, InputReadiness>;

export type RecursiveInputFailure = {
  code: string;
  hint: string;
  expected: string;
  actual: string;
  retryable: boolean;
  recoveryActions: string[];
};

type RecursiveInputResultBase = {
  schemaVersion: typeof SCHEMA_VERSION;
  content: RecursiveInputContent;
  provenance: RecursiveInputProvenance;
  readiness: ReadinessByClass;
};

export type RecursiveInputReady = RecursiveInputResultBase & {
  status: 'ready';
  failure?: never;
};

export type RecursiveInputNonReady = RecursiveInputResultBase & {
  status: 'non-ready';
  failure: RecursiveInputFailure;
};

export type RecursiveInputResult = RecursiveInputReady | RecursiveInputNonReady;

export type RecursiveInputJsonSchema = {
  $id: typeof SCHEMA_ID;
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  title: 'RecursiveInputResult';
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
};

const stringSchema = { type: 'string' } as const;
const classEnum = { type: 'string', enum: [...INPUT_CLASSES] } as const;
const trustScopeEnum = { type: 'string', enum: [...TRUST_SCOPES] } as const;
const readinessStatusEnum = { type: 'string', enum: [...READINESS_STATUSES] } as const;

export function deriveRecursiveInputJsonSchema(): RecursiveInputJsonSchema {
  return {
    $id: SCHEMA_ID,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'RecursiveInputResult',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'status', 'content', 'provenance', 'readiness'],
    properties: {
      schemaVersion: { type: 'integer', const: SCHEMA_VERSION },
      status: { type: 'string', enum: ['ready', 'non-ready'] },
      content: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceIdentity',
          'recursivePins',
          'requestedInputClasses',
          'inputDigest',
          'digestAlgorithm',
        ],
        properties: {
          sourceIdentity: {
            type: 'object',
            additionalProperties: false,
            required: ['repository', 'revision'],
            properties: { repository: stringSchema, revision: stringSchema },
          },
          recursivePins: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'pin'],
              properties: { path: stringSchema, pin: stringSchema },
            },
          },
          requestedInputClasses: { type: 'array', items: classEnum, uniqueItems: true },
          inputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          digestAlgorithm: { type: 'string', const: DIGEST_ALGORITHM },
        },
      },
      provenance: {
        type: 'object',
        additionalProperties: false,
        required: [
          'producer',
          'job',
          'attempt',
          'trustScope',
          'checkoutIdentity',
          'credentialCleanup',
        ],
        properties: {
          producer: stringSchema,
          job: stringSchema,
          attempt: stringSchema,
          trustScope: trustScopeEnum,
          checkoutIdentity: {
            type: 'object',
            additionalProperties: false,
            required: ['repository', 'revision'],
            properties: { repository: stringSchema, revision: stringSchema },
          },
          credentialCleanup: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', enum: ['passed', 'failed', 'unknown'] } },
          },
        },
      },
      readiness: {
        type: 'object',
        additionalProperties: false,
        required: [...INPUT_CLASSES],
        properties: Object.fromEntries(
          INPUT_CLASSES.map((inputClass) => [inputClass, {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: readinessStatusEnum },
          }]),
        ),
      },
      failure: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'hint', 'expected', 'actual', 'retryable', 'recoveryActions'],
        properties: {
          code: stringSchema,
          hint: stringSchema,
          expected: stringSchema,
          actual: stringSchema,
          retryable: { type: 'boolean' },
          recoveryActions: { type: 'array', items: stringSchema, minItems: 1 },
        },
      },
    },
  };
}

export const recursiveInputResultSchema = deriveRecursiveInputJsonSchema();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSourceIdentity(value: unknown): value is SourceIdentity {
  return isRecord(value)
    && hasOnlyKeys(value, ['repository', 'revision'])
    && typeof value.repository === 'string'
    && value.repository.length > 0
    && typeof value.revision === 'string'
    && value.revision.length > 0;
}

function isContent(value: unknown): value is RecursiveInputContent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sourceIdentity',
    'recursivePins',
    'requestedInputClasses',
    'inputDigest',
    'digestAlgorithm',
  ])) return false;
  if (!isSourceIdentity(value.sourceIdentity)) return false;
  if (!Array.isArray(value.recursivePins) || value.recursivePins.some((pin) => (
    !isRecord(pin)
    || !hasOnlyKeys(pin, ['path', 'pin'])
    || typeof pin.path !== 'string'
    || pin.path.length === 0
    || typeof pin.pin !== 'string'
    || pin.pin.length === 0
  ))) return false;
  if (!Array.isArray(value.requestedInputClasses) || value.requestedInputClasses.length === 0) return false;
  if (new Set(value.requestedInputClasses).size !== value.requestedInputClasses.length) return false;
  if (value.requestedInputClasses.some((inputClass) => !INPUT_CLASSES.includes(inputClass as InputClass))) return false;
  return value.inputDigest !== undefined
    && typeof value.inputDigest === 'string'
    && /^[a-f0-9]{64}$/.test(value.inputDigest)
    && value.digestAlgorithm === DIGEST_ALGORITHM;
}

function isProvenance(value: unknown): value is RecursiveInputProvenance {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'producer',
    'job',
    'attempt',
    'trustScope',
    'checkoutIdentity',
    'credentialCleanup',
  ])) return false;
  if (typeof value.producer !== 'string' || value.producer.length === 0) return false;
  if (typeof value.job !== 'string' || value.job.length === 0) return false;
  if (typeof value.attempt !== 'string' || value.attempt.length === 0) return false;
  if (!TRUST_SCOPES.includes(value.trustScope as TrustScope)) return false;
  if (!isSourceIdentity(value.checkoutIdentity)) return false;
  return isRecord(value.credentialCleanup)
    && hasOnlyKeys(value.credentialCleanup, ['status'])
    && ['passed', 'failed', 'unknown'].includes(String(value.credentialCleanup.status));
}

function isReadiness(value: unknown): value is ReadinessByClass {
  if (!isRecord(value) || !hasOnlyKeys(value, INPUT_CLASSES)) return false;
  return INPUT_CLASSES.every((inputClass) => {
    const row = value[inputClass];
    return isRecord(row)
      && hasOnlyKeys(row, ['status'])
      && READINESS_STATUSES.includes(row.status as ReadinessStatus);
  });
}

function isFailure(value: unknown): value is RecursiveInputFailure {
  return isRecord(value)
    && hasOnlyKeys(value, ['code', 'hint', 'expected', 'actual', 'retryable', 'recoveryActions'])
    && typeof value.code === 'string'
    && value.code.startsWith('recursive-input.')
    && typeof value.hint === 'string'
    && typeof value.expected === 'string'
    && typeof value.actual === 'string'
    && typeof value.retryable === 'boolean'
    && Array.isArray(value.recoveryActions)
    && value.recoveryActions.length > 0
    && value.recoveryActions.every((action) => typeof action === 'string' && action.length > 0);
}

export function isRecursiveInputResult(value: unknown): value is RecursiveInputResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion',
    'status',
    'content',
    'provenance',
    'readiness',
    'failure',
  ])) return false;
  if (value.schemaVersion !== SCHEMA_VERSION || !isContent(value.content)) return false;
  const provenance = value.provenance;
  const readiness = value.readiness;
  if (!isProvenance(provenance) || !isReadiness(readiness)) return false;

  const requested = value.content.requestedInputClasses;
  const requestedReady = requested.every((inputClass) => readiness[inputClass].status === 'ready');
  if (value.status === 'ready') return requestedReady && value.failure === undefined;
  return value.status === 'non-ready' && !requestedReady && isFailure(value.failure);
}

export function parseRecursiveInputResult(value: unknown): RecursiveInputResult {
  if (!isRecursiveInputResult(value)) {
    throw new Error('recursive-input result failed schema validation');
  }
  return value;
}
