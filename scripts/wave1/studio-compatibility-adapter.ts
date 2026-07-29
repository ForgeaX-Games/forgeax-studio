import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = {
  manifestVersion: '1.0.0',
  adapterId: 'studio-public-adapter',
  entrypoint: 'scripts/wave1/studio-compatibility-adapter.ts',
} as const;

type SmokeStep = 'boot' | 'open' | 'catalog' | 'save' | 'play' | 'stop';
type SmokeObservation = {
  step: SmokeStep;
  outcome: 'passed' | 'failed' | 'error' | 'skipped';
  evidence: string;
  reason?: string;
};

function revision(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot resolve immutable revision for ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function createAdapter() {
  const productRevision = revision(studioRoot);
  const contractRevision = process.env.FORGEAX_CONFORMANCE_CONTRACT_REVISION ?? revision(process.cwd());
  let result: ReturnType<typeof runSmoke> | undefined;
  return {
    pin: {
      product: 'studio' as const,
      productRevision,
      contractRevision,
      adapterRevision: productRevision,
      publicManifest: manifest,
      revisionEvidence: { immutable: true, isAncestor: true },
    },
    manifest,
    smoke(step: SmokeStep): SmokeObservation {
      result ??= runSmoke();
      const observed = result.evidence.find((item) => item.step === step);
      return {
        step,
        outcome: result.ok && observed ? 'passed' : 'failed',
        evidence: observed?.detail ?? result.output,
        ...(!result.ok || !observed ? { reason: result.error ?? `smoke produced no ${step} evidence` } : {}),
      };
    },
  };
}

function runSmoke(): {
  ok: boolean;
  evidence: Array<{ step: string; detail: string }>;
  output: string;
  error?: string;
} {
  const command = spawnSync('bun', ['scripts/wave1/studio-compatibility-smoke.ts'], {
    cwd: studioRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${command.stdout ?? ''}\n${command.stderr ?? ''}`.trim();
  const match = output.match(/\{\s*"ok"[\s\S]*\}\s*$/);
  if (!match) return { ok: false, evidence: [], output, error: `smoke exited ${command.status ?? 'by signal'} without JSON evidence` };
  const parsed = JSON.parse(match[0]) as { ok: boolean; evidence?: Array<{ step: string; detail: string }>; error?: string };
  return { ok: command.status === 0 && parsed.ok, evidence: parsed.evidence ?? [], output, ...(parsed.error ? { error: parsed.error } : {}) };
}
