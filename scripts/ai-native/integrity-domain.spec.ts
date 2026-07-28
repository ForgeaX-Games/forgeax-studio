import { describe, expect, it } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertIntegrityDomainGenerated,
  deriveIntegrityDomain,
  renderIntegrityDomainManifest,
} from './integrity-domain.ts';
import {
  computeEvidenceManifestSetFingerprint,
  computeScannerConfigurationFingerprint,
  observeRuntimePin,
  RUNTIME_PIN_PATH,
} from './runtime-artifact-integrity.ts';

const ROOT = resolve(import.meta.dir, '../..');

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-integrity-domain-'));
  cpSync(join(ROOT, 'scripts/ai-native'), join(root, 'scripts/ai-native'), { recursive: true });
  cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(ROOT, 'bun.lock'), join(root, 'bun.lock'));
  const ownership = 'docs/ai-native/other-team-gap-ownership.md';
  mkdirSync(dirname(join(root, ownership)), { recursive: true });
  cpSync(join(ROOT, ownership), join(root, ownership));
  symlinkSync(join(ROOT, 'packages'), join(root, 'packages'));
  return root;
}

function refreshGenerated(root: string): void {
  writeFileSync(
    join(root, 'scripts/ai-native/integrity-domain.generated.json'),
    renderIntegrityDomainManifest(deriveIntegrityDomain(root)),
  );
}

describe('derived AI-native integrity domain', () => {
  it('includes load-bearing code, live static resources, and workflow-owned roots', () => {
    const manifest = assertIntegrityDomainGenerated(ROOT);
    expect(manifest.domain_files).toContain('scripts/ai-native/control-id.ts');
    expect(manifest.domain_files).toContain('scripts/ai-native/evidence-file.ts');
    expect(manifest.domain_files).toContain('scripts/ai-native/generate-phase2-approval-docs.ts');
    expect(manifest.domain_files).toContain('scripts/ai-native/integrity-domain.ts');
    expect(manifest.domain_files).toContain('scripts/ai-native/manual-pool-adjudications-v1.jsonl');
    expect(manifest.domain_files).toContain('scripts/ai-native/manual-pool-carry-forward.json');
    expect(manifest.domain_files).not.toContain('scripts/ai-native/r4r5-artifacts.spec.ts');
    expect(manifest.domain_files).not.toContain('scripts/ai-native/r4r5-special-cases.json');
    expect(manifest.domain_files).toContain('docs/ai-native/other-team-gap-ownership.md');
    expect(manifest.configuration_files).not.toContain(
      'scripts/ai-native/runtime-snapshot-reports/main.formal.json',
    );
    expect(manifest.configuration_files).toContain('scripts/ai-native/vocab-config.json');
    expect(manifest.configuration_files).not.toContain('scripts/ai-native/vocab-map.json');
    expect(manifest.configuration_file_hashes.map((row) => row.path)).toEqual(
      manifest.configuration_files,
    );
    expect(manifest.configuration_files).toContain('package.json');
    expect(manifest.configuration_files).toContain('scripts/ai-native/baseline-literal.spec.ts');
    expect(manifest.scanner_configuration_files).not.toContain('package.json');
    expect(manifest.scanner_configuration_files).not.toContain(
      'scripts/ai-native/baseline-literal.spec.ts',
    );
    expect(manifest.snapshot_boundary_inputs).not.toContain('package.json');
    expect(manifest.roots.workflows).toEqual([]);
  });

  for (const file of ['control-id.ts', 'evidence-file.ts']) {
    it(`keeps enforcement-only ${file} out of the scanner configuration fingerprint`, () => {
      const root = fixtureRoot();
      const before = computeScannerConfigurationFingerprint(root).bound_sha256;
      const target = join(root, 'scripts/ai-native', file);
      writeFileSync(target, `${readFileSync(target, 'utf8')}\n// FR8 negative mutation\n`);
      expect(() => computeScannerConfigurationFingerprint(root)).toThrow(/generated artifact is stale/);
      refreshGenerated(root);
      const after = computeScannerConfigurationFingerprint(root).bound_sha256;
      expect(after).toBe(before);
    });
  }

  for (const file of ['exclusions.json', 'vocab-config.json', 'alias-map.json', 'scanner-config.json']) {
    it(`changes the scanner configuration fingerprint when true input ${file} changes`, () => {
      const root = fixtureRoot();
      const before = computeScannerConfigurationFingerprint(root).bound_sha256;
      const target = join(root, 'scripts/ai-native', file);
      writeFileSync(target, `${readFileSync(target, 'utf8')} `);
      expect(() => computeScannerConfigurationFingerprint(root)).toThrow(/generated artifact is stale/);
      refreshGenerated(root);
      expect(computeScannerConfigurationFingerprint(root).bound_sha256).not.toBe(before);
    });
  }

  it('turns the runtime anchor red when a true scanner input changes', () => {
    const root = fixtureRoot();
    mkdirSync(dirname(join(root, RUNTIME_PIN_PATH)), { recursive: true });
    cpSync(join(ROOT, RUNTIME_PIN_PATH), join(root, RUNTIME_PIN_PATH));
    expect(observeRuntimePin(root, RUNTIME_PIN_PATH).reasonCodes).toEqual([]);
    const target = join(root, 'scripts/ai-native/exclusions.json');
    writeFileSync(target, `${readFileSync(target, 'utf8')} `);
    refreshGenerated(root);
    expect(observeRuntimePin(root, RUNTIME_PIN_PATH).reasonCodes).toEqual([
      'formal-scanner-input-fingerprint-mismatch',
      'formal-scanner-configuration-fingerprint-mismatch',
    ]);
  });

  it('rejects a new value import until the generated domain is refreshed', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(join(root, 'scripts/ai-native/fr8-new-value.ts'), 'export const fr8NewValue = true;\n');
    writeFileSync(importer, `import { fr8NewValue } from './fr8-new-value.ts';\n${readFileSync(importer, 'utf8')}\nvoid fr8NewValue;\n`);
    expect(() => assertIntegrityDomainGenerated(root)).toThrow(/generated artifact is stale/);
  });

  it('rejects a protected configuration content change until the generated domain is refreshed', () => {
    const root = fixtureRoot();
    const target = join(root, 'scripts/ai-native/exclusions.json');
    writeFileSync(target, `${readFileSync(target, 'utf8')} `);
    expect(() => assertIntegrityDomainGenerated(root)).toThrow(/generated artifact is stale/);
  });

  it('rejects dynamic imports in the computation domain', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(importer, `${readFileSync(importer, 'utf8')}\nexport const forbidden = () => import('./control-id.ts');\n`);
    expect(() => deriveIntegrityDomain(root)).toThrow(/dynamic import is forbidden/);
  });

  it('tracks require value edges so a required module byte change changes the domain digest', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    const required = join(root, 'scripts/ai-native/fr9-required.ts');
    writeFileSync(required, "export const fr9Required = 'before';\n");
    writeFileSync(importer, `const fr9Required = require('./fr9-required.ts');\nvoid fr9Required;\n${readFileSync(importer, 'utf8')}`);
    refreshGenerated(root);
    const manifest = deriveIntegrityDomain(root);
    expect(manifest.domain_files).toContain('scripts/ai-native/fr9-required.ts');
    const before = deriveIntegrityDomain(root).configuration_file_hashes.find(
      (row) => row.path === 'scripts/ai-native/fr9-required.ts',
    )?.sha256;
    writeFileSync(required, "export const fr9Required = 'after';\n");
    expect(() => computeScannerConfigurationFingerprint(root)).toThrow(/generated artifact is stale/);
    refreshGenerated(root);
    const after = deriveIntegrityDomain(root).configuration_file_hashes.find(
      (row) => row.path === 'scripts/ai-native/fr9-required.ts',
    )?.sha256;
    expect(after).not.toBe(before);
  });

  it('tracks a module loaded through a direct require alias', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    const required = join(root, 'scripts/ai-native/fr10-aliased-required.ts');
    writeFileSync(required, "export const fr10AliasedRequired = 'before';\n");
    writeFileSync(
      importer,
      `const alias = require;\nconst fr10AliasedRequired = alias('./fr10-aliased-required.ts');\nvoid fr10AliasedRequired;\n${readFileSync(importer, 'utf8')}`,
    );
    refreshGenerated(root);
    const manifest = deriveIntegrityDomain(root);
    expect(manifest.domain_files).toContain('scripts/ai-native/fr10-aliased-required.ts');
    const before = deriveIntegrityDomain(root).configuration_file_hashes.find(
      (row) => row.path === 'scripts/ai-native/fr10-aliased-required.ts',
    )?.sha256;
    writeFileSync(required, "export const fr10AliasedRequired = 'after';\n");
    expect(() => computeScannerConfigurationFingerprint(root)).toThrow(/generated artifact is stale/);
    refreshGenerated(root);
    const after = deriveIntegrityDomain(root).configuration_file_hashes.find(
      (row) => row.path === 'scripts/ai-native/fr10-aliased-required.ts',
    )?.sha256;
    expect(after).not.toBe(before);
  });

  it('rejects a non-static call through an equivalent loader alias chain', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(
      importer,
      `const firstAlias = module['require'];\nconst secondAlias = firstAlias;\nconst target = './control-id.ts';\nsecondAlias(target);\n${readFileSync(importer, 'utf8')}`,
    );
    expect(() => deriveIntegrityDomain(root)).toThrow(/non-static require is forbidden/);
  });

  it('rejects a statically indeterminate loader alias instead of ignoring it', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(
      importer,
      `declare const chooseLoader: boolean;\nconst maybeLoader = chooseLoader ? require : console.log;\nmaybeLoader('./control-id.ts');\n${readFileSync(importer, 'utf8')}`,
    );
    expect(() => deriveIntegrityDomain(root)).toThrow(/statically indeterminate loader alias is forbidden/);
  });

  it('rejects non-static require instead of silently shrinking the value closure', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(importer, `const target = './control-id.ts';\nrequire(target);\n${readFileSync(importer, 'utf8')}`);
    expect(() => deriveIntegrityDomain(root)).toThrow(/non-static require is forbidden/);
  });

  it('ignores filename-looking log text unless the resource is explicitly registered', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    const unregistered = join(root, 'scripts/ai-native/fr9-log.json');
    writeFileSync(unregistered, '{"value":"before"}\n');
    writeFileSync(importer, `${readFileSync(importer, 'utf8')}\nconst logMessage = 'fr9-log.json';\nvoid logMessage;\n`);
    refreshGenerated(root);
    expect(deriveIntegrityDomain(root).domain_files).not.toContain('scripts/ai-native/fr9-log.json');
    const before = computeScannerConfigurationFingerprint(root).bound_sha256;
    writeFileSync(unregistered, '{"value":"after"}\n');
    expect(computeScannerConfigurationFingerprint(root).bound_sha256).toBe(before);
  });

  it('keeps generated outputs out of config self-reference while preserving their independent anchor', () => {
    const root = fixtureRoot();
    refreshGenerated(root);
    const configBefore = computeScannerConfigurationFingerprint(root).bound_sha256;
    const evidenceBefore = computeEvidenceManifestSetFingerprint(root).bound_sha256;
    const report = join(root, 'scripts/ai-native/runtime-snapshot-reports/main.formal.json');
    writeFileSync(report, `${readFileSync(report, 'utf8')} `);
    const manifest = join(root, 'scripts/ai-native/evidence-manifests-v1/role.create.json');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')} `);
    expect(computeScannerConfigurationFingerprint(root).bound_sha256).toBe(configBefore);
    expect(computeEvidenceManifestSetFingerprint(root).bound_sha256).not.toBe(evidenceBefore);
  });

  it('rejects an unregistered cross-package value import edge', () => {
    const root = fixtureRoot();
    const importer = join(root, 'scripts/ai-native/evidence-file.ts');
    writeFileSync(importer, `import { createForgeaxApp } from '../../packages/orchestrator/src/app.ts';\n${readFileSync(importer, 'utf8')}\nvoid createForgeaxApp;\n`);
    expect(() => deriveIntegrityDomain(root)).toThrow(/unregistered cross-package value import/);
  });

  it('keeps product-tree fingerprint ordering independent of locale and ICU tables', () => {
    const source = readFileSync(resolve(import.meta.dir, 'product-tree-fingerprint.ts'), 'utf8');
    expect(source).not.toContain('localeCompare');
    expect(source).toContain('codePointCompare');
  });
});
