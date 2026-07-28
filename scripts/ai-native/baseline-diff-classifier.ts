export type ReasonTag = 'product' | 'scanner-config' | 'identity' | 'ownership';

export interface RootCauseSignals {
  productBytesChanged: boolean;
  scannerConfigurationChanged: boolean;
  identityAdjudicationChanged: boolean;
  ownershipAdjudicationChanged: boolean;
}

/**
 * Classify the upstream driver of a baseline-diff row.
 *
 * A single changed input domain is self-adjudicating. When several domains
 * changed in the same interval, the caller must supply the row's adjudicated
 * cause; accepting an implicit priority here would hide concurrent changes.
 */
export function classifyRootCause(
  signals: RootCauseSignals,
  adjudicatedReason?: ReasonTag,
): ReasonTag {
  const active: ReasonTag[] = [];
  if (signals.productBytesChanged) active.push('product');
  if (signals.scannerConfigurationChanged) active.push('scanner-config');
  if (signals.identityAdjudicationChanged) active.push('identity');
  if (signals.ownershipAdjudicationChanged) active.push('ownership');

  if (active.length === 0) {
    throw new Error('no root cause input changed between baselines');
  }
  if (adjudicatedReason !== undefined) {
    if (!active.includes(adjudicatedReason)) {
      throw new Error(
        `reason tag mismatch: ${adjudicatedReason} is not supported by changed causes ${active.join(',')}`,
      );
    }
    return adjudicatedReason;
  }
  if (active.length !== 1) {
    throw new Error(`ambiguous root causes: ${active.join(',')}; row adjudication is required`);
  }
  return active[0]!;
}
