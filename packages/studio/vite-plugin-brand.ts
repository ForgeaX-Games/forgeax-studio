/**
 * vite-plugin-brand — inject the active brand pack into index.html.
 *
 * Behaviour:
 *   1. Resolve the brand pack at vite startup using the same algorithm as
 *      `packages/server/src/brand/loader.ts` (env → symlink → 'forgeax').
 *   2. Replace `%BRAND_PRODUCT_NAME%`, `%BRAND_SPLASH_TITLE%`,
 *      `%BRAND_SPLASH_SUBTITLE%`, `%BRAND_ID%`, `%BRAND_ASSISTANT_NAME%`
 *      placeholders in index.html with literal strings.
 *   3. Inject an inline `<script>window.__BRAND__ = {...}</script>` block as
 *      the very first child of `<head>` so module code (boot driver, store)
 *      can call `getBrandSync()` synchronously.
 *   4. Serve the brand pack's `assets/` directory at `/brand/assets/` via
 *      configureServer middleware (dev) and copy it into the build output
 *      under `brand/assets/` (production).
 *
 * The plugin is intentionally local to this package — it has no upstream
 * vite plugin to depend on, and the rebrand plan calls it out as a Phase 1
 * deliverable.
 */

import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig } from 'vite';

const BRAND_SCHEMA_VERSION = 1 as const;
const DEFAULT_BRAND_ID = 'forgeax';

interface BrandConfig {
  id: string;
  schemaVersion: typeof BRAND_SCHEMA_VERSION;
  product: { name: string; shortName: string; tagline: string };
  assistant: { name: string; avatarSrc?: string | null; cardName?: { zh?: string; en?: string } };
  splash: { title: string; subtitle: string; theme: 'classic-lime' | 'neon-pulse' };
  providers: { native: { id: string; label: string; title: string } };
  links: { repoUrl: string; communityUrl: string; docsUrl?: string | null; issuesUrl?: string | null };
  assets?: { favicon?: string | null; logo?: string | null; appleTouchIcon?: string | null };
}

type BrandSource =
  | { kind: 'env'; name: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'default' }
  | { kind: 'override-dir'; dir: string };

interface BrandResolution {
  config: BrandConfig;
  source: BrandSource;
  packDir: string;
  manifestPath: string;
  brandRoot: string;
}

function locateBrandRoot(packageDir: string): string {
  const override = process.env.FORGEAX_BRAND_DIR;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`[brand] FORGEAX_BRAND_DIR points to non-existent path: ${override}`);
    }
    return resolve(override);
  }
  const candidates = [
    resolve(packageDir, '..', '..', 'brand'),  // packages/interface → repo root → brand
    resolve(packageDir, '..', 'brand'),
    resolve(process.cwd(), 'brand'),
    resolve(process.cwd(), '..', 'brand'),
    resolve(process.cwd(), '..', '..', 'brand'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'defaults.forgeax.json'))) return dir;
  }
  throw new Error(`[brand] brand/ directory not found. Tried: ${candidates.join(', ')}`);
}

function pickBrandId(brandRoot: string): { id: string; source: BrandSource } {
  const fromEnv = process.env.FORGEAX_BRAND?.trim();
  if (fromEnv) return { id: fromEnv, source: { kind: 'env', name: 'FORGEAX_BRAND' } };
  const activeLink = join(brandRoot, 'active');
  if (existsSync(activeLink)) {
    try {
      const st = lstatSync(activeLink);
      const target = st.isSymbolicLink() ? readlinkSync(activeLink) : basename(activeLink);
      const match = /^(?:defaults\.)?([a-z][a-z0-9-]{1,31})$/.exec(basename(target));
      if (match) return { id: match[1], source: { kind: 'symlink', target } };
    } catch {
      /* fall through */
    }
  }
  return { id: DEFAULT_BRAND_ID, source: { kind: 'default' } };
}

function loadBrand(packageDir: string): BrandResolution {
  const brandRoot = locateBrandRoot(packageDir);
  const { id, source } = pickBrandId(brandRoot);
  const manifestPath = join(brandRoot, `defaults.${id}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`[brand] manifest not found: ${manifestPath}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrandConfig;
  if (raw.schemaVersion !== BRAND_SCHEMA_VERSION) {
    throw new Error(`[brand] schemaVersion mismatch: expected ${BRAND_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`);
  }
  if (raw.id !== id) {
    throw new Error(`[brand] manifest id "${raw.id}" does not match pack id "${id}"`);
  }
  const packDir = join(brandRoot, `defaults.${id}`);
  const finalSource: BrandSource = process.env.FORGEAX_BRAND_DIR
    ? { kind: 'override-dir', dir: process.env.FORGEAX_BRAND_DIR }
    : source;
  return { config: raw, source: finalSource, packDir, manifestPath, brandRoot };
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function escapeJsonForHtml(json: string): string {
  // Defend against the inline `<script>` tag containing `</script>` or HTML
  // comment delimiters in any string field.
  return json.replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
}

function buildInjection(resolution: BrandResolution): string {
  const runtime = {
    config: resolution.config,
    source: resolution.source,
    assetBaseUrl: '/brand/assets/',
  };
  const json = escapeJsonForHtml(JSON.stringify(runtime));
  return `<script>window.__BRAND__=${json};</script>`;
}

function applyPlaceholders(html: string, brand: BrandConfig): string {
  const subs: Record<string, string> = {
    BRAND_PRODUCT_NAME: brand.product.name,
    BRAND_PRODUCT_SHORTNAME: brand.product.shortName,
    BRAND_ID: brand.id,
    BRAND_SPLASH_TITLE: brand.splash.title,
    BRAND_SPLASH_SUBTITLE: brand.splash.subtitle,
    BRAND_SPLASH_THEME: brand.splash.theme,
    BRAND_ASSISTANT_NAME: brand.assistant.name,
    BRAND_REPO_URL: brand.links.repoUrl,
    BRAND_COMMUNITY_URL: brand.links.communityUrl,
  };
  return html.replace(/%([A-Z_][A-Z0-9_]*)%/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : m;
  });
}

export interface BrandPluginOptions {
  /** Absolute path to the interface package root (where vite.config.ts lives). */
  packageDir: string;
}

export function vitePluginBrand({ packageDir }: BrandPluginOptions): Plugin {
  let resolution: BrandResolution | null = null;
  let resolvedConfig: ResolvedConfig | null = null;

  function ensureLoaded(): BrandResolution {
    if (!resolution) {
      resolution = loadBrand(packageDir);
    }
    return resolution;
  }

  return {
    name: 'forgeax:brand',
    enforce: 'pre',

    configResolved(config) {
      resolvedConfig = config;
      const r = ensureLoaded();
      const logger = config.logger ?? console;
      logger.info(`[brand] pack "${r.config.id}" via ${r.source.kind} · ${r.config.product.name}`);
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const r = ensureLoaded();
        const withPlaceholders = applyPlaceholders(html, r.config);
        const inject = buildInjection(r);
        // Inject right after the opening <head> so window.__BRAND__ exists
        // before any inline bootstrap script runs.
        if (withPlaceholders.includes('<head>')) {
          return withPlaceholders.replace('<head>', `<head>\n  ${inject}`);
        }
        return withPlaceholders.replace(/<head([^>]*)>/i, (m) => `${m}\n  ${inject}`);
      },
    },

    configureServer(server) {
      const r = ensureLoaded();
      const assetDir = join(r.packDir, 'assets');
      server.middlewares.use('/brand/assets', (req, res, next) => {
        if (!req.url) return next();
        const rel = decodeURIComponent(req.url.split('?')[0]);
        const target = normalize(join(assetDir, rel));
        if (!target.startsWith(assetDir)) {
          res.statusCode = 400;
          res.end('bad path');
          return;
        }
        if (!existsSync(target)) {
          return next();
        }
        const st = statSync(target);
        if (st.isDirectory()) return next();
        const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
        res.setHeader('content-type', mime);
        res.setHeader('content-length', String(st.size));
        res.setHeader('cache-control', 'public, max-age=300');
        res.end(readFileSync(target));
      });
    },

    async generateBundle() {
      if (!resolvedConfig || resolvedConfig.command !== 'build') return;
      const r = ensureLoaded();
      const assetDir = join(r.packDir, 'assets');
      if (!existsSync(assetDir)) return;
      const walk = (dir: string, prefix: string): string[] => {
        const entries = readdirSync(dir, { withFileTypes: true });
        const out: string[] = [];
        for (const e of entries) {
          const full = join(dir, e.name);
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) out.push(...walk(full, rel));
          else if (e.isFile()) out.push(rel);
        }
        return out;
      };
      for (const rel of walk(assetDir, '')) {
        const abs = join(assetDir, rel);
        this.emitFile({
          type: 'asset',
          fileName: `brand/assets/${rel}`,
          source: readFileSync(abs),
        });
      }
    },
  };
}

// Helper for callers that want to know where the plugin found its pack.
export function __probeBrand(packageDir: string): BrandResolution {
  return loadBrand(packageDir);
}

// Vite's plugin loader prefers `default` exports for some setups.
export default vitePluginBrand;
