import { z } from 'zod';

/**
 * 多语言字符串。manifest 里有两种形态:
 *   1) 纯字符串（最早期插件常见）
 *   2) {zh,en,ja} 三选一以上
 * 我们都接受，但下游消费时按 zh > en > ja > 任意 fallback。
 */
export const I18nStringSchema = z.union([
  z.string().min(1),
  z
    .object({
      zh: z.string().optional(),
      en: z.string().optional(),
      ja: z.string().optional(),
    })
    .refine((o) => Boolean(o.zh || o.en || o.ja), {
      message: 'i18n object must contain at least one of zh/en/ja',
    }),
]);

export type I18nString = z.infer<typeof I18nStringSchema>;

export function pickI18n(s: I18nString | undefined, lang: 'zh' | 'en' | 'ja' = 'zh'): string {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s[lang] ?? s.zh ?? s.en ?? s.ja ?? '';
}
