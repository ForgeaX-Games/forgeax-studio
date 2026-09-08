import {
  releaseIntegrityError,
} from './errors.ts';

export const RELEASE_TRUST_DAG_SCHEMA_ID = 'urn:forgeax:release-trust-dag:v1' as const;
export const RELEASE_TRUST_DAG_SCHEMA_VERSION = 1 as const;

export const TRUST_DAG_ROLES = ['producer', 'verifier', 'publisher', 'target', 'mutation'] as const;
export type TrustDagRole = (typeof TRUST_DAG_ROLES)[number];
export const TRUST_DAG_EDGE_KINDS = ['evidence', 'precondition', 'binding', 'order'] as const;
export type TrustDagEdgeKind = (typeof TRUST_DAG_EDGE_KINDS)[number];

export type TrustDagNode = {
  nodeId: string;
  role: TrustDagRole;
  identity: string;
  permissions: string[];
};

export type TrustDagEdge = {
  edgeId: string;
  from: string;
  to: string;
  kind: TrustDagEdgeKind;
};

export type TrustDagMutation = {
  mutationId: string;
  targetNodeId: string;
  publisherNodeId: string;
  operation: string;
  requiredPreconditions: string[];
};

export type ReleaseTrustDag = {
  schemaVersion: typeof RELEASE_TRUST_DAG_SCHEMA_VERSION;
  candidateId: string;
  nodes: TrustDagNode[];
  edges: TrustDagEdge[];
  mutations: TrustDagMutation[];
};

export type TrustDagValidation = {
  ok: true;
  value: ReleaseTrustDag;
  mutationEdges: string[];
} | {
  ok: false;
  error: ReturnType<typeof releaseIntegrityError>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function fail(code: string, gate: string, expected: string, actual: string, candidateId: string): TrustDagValidation {
  return { ok: false, error: releaseIntegrityError(code, gate, expected, actual, {
    candidateId,
    recoveryActions: ['repair-trust-dag', 'rerun-read-only-verifier'],
  }) };
}

function nodeById(nodes: readonly TrustDagNode[]): Map<string, TrustDagNode> {
  return new Map(nodes.map((node) => [node.nodeId, node]));
}

function hasCycle(nodes: readonly TrustDagNode[], edges: readonly TrustDagEdge[]): boolean {
  const graph = new Map(nodes.map((node) => [node.nodeId, [] as string[]]));
  for (const edge of edges) graph.get(edge.from)?.push(edge.to);
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    active.add(nodeId);
    for (const child of graph.get(nodeId) ?? []) if (visit(child)) return true;
    active.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.nodeId));
}

export function validateTrustDag(value: unknown): TrustDagValidation {
  const candidateId = isRecord(value) && typeof value.candidateId === 'string' ? value.candidateId : 'unknown';
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'candidateId', 'nodes', 'edges', 'mutations'])) return fail('trust-dag-schema-invalid', 'trust-dag', 'closed release-trust-dag.v1 object', 'invalid or extra fields', candidateId);
  if (value.schemaVersion !== RELEASE_TRUST_DAG_SCHEMA_VERSION || typeof value.candidateId !== 'string' || value.candidateId.length === 0) return fail('trust-dag-schema-invalid', 'trust-dag', 'schemaVersion=1 and candidateId', 'missing or invalid', candidateId);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.mutations) || value.nodes.length === 0 || value.edges.length === 0 || value.mutations.length === 0) return fail('trust-dag-schema-invalid', 'trust-dag', 'non-empty nodes, edges, and mutations arrays', 'missing or empty array', candidateId);
  if (!value.nodes.every((node) => isRecord(node) && hasOnlyKeys(node, ['nodeId', 'role', 'identity', 'permissions']) && typeof node.nodeId === 'string' && node.nodeId.length > 0 && typeof node.identity === 'string' && node.identity.length > 0 && TRUST_DAG_ROLES.includes(node.role as TrustDagRole) && Array.isArray(node.permissions) && node.permissions.every((permission) => typeof permission === 'string'))) return fail('trust-dag-node-invalid', 'trust-dag', 'closed typed node declarations', 'invalid node', candidateId);
  if (!value.edges.every((edge) => isRecord(edge) && hasOnlyKeys(edge, ['edgeId', 'from', 'to', 'kind']) && typeof edge.edgeId === 'string' && edge.edgeId.length > 0 && typeof edge.from === 'string' && edge.from.length > 0 && typeof edge.to === 'string' && edge.to.length > 0 && TRUST_DAG_EDGE_KINDS.includes(edge.kind as TrustDagEdgeKind))) return fail('trust-dag-edge-invalid', 'trust-dag', 'closed typed edge declarations', 'invalid edge', candidateId);
  if (!value.mutations.every((mutation) => isRecord(mutation) && hasOnlyKeys(mutation, ['mutationId', 'targetNodeId', 'publisherNodeId', 'operation', 'requiredPreconditions']) && typeof mutation.mutationId === 'string' && mutation.mutationId.length > 0 && typeof mutation.targetNodeId === 'string' && mutation.targetNodeId.length > 0 && typeof mutation.publisherNodeId === 'string' && mutation.publisherNodeId.length > 0 && typeof mutation.operation === 'string' && mutation.operation.length > 0 && Array.isArray(mutation.requiredPreconditions) && mutation.requiredPreconditions.every((edgeId) => typeof edgeId === 'string' && edgeId.length > 0))) return fail('trust-dag-mutation-invalid', 'mutation-order', 'closed mutation declarations', 'invalid mutation', candidateId);

  const nodes = value.nodes as TrustDagNode[];
  const edges = value.edges as TrustDagEdge[];
  const mutations = value.mutations as TrustDagMutation[];
  const nodeIds = nodes.map((node) => node.nodeId);
  const edgeIds = edges.map((edge) => edge.edgeId);
  const mutationIds = mutations.map((mutation) => mutation.mutationId);
  if (new Set(nodeIds).size !== nodeIds.length || new Set(edgeIds).size !== edgeIds.length || new Set(mutationIds).size !== mutationIds.length) return fail('trust-dag-duplicate-id', 'trust-dag', 'unique node, edge, and mutation identities', 'duplicate identity', candidateId);
  const nodesById = nodeById(nodes);
  if (nodes.filter((node) => node.role === 'producer').length !== 1 || nodes.filter((node) => node.role === 'verifier').length !== 1) return fail('role-invalid', 'trust-dag', 'one producer and verifier authority', 'role authority is duplicated or missing', candidateId);
  if (nodes.filter((node) => node.role === 'publisher').length !== 1) return fail('duplicate-publisher', 'trust-dag', 'one publisher authority', 'publisher authority is duplicated or missing', candidateId);
  if (edges.some((edge) => !nodesById.has(edge.from) || !nodesById.has(edge.to))) return fail('candidate-binding-invalid', 'candidate-binding', 'all edge endpoints belong to this candidate', 'edge references an unknown node', candidateId);
  if (nodes.some((node) => (node.role === 'producer' || node.role === 'verifier') && node.permissions.some((permission) => permission.startsWith('write:')))) return fail('permission-expanded', 'permission-boundary', 'producer and verifier read-only permissions', 'write permission declared', candidateId);
  if (nodes.some((node) => node.permissions.some((permission) => permission.includes('*')))) return fail('permission-expanded', 'permission-boundary', 'target-scoped permissions without wildcards', 'wildcard permission declared', candidateId);
  if (hasCycle(nodes, edges)) return fail('cycle-detected', 'trust-dag', 'acyclic dependency graph', 'cycle detected', candidateId);

  const publisher = nodes.find((node) => node.role === 'publisher')!;
  const verifier = nodes.find((node) => node.role === 'verifier')!;
  const producer = nodes.find((node) => node.role === 'producer')!;
  const evidence = edges.some((edge) => edge.kind === 'evidence' && edge.from === producer.nodeId && edge.to === verifier.nodeId);
  if (!evidence) return fail('evidence-edge-missing', 'trust-dag', `${producer.nodeId}->${verifier.nodeId} evidence edge`, 'missing', candidateId);
  const mutationEdges: string[] = [];
  for (const mutation of mutations) {
    const target = nodesById.get(mutation.targetNodeId);
    const mutationNode = nodesById.get(mutation.mutationId);
    const declaredPublisher = nodesById.get(mutation.publisherNodeId);
    if (!target || target.role !== 'target' || !mutationNode || mutationNode.role !== 'mutation') return fail('candidate-binding-invalid', 'candidate-binding', 'known target and mutation nodes', `${mutation.targetNodeId}/${mutation.mutationId}`, candidateId);
    if (!declaredPublisher || declaredPublisher.role !== 'publisher' || declaredPublisher.nodeId !== publisher.nodeId) return fail('duplicate-publisher', 'trust-dag', publisher.nodeId, mutation.publisherNodeId, candidateId);
    if (mutation.requiredPreconditions.length === 0 || mutation.requiredPreconditions.some((edgeId) => !edges.some((edge) => edge.edgeId === edgeId && edge.kind === 'precondition' && edge.from === verifier.nodeId && edge.to === publisher.nodeId))) return fail('mutation-before-gate', 'mutation-order', 'verifier precondition before publisher', 'missing or mismatched precondition', candidateId);
    if (!edges.some((edge) => edge.kind === 'binding' && edge.from === target.nodeId && edge.to === mutationNode.nodeId)) return fail('mutation-target-unbound', 'candidate-binding', `${target.nodeId}->${mutationNode.nodeId} binding edge`, 'missing', candidateId);
    if (!edges.some((edge) => edge.kind === 'order' && edge.from === publisher.nodeId && edge.to === mutationNode.nodeId)) return fail('mutation-before-gate', 'mutation-order', `${publisher.nodeId}->${mutationNode.nodeId} order edge`, 'missing', candidateId);
    mutationEdges.push(mutation.mutationId);
  }
  return { ok: true, value: value as ReleaseTrustDag, mutationEdges };
}

export function deriveReleaseTrustDagJsonSchema(): Record<string, unknown> {
  const node = { type: 'object', additionalProperties: false, required: ['nodeId', 'role', 'identity', 'permissions'], properties: { nodeId: { type: 'string', minLength: 1 }, role: { type: 'string', enum: [...TRUST_DAG_ROLES] }, identity: { type: 'string', minLength: 1 }, permissions: { type: 'array', items: { type: 'string' } } } };
  const edge = { type: 'object', additionalProperties: false, required: ['edgeId', 'from', 'to', 'kind'], properties: { edgeId: { type: 'string', minLength: 1 }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: [...TRUST_DAG_EDGE_KINDS] } } };
  const mutation = { type: 'object', additionalProperties: false, required: ['mutationId', 'targetNodeId', 'publisherNodeId', 'operation', 'requiredPreconditions'], properties: { mutationId: { type: 'string', minLength: 1 }, targetNodeId: { type: 'string', minLength: 1 }, publisherNodeId: { type: 'string', minLength: 1 }, operation: { type: 'string', minLength: 1 }, requiredPreconditions: { type: 'array', items: { type: 'string', minLength: 1 } } } };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: RELEASE_TRUST_DAG_SCHEMA_ID, title: 'ForgeaX release trust DAG', type: 'object', additionalProperties: false, required: ['schemaVersion', 'candidateId', 'nodes', 'edges', 'mutations'], properties: { schemaVersion: { type: 'integer', const: 1 }, candidateId: { type: 'string', minLength: 1 }, nodes: { type: 'array', minItems: 1, items: { $ref: '#/$defs/node' } }, edges: { type: 'array', minItems: 1, items: { $ref: '#/$defs/edge' } }, mutations: { type: 'array', minItems: 1, items: { $ref: '#/$defs/mutation' } } }, $defs: { node, edge, mutation } };
}
