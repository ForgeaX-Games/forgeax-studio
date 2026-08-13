import type { ReactNode } from 'react';

/**
 * Full bundle boundary. These eager globs are deliberately isolated in a
 * profile-selected module: Vite expands import.meta.glob at compile time, so
 * putting them behind a runtime branch in editorRenderers.tsx would still
 * parse every product extension source in a lite build.
 */
export type InlineWorkbenchPanels = Record<string, () => ReactNode>;

export function deriveInlineWorkbenchPanels(): InlineWorkbenchPanels {
  // Flat `extensions/<slug>/` only — kind-bucketed
  // `extensions/<kind>/<slug>/` was rolled back; do not reintroduce nested
  // globs here.
  const manifests = import.meta.glob(
    '../../../marketplace/extensions/*/forgeax-extension.json',
    { eager: true },
  ) as Record<string, {
    id?: string;
    kind?: string;
    entry?: { frontend?: string; standalone?: unknown };
  }>;
  const panels = import.meta.glob(
    '../../../marketplace/extensions/*/src/panel.tsx',
    { eager: true },
  ) as Record<string, { default?: () => ReactNode }>;
  const map: InlineWorkbenchPanels = {};
  for (const [manifestPath, manifest] of Object.entries(manifests)) {
    if (manifest.kind !== 'workbench' || !manifest.id || manifest.entry?.standalone) continue;
    if (manifest.entry?.frontend !== './src/panel.tsx') continue;
    const panel = panels[manifestPath.replace(/forgeax-extension\.json$/, 'src/panel.tsx')];
    if (panel?.default) map[manifest.id] = panel.default;
  }
  return map;
}
