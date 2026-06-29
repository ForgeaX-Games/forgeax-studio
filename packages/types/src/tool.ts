/**
 * Tool contract — see docs/v2-vision/architecture-evolution/07-INTERFACE-EXPOSURE.md.
 *
 * Tool = a unified call entry point for human / AI / CLI flag / hotkey (Blender-spirit equivalent).
 * This file is the contract only; ToolRegistry lands in phase D1.
 */
import { z } from 'zod';
import { I18nStringSchema } from './i18n';

/**
 * args / returns are written as path strings in the manifest (pointing to schema JSON files);
 * the loader reads the file and expands them into unknown JSONSchema objects. Both forms accepted here.
 */
export const SchemaRefSchema = z.union([
  z.string().min(1), // "./schemas/foo.args.json"
  z.unknown(),       // inline JSONSchema object
]);

export const ManifestToolEntrySchema = z.object({
  id: z.string().min(1),
  args: SchemaRefSchema.optional(),
  returns: SchemaRefSchema.optional(),
  exposedToAI: z.boolean().optional(),
  /** 07 §9.5 — high-impact tool: AI caller must wait for user ack before
   *  the handler runs. Three-value enum: 'always' (every ai call), 'destructive'
   *  (irreversible side-effects), 'never' / omitted (bypass gate). Only
   *  caller.kind='ai' is gated; user/skill/workbench/cli execute transparently. */
  requireConfirm: z.enum(['always', 'destructive', 'never']).optional(),
  /** Optional human-readable summary surfaced in the confirm dialog. */
  confirmMessage: I18nStringSchema.optional(),
  description: I18nStringSchema.optional(),
});

export type ManifestToolEntry = z.infer<typeof ManifestToolEntrySchema>;

/** Normalized form used when registering with ToolRegistry (Phase D1 only) */
export interface ToolSpec {
  id: string;
  pluginId: string;
  args?: unknown;    // expanded JSONSchema
  returns?: unknown; // expanded JSONSchema
  exposedToAI: boolean;
  requireConfirm?: 'always' | 'destructive' | 'never';
  confirmMessage?: string;
  description?: string;
}

/* ----------------------------------------------------------------------------
 * ToolCall envelope — protocol between host SDK and plugin
 * --------------------------------------------------------------------------*/

export const ToolCallSchema = z.object({
  toolId: z.string().min(1),
  args: z.unknown(),
  /** Caller context — for ledger / permission decisions */
  caller: z.object({
    kind: z.enum(['user', 'ai', 'skill', 'workbench', 'cli']),
    sessionId: z.string().optional(),
    threadId: z.string().optional(),
    agentId: z.string().optional(),
  }),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
]);

export type ToolResult = z.infer<typeof ToolResultSchema>;
