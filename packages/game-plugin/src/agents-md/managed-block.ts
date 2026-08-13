/**
 * The `AGENTS.md` managed block.
 *
 * Routing rules have to live where the host CLI already looks, which is the project's
 * `AGENTS.md` / `CLAUDE.md`. The block is delimited and content-hashed so the plugin
 * can rewrite exactly its own region and leave everything the user wrote untouched —
 * the alternative, owning the whole file, makes the plugin and the user fight over it.
 *
 * All functions here are pure string transforms; the caller does the IO.
 */
import { createHash } from 'node:crypto';

/** Bump when the block's *shape* changes in a way older readers cannot handle. */
export const BLOCK_VERSION = 1;

const BEGIN = '<!-- BEGIN FORGEAX GAME PLUGIN';
const END = '<!-- END FORGEAX GAME PLUGIN -->';

/** Match a whole managed block and capture its declared version and body hash. */
const BLOCK_RE =
  /<!-- BEGIN FORGEAX GAME PLUGIN \(v(\d+) sha256:([0-9a-f]{12})\) -->\n([\s\S]*?)\n<!-- END FORGEAX GAME PLUGIN -->/;

export type BlockStatus = 'missing_file' | 'missing_block' | 'outdated' | 'current';

export interface BlockState {
  readonly status: BlockStatus;
  /** Version recorded in the file, when a block was found. */
  readonly foundVersion?: number;
  readonly expectedVersion: number;
}

/** Short content fingerprint. Twelve hex chars is plenty to detect drift. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/** Render the delimited block for a given body. */
export function renderBlock(body: string): string {
  const trimmed = body.trim();
  return `${BEGIN} (v${BLOCK_VERSION} sha256:${bodyHash(trimmed)}) -->\n${trimmed}\n${END}`;
}

/**
 * Compare what is in the file against what this plugin version would write.
 *
 * `outdated` covers both a version bump and an edited body, because either means the
 * project is carrying stale routing rules.
 */
export function inspectBlock(fileContent: string | undefined, expectedBody: string): BlockState {
  if (fileContent === undefined) return { status: 'missing_file', expectedVersion: BLOCK_VERSION };

  const m = BLOCK_RE.exec(fileContent);
  if (!m) return { status: 'missing_block', expectedVersion: BLOCK_VERSION };

  const foundVersion = Number.parseInt(m[1]!, 10);
  const foundHash = m[2]!;
  const foundBody = m[3]!;
  const expectedHash = bodyHash(expectedBody.trim());
  const current =
    foundVersion === BLOCK_VERSION &&
    foundHash === expectedHash &&
    foundHash === bodyHash(foundBody.trim());
  return {
    status: current ? 'current' : 'outdated',
    foundVersion,
    expectedVersion: BLOCK_VERSION,
  };
}

/**
 * Insert or replace the managed block, returning the new file content.
 *
 * A missing block is appended rather than prepended: the user's own introduction
 * should stay at the top of their file.
 */
export function upsertBlock(fileContent: string | undefined, body: string): string {
  const block = renderBlock(body);
  if (fileContent === undefined || fileContent.trim() === '') return `${block}\n`;
  if (BLOCK_RE.test(fileContent)) return fileContent.replace(BLOCK_RE, block);
  return `${fileContent.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** Remove the managed block, leaving user content intact. */
export function removeBlock(fileContent: string): string {
  return fileContent.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}
