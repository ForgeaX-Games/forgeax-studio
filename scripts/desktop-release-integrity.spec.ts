import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '..');
const weekly = readFileSync(join(root, '.github/workflows/weekly-release.yml'), 'utf8');

function ordered(source: string, before: string, after: string): boolean {
  const left = source.indexOf(before);
  const right = source.indexOf(after);
  return left >= 0 && right > left;
}

describe('IDE-owned desktop release wire contract', () => {
  test('removes Studio and mirror-assets desktop packaging owners', () => {
    expect(existsSync(join(root, 'scripts/mirror/oss-assets/.github/workflows/release.yml'))).toBe(false);
    expect(weekly).not.toContain('tauri-apps/tauri-action');
    expect(weekly).not.toContain('gh release create');
    expect(weekly).not.toContain('gh release upload');
    expect(weekly).not.toContain('bun fx build desktop');
  });

  test('dispatches the public IDE inputs at the recursively resolved immutable tag', () => {
    expect(weekly).toContain('gh workflow run "$IDE_RELEASE_WORKFLOW"');
    expect(weekly).toContain('--ref "$IDE_TAG"');
    expect(weekly).toContain('while [ "$type" = tag ]');
    expect(weekly).toContain('tag="$IDE_SOURCE_TAG"');
    expect(weekly).not.toContain('tag="ide-v${VERSION}"');
    for (const input of [
      'version="$VERSION"', 'ide_revision="$IDE_REVISION"', 'integration_revision="$INTEGRATION_REVISION"', 'revision_branch="$REVISION_BRANCH"',
      'sidecar_candidate_manifest_url="$SIDECAR_URL"', 'sidecar_candidate_manifest_sha256="$SIDECAR_SHA256"',
      'intent="$INTENT"', 'orchestration_id="$orchestration_id"',
    ]) expect(weekly).toContain(input);
  });

  test('consumes flat owner assets and the publish-only completion recovery artifact', () => {
    expect(weekly).toContain('--name "ide-release-assets-${ORCHESTRATION_ID}" --dir owner-assets');
    expect(weekly).toContain('--name "ide-release-completion-${ORCHESTRATION_ID}" --dir owner-completion');
    expect(weekly).toContain('if [ "$INTENT" = publish ]; then recovery=owner-completion/recovery.jsonl; fi');
    expect(weekly).toContain('--orchestration-id "$ORCHESTRATION_ID"');
    expect(weekly).not.toContain('--publisher-actor-id');
    expect(weekly).not.toContain('--workflow-definition-sha');
    expect(weekly).toContain('--tag "$PRODUCT_TAG"');
  });

  test('keeps dry-run outside Studio mutation jobs and verifies before mirror mutation', () => {
    expect(weekly).toContain("if: needs.gate.outputs.intent == 'publish'");
    expect(weekly).toContain("needs.gate.outputs.intent == 'publish' && needs.gate.outputs.mirror == 'true'");
    expect(ordered(weekly, 'verify-candidate', 'run-verified-mirror.ts')).toBe(true);
  });

  test('binds metadata merge to complete expected bytes and the reviewed head', () => {
    expect(weekly).toContain('cmp "$expected/$file" "$actual/$file"');
    expect(weekly).toContain('--match-head-commit "$reviewed_head"');
    expect(weekly).toContain('steps.verify.outputs.candidate_digest');
    expect(weekly).toContain('needs.ide-owner-release.outputs.candidate_digest');
  });
});
