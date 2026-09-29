import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '..');
const surfaces = {
  mirrorForward: readFileSync(join(root, 'scripts/mirror/publish-multi.sh'), 'utf8'),
  mirrorWorkflow: readFileSync(join(root, '.github/workflows/mirror-multi.yml'), 'utf8'),
  publicRelease: readFileSync(join(root, 'scripts/mirror/reconcile-public-release.ts'), 'utf8'),
  routeBackLegacy: readFileSync(join(root, 'scripts/mirror/route-back.sh'), 'utf8'),
  routeBackMulti: readFileSync(join(root, 'scripts/mirror/route-back-multi.sh'), 'utf8'),
  routeBackWorkflow: readFileSync(join(root, '.github/workflows/mirror-route-back.yml'), 'utf8'),
  routeBackTemplate: readFileSync(join(root, 'scripts/mirror/ci/route-back.yml'), 'utf8'),
  routeBackContract: readFileSync(join(root, 'scripts/mirror/route-back-contract.ts'), 'utf8'),
  releaseIntegrityCli: readFileSync(join(root, 'packages/recursive-input-contract/src/cli.ts'), 'utf8'),
  weekly: readFileSync(join(root, '.github/workflows/weekly-release.yml'), 'utf8'),
};

type MutationEdge = { id: string; target: string; publisher: string; candidate: string; gate: string };
const dag: MutationEdge[] = [
  { id: 'mirror-forward-push', target: 'ForgeaX-Games', publisher: 'mirror-forward-publisher', candidate: 'candidateId', gate: 'verifiedScheduledOrManualAuthorization' },
  { id: 'public-product-release', target: 'ForgeaX-Games/forgeax-studio', publisher: 'trusted-public-release-publisher', candidate: 'sourceCandidateId', gate: 'verifiedPublicMergeAndTagReconciliation' },
  { id: 'route-back-internal-pr', target: 'ForgeaX-Games/*', publisher: 'route-back-to-internal-pr', candidate: 'candidateId', gate: 'mutationOrder' },
  { id: 'release-metadata-pr', target: 'ForgeaX-Games/forgeax-studio', publisher: 'forgeax-bot', candidate: 'integrationRevision', gate: 'release-publish' },
  { id: 'ide-owner-dispatch', target: 'ForgeaX-Games/forgeax-ide/actions', publisher: 'studio-release-orchestrator', candidate: 'orchestrationId', gate: 'immutableTagAndRunObservation' },
];

function duplicateIds(edges: readonly MutationEdge[]): string[] {
  return [...new Set(edges.map((edge) => edge.id).filter((id, index, all) => all.indexOf(id) !== index))];
}

describe('mutation trust DAG coverage', () => {
  test('enumerates each remaining Studio external mutation with a concrete gate', () => {
    expect(duplicateIds(dag)).toEqual([]);
    for (const edge of dag) {
      expect(edge.target).not.toBe('unknown-repository');
      expect(edge.publisher).not.toBe('');
      expect(edge.candidate).not.toBe('');
      expect(edge.gate).not.toBe('');
    }
  });

  test('removes all Studio and public-mirror desktop Release publishers', () => {
    expect(existsSync(join(root, '.github/workflows/desktop-build.yml'))).toBe(false);
    expect(existsSync(join(root, 'scripts/mirror/oss-assets/.github/workflows/release.yml'))).toBe(false);
    expect(surfaces.weekly).not.toContain('gh release create');
    expect(surfaces.weekly).not.toContain('gh release upload');
  });

  test('covers legacy and modern route-back through the canonical result adapter', () => {
    for (const source of [surfaces.routeBackLegacy, surfaces.routeBackMulti, surfaces.routeBackWorkflow, surfaces.routeBackTemplate]) {
      expect(source).toContain('route-back-to-internal-pr');
      expect(source).toContain('candidateId');
      expect(source).toContain('permission');
      expect(source).toContain('mutation');
    }
    expect(surfaces.releaseIntegrityCli).toContain('release-integrity-result.v1');
    expect(surfaces.routeBackContract).toContain('validateReleaseIntegrityResult');
    expect(surfaces.routeBackContract).toContain('external-outcome-unobserved');
  });

  test('requires verified candidate outputs at every remaining public mirror mutation boundary', () => {
    expect(surfaces.mirrorForward).toContain('mirror_validate_publisher_edge');
    expect(surfaces.mirrorWorkflow).toContain('verify-release-candidate.ts');
    expect(surfaces.mirrorWorkflow).toContain('reconcile-public-release.ts');
    expect(surfaces.mirrorWorkflow).toContain('MIRROR_AUTO_PUBLISH_ENABLED');
    expect(surfaces.weekly).not.toContain('mirror-publish:');
    expect(surfaces.publicRelease).toContain('trusted-public-release-publisher');
    expect(surfaces.publicRelease).toContain('sourceCandidateId');
    expect(surfaces.publicRelease).toContain('externalOutcome');
  });

  test('keeps dry-run outside metadata, mirror, and notification mutations', () => {
    expect(surfaces.weekly).toContain("if: needs.gate.outputs.intent == 'publish'");
    expect(surfaces.mirrorWorkflow).toContain("steps.publication.outputs.publish == 'true'");
    expect(surfaces.mirrorForward).toContain('MIRROR_DRY_RUN');
    expect(surfaces.routeBackLegacy).toContain('ROUTE_BACK_DRY_RUN');
  });
});
