import { describe, expect, it } from 'bun:test';
import { parseEvidenceManifest } from './evidence-manifest.schema';

function migratedFixture(): Record<string, unknown> {
  return {
    schema_version: 1,
    manifest_id: 'ev_role_create_main',
    baseline_id: 'b1-2026-07-22-0.6.0',
    status: 'migrated',
    mapping: {
      effect_id: 'role.create',
      control_ids: ['ctl_0123456789abcdef01234567'],
      handler_ids: ['headless:role.create'],
      tests: [{
        test_id: 'tests/role.test.ts#role.create reaches action',
        proves_effect_ids: ['role.create'],
      }],
    },
    equivalent: { kind: 'action', id: 'role.create' },
    context: { agent_id: 'forge', trust_tier: 'own', session_id: 'sid-fixture', game_slug: 'game-fixture' },
    wire_name: 'ui_act_role_create',
    direct_call_residual: { status: 'none', evidence_refs: ['evidence/direct-call-scan.json'] },
    verification_level: 'isolated-fixture-run',
    profile_id: 'main',
    reproduction_key_sha256: 'a'.repeat(64),
    tool_source: 'catalog-firstclass',
    qualifies_for_verified_equivalence: true,
    evidence_refs: ['evidence/runtime-snapshot.json'],
  };
}

function unmigratedFixture(): Record<string, unknown> {
  return {
    ...migratedFixture(),
    manifest_id: 'ev_external_tool_main',
    status: 'unmigrated',
    mapping: { effect_id: 'asset.generate', control_ids: [], handler_ids: [], tests: [] },
    equivalent: { kind: 'tool', id: 'gen3d_generate' },
    context: { agent_id: 'forge', trust_tier: 'own', session_id: null, game_slug: null },
    wire_name: 'gen3d_generate',
    direct_call_residual: { status: 'unknown', evidence_refs: [] },
    verification_level: 'external-unverified',
    reproduction_key_sha256: 'b'.repeat(64),
    tool_source: 'plugin',
    qualifies_for_verified_equivalence: false,
    evidence_refs: ['evidence/static-route-proof.json'],
  };
}

function fixtureGroup(group: 'valid' | 'invalid'): unknown[] {
  if (group === 'valid') return [migratedFixture(), unmigratedFixture()];

  const falseVerified = unmigratedFixture();
  falseVerified.manifest_id = 'invalid_false_verified';
  falseVerified.equivalent = { kind: 'action', id: 'role.create' };
  falseVerified.mapping = { effect_id: 'role.create', control_ids: [], handler_ids: [], tests: [] };
  falseVerified.wire_name = 'ui_act_role_create';
  falseVerified.verification_level = 'static-route-proof';
  falseVerified.tool_source = 'catalog-firstclass';
  falseVerified.qualifies_for_verified_equivalence = true;

  const hollowMigrated = migratedFixture();
  hollowMigrated.manifest_id = 'invalid_hollow_migrated';
  hollowMigrated.mapping = { effect_id: 'role.create', control_ids: [], handler_ids: [], tests: [] };
  hollowMigrated.equivalent = { kind: 'none', id: null };
  hollowMigrated.wire_name = null;
  hollowMigrated.direct_call_residual = { status: 'unknown', evidence_refs: [] };
  hollowMigrated.verification_level = 'external-unverified';
  hollowMigrated.tool_source = 'builtin';
  hollowMigrated.qualifies_for_verified_equivalence = false;
  hollowMigrated.evidence_refs = [];

  const missingWire = unmigratedFixture();
  missingWire.manifest_id = 'invalid_missing_wire';
  missingWire.mapping = { effect_id: 'role.create', control_ids: [], handler_ids: [], tests: [] };
  missingWire.equivalent = { kind: 'action', id: 'role.create' };
  missingWire.tool_source = 'catalog-firstclass';
  delete missingWire.wire_name;

  const verifiedNullWire = falseVerified;
  const isolatedNullWire = structuredClone(verifiedNullWire);
  isolatedNullWire.manifest_id = 'invalid_verified_null_wire';
  isolatedNullWire.wire_name = null;
  isolatedNullWire.verification_level = 'isolated-fixture-run';

  return [falseVerified, hollowMigrated, missingWire, isolatedNullWire];
}

describe('evidence manifest v1 fail-closed Zod schema', () => {
  it('accepts every fixture in the valid group', () => {
    const fixtures = fixtureGroup('valid');
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) expect(() => parseEvidenceManifest(fixture)).not.toThrow();
  });

  it('rejects every fixture in the invalid group', () => {
    const fixtures = fixtureGroup('invalid');
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) expect(() => parseEvidenceManifest(fixture)).toThrow();
  });

  it('rejects every missing top-level field', () => {
    const fixture = fixtureGroup('valid')[0] as Record<string, unknown>;
    for (const field of Object.keys(fixture)) {
      const missing = structuredClone(fixture);
      delete missing[field];
      expect(() => parseEvidenceManifest(missing), field).toThrow();
    }
  });

  it('rejects unknown top-level and nested fields', () => {
    const fixture = fixtureGroup('valid')[0] as Record<string, unknown>;
    expect(() => parseEvidenceManifest({ ...fixture, coverage: true })).toThrow();
    const nested = structuredClone(fixture);
    nested.mapping = { ...(nested.mapping as object), unexpected: true };
    expect(() => parseEvidenceManifest(nested)).toThrow();
  });

  it('keeps verified equivalence independent from migrated coverage status', () => {
    const fixture = structuredClone(fixtureGroup('valid')[0]) as Record<string, unknown>;
    fixture.status = 'unmigrated';
    expect(parseEvidenceManifest(fixture).qualifies_for_verified_equivalence).toBe(true);
  });

  it('rejects duplicate IDs and a non-SHA reproduction key binding', () => {
    const duplicate = structuredClone(fixtureGroup('valid')[0]) as Record<string, unknown>;
    duplicate.mapping = {
      ...(duplicate.mapping as object),
      tests: [
        { test_id: 'tests/role.test.ts#role.create reaches action', proves_effect_ids: ['role.create'] },
        { test_id: 'tests/role.test.ts#role.create reaches action', proves_effect_ids: ['role.create'] },
      ],
    };
    expect(() => parseEvidenceManifest(duplicate)).toThrow(/duplicates/);

    const badSha = structuredClone(fixtureGroup('valid')[0]) as Record<string, unknown>;
    badSha.reproduction_key_sha256 = 'not-a-sha';
    expect(() => parseEvidenceManifest(badSha)).toThrow(/SHA-256/);
  });

  it('rejects baseline IDs outside the scanner b-series/date/version format', () => {
    const badBaseline = structuredClone(fixtureGroup('valid')[0]) as Record<string, unknown>;
    badBaseline.baseline_id = 'latest';
    expect(() => parseEvidenceManifest(badBaseline)).toThrow(/baseline/);
  });
});
