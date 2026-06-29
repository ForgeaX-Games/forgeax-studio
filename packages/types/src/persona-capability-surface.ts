/**
 * Doc 01 §P3 — Persona / Capability / Surface 三体命名 (ADR-EVO-002).
 *
 * The implementation uses Agent / Skill+Tool / Workbench. P3 spelt out
 * domain-language aliases that read better in user-facing docs and
 * conversation, and we want both names to refer to the same types so a
 * future renamings (or the inverse rename) doesn't fork the type graph:
 *
 *   Persona     = Agent           — "WHO talks"
 *   Capability  = Skill ∪ Tool    — "WHAT it can do"  (+ model-binding,
 *                                                       cli-provider)
 *   Surface     = Workbench       — "WHERE you see/touch it"
 *
 * Importers may use either name. The aliases are pure type re-exports —
 * no runtime cost, no schema duplication. Schemas remain on the
 * Agent/Skill/Tool/Workbench side per P1 (SSOT).
 *
 * Why aliases instead of a hard rename:
 *   - Implementation, tests, comments, ledger events, and external blog
 *     posts already use Agent/Skill/Tool/Workbench. A hard rename costs
 *     ~hundreds of edits across host + submodules + diaries.
 *   - The names are *labels*, not different types. Aliases preserve
 *     conceptual clarity for new readers without churning everything.
 *   - When a future "Persona Marketplace" feature needs an actual distinct
 *     type (e.g. PersonaInstance with bound skills), it can extend Agent
 *     with composition rather than rename it.
 */

import type { AgentCard, AgentDefinition } from './agent';
import type { AgentManifest, SkillManifest, WorkbenchManifest } from './manifest';
import type { ToolCall, ToolResult, ManifestToolEntry } from './tool';

// ─── Persona = Agent ─────────────────────────────────────────────────────
export type Persona = AgentDefinition;
export type PersonaCard = AgentCard;
export type PersonaManifest = AgentManifest;

// ─── Capability = Skill ∪ Tool (+ binding/provider, future) ──────────────
export type SkillCapability = SkillManifest;
export type ToolCapability = ManifestToolEntry;
/** Discriminated union of capability types. Add `model-binding` /
 *  `cli-provider` variants here as those manifest kinds land. */
export type Capability =
  | { kind: 'skill'; manifest: SkillCapability }
  | { kind: 'tool'; entry: ToolCapability };

export type CapabilityCall = ToolCall;
export type CapabilityResult = ToolResult;

// ─── Surface = Workbench ─────────────────────────────────────────────────
export type Surface = WorkbenchManifest;
