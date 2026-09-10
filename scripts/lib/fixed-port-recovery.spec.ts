import { describe, expect, it } from 'bun:test';
import {
  fixedHeavyPorts,
  isGeneratedSampleAnchor,
  planFixedPortRecovery,
  type FixedPortOccupant,
} from './fixed-port-recovery.ts';

const PREFIXES = ['studio-qa-sample-'];

function occupant(partial: Partial<FixedPortOccupant> & { pid: number; port: number }): FixedPortOccupant {
  return { commandLine: null, cwdLink: null, ...partial };
}

describe('fixedHeavyPorts', () => {
  it('covers server/interface/engine triples across all five slots', () => {
    const ports = fixedHeavyPorts();
    expect(ports).toHaveLength(15);
    // Slot 0 and slot 2 (the :38900 slot that failed in run 32273979585).
    expect(ports).toContain(18900);
    expect(ports).toContain(18920);
    expect(ports).toContain(15173);
    expect(ports).toContain(38900);
    expect(ports).toContain(38920);
    expect(ports).toContain(35173);
    // Slot 4 upper bound.
    expect(ports).toContain(58900);
  });
});

describe('isGeneratedSampleAnchor', () => {
  it('matches a live sample workspace cwd', () => {
    expect(isGeneratedSampleAnchor('/tmp/studio-qa-sample-WLVrU4', PREFIXES)).toBe(true);
  });

  it('matches a DELETED sample workspace cwd (realpath cannot, raw readlink can)', () => {
    expect(isGeneratedSampleAnchor('/tmp/studio-qa-sample-WLVrU4 (deleted)', PREFIXES)).toBe(true);
  });

  it('matches an absolute command-line path under the sample workspace', () => {
    expect(
      isGeneratedSampleAnchor('bun /tmp/studio-qa-sample-abc/packages/server/src/main.ts', PREFIXES),
    ).toBe(true);
  });

  it('does not match an unrelated /tmp path or a real checkout', () => {
    expect(isGeneratedSampleAnchor('/tmp/other-thing', PREFIXES)).toBe(false);
    expect(isGeneratedSampleAnchor('/home/you/actions-runner/_work/forgeax-studio', PREFIXES)).toBe(false);
    expect(isGeneratedSampleAnchor(null, PREFIXES)).toBe(false);
  });
});

describe('planFixedPortRecovery', () => {
  it('kills a leftover server whose environ never exposed the port (the regression)', () => {
    // Root cause of run 32273979585: a server bound :38900 but the environ scan
    // could not classify it. Port-anchored, its cwd proves it is ours.
    const plan = planFixedPortRecovery(
      [occupant({ pid: 1087113, port: 38900, commandLine: 'bun run start', cwdLink: '/tmp/studio-qa-sample-old (deleted)' })],
      { samplePrefixes: PREFIXES },
    );
    expect(plan.kill.map((o) => o.pid)).toEqual([1087113]);
    expect(plan.skip).toHaveLength(0);
  });

  it('kills a leftover engine vite anchored to the sample workspace', () => {
    const plan = planFixedPortRecovery(
      [occupant({ pid: 222, port: 35173, commandLine: 'vite', cwdLink: '/tmp/studio-qa-sample-xyz/packages/editor/packages/play-runtime' })],
      { samplePrefixes: PREFIXES },
    );
    expect(plan.kill.map((o) => o.pid)).toEqual([222]);
  });

  it('NEVER kills an unrelated process holding a fixed port', () => {
    const plan = planFixedPortRecovery(
      [occupant({ pid: 999, port: 18900, commandLine: 'node /home/you/app/server.js', cwdLink: '/home/you/app' })],
      { samplePrefixes: PREFIXES },
    );
    expect(plan.kill).toHaveLength(0);
    expect(plan.skip.map((s) => s.occupant.pid)).toEqual([999]);
    expect(plan.skip[0]?.reason).toContain('not anchored');
  });

  it('never kills the recovery process or its ancestors even if path-anchored', () => {
    const plan = planFixedPortRecovery(
      [occupant({ pid: 42, port: 28900, commandLine: 'bun scripts/fx.ts recover-fixed-ports', cwdLink: '/tmp/studio-qa-sample-self' })],
      { samplePrefixes: PREFIXES, protectedPids: new Set([42]) },
    );
    expect(plan.kill).toHaveLength(0);
    expect(plan.skip[0]?.reason).toContain('protected');
  });

  it('partitions a mixed fixed-port scan into kill vs skip', () => {
    const plan = planFixedPortRecovery(
      [
        occupant({ pid: 1, port: 38900, cwdLink: '/tmp/studio-qa-sample-a' }),
        occupant({ pid: 2, port: 18900, cwdLink: '/home/you/checkout' }),
        occupant({ pid: 3, port: 35173, commandLine: 'bun /tmp/studio-qa-sample-b/scripts/run.ts' }),
      ],
      { samplePrefixes: PREFIXES },
    );
    expect(plan.kill.map((o) => o.pid).sort()).toEqual([1, 3]);
    expect(plan.skip.map((s) => s.occupant.pid)).toEqual([2]);
  });
});
