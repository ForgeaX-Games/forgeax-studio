/**
 * Session shape that drivers consume. Mirrors the BootContext fields
 * the existing `cli daemon` already passes around (instanceId, thread,
 * cwd, persona, defaultSkills) but nails them down as a versioned
 * contract so the four cli-providers can interoperate.
 */
import type { AgentDefinition, SkillRef } from '@forgeax/types';

export interface SessionThread {
  id: string;
  cwd: string;
}

export interface SessionAgent {
  id: string;
  definition: AgentDefinition;
  /** Pre-rendered system prompt (persona md + prompt-skill blocks),
   *  produced by `composeSystemPrompt()` in `packages/server/src/agents/loader.ts`. */
  systemPrompt: string;
  /** Skill refs the driver may want to surface as slash-commands or
   *  pre-load into context. Empty when the agent declares no defaults. */
  defaultSkills: SkillRef[];
}

export interface Session {
  /** Stable id per chat instance (ledger pk). */
  instanceId: string;
  thread: SessionThread;
  agent: SessionAgent;
  /** Optional workbench context — present when the chat originates from
   *  a workbench tab (sidebar / mainarea iframe). Drivers may use this
   *  to scope tool permissions / surface dispatch routes. */
  workbench?: { id: string };
  /** Free-form bag of warnings that surfaced during boot — drivers may
   *  forward to the UI but must not gate on them. */
  warnings?: string[];
}
