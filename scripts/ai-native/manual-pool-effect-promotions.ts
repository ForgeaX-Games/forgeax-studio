import { z } from 'zod';

export interface ManualPoolEffectPromotion {
  effect_id: string;
  disposition: 'tool' | 'read';
  domain: string;
  source_control_ids: string[];
}

export interface ManualPoolEffectPromotionRegistry {
  schema_version: 1;
  promotions: ManualPoolEffectPromotion[];
}

const effectId = z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/);
const controlId = z.string().regex(/^ctl_[0-9a-f]{24}$/);
const promotionRegistrySchema = z.object({
  schema_version: z.literal(1),
  promotions: z.array(z.object({
    effect_id: effectId,
    disposition: z.enum(['tool', 'read'], {
      message: 'disposition must be one of: tool, read',
    }),
    domain: z.string().regex(/^[a-z0-9_]+$/),
    source_control_ids: z.array(controlId).min(1),
  }).strict()),
}).strict();

export function parseManualPoolEffectPromotionRegistry(
  value: unknown,
): ManualPoolEffectPromotionRegistry {
  const parsed = promotionRegistrySchema.safeParse(value);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => (
      `${issue.path.join('.') || '<registry>'}: ${issue.message}`
    ));
    throw new Error(`invalid manual-pool effect promotion registry: ${reasons.join('; ')}`);
  }
  return parsed.data;
}
