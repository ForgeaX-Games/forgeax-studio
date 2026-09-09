/**
 * The two asset-generation MCP tools: `forgeax_generate_image` and `forgeax_generate_3d`.
 *
 * These are the only generation ops that belong in the dev loop — a game author asks
 * for a sprite or a prop mid-session and expects it to land in the project. Everything
 * else (listing models, tuning gateway config) is one-time and stays out of the tool
 * list, matching the "surface deliberately tiny" rule the rest of the server follows.
 *
 * Both tools write the asset to `<game>/assets/` and return the project-relative path.
 * We save server-side rather than returning bytes because the returned URLs are signed
 * and expire, and because the host Agent's next move is to reference the file from game
 * code — a path is what it needs, not a base64 blob in the transcript.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { resolveLiteLlmConfig } from './config';
import { resolveCosConfig, uploadAndPresign } from './cos';
import { editImage, generate3dFromImageUrl, generate3dFromText, generateImage } from './litellm';
import { activeGame, gameDir, listGames, resolveProject } from '../project/locate';

/** Where a generated asset for `slug` should be written, created on demand. */
function assetsDirFor(cwd: string, explicitGame?: string): { dir: string; root: string; slug: string } {
  const binding = resolveProject(cwd);
  if (!binding.root) {
    throw new Error(
      `No ForgeaX project found from ${binding.searchedFrom}. Run \`forgeax-game init --game <slug>\` in the workspace first, or pass \`game\`/\`target_dir\`.`,
    );
  }
  const slug = explicitGame?.trim() || activeGame(binding.root);
  if (!slug) {
    const games = listGames(binding.root);
    throw new Error(
      `No active game to save the asset into.${games.length ? ` Pass one of: ${games.join(', ')}` : ' Create one with `forgeax-game init --game <slug>`.'}`,
    );
  }
  const dir = gameDir(binding.root, slug);
  if (!dir) throw new Error(`Game ${JSON.stringify(slug)} not found in this project.`);
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  return { dir: assets, root: binding.root, slug };
}

/** Turn a caller-supplied name (or a prompt) into a safe, lowercase file stem. */
function safeStem(preferred: string | undefined, fallback: string): string {
  const source = (preferred ?? fallback).toLowerCase();
  const stem = source
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return stem || 'asset';
}

/** First free `<stem>.<ext>`, `<stem>-1.<ext>`, ... so a re-run never clobbers. */
function uniquePath(dir: string, stem: string, ext: string): string {
  let candidate = join(dir, `${stem}.${ext}`);
  for (let i = 1; existsSync(candidate); i += 1) candidate = join(dir, `${stem}-${i}.${ext}`);
  return candidate;
}

/** Progress heartbeat for long 3D jobs. stderr is safe; stdout carries the JSON-RPC. */
function logProgress(label: string): (pct: number) => void {
  let last = -1;
  return (pct) => {
    const step = Math.floor(pct / 10);
    if (step !== last) {
      last = step;
      process.stderr.write(`[forgeax] ${label}: ${pct}%\n`);
    }
  };
}

/** Input schema shared shape: which game to write into. */
const GAME_PROPERTY = {
  game: {
    type: 'string',
    description: 'Game slug to save the asset into. Defaults to the active game.',
  },
  target_dir: {
    type: 'string',
    description: 'Directory to resolve the ForgeaX project from. Defaults to the server working directory.',
  },
  name: {
    type: 'string',
    description: 'Base file name for the saved asset (without extension). Defaults to a slug of the prompt.',
  },
} as const;

export const GENERATE_IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'What to draw. Required for both text-to-image and editing an input image.' },
    image: {
      type: 'string',
      description: 'Optional local image path to edit (image-to-image). When set, the prompt describes the desired change.',
    },
    model: { type: 'string', description: 'Override the image model. Defaults to the configured text-to-image model.' },
    ...GAME_PROPERTY,
  },
  required: ['prompt'],
  additionalProperties: false,
} as const;

export const GENERATE_3D_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Text description for text-to-3D. Provide this or `image`.' },
    image: {
      type: 'string',
      description:
        'Image for image-to-3D: a public https URL, or a local file path when COS is configured (FORGEAX_COS_*) — local files are uploaded to COS and passed as a short-lived presigned URL. Without COS, only a public URL works.',
    },
    model: { type: 'string', description: 'Override the 3D model. Defaults to the configured text/image-to-3D model.' },
    ...GAME_PROPERTY,
  },
  additionalProperties: false,
} as const;

const HTTP_URL_RE = /^https?:\/\//i;

/** `forgeax_generate_image` handler: text-to-image, or image-to-image when `image` is set. */
export async function generateImageTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) throw new Error('`prompt` is required.');
  const cfg = resolveLiteLlmConfig();
  const targetDir = typeof args.target_dir === 'string' ? args.target_dir : cwd;
  const { dir, root, slug } = assetsDirFor(targetDir, typeof args.game === 'string' ? args.game : undefined);
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.models.textToImage;

  let result;
  let mode: string;
  const inputImage = typeof args.image === 'string' ? args.image.trim() : '';
  if (inputImage) {
    if (HTTP_URL_RE.test(inputImage)) {
      throw new Error('Image-to-image expects a LOCAL image path, not a URL. Download it first, then pass the path.');
    }
    if (!existsSync(inputImage)) throw new Error(`Input image not found: ${inputImage}`);
    const bytes = new Uint8Array(readFileSync(inputImage));
    result = await editImage(cfg, { model, prompt, image: bytes, filename: basename(inputImage) });
    mode = 'image-to-image';
  } else {
    result = await generateImage(cfg, { model, prompt });
    mode = 'text-to-image';
  }

  const stem = safeStem(typeof args.name === 'string' ? args.name : undefined, prompt);
  const outPath = uniquePath(dir, stem, result.ext);
  writeFileSync(outPath, result.bytes);
  const rel = relative(root, outPath);
  return `Saved ${mode} asset to \`${rel}\` (game: ${slug}, model: ${model}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}

/** Content type for an image path, so COS serves it back with a sane header. */
function imageContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/**
 * Resolve the caller's `image` into a URL the 3D backend can fetch. A public https URL
 * passes through; a local file is uploaded to COS and returned as a presigned URL.
 * Without COS configured, a local path is a clear, actionable error.
 */
async function resolveImageUrlFor3d(image: string, slug: string): Promise<string> {
  if (HTTP_URL_RE.test(image)) return image;
  if (!existsSync(image)) throw new Error(`Input image not found: ${image}`);
  const cos = resolveCosConfig();
  if (!cos) {
    throw new Error(
      'Image-to-3D from a local file needs COS configured (FORGEAX_COS_BUCKET/REGION/SECRET_ID/SECRET_KEY) so the image can be hosted for the backend to fetch. Alternatively pass a public https URL.',
    );
  }
  const bytes = new Uint8Array(readFileSync(image));
  const stem = safeStem(basename(image, extname(image)), 'input');
  const ext = (extname(image).replace('.', '') || 'png').toLowerCase();
  const key = `forgeax/${slug}/${stem}-${Date.now()}.${ext}`;
  return uploadAndPresign(cos, key, bytes, imageContentType(image));
}

/** `forgeax_generate_3d` handler: text-to-3D, or image-to-3D (public URL or local file via COS). */
export async function generate3dTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  const image = typeof args.image === 'string' ? args.image.trim() : '';
  if (!prompt && !image) throw new Error('Provide `prompt` (text-to-3D) or `image` (image-to-3D).');
  const cfg = resolveLiteLlmConfig();
  const targetDir = typeof args.target_dir === 'string' ? args.target_dir : cwd;
  const { dir, root, slug } = assetsDirFor(targetDir, typeof args.game === 'string' ? args.game : undefined);

  let result;
  let mode: string;
  if (image) {
    const imageUrl = await resolveImageUrlFor3d(image, slug);
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.models.imageTo3d;
    result = await generate3dFromImageUrl(cfg, { model, imageUrl, prompt: prompt || undefined, onProgress: logProgress('image-to-3D') });
    mode = 'image-to-3D';
  } else {
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.models.textTo3d;
    result = await generate3dFromText(cfg, { model, prompt, onProgress: logProgress('text-to-3D') });
    mode = 'text-to-3D';
  }

  const stem = safeStem(typeof args.name === 'string' ? args.name : undefined, prompt || 'model');
  const outPath = uniquePath(dir, stem, result.ext);
  writeFileSync(outPath, result.bytes);
  const rel = relative(root, outPath);
  return `Saved ${mode} ${result.assetType} to \`${rel}\` (game: ${slug}, ${result.bytes.length} bytes). Reference it from game code by this path.`;
}
