import { RELEASE_SURFACES, type ReleaseSurface } from './candidate.ts';

export const RELEASE_PRODUCER_MANIFEST_VERSION = 'release-integrity.v1' as const;
export const RELEASE_RESULT_VERSION = 'release-integrity-result.v1' as const;
export const RELEASE_TRUST_SCOPES = ['ordinary-ci', 'trusted-base-ci'] as const;
export type ReleaseTrustScope = (typeof RELEASE_TRUST_SCOPES)[number];

export type ReleaseProducerDeclaration = {
  producerId: string;
  releaseSurface: ReleaseSurface;
  owner: string;
  resultVersion: typeof RELEASE_RESULT_VERSION;
  trustScope: ReleaseTrustScope;
  sourceWork: string;
};

export type ReleaseConsumerDeclaration = {
  consumerId: string;
  producerId: string;
  releaseSurface: ReleaseSurface;
  verifierId: string;
  publisherId: string;
  resultVersion: typeof RELEASE_RESULT_VERSION;
  trustScope: ReleaseTrustScope;
  sourceWork: string;
};

export type ReleaseRegistryEdge = {
  edgeId: string;
  from: string;
  to: string;
  kind: 'producer' | 'verifier' | 'publisher';
};

export type ReleaseProducerManifest = {
  manifestVersion: typeof RELEASE_PRODUCER_MANIFEST_VERSION;
  producers: ReleaseProducerDeclaration[];
  consumers: ReleaseConsumerDeclaration[];
  edges: ReleaseRegistryEdge[];
};

export type ReleaseManifestError = { code: `release-integrity.${string}`; path: string; message: string };
export type ReleaseManifestValidation = { ok: true; value: ReleaseProducerManifest } | { ok: false; errors: ReleaseManifestError[] };

const error = (code: string, path: string, message: string): ReleaseManifestError => ({ code: `release-integrity.${code}`, path, message });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

export function createReleaseProducerManifestFixture(): ReleaseProducerManifest {
  const surfaces: ReleaseSurface[] = ['mirror-forward', 'trusted-dry-run', 'route-back', 'desktop', 'game-runtime'];
  const producers = surfaces.map((releaseSurface) => ({
    producerId: `${releaseSurface}-producer`,
    releaseSurface,
    owner: `producer:${releaseSurface}`,
    resultVersion: RELEASE_RESULT_VERSION,
    trustScope: releaseSurface === 'trusted-dry-run' ? 'trusted-base-ci' as const : 'ordinary-ci' as const,
    sourceWork: `${releaseSurface} candidate evidence`,
  }));
  const consumers = surfaces.map((releaseSurface) => ({
    consumerId: `${releaseSurface}-source-admission`,
    producerId: `${releaseSurface}-producer`,
    releaseSurface,
    verifierId: `${releaseSurface}-verifier`,
    publisherId: `${releaseSurface}-publisher`,
    resultVersion: RELEASE_RESULT_VERSION,
    trustScope: releaseSurface === 'trusted-dry-run' ? 'trusted-base-ci' as const : 'ordinary-ci' as const,
    sourceWork: releaseSurface === 'desktop' ? 'desktop payload source work' : `${releaseSurface} source work`,
  }));
  const edges = consumers.flatMap((consumer) => [
    { edgeId: `${consumer.consumerId}-producer`, from: consumer.producerId, to: consumer.verifierId, kind: 'verifier' as const },
    { edgeId: `${consumer.consumerId}-publisher`, from: consumer.verifierId, to: consumer.publisherId, kind: 'publisher' as const },
  ]);
  return { manifestVersion: RELEASE_PRODUCER_MANIFEST_VERSION, producers, consumers, edges };
}

export function validateReleaseProducerManifest(value: unknown): ReleaseManifestValidation {
  const errors: ReleaseManifestError[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, ['manifestVersion', 'producers', 'consumers', 'edges'])) return { ok: false, errors: [error('manifest-schema-invalid', '$', 'manifest must be a closed release registry')] };
  if (value.manifestVersion !== RELEASE_PRODUCER_MANIFEST_VERSION) errors.push(error('manifest-version-invalid', '$.manifestVersion', `must be ${RELEASE_PRODUCER_MANIFEST_VERSION}`));
  if (!Array.isArray(value.producers)) errors.push(error('producer-missing', '$.producers', 'producers must be an array'));
  if (!Array.isArray(value.consumers)) errors.push(error('consumer-missing', '$.consumers', 'consumers must be an array'));
  if (!Array.isArray(value.edges)) errors.push(error('edge-missing', '$.edges', 'producer/verifier/publisher edges are required'));
  if (Array.isArray(value.producers) && (Object.keys(value.producers).length !== value.producers.length || value.producers.some((producer) => !isRecord(producer)))) errors.push(error('producer-invalid', '$.producers', 'producer entries must be objects'));
  if (Array.isArray(value.consumers) && (Object.keys(value.consumers).length !== value.consumers.length || value.consumers.some((consumer) => !isRecord(consumer)))) errors.push(error('consumer-invalid', '$.consumers', 'consumer entries must be objects'));
  if (errors.length > 0) return { ok: false, errors };
  const producers = value.producers as ReleaseProducerDeclaration[];
  const consumers = value.consumers as ReleaseConsumerDeclaration[];
  const edges = value.edges as ReleaseRegistryEdge[];
  if (producers.length !== RELEASE_SURFACES.length) errors.push(error('producer-missing', '$.producers', 'exactly one producer per release surface is required'));
  if (consumers.length !== RELEASE_SURFACES.length) errors.push(error('consumer-missing', '$.consumers', 'exactly one source admission consumer per release surface is required'));
  for (const [index, producer] of producers.entries()) {
    if (!isRecord(producer) || !hasOnlyKeys(producer, ['producerId', 'releaseSurface', 'owner', 'resultVersion', 'trustScope', 'sourceWork'])) errors.push(error('producer-invalid', `$.producers[${index}]`, 'producer declaration is closed and complete'));
    else {
      if (!RELEASE_SURFACES.includes(producer.releaseSurface as ReleaseSurface)) errors.push(error('producer-surface-invalid', `$.producers[${index}].releaseSurface`, 'declared release surface'));
      if (producer.resultVersion !== RELEASE_RESULT_VERSION) errors.push(error('result-version-invalid', `$.producers[${index}].resultVersion`, RELEASE_RESULT_VERSION));
      if (!RELEASE_TRUST_SCOPES.includes(producer.trustScope as ReleaseTrustScope)) errors.push(error('trust-scope-invalid', `$.producers[${index}].trustScope`, RELEASE_TRUST_SCOPES.join(',')));
      if (typeof producer.sourceWork !== 'string' || producer.sourceWork.length === 0) errors.push(error('source-work-missing', `$.producers[${index}].sourceWork`, 'source work boundary'));
    }
  }
  const producerIds = producers.map((producer) => producer.producerId);
  if (new Set(producerIds).size !== producerIds.length) errors.push(error('duplicate-producer', '$.producers', 'producer identity must be unique'));
  const producerSurfaces = producers.map((producer) => producer.releaseSurface);
  if (new Set(producerSurfaces).size !== producerSurfaces.length) errors.push(error('duplicate-producer-surface', '$.producers', 'producer release surface must be unique'));
  if (RELEASE_SURFACES.some((surface) => !producerSurfaces.includes(surface))) errors.push(error('producer-surface-missing', '$.producers', 'all release surfaces must have a producer'));
  const producerById = new Map(producers.map((producer) => [producer.producerId, producer]));
  const consumerIds = consumers.map((consumer) => consumer.consumerId);
  if (new Set(consumerIds).size !== consumerIds.length) errors.push(error('duplicate-consumer', '$.consumers', 'consumer identity must be unique'));
  const consumerSurfaces = consumers.map((consumer) => consumer.releaseSurface);
  if (new Set(consumerSurfaces).size !== consumerSurfaces.length) errors.push(error('duplicate-consumer-surface', '$.consumers', 'consumer release surface must be unique'));
  if (RELEASE_SURFACES.some((surface) => !consumerSurfaces.includes(surface))) errors.push(error('consumer-surface-missing', '$.consumers', 'all release surfaces must have a consumer'));
  for (const [index, consumer] of consumers.entries()) {
    if (!isRecord(consumer) || !hasOnlyKeys(consumer, ['consumerId', 'producerId', 'releaseSurface', 'verifierId', 'publisherId', 'resultVersion', 'trustScope', 'sourceWork'])) errors.push(error('consumer-invalid', `$.consumers[${index}]`, 'consumer declaration is closed and complete'));
    else {
      const producer = producerById.get(consumer.producerId);
      if (!producer) errors.push(error('producer-reference-invalid', `$.consumers[${index}].producerId`, 'declared producer identity'));
      if (consumer.resultVersion !== RELEASE_RESULT_VERSION) errors.push(error('result-version-invalid', `$.consumers[${index}].resultVersion`, RELEASE_RESULT_VERSION));
      if (!RELEASE_TRUST_SCOPES.includes(consumer.trustScope as ReleaseTrustScope) || producer?.trustScope !== consumer.trustScope) errors.push(error('trust-scope-invalid', `$.consumers[${index}].trustScope`, 'consumer scope must match producer scope'));
      if (!RELEASE_SURFACES.includes(consumer.releaseSurface as ReleaseSurface) || producer?.releaseSurface !== consumer.releaseSurface) errors.push(error('consumer-surface-invalid', `$.consumers[${index}].releaseSurface`, 'consumer surface must match producer surface'));
      if (typeof consumer.verifierId !== 'string' || consumer.verifierId.length === 0) errors.push(error('verifier-missing', `$.consumers[${index}].verifierId`, 'declared verifier identity'));
      if (typeof consumer.publisherId !== 'string' || consumer.publisherId.length === 0) errors.push(error('publisher-missing', `$.consumers[${index}].publisherId`, 'declared publisher identity'));
      if (typeof consumer.sourceWork !== 'string' || consumer.sourceWork.length === 0) errors.push(error('source-work-missing', `$.consumers[${index}].sourceWork`, 'source work must be suppressed until admission'));
    }
  }
  if (edges.length === 0) errors.push(error('edge-missing', '$.edges', 'at least one edge is required'));
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>([
    ...producers.map((producer) => producer.producerId),
    ...consumers.flatMap((consumer) => [consumer.verifierId, consumer.publisherId]),
  ]);
  for (const [index, edge] of edges.entries()) {
    const validShape = isRecord(edge)
      && hasOnlyKeys(edge, ['edgeId', 'from', 'to', 'kind'])
      && typeof edge.edgeId === 'string'
      && typeof edge.from === 'string'
      && typeof edge.to === 'string'
      && ['producer', 'verifier', 'publisher'].includes(String(edge.kind));
    if (!validShape) {
      errors.push(error('edge-invalid', `$.edges[${index}]`, 'closed producer/verifier/publisher edge'));
      continue;
    }
    const typedEdge = edge as ReleaseRegistryEdge;
    if (edgeIds.has(typedEdge.edgeId)) errors.push(error('duplicate-edge', `$.edges[${index}].edgeId`, 'edge identity must be unique'));
    edgeIds.add(typedEdge.edgeId);
    if (!nodeIds.has(typedEdge.from) || !nodeIds.has(typedEdge.to)) errors.push(error('edge-endpoint-invalid', `$.edges[${index}]`, 'edge endpoints must be declared producer, verifier, or publisher identities'));
  }
  for (const [index, consumer] of consumers.entries()) {
    const producerEdge = edges.find((edge) => isRecord(edge) && edge.from === consumer.producerId && edge.to === consumer.verifierId && edge.kind === 'verifier');
    const publisherEdge = edges.find((edge) => isRecord(edge) && edge.from === consumer.verifierId && edge.to === consumer.publisherId && edge.kind === 'publisher');
    if (!producerEdge || !publisherEdge) errors.push(error('consumer-edge-closure', `$.consumers[${index}]`, 'each consumer must have producer-to-verifier and verifier-to-publisher edges'));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as ReleaseProducerManifest };
}

export function enumerateReleaseConsumers(manifest: ReleaseProducerManifest): ReleaseConsumerDeclaration[] {
  return manifest.consumers.map((consumer) => ({ ...consumer }));
}
