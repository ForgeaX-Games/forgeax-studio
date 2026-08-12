import { ciFailureRecovery, type CiManifest } from './ci-contract.ts';
import type { LiveRulesetResult } from './ci-ruleset.ts';

export type LocalStaticStatus = 'aligned' | 'non-ready';
export type ExternalRulesetStatus = 'aligned' | 'misaligned' | 'unverified' | 'not-checked';

export type CiStatusProjection = {
  operation: 'status';
  scope: 'ci';
  status: 'ready' | 'non-ready' | 'unverified';
  exitCode: 0 | 3;
  localStatic: LocalStaticStatus;
  externalRuleset: ExternalRulesetStatus;
  overall: 'ready' | 'non-ready';
  expectedContexts: string[];
  code: string;
  hint: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  recoveryActions: Array<{ actionId: string; argv?: string[]; manualHandoff?: string }>;
};

export function reduceCiStatus(localStatic: LocalStaticStatus, externalRuleset: ExternalRulesetStatus, manifest: CiManifest): CiStatusProjection {
  const ready = localStatic === 'aligned' && externalRuleset === 'aligned';
  const code = ready
    ? 'recursive-input.ci.ready'
    : localStatic !== 'aligned'
      ? 'recursive-input.ci.local-static-non-ready'
      : externalRuleset === 'not-checked'
        ? 'recursive-input.ci.live-ruleset-not-checked'
        : externalRuleset === 'unverified'
          ? 'recursive-input.ci.live-ruleset-unverified'
          : 'recursive-input.ci.live-ruleset-misaligned';
  const hint = ready
    ? 'Local CI contract and the current live governance observation are aligned.'
    : localStatic !== 'aligned'
      ? 'Validate the canonical CI contract and every manifest-derived direct consumer before source work.'
      : externalRuleset === 'not-checked'
        ? 'Run the fresh read-only live ruleset probe; local alignment cannot prove external governance.'
        : externalRuleset === 'unverified'
          ? 'The live governance response is unavailable or incomplete; do not infer alignment.'
          : 'The fresh live governance response differs from the canonical expectation; review it without mutating policy.';
  const recoveryActions = ready
    ? []
    : [
        ...(localStatic === 'aligned' ? [] : ciFailureRecovery('manifest-invalid')),
        ...(externalRuleset === 'aligned' || externalRuleset === 'not-checked' ? [] : ciFailureRecovery('live-ruleset')),
        ...(externalRuleset === 'not-checked' ? [{ actionId: 'probe-live-ruleset-read', argv: ['bun', 'fx', 'recursive-inputs', 'status', '--scope', 'ci', '--live-ruleset'] }] : []),
      ];
  return {
    operation: 'status',
    scope: 'ci',
    status: ready ? 'ready' : externalRuleset === 'unverified' ? 'unverified' : 'non-ready',
    exitCode: ready ? 0 : 3,
    localStatic,
    externalRuleset,
    overall: ready ? 'ready' : 'non-ready',
    expectedContexts: manifest.requiredContexts.map((context) => context.name),
    code,
    hint,
    expected: {
      localStatic: 'aligned',
      externalRuleset: 'aligned',
      contexts: manifest.requiredContexts.map((context) => context.name),
      enforcement: manifest.governance.enforcement,
      bypassActors: manifest.governance.bypassActors,
      currentUserCanBypass: manifest.governance.currentUserCanBypass,
    },
    actual: { localStatic, externalRuleset },
    recoveryActions,
  };
}

export function projectLiveRulesetStatus(result: LiveRulesetResult): ExternalRulesetStatus {
  return result.status;
}
