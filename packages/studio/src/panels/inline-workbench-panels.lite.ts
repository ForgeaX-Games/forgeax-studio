/**
 * Lite bundle boundary. Do not import marketplace manifests or panel source
 * here: Vite resolves this module instead of the full glob module for lite
 * builds, so those files never enter the module graph.
 */
export type InlineWorkbenchPanels = Record<string, () => import('react').ReactNode>;

export function deriveInlineWorkbenchPanels(): InlineWorkbenchPanels {
  return {};
}
