import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateVerifiedMirrorAuthorization } from './run-verified-mirror.ts';

const source = readFileSync(new URL('./run-verified-mirror.ts', import.meta.url), 'utf8');

describe('verified IDE candidate mirror boundary', () => {
  test('passes the actual IDE candidate digest and integration revision into mirror commands', () => {
    expect(() => validateVerifiedMirrorAuthorization({
      candidateDigest: 'a'.repeat(64), integrationRevision: 'c'.repeat(40), intent: 'publish',
    })).not.toThrow();
    expect(source).toContain('FORGEAX_VERIFIED_IDE_CANDIDATE_DIGEST');
    expect(source).toContain('publish-multi.sh');
    expect(source).toContain('protect-repos.sh');
  });
});
