/**
 * ImageGen — 宿主↔插件之间的「图像生成能力」中立缝(host capability seam)。
 *
 * 编排层(forgeax-cli)的 image-gateway 实现它(`createImageGen(env)`),由
 * ToolRegistry 在调用插件后端时注入进 handler ctx;业务插件(如 wb-character)
 * 只**消费这个接口**生成图片,从而不必反向 import 编排层的任何具体 vendor 实现。
 *
 * 形状对齐 image-gateway 的 ImageDispatcher(`generate(role, opts, preferred)` +
 * `isReady()`),便于 0 成本适配。
 */

export type ImageGenRole = 'concept-art' | 'sprite-frame';

export interface ImageGenRequest {
  prompt: string;
  size?: '1k' | '2k' | '4k';
  refImageBase64?: string | null;
  /** 覆盖默认 vendor 模型 id;不传走 role 的默认链。 */
  modelOverride?: string;
}

export interface ImageGenOutput {
  pngBytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  vendor: string;
  modelId: string;
  estimateUSD?: number;
  triedVendors?: string[];
}

/** 宿主下注给插件 handler 的图像生成能力。 */
export interface ImageGen {
  /** 按 role(concept-art / sprite-frame)+ 可选首选 vendor 生成一张图。 */
  generate(role: ImageGenRole, opts: ImageGenRequest, preferred?: string): Promise<ImageGenOutput>;
  /** 各 vendor 就绪状态(key 是否配齐)。 */
  isReady(): { ready: string[]; missing: string[] };
}
