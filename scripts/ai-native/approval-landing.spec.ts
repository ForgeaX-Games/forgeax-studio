import { describe, expect, test } from 'bun:test';
import {
  approvalLandingCommands,
  assertBaseMainMatchesAnchor,
  executeApprovalLandingStage,
  type ApprovalLandingStage,
} from './land-phase2-approval.ts';

describe('Phase 2 approved receipt landing pipeline', () => {
  test('orders anchor, runtime evidence, coverage projections, documents, then checks', () => {
    const stages: ApprovalLandingStage[] = ['anchor', 'runtime', 'coverage', 'documents', 'check'];
    const commands = stages.flatMap((stage) => approvalLandingCommands(stage, 'a'.repeat(40)));
    const rendered = commands.map((command) => command.join(' '));
    expect(rendered[0]).toContain('build-runtime-pin.ts');
    expect(rendered.findIndex((command) => command.includes('--mode formal'))).toBeGreaterThan(0);
    expect(rendered.findIndex((command) => command.includes('calculate-r6-coverage.ts'))).toBeGreaterThan(
      rendered.findIndex((command) => command.includes('--mode formal')),
    );
    expect(rendered.findIndex((command) => command.includes('generate-phase2-approval-docs.ts'))).toBeGreaterThan(
      rendered.findIndex((command) => command.includes('calculate-r6-coverage.ts')),
    );
    expect(rendered.at(-1)).toContain('test:approval-manifest');

    const executed: string[] = [];
    let cleanChecks = 0;
    for (const stage of stages) {
      executeApprovalLandingStage(stage, approvalLandingCommands(stage, 'a'.repeat(40)), {
        approvalStatus: () => 'approved',
        assertClean: () => { cleanChecks += 1; },
        run: (command) => {
          executed.push(command.join(' '));
          return 0;
        },
      });
    }
    expect(executed).toEqual(rendered);
    expect(cleanChecks).toBe(5);
  });

  test('contains no git write command and requires an explicit base for anchor-bearing stages', () => {
    const all = (['anchor', 'runtime', 'coverage', 'documents', 'check'] as const)
      .flatMap((stage) => approvalLandingCommands(stage, 'a'.repeat(40)))
      .flat();
    expect(all).not.toContain('commit');
    expect(all).not.toContain('add');
    expect(all).not.toContain('push');
    expect(() => approvalLandingCommands('anchor')).toThrow('--base-main is required');
    expect(() => approvalLandingCommands('runtime')).toThrow('--base-main is required');
    expect(all.join(' ')).not.toContain('/tmp/r6-coverage');
    expect(all.join(' ')).toContain('{isolated-temp-dir}/r6-coverage.json');
    expect(() => assertBaseMainMatchesAnchor('b'.repeat(40), 'a'.repeat(40))).toThrow(
      '--base-main does not match the recorded runtime anchor',
    );
    expect(() => assertBaseMainMatchesAnchor('short', 'a'.repeat(40))).toThrow(
      '--base-main must be a full lowercase commit SHA',
    );
    expect(() => executeApprovalLandingStage('anchor', [['bun', '--version']], {
      approvalStatus: () => 'pending',
      assertClean: () => {},
      run: () => 0,
    })).toThrow('approval landing execution requires an already recorded approved receipt');
    expect(() => executeApprovalLandingStage('check', [['bun', 'failing-command']], {
      approvalStatus: () => 'approved',
      assertClean: () => {},
      run: () => 9,
    })).toThrow('stage check failed: bun failing-command');
  });
});
