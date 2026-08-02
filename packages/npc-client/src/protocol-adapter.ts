import {
  NPC_PROTOCOL_VERSION,
  parseNpcDecisionWire,
  parseNpcSessionResponse,
  parseNpcWireEnvelope,
  parsePerceptionSnapshot,
  type Affordance,
  type NpcDecisionWire,
  type NpcWireEnvelope,
  type PerceptionSnapshot,
} from '@forgeax/types';

export type { Affordance, NpcDecisionWire, NpcWireEnvelope, PerceptionSnapshot };

/** Keeps the transport independent from additions to the shared contract. */
export const npcProtocol = {
  version: NPC_PROTOCOL_VERSION,
  decision: parseNpcDecisionWire,
  envelope: parseNpcWireEnvelope,
  sessionResponse: parseNpcSessionResponse,
  snapshot: parsePerceptionSnapshot,
};

export function snapshotDedupeKey(snapshot: PerceptionSnapshot): string {
  return [snapshot.game, snapshot.playerId ?? '-', snapshot.npcId, snapshot.eventId].join('');
}

export function withDecisionFeedback(
  snapshot: PerceptionSnapshot,
  decision: NpcDecisionWire | undefined,
): PerceptionSnapshot {
  if (!decision?.emotion) return snapshot;
  const towards = Object.entries(decision.emotion.towards ?? {}).map(
    ([target, value]) => `emotion:${target}:${value}`,
  );
  return npcProtocol.snapshot({
    ...snapshot,
    self: { ...snapshot.self, mood: decision.emotion.mood },
    recentEvents: [...(snapshot.recentEvents ?? []), ...towards].slice(-24),
  });
}
