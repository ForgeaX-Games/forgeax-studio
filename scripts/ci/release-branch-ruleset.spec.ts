import { describe, expect, test } from 'bun:test';
import contract from '../../.github/release-branch-ruleset.json';
import { rulesetsMatch } from './release-branch-ruleset.ts';

describe('release branch ruleset reconciliation', () => {
  test('ignores GitHub response metadata but detects policy drift', () => {
    expect(rulesetsMatch(contract, { id: 123, source_type: 'Repository', ...contract })).toBe(true);
    expect(rulesetsMatch(contract, { ...contract, enforcement: 'evaluate' })).toBe(false);
    expect(rulesetsMatch(contract, { ...contract, bypass_actors: [{ actor_id: 1 }] })).toBe(false);
  });
});
