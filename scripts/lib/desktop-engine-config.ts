export function rewritePackagedEngineViteConfig(source: string): string {
  return source.replace(
    /from\s+['"]\.\.\/core\/src\/asset-roots['"]/g,
    "from '@forgeax/editor-core/asset-roots'",
  ).replace(
    /from\s+['"]\.\.\/\.\.\/scripts\/vite\/engine-vite-preset['"]/g,
    "from './engine-vite-preset.mjs'",
  );
}
