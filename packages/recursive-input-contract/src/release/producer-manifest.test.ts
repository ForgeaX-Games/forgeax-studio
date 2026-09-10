import { describe, expect, test } from 'bun:test';
import {
  RELEASE_PRODUCER_MANIFEST_VERSION,
  createReleaseProducerManifestFixture,
  enumerateReleaseConsumers,
  validateReleaseProducerManifest,
} from './producer-manifest.ts';

describe('release producer and consumer registry', () => {
  test('enumerates five independent release surfaces and a desktop source admission consumer', () => {
    const manifest = createReleaseProducerManifestFixture();
    const validation = validateReleaseProducerManifest(manifest);

    expect(validation.ok).toBe(true);
    expect(RELEASE_PRODUCER_MANIFEST_VERSION).toBe('release-integrity.v1');
    expect(enumerateReleaseConsumers(manifest).map((consumer) => consumer.releaseSurface)).toEqual([
      'mirror-forward', 'trusted-dry-run', 'route-back', 'desktop', 'game-runtime',
    ]);
    expect(enumerateReleaseConsumers(manifest).find((consumer) => consumer.releaseSurface === 'desktop')).toEqual(expect.objectContaining({
      consumerId: 'desktop-source-admission',
      sourceWork: 'desktop payload source work',
    }));
  });

  test.each([
    ['missing producer', (manifest: Record<string, unknown>) => delete (manifest.producers as unknown[])[0]],
    ['missing verifier', (manifest: Record<string, unknown>) => delete (manifest.consumers as Array<Record<string, unknown>>)[0].verifierId],
    ['missing publisher', (manifest: Record<string, unknown>) => delete (manifest.consumers as Array<Record<string, unknown>>)[0].publisherId],
    ['wrong output version', (manifest: Record<string, unknown>) => (manifest.producers as Array<Record<string, unknown>>)[0].resultVersion = 'release-integrity.v9'],
    ['wrong trust scope', (manifest: Record<string, unknown>) => (manifest.consumers as Array<Record<string, unknown>>)[0].trustScope = 'trusted-base-ci'],
    ['missing source work', (manifest: Record<string, unknown>) => delete (manifest.consumers as Array<Record<string, unknown>>)[0].sourceWork],
  ])('rejects %s before consumer work', (_name, mutate) => {
    const manifest = structuredClone(createReleaseProducerManifestFixture()) as unknown as Record<string, unknown>;
    mutate(manifest);

    const validation = validateReleaseProducerManifest(manifest);

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors[0]?.code).toMatch(/^release-integrity\./);
  });

  test('rejects duplicate consumer identity instead of merging release surfaces', () => {
    const manifest = createReleaseProducerManifestFixture();
    manifest.consumers.push({ ...manifest.consumers[0] });

    const validation = validateReleaseProducerManifest(manifest);

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.map((error) => error.code)).toContain('release-integrity.duplicate-consumer');
  });

  test.each([
    ['producers', undefined],
    ['producers', null],
    ['producers', {}],
    ['consumers', undefined],
    ['consumers', null],
    ['consumers', {}],
  ])('rejects a malformed %s container with structured errors', (field, replacement) => {
    const manifest = structuredClone(createReleaseProducerManifestFixture()) as unknown as Record<string, unknown>;
    if (replacement === undefined) delete manifest[field];
    else manifest[field] = replacement;

    expect(() => validateReleaseProducerManifest(manifest)).not.toThrow();
    const validation = validateReleaseProducerManifest(manifest);

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `$.${field}`, code: `release-integrity.${field === 'producers' ? 'producer' : 'consumer'}-missing` }),
    ]));
  });

  test.each([
    ['empty edge graph', (manifest: ReturnType<typeof createReleaseProducerManifestFixture>) => { manifest.edges = []; }, 'release-integrity.edge-missing'],
    ['duplicate edge identity', (manifest: ReturnType<typeof createReleaseProducerManifestFixture>) => { manifest.edges.push({ ...manifest.edges[0]! }); }, 'release-integrity.duplicate-edge'],
    ['unknown endpoint', (manifest: ReturnType<typeof createReleaseProducerManifestFixture>) => { manifest.edges[0]!.from = 'unknown-producer'; }, 'release-integrity.edge-endpoint-invalid'],
    ['non-closed consumer graph', (manifest: ReturnType<typeof createReleaseProducerManifestFixture>) => { manifest.edges = manifest.edges.filter((edge) => !edge.edgeId.endsWith('-publisher')); }, 'release-integrity.consumer-edge-closure'],
    ['duplicate producer surface', (manifest: ReturnType<typeof createReleaseProducerManifestFixture>) => { manifest.producers[1]!.releaseSurface = manifest.producers[0]!.releaseSurface; }, 'release-integrity.duplicate-producer-surface'],
  ])('rejects %s before consumer work', (_name, mutate, code) => {
    const manifest = createReleaseProducerManifestFixture();
    mutate(manifest);

    const validation = validateReleaseProducerManifest(manifest);

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.map((error) => error.code)).toContain(code as `release-integrity.${string}`);
  });
});
