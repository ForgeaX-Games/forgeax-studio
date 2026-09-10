import { describe, expect, test } from 'bun:test';
import { validateTrustDag, type ReleaseTrustDag } from './trust-dag.ts';

const validDag = (): ReleaseTrustDag => ({
  schemaVersion: 1,
  candidateId: 'candidate-1',
  nodes: [
    { nodeId: 'producer-1', role: 'producer', identity: 'producer:mirror', permissions: ['read:candidate'] },
    { nodeId: 'verifier-1', role: 'verifier', identity: 'verifier:contract', permissions: ['read:candidate', 'read:target'] },
    { nodeId: 'publisher-1', role: 'publisher', identity: 'publisher:mirror', permissions: ['write:mirror-target'] },
    { nodeId: 'target-1', role: 'target', identity: 'target:mirror', permissions: ['target:mirror'] },
    { nodeId: 'mutation-1', role: 'mutation', identity: 'mutation:push', permissions: ['write:mirror-target'] },
  ],
  edges: [
    { edgeId: 'evidence-1', from: 'producer-1', to: 'verifier-1', kind: 'evidence' },
    { edgeId: 'gate-1', from: 'verifier-1', to: 'publisher-1', kind: 'precondition' },
    { edgeId: 'target-1', from: 'target-1', to: 'mutation-1', kind: 'binding' },
    { edgeId: 'order-1', from: 'publisher-1', to: 'mutation-1', kind: 'order' },
  ],
  mutations: [{
    mutationId: 'mutation-1',
    targetNodeId: 'target-1',
    publisherNodeId: 'publisher-1',
    operation: 'push',
    requiredPreconditions: ['gate-1'],
  }],
});

describe('release trust DAG contract', () => {
  test('accepts one candidate-bound publisher edge with a complete acyclic graph', () => {
    const result = validateTrustDag(validDag());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mutationEdges).toEqual(['mutation-1']);
  });

  test.each([
    ['missing evidence edge', (dag: ReleaseTrustDag) => { dag.edges = dag.edges.filter((edge) => edge.kind !== 'evidence'); }],
    ['unknown target', (dag: ReleaseTrustDag) => { dag.mutations[0].targetNodeId = 'target-missing'; }],
    ['cross candidate result', (dag: ReleaseTrustDag) => { dag.candidateId = 'candidate-other'; dag.edges[0].from = 'producer-other'; }],
    ['mutation before gate', (dag: ReleaseTrustDag) => { dag.edges = dag.edges.filter((edge) => edge.kind !== 'precondition'); }],
  ])('rejects %s before external mutation', (_name, mutate) => {
    const dag = validDag();
    mutate(dag);

    const result = validateTrustDag(dag);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toMatch(/^release-integrity\./);
      expect(result.error.gate).toMatch(/trust-dag|mutation-order|candidate-binding/);
      expect(result.error.recoveryActions.length).toBeGreaterThan(0);
    }
  });

  test('rejects duplicate publishers and permission expansion', () => {
    const dag = validDag();
    dag.nodes.push({ nodeId: 'publisher-2', role: 'publisher', identity: 'publisher:other', permissions: ['write:other-target'] });
    dag.mutations.push({
      mutationId: 'mutation-2',
      targetNodeId: 'target-1',
      publisherNodeId: 'publisher-2',
      operation: 'delete',
      requiredPreconditions: ['gate-1'],
    });
    dag.nodes.find((node) => node.nodeId === 'publisher-1')!.permissions.push('write:*');

    const result = validateTrustDag(dag);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['release-integrity.duplicate-publisher', 'release-integrity.permission-expanded']).toContain(result.error.code);
      expect(result.error.expected).toBeTruthy();
      expect(result.error.actual).toBeTruthy();
    }
  });

  test('rejects role replacement and cycles without trusting workflow order', () => {
    const dag = validDag();
    dag.nodes.find((node) => node.nodeId === 'verifier-1')!.role = 'publisher';
    dag.edges.push({ edgeId: 'cycle-1', from: 'mutation-1', to: 'producer-1', kind: 'order' });

    const result = validateTrustDag(dag);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(['release-integrity.role-invalid', 'release-integrity.cycle-detected']).toContain(result.error.code);
  });
});
