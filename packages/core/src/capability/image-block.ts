/**
 * 共享 image-block helper —— 把各种来源(base64 / dataUrl / 原始字节 / 文件路径)
 * 规整成 provider 中立的 image content block(Anthropic `{type:'image',source:{...}}`)。
 *
 * 背景:原先 facade(`kernel-facade/forgeax-core-kernel.ts`)有一份只服务「用户输入
 * 附件」的 `imageBlockFromAttachment`;多模态 `read_file`(011)也要把磁盘图片读成同形
 * image block。为避免两处各写一份、降低与 008 在 facade 的合并冲突,把这套逻辑抽到本
 * 共享文件,facade 与 read_file 共用。
 *
 * Boundary: 仅 import node:(扩展名推断),不引外部包。core 不打真 IO —— 路径读盘交给
 * 调用方(facade 用 node:fs 同步读用户附件;read_file 走注入的 SandboxFs.readBytes)。
 */
import { extname } from 'node:path';

/** provider 中立 image content block(Anthropic base64 source 形;openai-compat 会优雅降级)。 */
export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** 由文件扩展名推断 image media_type(兜底 image/png)。 */
export function mediaTypeFromExt(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    default:
      return 'image/png';
  }
}

/** 扩展名是否「看起来是图片」(read_file 的快速判定;无扩展名时再交给 magic-bytes)。 */
export function isImageExt(path: string): boolean {
  switch (extname(path).toLowerCase()) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return true;
    default:
      return false;
  }
}

/** 由文件头魔数判图片类型;非图片返回 null。用于无扩展名 / 扩展名不可信时兜底。 */
export function imageMediaTypeFromMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** 把 Uint8Array(已读到内存)转成 base64(不依赖 node:Buffer 形态约束,跑 bun/node 皆可)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  // node / bun 下 Buffer 总在;用它做 base64 最快且不超栈。
  return Buffer.from(bytes).toString('base64');
}

/** base64 + mediaType → image block(已是 base64,直接组块)。 */
export function imageBlockFromBase64(base64: string, mediaType: string): ImageContentBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

/** 原始字节 + 路径(推断 mediaType)→ image block。优先 magic-bytes,回落扩展名。 */
export function imageBlockFromBytes(bytes: Uint8Array, path: string): ImageContentBlock {
  const mediaType = imageMediaTypeFromMagic(bytes) ?? mediaTypeFromExt(path);
  return imageBlockFromBase64(bytesToBase64(bytes), mediaType);
}

/** dataUrl(`data:image/png;base64,xxxx`)→ {data, mediaType};非 dataUrl 返回 null。 */
export function parseDataUrl(s: string): { data: string; mediaType?: string } | null {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  return { data: m[2], mediaType: m[1] || undefined };
}

/** 「用户输入附件」→ image block(从 facade 抽出,逻辑等价)。
 *  支持两种数据来源:`data`(base64,容忍 dataUrl 前缀)或 `path`(host 文件,经 readPath 读盘)。
 *  非图片 / 无数据的项返回 null(forward-compat,调用方静默跳过)。
 *  `readPath`:把 host 路径读成字节的注入点(facade 用 node:fs.readFileSync)。 */
export function imageBlockFromAttachment(
  att: Record<string, unknown>,
  readPath: (path: string) => Uint8Array,
): ImageContentBlock | null {
  if (att.kind !== 'image') return null;
  let data: string | undefined;
  let mediaType = typeof att.mediaType === 'string' ? att.mediaType : undefined;
  if (typeof att.data === 'string' && att.data) {
    const parsed = parseDataUrl(att.data);
    if (parsed) {
      mediaType = mediaType ?? parsed.mediaType;
      data = parsed.data;
    } else {
      data = att.data;
    }
  } else if (typeof att.path === 'string' && att.path) {
    try {
      const bytes = readPath(att.path);
      data = bytesToBase64(bytes);
      mediaType = mediaType ?? mediaTypeFromExt(att.path);
    } catch {
      return null; // 读盘失败 → 跳过该图(不挂死整轮)
    }
  }
  if (!data) return null;
  return imageBlockFromBase64(data, mediaType ?? 'image/png');
}
