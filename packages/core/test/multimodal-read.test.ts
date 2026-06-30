/**
 * 011 · 多模态 read_file(图片 / PDF)单测。
 *
 * 用内存 stub 的 SandboxFs(支持 readBytes)测:
 *   - PNG/JPEG(扩展名 + 魔数)→ read_file 返回 image content block(base64 + mediaType);
 *   - 无扩展名但文件头是 PNG → 仍判图片(magic-bytes 兜底);
 *   - 文本文件 → 走原文本路径不回归;
 *   - mapResult 把 imageBlocks 透到 tool.result payload;
 *   - 共享 helper(image-block.ts)各函数;
 *   - facade 用的 imageBlockFromAttachment 经共享 helper 仍可建块。
 * 不打真 IO。风格对齐 test/builtin-tools.test.ts。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import { readFileTool } from '../src/capability/builtin-tools/file-tools';
import {
  mediaTypeFromExt,
  isImageExt,
  imageMediaTypeFromMagic,
  bytesToBase64,
  imageBlockFromBase64,
  imageBlockFromBytes,
  parseDataUrl,
  imageBlockFromAttachment,
} from '../src/capability/image-block';

// ─── 测试用图片字节(合法文件头魔数) ────────────────────────────────────────────

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x01, 0x02]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xaa, 0xbb]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00]);
const WEBP_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);

// ─── stub SandboxFs(内存 bytes 树,支持 readBytes) ─────────────────────────────

class MemFs implements SandboxFs {
  texts = new Map<string, string>();
  bins = new Map<string, Uint8Array>();

  constructor(opts: { texts?: Record<string, string>; bins?: Record<string, Uint8Array> } = {}) {
    for (const [k, v] of Object.entries(opts.texts ?? {})) this.texts.set(k, v);
    for (const [k, v] of Object.entries(opts.bins ?? {})) this.bins.set(k, v);
  }

  readTextSync(path: string): string {
    const v = this.texts.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  writeTextSync(path: string, content: string): void {
    this.texts.set(path, content);
  }
  mkdirSync(): void {}
  existsSync(path: string): boolean {
    return this.texts.has(path) || this.bins.has(path);
  }
  unlinkSync(path: string): void {
    this.texts.delete(path);
    this.bins.delete(path);
  }
  renameSync(): void {}
  statSync(path: string): StatResult {
    return { isFile: this.existsSync(path), isDir: false, size: 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async readText(path: string): Promise<string> {
    return this.readTextSync(path);
  }
  async writeText(path: string, content: string): Promise<void> {
    this.writeTextSync(path, content);
  }
  async readBytes(path: string, offset = 0, limit?: number): Promise<Uint8Array> {
    const full = this.bins.get(path);
    if (!full) throw new Error(`ENOENT(bin) ${path}`);
    const end = limit !== undefined ? offset + limit : full.length;
    return full.slice(offset, end);
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.bins.set(path, data);
  }
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('not used');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('not used');
  }
}

function ctxWith(extra: Record<string, unknown>): ToolContext {
  return { signal: new AbortController().signal, ...extra };
}

// ─── 共享 helper: image-block.ts ─────────────────────────────────────────────

describe('image-block helper', () => {
  test('mediaTypeFromExt maps known exts, falls back to png', () => {
    expect(mediaTypeFromExt('/a.png')).toBe('image/png');
    expect(mediaTypeFromExt('/a.JPG')).toBe('image/jpeg');
    expect(mediaTypeFromExt('/a.jpeg')).toBe('image/jpeg');
    expect(mediaTypeFromExt('/a.gif')).toBe('image/gif');
    expect(mediaTypeFromExt('/a.webp')).toBe('image/webp');
    expect(mediaTypeFromExt('/a.unknown')).toBe('image/png');
  });

  test('isImageExt only true for image exts', () => {
    expect(isImageExt('/a.png')).toBe(true);
    expect(isImageExt('/a.JPEG')).toBe(true);
    expect(isImageExt('/a.txt')).toBe(false);
    expect(isImageExt('/a')).toBe(false);
  });

  test('imageMediaTypeFromMagic detects png/jpeg/gif/webp, null otherwise', () => {
    expect(imageMediaTypeFromMagic(PNG_MAGIC)).toBe('image/png');
    expect(imageMediaTypeFromMagic(JPEG_MAGIC)).toBe('image/jpeg');
    expect(imageMediaTypeFromMagic(GIF_MAGIC)).toBe('image/gif');
    expect(imageMediaTypeFromMagic(WEBP_MAGIC)).toBe('image/webp');
    expect(imageMediaTypeFromMagic(new TextEncoder().encode('hello world plain text'))).toBeNull();
    expect(imageMediaTypeFromMagic(new Uint8Array([1, 2, 3]))).toBeNull(); // 太短
  });

  test('bytesToBase64 round-trips', () => {
    const b64 = bytesToBase64(PNG_MAGIC);
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(PNG_MAGIC));
  });

  test('imageBlockFromBase64 builds anthropic image block', () => {
    const block = imageBlockFromBase64('AAAA', 'image/png');
    expect(block.type).toBe('image');
    expect(block.source.type).toBe('base64');
    expect(block.source.media_type).toBe('image/png');
    expect(block.source.data).toBe('AAAA');
  });

  test('imageBlockFromBytes prefers magic-bytes over ext', () => {
    // 字节是 JPEG,但路径扩展名 .png → 应以魔数 JPEG 为准。
    const block = imageBlockFromBytes(JPEG_MAGIC, '/wrong.png');
    expect(block.source.media_type).toBe('image/jpeg');
  });

  test('parseDataUrl extracts data + mediaType', () => {
    const r = parseDataUrl('data:image/png;base64,QUJD');
    expect(r).not.toBeNull();
    expect(r!.data).toBe('QUJD');
    expect(r!.mediaType).toBe('image/png');
    expect(parseDataUrl('not-a-data-url')).toBeNull();
  });

  test('imageBlockFromAttachment: base64 data', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', data: 'QUJD', mediaType: 'image/png' },
      () => new Uint8Array(),
    );
    expect(block?.source.data).toBe('QUJD');
    expect(block?.source.media_type).toBe('image/png');
  });

  test('imageBlockFromAttachment: dataUrl prefix tolerated', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', data: 'data:image/jpeg;base64,QUJD' },
      () => new Uint8Array(),
    );
    expect(block?.source.media_type).toBe('image/jpeg');
    expect(block?.source.data).toBe('QUJD');
  });

  test('imageBlockFromAttachment: path → readPath injection', () => {
    const block = imageBlockFromAttachment({ kind: 'image', path: '/x.png' }, () => PNG_MAGIC);
    expect(block?.source.media_type).toBe('image/png');
    expect(block?.source.data).toBe(bytesToBase64(PNG_MAGIC));
  });

  test('imageBlockFromAttachment: non-image kind → null', () => {
    expect(imageBlockFromAttachment({ kind: 'file', path: '/x.txt' }, () => new Uint8Array())).toBeNull();
  });

  test('imageBlockFromAttachment: path read failure → null (graceful)', () => {
    const block = imageBlockFromAttachment(
      { kind: 'image', path: '/missing.png' },
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(block).toBeNull();
  });
});

// ─── read_file 多模态分支 ─────────────────────────────────────────────────────

describe('read_file multimodal', () => {
  test('PNG (by ext) → returns image content block, not text', async () => {
    const fs = new MemFs({ bins: { '/shot.png': PNG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/shot.png' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks!.length).toBe(1);
    const block = data.imageBlocks![0];
    expect(block.type).toBe('image');
    expect(block.source.media_type).toBe('image/png');
    expect(block.source.data).toBe(bytesToBase64(PNG_MAGIC));
    // 文本 content 是人类可读占位,不是图片字节。
    expect(data.content).toContain('image');
    expect(data.numLines).toBe(0);
  });

  test('JPEG (by ext) → image block with image/jpeg', async () => {
    const fs = new MemFs({ bins: { '/photo.jpg': JPEG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/photo.jpg' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks![0].source.media_type).toBe('image/jpeg');
  });

  test('no extension but PNG magic bytes → detected as image', async () => {
    const fs = new MemFs({ bins: { '/blob': PNG_MAGIC } });
    const { data } = await readFileTool().call({ file_path: '/blob' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks![0].source.media_type).toBe('image/png');
  });

  test('text file → text path unchanged (no imageBlocks, line numbers)', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'l1\nl2\nl3' } });
    const { data } = await readFileTool().call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeUndefined();
    expect(data.totalLines).toBe(3);
    expect(data.numLines).toBe(3);
    expect(data.content).toContain('1\tl1');
    expect(data.content).toContain('3\tl3');
  });

  test('text file with no extension (not image magic) → text path', async () => {
    // bins 没有该 path → readBytes 抛错 → tryReadImage 回落 null → 文本路径读到。
    const fs = new MemFs({ texts: { '/README': 'plain readme line' } });
    const { data } = await readFileTool().call({ file_path: '/README' }, ctxWith({ sandboxFs: fs }));
    expect(data.imageBlocks).toBeUndefined();
    expect(data.content).toContain('plain readme line');
  });

  test('text path still honors offset + limit (no regression)', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'l1\nl2\nl3\nl4' } });
    const { data } = await readFileTool().call(
      { file_path: '/a.txt', offset: 2, limit: 2 },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.numLines).toBe(2);
    expect(data.content).toContain('2\tl2');
    expect(data.content).toContain('3\tl3');
    expect(data.content).not.toContain('l1');
  });

  test('mapResult carries imageBlocks into tool.result payload for image', async () => {
    const fs = new MemFs({ bins: { '/shot.png': PNG_MAGIC } });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/shot.png' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_img');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.toolUseId).toBe('tu_img');
    const blocks = payload.imageBlocks as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as { type: string }).type).toBe('image');
  });

  test('mapResult for text result has no imageBlocks key', async () => {
    const fs = new MemFs({ texts: { '/a.txt': 'hi' } });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_txt');
    expect((ev.payload as Record<string, unknown>).imageBlocks).toBeUndefined();
  });

  test('predicates unchanged: read-only + concurrency-safe + maxResultSizeChars=Infinity', () => {
    const t = readFileTool();
    expect(t.isReadOnly({ file_path: '/a' })).toBe(true);
    expect(t.isConcurrencySafe({ file_path: '/a' })).toBe(true);
    expect(t.maxResultSizeChars).toBe(Infinity);
  });

  test('inputJSONSchema exposes pages param (PDF forward-compat)', () => {
    const schema = readFileTool().inputJSONSchema as { properties: Record<string, unknown> };
    expect(schema.properties.pages).toBeDefined();
  });
});
