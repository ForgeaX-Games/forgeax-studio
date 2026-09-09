import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { activeGame, gameDir, resolveProject, SLUG_RE } from '../project/locate';
import type { McpTool } from './protocol';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LISTED_FILES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const BLOCKED_SEGMENTS = new Set(['node_modules', '.git', '.env', '.ssh', '.npmrc']);
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.txt',
  '.glsl', '.wgsl', '.vert', '.frag', '.toml', '.yaml', '.yml',
]);

interface FileToolContext {
  readonly cwd: string;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function selectedGame(cwd: string, raw: unknown): { root: string; slug: string; dir: string } {
  const project = resolveProject(cwd);
  if (!project.root) throw new Error(`no ForgeaX project found from ${cwd}`);
  const slug = typeof raw === 'string' && raw !== '' ? raw : activeGame(project.root);
  if (!slug || !SLUG_RE.test(slug)) throw new Error('game must name an existing game slug, or an active game must be selected');
  const dir = gameDir(project.root, slug);
  if (!dir) throw new Error(`game ${JSON.stringify(slug)} was not found`);
  return { root: project.root, slug, dir };
}

function safeSegments(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('path must be a non-empty relative path');
  if (raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')) {
    throw new Error('path must use relative POSIX segments');
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('path contains an unsafe segment');
  }
  if (segments.some((segment) => segment.startsWith('.') || BLOCKED_SEGMENTS.has(segment))) {
    throw new Error('path targets a hidden or dependency-owned location');
  }
  if (!TEXT_EXTENSIONS.has(extname(segments.at(-1)!).toLowerCase())) {
    throw new Error('path must name a supported UTF-8 text file');
  }
  return segments;
}

function confinedPath(gameRoot: string, raw: unknown, allowMissing: boolean): { path: string; relativePath: string } {
  const segments = safeSegments(raw);
  const root = resolve(gameRoot);
  const path = resolve(root, ...segments);
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('path escapes the game root');

  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) {
      if (!allowMissing) throw new Error(`file does not exist: ${segments.join('/')}`);
      continue;
    }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('path traverses a symbolic link');
  }
  return { path, relativePath: segments.join('/') };
}

function listTextFiles(gameRoot: string): Array<{ path: string; bytes: number }> {
  const rows: Array<{ path: string; bytes: number }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_LISTED_FILES) return;
      if (entry.name.startsWith('.') || BLOCKED_SEGMENTS.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        rows.push({ path: relative(gameRoot, path).split(sep).join('/'), bytes: statSync(path).size });
      }
    }
  };
  visit(gameRoot);
  return rows;
}

function readGameFile(gameRoot: string, rawPath: unknown): Record<string, unknown> {
  const file = confinedPath(gameRoot, rawPath, false);
  if (!statSync(file.path).isFile()) throw new Error(`path is not a file: ${file.relativePath}`);
  const content = readFileSync(file.path);
  if (content.length > MAX_TEXT_BYTES) throw new Error(`file exceeds ${MAX_TEXT_BYTES} bytes`);
  if (content.includes(0)) throw new Error('binary files are not readable through the text authoring tool');
  return { path: file.relativePath, bytes: content.length, sha256: sha256(content), content: content.toString('utf8') };
}

function readRuntimeLogs(cwd: string, rawLines: unknown): Record<string, unknown> {
  const project = resolveProject(cwd);
  if (!project.root) throw new Error(`no ForgeaX project found from ${cwd}`);
  const lines = rawLines === undefined ? 200 : Number(rawLines);
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 400) throw new Error('lines must be an integer from 1 to 400');
  const candidates = [
    join(project.root, '.forgeax', 'runtime', 'stack.log'),
    join(project.root, '.forgeax', 'logs', 'runtime', 'runtime.log'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!path) return { available: false, searched: candidates.map((candidate) => relative(project.root!, candidate)) };
  const size = statSync(path).size;
  const content = readFileSync(path);
  const tail = content.subarray(Math.max(0, content.length - MAX_LOG_BYTES)).toString('utf8');
  const rows = tail.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  return {
    available: true,
    path: relative(project.root, path).split(sep).join('/'),
    bytes: size,
    truncatedBytes: content.length > MAX_LOG_BYTES,
    content: rows.slice(-lines).join('\n'),
  };
}

function writeGameFile(gameRoot: string, args: Record<string, unknown>): Record<string, unknown> {
  const file = confinedPath(gameRoot, args.path, true);
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(args.content);
  if (bytes > MAX_TEXT_BYTES) throw new Error(`content exceeds ${MAX_TEXT_BYTES} bytes`);

  const exists = existsSync(file.path);
  if (exists) {
    if (!statSync(file.path).isFile()) throw new Error(`path is not a file: ${file.relativePath}`);
    if (typeof args.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expected_sha256)) {
      throw new Error('expected_sha256 is required when replacing an existing file');
    }
    const current = sha256(readFileSync(file.path));
    if (current !== args.expected_sha256) {
      throw new Error(`file changed since it was read: expected ${args.expected_sha256}, current ${current}`);
    }
  } else if (args.expected_sha256 !== undefined) {
    throw new Error('expected_sha256 must be omitted when creating a new file');
  }

  mkdirSync(dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, args.content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file.path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path: file.relativePath, bytes, sha256: sha256(args.content), created: !exists };
}

const GAME_PROPERTY = {
  game: {
    type: 'string',
    description: 'Game slug. Defaults to the active game.',
    pattern: '^[a-z0-9][a-z0-9-]{0,40}$',
  },
} as const;

export function gameFileTools<Ctx extends FileToolContext>(): readonly McpTool<Ctx>[] {
  return [
    {
      name: 'forgeax_game_list_files',
      description: 'List editable files under one game. Hidden paths, dependencies, and symbolic links are excluded.',
      inputSchema: { type: 'object', properties: { ...GAME_PROPERTY }, additionalProperties: false },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        const files = listTextFiles(game.dir);
        return { game: game.slug, files, truncated: files.length >= MAX_LISTED_FILES };
      },
    },
    {
      name: 'forgeax_game_read_file',
      description: 'Read one UTF-8 game file and return its SHA-256. Read before replacing a file.',
      inputSchema: {
        type: 'object',
        properties: { ...GAME_PROPERTY, path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        return { game: game.slug, ...readGameFile(game.dir, args.path) };
      },
    },
    {
      name: 'forgeax_game_read_logs',
      description: 'Read the bounded tail of the supervisor or packaged Runtime log for the bound project.',
      inputSchema: {
        type: 'object',
        properties: { lines: { type: 'integer', minimum: 1, maximum: 400, default: 200 } },
        additionalProperties: false,
      },
      run: (args, ctx) => readRuntimeLogs(ctx.cwd, args.lines),
    },
    {
      name: 'forgeax_game_write_file',
      description: 'Create or atomically replace one UTF-8 game file. Replacing requires the SHA-256 returned by forgeax_game_read_file.',
      inputSchema: {
        type: 'object',
        properties: {
          ...GAME_PROPERTY,
          path: { type: 'string' },
          content: { type: 'string' },
          expected_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const game = selectedGame(ctx.cwd, args.game);
        return { game: game.slug, ...writeGameFile(game.dir, args) };
      },
    },
  ];
}
