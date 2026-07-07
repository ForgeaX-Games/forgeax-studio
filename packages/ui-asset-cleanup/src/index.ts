// Shared UI asset cleanup (sharp image normalization + canvas inspection).
// SSOT for wb-ui, wb-items, and forgeax-server — do not fork cutout logic in plugins.
import sharp from 'sharp'

const UI_ASSET_WHITE_THRESHOLD = 242
const UI_ASSET_BLACK_THRESHOLD = 52
const UI_ASSET_ALPHA_THRESHOLD = 12
const UI_ASSET_COLOR_TOLERANCE = 34
/** Chrome 用更紧的 seed 匹配，减少「中灰/橄榄与边缘种子一个桶」时整片被吃掉 */
const UI_ASSET_CHROME_SEED_TOL = 20
const UI_ASSET_SEED_QUANTIZE = 16

export type UiAssetCleanupMode = 'icon' | 'chrome'

/** 深色 HUD / 军事金属等：额外收边，削弱粉边与黑底半透明晕染 */
export type ChromeEdgeRefine = 'dark-ui'

interface NormalizeStandaloneUiAssetOptions {
  fillRatio?: number
  mode?: UiAssetCleanupMode
  chromeEdgeRefine?: ChromeEdgeRefine
}

interface NormalizeUiAssetForCanvasOptions {
  targetWidth: number
  targetHeight: number
  maxFillWidth: number
  maxFillHeight: number
  kernel?: keyof sharp.KernelEnum
}

export interface UiAssetCanvasInspection {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
  occupancyWidth: number
  occupancyHeight: number
  opaqueEdgePixels: number
  transparentDirtyPixels: number
  transparentCornerDirtyPixels: number
  opaquePixelCount: number
  opaqueBoundsFillRatio: number
  opaqueBoundsEdgeRatio: number
  opaquePinkBackdropRatio: number
  opaquePlateLikeRatio: number
  textLikeRowScore: number
  denseTextBlockScore: number
  captionBandScore: number
  interiorDetailScore: number
  solidSlotPlateScore: number
  opaqueComponentCount: number
  largestComponentPixels: number
  fragmentationRatio: number
  largestComponentRatio: number
}

function parseDataUrlImage(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mime: match[1], base64: match[2] }
}

interface SeedColor {
  r: number
  g: number
  b: number
}

function isNearWhite(r: number, g: number, b: number): boolean {
  return r >= UI_ASSET_WHITE_THRESHOLD && g >= UI_ASSET_WHITE_THRESHOLD && b >= UI_ASSET_WHITE_THRESHOLD
}

function isNearBlack(r: number, g: number, b: number): boolean {
  return r <= UI_ASSET_BLACK_THRESHOLD && g <= UI_ASSET_BLACK_THRESHOLD && b <= UI_ASSET_BLACK_THRESHOLD
}

/**
 * 洋红/绿幕色键：生图时强制用纯色底，与主体拉开距离，减少 neutral 类误判抠烂。
 * 判定需略宽松以容忍 JPEG/压缩色差。
 */
function isChromaMagentaKey(r: number, g: number, b: number): boolean {
  return g <= 110
    && r >= 150
    && b >= 150
    && (r - g) >= 40
    && (b - g) >= 40
}
function isChromaGreenKey(r: number, g: number, b: number): boolean {
  return g >= 150 && r <= 120 && b <= 120 && g - Math.max(r, b) >= 30
}

function isChromaKeyScreen(r: number, g: number, b: number): boolean {
  return isChromaMagentaKey(r, g, b) || isChromaGreenKey(r, g, b)
}

function colorCloseToSeed(r: number, g: number, b: number, seed: SeedColor): boolean {
  return colorCloseToSeedTolerant(r, g, b, seed, UI_ASSET_COLOR_TOLERANCE)
}

function colorCloseToSeedTolerant(r: number, g: number, b: number, seed: SeedColor, tolerance: number): boolean {
  return Math.abs(r - seed.r) <= tolerance
    && Math.abs(g - seed.g) <= tolerance
    && Math.abs(b - seed.b) <= tolerance
}

/** 仅作边缘种子：与灰/军绿同色的面不应作为泛洪源，避免误把主体当背景。 */
function isChromaOrMonoEdgeBackdrop(r: number, g: number, b: number): boolean {
  return isNearWhite(r, g, b) || isNearBlack(r, g, b) || isChromaKeyScreen(r, g, b)
}

type EdgeSeedFilter = 'all' | 'chroma-bias'

function collectEdgeSeeds(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  edgeFilter: EdgeSeedFilter = 'all',
): SeedColor[] {
  const seeds: SeedColor[] = []
  const seen = new Set<string>()

  const addSeed = (x: number, y: number) => {
    const idx = (y * width + x) * channels
    const a = rgba[idx + 3]
    if (a < UI_ASSET_ALPHA_THRESHOLD) return
    const r = rgba[idx]
    const g = rgba[idx + 1]
    const b = rgba[idx + 2]
    if (edgeFilter === 'chroma-bias' && !isChromaOrMonoEdgeBackdrop(r, g, b)) return
    const key = [
      Math.round(r / UI_ASSET_SEED_QUANTIZE),
      Math.round(g / UI_ASSET_SEED_QUANTIZE),
      Math.round(b / UI_ASSET_SEED_QUANTIZE),
    ].join(':')
    if (seen.has(key)) return
    seen.add(key)
    seeds.push({ r, g, b })
  }

  for (let x = 0; x < width; x++) {
    addSeed(x, 0)
    addSeed(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    addSeed(0, y)
    addSeed(width - 1, y)
  }

  return seeds
}

/**
 * 从四边作泛洪，把 isErasable 为真的连通区域抠成全透明。用于 edge 抠除背景。
 */
function runFloodErasable(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  isErasable: (r: number, g: number, b: number, a: number) => boolean,
): void {
  const visited = new Uint8Array(width * height)
  const queue: number[] = []

  const enqueue = (x: number, y: number) => {
    const pos = y * width + x
    if (visited[pos]) return
    const i = (y * width + x) * channels
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const a = rgba[i + 3]
    if (!isErasable(r, g, b, a)) return
    visited[pos] = 1
    queue.push(pos)
  }

  for (let x = 0; x < width; x++) {
    enqueue(x, 0)
    enqueue(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y)
    enqueue(width - 1, y)
  }

  for (let head = 0; head < queue.length; head++) {
    const pos = queue[head]
    const x = pos % width
    const y = Math.floor(pos / width)
    const idx = pos * channels
    rgba[idx] = 0
    rgba[idx + 1] = 0
    rgba[idx + 2] = 0
    rgba[idx + 3] = 0
    if (x > 0) enqueue(x - 1, y)
    if (x + 1 < width) enqueue(x + 1, y)
    if (y > 0) enqueue(x, y - 1)
    if (y + 1 < height) enqueue(x, y + 1)
  }
}

/**
 * Chrome 边缘抠除：不再把 neutral 中灰/深灰当全局可删，仅靠色键+白/黑+与**可信**边缘种子
 * 的紧致匹配。泛洪误伤大平面 UI 的风险显著低于使用 isNeutralLight/NeutralDark。
 */
function makeChromeErasable(
  seeds: SeedColor[],
): (r: number, g: number, b: number, a: number) => boolean {
  return (r, g, b, a) => {
    if (a < UI_ASSET_ALPHA_THRESHOLD) return true
    if (isNearWhite(r, g, b) || isNearBlack(r, g, b)) return true
    if (isChromaKeyScreen(r, g, b)) return true
    return seeds.some(seed => colorCloseToSeedTolerant(r, g, b, seed, UI_ASSET_CHROME_SEED_TOL))
  }
}

function makeIconErasable(
  seeds: SeedColor[],
): (r: number, g: number, b: number, a: number) => boolean {
  return (r, g, b, a) => {
    if (a < UI_ASSET_ALPHA_THRESHOLD) return true
    if (isNearWhite(r, g, b) || isNearBlack(r, g, b)) return true
    if (isChromaKeyScreen(r, g, b)) return true
    if (isIconNearWhiteKey(r, g, b)) return true
    return seeds.some(seed => colorCloseToSeedTolerant(r, g, b, seed, UI_ASSET_COLOR_TOLERANCE))
  }
}

/**
 * 二次回退：当 chrome 主通道「抠过肉」时，全图仅剥色键/白/黑，不跑种子泛洪。
 * 能去掉洋红/绿幕残边，但不会把大灰面再抹掉一截（除非整片灰贴边，此时应重生图）。
 */
function makeChromaOrMonoErasable(): (r: number, g: number, b: number, a: number) => boolean {
  return (r, g, b, a) => {
    if (a < UI_ASSET_ALPHA_THRESHOLD) return true
    if (isNearWhite(r, g, b) || isNearBlack(r, g, b)) return true
    return isChromaKeyScreen(r, g, b)
  }
}

function clearEdgeConnectedBackground(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  mode: UiAssetCleanupMode,
): void {
  const filter: EdgeSeedFilter = mode === 'chrome' || mode === 'icon' ? 'chroma-bias' : 'all'
  const seeds = collectEdgeSeeds(rgba, width, height, channels, filter)
  const isErasable
    = mode === 'chrome'
      ? makeChromeErasable(seeds)
      : makeIconErasable(seeds)
  runFloodErasable(rgba, width, height, channels, isErasable)
}

function removeChromaOrMonoByEdgeFlood(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  runFloodErasable(rgba, width, height, channels, makeChromaOrMonoErasable())
}

/**
 * 画框类素材：洋红/绿幕可能整片在**内孔**里，与四边不连通，边缘泛洪进不去。
 * 在生图已约定「主体不用色键色」的前提下，对整图做色键像素的补扫，去掉框内残底。
 * 生图内孔常偏色洋红/玫红，仅靠欧氏球 120 会漏，故放大球并加品红轴/绿幕轴启发式。
 */
const CHROMA_SCORCH_DIST_MAGENTA = 185
const CHROMA_SCORCH_DIST_GREEN = 150

/**
 * 压暗+纹理的玫红/酒红残底，R、B 仍常高于 G，但 (r+b)/2−g 不大，单一轴会漏扫。
 */
function isDullMauveMagentaScorch(r: number, g: number, b: number): boolean {
  if (g > 150) return false
  if (r < 48 || b < 48) return false
  if (g > Math.max(r, b) + 6) return false
  if (Math.abs(r - b) > 80) return false
  if ((r + b) / 2 - g < 9) return false
  if ((r - g) < 4 || (b - g) < 4) return false
  return (r - g) + (b - g) > 18
}

/**
 * 框内/纹理压暗的灰洋红、玫红，r/b 与 g 只差少数灰阶，(r+b)/2−g 在 3~20，上一路径会整段漏掉。
 */
function isLowChromaMauveRoseScorch(r: number, g: number, b: number): boolean {
  if (g > 165) return false
  if (r < 32 || b < 32) return false
  if (r + g + b > 620) return false
  if (g > Math.max(r, b) + 8) return false
  if (Math.abs(r - b) > 72) return false
  const mag = (r + b) / 2 - g
  if (mag < 3 || mag > 32) return false
  if ((r - g) < 1 || (b - g) < 1) return false
  return (r - g) + (b - g) > 6
}

function isMagentaKeyAxisScorch(r: number, g: number, b: number): boolean {
  if (g > 165) return false
  if (r < 50 || b < 50) return false
  if (g > Math.max(r, b) - 10) return false
  if (Math.abs(r - b) > 92) return false
  if ((r + b) / 2 - g < 20) return false
  return (r - g) + (b - g) > 24
}

function isGreenKeyAxisScorch(r: number, g: number, b: number): boolean {
  if (g < 105) return false
  if (g < Math.max(r, b) + 22) return false
  if (r + b > 280 && g < 200) return false
  if (g - (r + b) / 2 < 32) return false
  if (g > 118 && r < 150 && b < 150) return (g - r) + (g - b) > 48
  return (g - r) > 28 && (g - b) > 28
}

function shouldScorchChromaKeyPixel(r: number, g: number, b: number): boolean {
  if (isChromaKeyScreen(r, g, b)) return true
  if (
    isDullMauveMagentaScorch(r, g, b)
    || isLowChromaMauveRoseScorch(r, g, b)
    || isMagentaKeyAxisScorch(r, g, b)
    || isGreenKeyAxisScorch(r, g, b)
  ) {
    return true
  }
  const dMagenta = Math.hypot(r - 255, g, b - 255)
  const dGreen = Math.hypot(r, g - 255, b)
  return dMagenta <= CHROMA_SCORCH_DIST_MAGENTA || dGreen <= CHROMA_SCORCH_DIST_GREEN
}

function scorchChromaKeyPixelsGlobally(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      if (rgba[i + 3] <= UI_ASSET_ALPHA_THRESHOLD) continue
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      if (!shouldScorchChromaKeyPixel(r, g, b)) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

/** 约定：icon 画在 #FFF 上；生图常带微偏冷/微灰白（#F3F3F3 等），用 max 偏差比三通道同阈更稳。 */
const ICON_KEY_WHITE_MAX_MAX_DIFF = 42

function isIconNearWhiteKey(r: number, g: number, b: number): boolean {
  return Math.max(255 - r, 255 - g, 255 - b) <= ICON_KEY_WHITE_MAX_MAX_DIFF
}

function scorchIconWhiteKeyBackdrop(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      if (rgba[i + 3] <= UI_ASSET_ALPHA_THRESHOLD) continue
      if (!isIconNearWhiteKey(rgba[i], rgba[i + 1], rgba[i + 2])) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

function countOpaqueEdgePixels(rgba: Buffer, width: number, height: number, channels: number): number {
  let n = 0
  const alphaAt = (x: number, y: number) => rgba[(y * width + x) * channels + 3]
  for (let x = 0; x < width; x++) {
    if (alphaAt(x, 0) > UI_ASSET_ALPHA_THRESHOLD) n++
    if (alphaAt(x, height - 1) > UI_ASSET_ALPHA_THRESHOLD) n++
  }
  for (let y = 0; y < height; y++) {
    if (alphaAt(0, y) > UI_ASSET_ALPHA_THRESHOLD) n++
    if (alphaAt(width - 1, y) > UI_ASSET_ALPHA_THRESHOLD) n++
  }
  return n
}

function isDarkNeutralPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max <= 130 && (max - min) <= 26
}

function makeDarkNeutralEdgeErasable(
  seeds: SeedColor[],
): (r: number, g: number, b: number, a: number) => boolean {
  return (r, g, b, a) => {
    if (a < UI_ASSET_ALPHA_THRESHOLD) return true
    if (isNearWhite(r, g, b) || isNearBlack(r, g, b) || isChromaKeyScreen(r, g, b)) return true
    if (!isDarkNeutralPixel(r, g, b)) return false
    return seeds.some(seed => colorCloseToSeedTolerant(r, g, b, seed, 30))
  }
}

function scrubDarkNeutralEdgeBackdrop(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const seeds = collectEdgeSeeds(rgba, width, height, channels, 'all')
  runFloodErasable(rgba, width, height, channels, makeDarkNeutralEdgeErasable(seeds))
}

/**
 * 去除色键边缘的半透明/压缩晕染：在透明边附近把明显品红/绿幕像素清掉。
 */
function scrubChromaFringe(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const copy = Buffer.from(rgba)
  const alphaAt = (x: number, y: number) => copy[(y * width + x) * channels + 3]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels
      const a = copy[i + 3]
      if (a <= UI_ASSET_ALPHA_THRESHOLD) continue
      const r = copy[i]
      const g = copy[i + 1]
      const b = copy[i + 2]
      if (!shouldScorchChromaKeyPixel(r, g, b)) continue
      const hasTransparentNeighbor = (
        alphaAt(x - 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x + 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y - 1) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y + 1) <= UI_ASSET_ALPHA_THRESHOLD
      )
      if (!hasTransparentNeighbor) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

function runChromaFringePasses(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  passes: number,
): void {
  for (let p = 0; p < passes; p++) scrubChromaFringe(rgba, width, height, channels)
}

/**
 * 抗锯齿/压缩产生的**半透明**品红边（不透明分支扫不到）。
 */
function scrubChromaSemifringe(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const copy = Buffer.from(rgba)
  const alphaAt = (x: number, y: number) => copy[(y * width + x) * channels + 3]
  const hiOpaque = 252
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels
      const a = copy[i + 3]
      if (a <= UI_ASSET_ALPHA_THRESHOLD || a >= hiOpaque) continue
      const r = copy[i]
      const g = copy[i + 1]
      const b = copy[i + 2]
      if (!shouldScorchChromaKeyPixel(r, g, b)) continue
      const hasTransparentNeighbor = (
        alphaAt(x - 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x + 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y - 1) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y + 1) <= UI_ASSET_ALPHA_THRESHOLD
      )
      if (!hasTransparentNeighbor) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

function isVeryDarkBackdropLike(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max > 122) return false
  if (max - min > 38) return false
  return true
}

/** 白底提取键：近白 + 贴透明边的浅灰抗锯齿晕。 */
function isLightExtractionKey(r: number, g: number, b: number): boolean {
  const maxDiff = Math.max(255 - r, 255 - g, 255 - b)
  if (maxDiff <= ICON_KEY_WHITE_MAX_MAX_DIFF) return true
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  if (max - min > 28) return false
  const avg = (r + g + b) / 3
  return maxDiff <= 72 && avg >= 175
}

function runLightKeyFringePasses(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  passes: number,
): void {
  for (let p = 0; p < passes; p++) scrubLightKeyFringe(rgba, width, height, channels)
}

/**
 * 白底提取后残留的不透明/半透明浅灰白描边（贴透明邻居），是 icon 脏边的主要来源。
 */
function scrubLightKeyFringe(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const copy = Buffer.from(rgba)
  const alphaAt = (x: number, y: number) => copy[(y * width + x) * channels + 3]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels
      const a = copy[i + 3]
      if (a <= UI_ASSET_ALPHA_THRESHOLD) continue
      const r = copy[i]
      const g = copy[i + 1]
      const b = copy[i + 2]
      if (!isLightExtractionKey(r, g, b)) continue
      const hasTransparentNeighbor = (
        alphaAt(x - 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x + 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y - 1) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y + 1) <= UI_ASSET_ALPHA_THRESHOLD
      )
      if (!hasTransparentNeighbor) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

/** 半透明浅灰白抗锯齿晕（白底抠图后贴透明边）。 */
function scrubLightKeySemifringe(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const copy = Buffer.from(rgba)
  const alphaAt = (x: number, y: number) => copy[(y * width + x) * channels + 3]
  const hiOpaque = 252
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels
      const a = copy[i + 3]
      if (a <= UI_ASSET_ALPHA_THRESHOLD || a >= hiOpaque) continue
      const r = copy[i]
      const g = copy[i + 1]
      const b = copy[i + 2]
      if (!isLightExtractionKey(r, g, b)) continue
      const hasTransparentNeighbor = (
        alphaAt(x - 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x + 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y - 1) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y + 1) <= UI_ASSET_ALPHA_THRESHOLD
      )
      if (!hasTransparentNeighbor) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

function countChromaOpaquePixels(rgba: Buffer, width: number, height: number, channels: number): number {
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      if (rgba[i + 3] <= UI_ASSET_ALPHA_THRESHOLD) continue
      if (shouldScorchChromaKeyPixel(rgba[i], rgba[i + 1], rgba[i + 2])) n++
    }
  }
  return n
}

function refineIconCutout(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  scorchIconWhiteKeyBackdrop(rgba, width, height, channels)
  runLightKeyFringePasses(rgba, width, height, channels, 3)
  scrubLightKeySemifringe(rgba, width, height, channels)
  keepLargestOpaqueComponent(rgba, width, height, channels)
  runLightKeyFringePasses(rgba, width, height, channels, 3)
  scrubDarkBackdropSemifringe(rgba, width, height, channels)
  scrubLightKeySemifringe(rgba, width, height, channels)
  runLightKeyFringePasses(rgba, width, height, channels, 2)
  scrubLightKeyFringe(rgba, width, height, channels)
  // 兼容旧图/误用色键底的输入：仅在仍检测到明显色键像素时补扫
  if (countChromaOpaquePixels(rgba, width, height, channels) > 48) {
    scorchChromaKeyPixelsGlobally(rgba, width, height, channels)
    runChromaFringePasses(rgba, width, height, channels, 2)
    scrubChromaSemifringe(rgba, width, height, channels)
    keepLargestOpaqueComponent(rgba, width, height, channels)
    scrubLightKeyFringe(rgba, width, height, channels)
  }
}

/**
 * 黑底舞台残留的半透明暗边（贴透明邻居），常见于低对比抠图。
 */
function scrubDarkBackdropSemifringe(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  const copy = Buffer.from(rgba)
  const alphaAt = (x: number, y: number) => copy[(y * width + x) * channels + 3]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels
      const a = copy[i + 3]
      if (a <= UI_ASSET_ALPHA_THRESHOLD || a >= 252) continue
      const r = copy[i]
      const g = copy[i + 1]
      const b = copy[i + 2]
      if (!isVeryDarkBackdropLike(r, g, b) && !isNearBlack(r, g, b)) continue
      const hasTransparentNeighbor = (
        alphaAt(x - 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x + 1, y) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y - 1) <= UI_ASSET_ALPHA_THRESHOLD
        || alphaAt(x, y + 1) <= UI_ASSET_ALPHA_THRESHOLD
      )
      if (!hasTransparentNeighbor) continue
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    }
  }
}

function refineChromeEdgesForDarkUi(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): void {
  runChromaFringePasses(rgba, width, height, channels, 3)
  scrubChromaSemifringe(rgba, width, height, channels)
  runChromaFringePasses(rgba, width, height, channels, 1)
  scrubDarkBackdropSemifringe(rgba, width, height, channels)
  scrubDarkBackdropSemifringe(rgba, width, height, channels)
}

interface OpaqueComponentStats {
  opaquePixelCount: number
  opaqueComponentCount: number
  largestComponentPixels: number
  fragmentationRatio: number
  largestComponentRatio: number
}

function computeOpaqueComponentStats(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): OpaqueComponentStats {
  const visited = new Uint8Array(width * height)
  const alphaAt = (pos: number): number => rgba[pos * channels + 3]
  let opaquePixelCount = 0
  let opaqueComponentCount = 0
  let largestComponentPixels = 0

  for (let pos = 0; pos < width * height; pos++) {
    if (alphaAt(pos) > UI_ASSET_ALPHA_THRESHOLD) opaquePixelCount++
  }

  for (let pos = 0; pos < width * height; pos++) {
    if (visited[pos] || alphaAt(pos) <= UI_ASSET_ALPHA_THRESHOLD) continue
    opaqueComponentCount++
    const queue = [pos]
    let size = 0
    visited[pos] = 1
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]
      size++
      const x = current % width
      const y = Math.floor(current / width)
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]
      for (const next of neighbors) {
        if (next < 0 || visited[next] || alphaAt(next) <= UI_ASSET_ALPHA_THRESHOLD) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (size > largestComponentPixels) largestComponentPixels = size
  }

  const largestComponentRatio = opaquePixelCount > 0 ? largestComponentPixels / opaquePixelCount : 0
  const fragmentationRatio = opaquePixelCount > 0 ? (opaquePixelCount - largestComponentPixels) / opaquePixelCount : 0
  return {
    opaquePixelCount,
    opaqueComponentCount,
    largestComponentPixels,
    fragmentationRatio,
    largestComponentRatio,
  }
}

function keepLargestOpaqueComponent(rgba: Buffer, width: number, height: number, channels: number): void {
  const visited = new Uint8Array(width * height)
  let largestComponent: number[] = []

  const alphaAt = (pos: number): number => rgba[pos * channels + 3]

  for (let pos = 0; pos < width * height; pos++) {
    if (visited[pos] || alphaAt(pos) < UI_ASSET_ALPHA_THRESHOLD) continue

    const component: number[] = []
    const queue = [pos]
    visited[pos] = 1

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]
      component.push(current)
      const x = current % width
      const y = Math.floor(current / width)
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]
      for (const next of neighbors) {
        if (next < 0 || visited[next] || alphaAt(next) < UI_ASSET_ALPHA_THRESHOLD) continue
        visited[next] = 1
        queue.push(next)
      }
    }

    if (component.length > largestComponent.length) {
      largestComponent = component
    }
  }

  if (largestComponent.length === 0) return

  const keep = new Uint8Array(width * height)
  for (const pos of largestComponent) keep[pos] = 1
  for (let pos = 0; pos < width * height; pos++) {
    if (keep[pos]) continue
    const idx = pos * channels
    rgba[idx] = 0
    rgba[idx + 1] = 0
    rgba[idx + 2] = 0
    rgba[idx + 3] = 0
  }
}

function zeroTransparentRgb(rgba: Buffer, channels: number): void {
  for (let idx = 0; idx < rgba.length; idx += channels) {
    if (rgba[idx + 3] > UI_ASSET_ALPHA_THRESHOLD) continue
    rgba[idx] = 0
    rgba[idx + 1] = 0
    rgba[idx + 2] = 0
    rgba[idx + 3] = 0
  }
}

function measureOpaqueBounds(rgba: Buffer, width: number, height: number, channels: number): {
  minX: number
  minY: number
  maxX: number
  maxY: number
  contentW: number
  contentH: number
} | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels
      if (rgba[idx + 3] <= UI_ASSET_ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) return null
  return {
    minX,
    minY,
    maxX,
    maxY,
    contentW: maxX - minX + 1,
    contentH: maxY - minY + 1,
  }
}

function countOpaqueBoundsEdgePixels(
  rgba: Buffer,
  width: number,
  channels: number,
  bounds: NonNullable<ReturnType<typeof measureOpaqueBounds>>,
): { count: number; ratio: number } {
  let count = 0
  let perimeter = 0
  const alphaAt = (x: number, y: number) => rgba[(y * width + x) * channels + 3]
  const visit = (x: number, y: number) => {
    perimeter++
    if (alphaAt(x, y) > UI_ASSET_ALPHA_THRESHOLD) count++
  }

  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    visit(x, bounds.minY)
    if (bounds.maxY !== bounds.minY) visit(x, bounds.maxY)
  }
  for (let y = bounds.minY + 1; y <= bounds.maxY - 1; y++) {
    visit(bounds.minX, y)
    if (bounds.maxX !== bounds.minX) visit(bounds.maxX, y)
  }

  return { count, ratio: perimeter > 0 ? count / perimeter : 0 }
}

function isIconBackdropPinkPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 42) return false
  if (r < 150 || b < 95) return false
  if (g > 150) return false
  return r - g >= 38 && b - g >= 18
}

function countOpaquePinkBackdropPixels(rgba: Buffer, channels: number): number {
  let count = 0
  for (let idx = 0; idx < rgba.length; idx += channels) {
    if (rgba[idx + 3] <= UI_ASSET_ALPHA_THRESHOLD) continue
    if (isIconBackdropPinkPixel(rgba[idx], rgba[idx + 1], rgba[idx + 2])) count++
  }
  return count
}

function computeOpaquePlateLikeRatio(report: {
  occupancyWidth: number
  occupancyHeight: number
  opaqueBoundsFillRatio: number
  opaqueBoundsEdgeRatio: number
}): number {
  const occupancy = Math.min(report.occupancyWidth, report.occupancyHeight)
  const fillScore = Math.max(0, (report.opaqueBoundsFillRatio - 0.42) / 0.42)
  const edgeScore = Math.max(0, (report.opaqueBoundsEdgeRatio - 0.22) / 0.58)
  const occupancyScore = Math.max(0, (occupancy - 0.58) / 0.36)
  return Math.min(1, fillScore * 0.45 + edgeScore * 0.35 + occupancyScore * 0.2)
}

/** 横排笔画/标签类 icon 常在一行内出现大量不透明↔透明跳变。 */
function isInspectableGlyphPixel(rgba: Buffer, idx: number, channels: number): boolean {
  const a = rgba[idx + 3]
  if (a <= UI_ASSET_ALPHA_THRESHOLD) return false
  if (isIconNearWhiteKey(rgba[idx], rgba[idx + 1], rgba[idx + 2])) return false
  return true
}

function computeTextLikeRowScore(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  const y0 = Math.floor(height * 0.18)
  const y1 = Math.floor(height * 0.9)
  let textLikeRows = 0
  let scannedRows = 0
  for (let y = y0; y < y1; y++) {
    let transitions = 0
    let prevGlyph = false
    let glyphInRow = 0
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels
      const glyph = isInspectableGlyphPixel(rgba, idx, channels)
      if (glyph) glyphInRow++
      if (x > 0 && glyph !== prevGlyph) transitions++
      prevGlyph = glyph
    }
    scannedRows++
    if (glyphInRow > width * 0.08 && transitions >= 6) textLikeRows++
  }
  return scannedRows > 0 ? textLikeRows / scannedRows : 0
}

/** 多行横排笔画堆叠（结算横幅/双行标题） */
function computeDenseTextBlockScore(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  const y0 = Math.floor(height * 0.28)
  const y1 = Math.floor(height * 0.86)
  let denseBands = 0
  let scannedBands = 0
  const bandH = Math.max(4, Math.floor(height * 0.06))
  for (let y = y0; y < y1; y += bandH) {
    let textRowsInBand = 0
    for (let by = y; by < Math.min(y1, y + bandH); by += 1) {
      let transitions = 0
      let prevGlyph = false
      let glyphInRow = 0
      for (let x = 0; x < width; x++) {
        const idx = (by * width + x) * channels
        const glyph = isInspectableGlyphPixel(rgba, idx, channels)
        if (glyph) glyphInRow++
        if (x > 0 && glyph !== prevGlyph) transitions++
        prevGlyph = glyph
      }
      if (glyphInRow > width * 0.1 && transitions >= 6) textRowsInBand++
    }
    scannedBands++
    if (textRowsInBand >= 2) denseBands++
  }
  return scannedBands > 0 ? denseBands / scannedBands : 0
}

/**
 * 结算条/横幅字：glyph 包围盒下半区出现「宽跨度 + 高频横跳」的连续行。
 * 对角线符号（双剑等）虽也有跳变，但很少形成底部宽横幅带。
 */
function computeCaptionBandScore(
  rgba: Buffer,
  width: number,
  height: number,
  channels: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number; contentW: number; contentH: number } | null,
): number {
  if (!bounds || bounds.contentH < 12 || bounds.contentW < 12) return 0
  const yStart = bounds.minY + Math.floor(bounds.contentH * 0.42)
  const yEnd = bounds.maxY - 1
  let captionRows = 0
  let scannedRows = 0
  for (let y = yStart; y <= yEnd; y++) {
    let glyphPixels = 0
    let minGX = width
    let maxGX = -1
    let transitions = 0
    let prevGlyph = false
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const idx = (y * width + x) * channels
      const glyph = isInspectableGlyphPixel(rgba, idx, channels)
      if (glyph) {
        glyphPixels++
        minGX = Math.min(minGX, x)
        maxGX = Math.max(maxGX, x)
      }
      if (x > bounds.minX && glyph !== prevGlyph) transitions++
      prevGlyph = glyph
    }
    scannedRows++
    const span = maxGX >= minGX ? maxGX - minGX + 1 : 0
    const spanRatio = span / Math.max(1, bounds.contentW)
    const rowFill = glyphPixels / Math.max(1, bounds.contentW)
    if (spanRatio > 0.62 && rowFill > 0.18 && rowFill < 0.82 && transitions >= 7) {
      captionRows++
    }
  }
  return scannedRows > 0 ? captionRows / scannedRows : 0
}

/** 包围盒内部亮度跳变：空槽纯色板接近 0，有图案/文字时更高。 */
function computeInteriorDetailScore(
  rgba: Buffer,
  width: number,
  channels: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number; contentW: number; contentH: number } | null,
): number {
  if (!bounds || bounds.contentW < 10 || bounds.contentH < 10) return 0
  const insetX = Math.max(1, Math.floor(bounds.contentW * 0.14))
  const insetY = Math.max(1, Math.floor(bounds.contentH * 0.14))
  const x0 = bounds.minX + insetX
  const x1 = bounds.maxX - insetX
  const y0 = bounds.minY + insetY
  const y1 = bounds.maxY - insetY
  if (x1 <= x0 || y1 <= y0) return 0
  let transitions = 0
  let samples = 0
  for (let y = y0; y <= y1; y++) {
    let prevBucket = -1
    for (let x = x0; x <= x1; x++) {
      const idx = (y * width + x) * channels
      if (!isInspectableGlyphPixel(rgba, idx, channels)) continue
      const lum = Math.round((rgba[idx] + rgba[idx + 1] + rgba[idx + 2]) / 3)
      const bucket = Math.floor(lum / 22)
      if (prevBucket >= 0 && bucket !== prevBucket) transitions++
      prevBucket = bucket
      samples++
    }
  }
  return samples > 0 ? transitions / samples : 0
}

/** 纯色圆角方块空槽 / app-icon 底板 */
function computeSolidSlotPlateScore(report: {
  occupancyWidth: number
  occupancyHeight: number
  opaqueBoundsFillRatio: number
  opaqueBoundsEdgeRatio: number
  largestComponentRatio: number
  fragmentationRatio: number
}): number {
  const occupancy = Math.min(report.occupancyWidth, report.occupancyHeight)
  if (occupancy < 0.46) return 0
  if (report.opaqueBoundsFillRatio < 0.66) return 0
  if (report.largestComponentRatio < 0.86) return 0
  const fillScore = Math.max(0, (report.opaqueBoundsFillRatio - 0.66) / 0.3)
  const occScore = Math.max(0, (occupancy - 0.46) / 0.4)
  const monoScore = report.fragmentationRatio < 0.1 ? 1 : Math.max(0, 1 - report.fragmentationRatio * 2.2)
  const edgeBand = report.opaqueBoundsEdgeRatio >= 0.14 && report.opaqueBoundsEdgeRatio <= 0.52 ? 1 : 0.35
  return Math.min(1, fillScore * 0.42 + occScore * 0.33 + monoScore * 0.15 + edgeBand * 0.1)
}

export function isIconContentRejected(report: UiAssetCanvasInspection): boolean {
  const emptySlotPlate = report.solidSlotPlateScore > 0.52 && report.interiorDetailScore < 0.055
  const textBannerLike = report.captionBandScore > 0.34
  return report.opaquePlateLikeRatio > 0.22
    || textBannerLike
    || emptySlotPlate
}

export function isIconInspectionRejected(report: UiAssetCanvasInspection): boolean {
  return isIconContentRejected(report)
    || report.opaqueEdgePixels > 4
    || report.transparentCornerDirtyPixels > 2
    || report.transparentDirtyPixels > 6
    || report.fragmentationRatio > 0.32
    || report.largestComponentRatio < 0.68
    || report.opaqueBoundsEdgeRatio > 0.38
    || (report.opaquePinkBackdropRatio > 0.22 && report.opaqueBoundsFillRatio > 0.38)
}

/** 末次重试降级：仍拒横幅/空槽/明显文字，但放宽抠图边缘与碎片容忍。 */
export function isIconInspectionRejectedRelaxed(report: UiAssetCanvasInspection): boolean {
  const emptySlotPlate = report.solidSlotPlateScore > 0.58 && report.interiorDetailScore < 0.04
  const textBannerLike = report.captionBandScore > 0.42 || report.denseTextBlockScore > 0.38
  return report.opaquePlateLikeRatio > 0.32
    || textBannerLike
    || emptySlotPlate
    || report.opaqueEdgePixels > 24
    || report.transparentCornerDirtyPixels > 12
    || report.transparentDirtyPixels > 24
}

export async function inspectUiAssetCanvas(dataUrl: string): Promise<UiAssetCanvasInspection> {
  const parsed = parseDataUrlImage(dataUrl)
  if (!parsed) {
    return {
      width: 0,
      height: 0,
      contentWidth: 0,
      contentHeight: 0,
      occupancyWidth: 0,
      occupancyHeight: 0,
      opaqueEdgePixels: 0,
      transparentDirtyPixels: 0,
      transparentCornerDirtyPixels: 0,
      opaquePixelCount: 0,
      opaqueBoundsFillRatio: 0,
      opaqueBoundsEdgeRatio: 0,
      opaquePinkBackdropRatio: 0,
      opaquePlateLikeRatio: 0,
      textLikeRowScore: 0,
      denseTextBlockScore: 0,
      captionBandScore: 0,
      interiorDetailScore: 0,
      solidSlotPlateScore: 0,
      opaqueComponentCount: 0,
      largestComponentPixels: 0,
      fragmentationRatio: 0,
      largestComponentRatio: 0,
    }
  }

  const buf = Buffer.from(parsed.base64, 'base64')
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.from(data)
  const bounds = measureOpaqueBounds(rgba, info.width, info.height, info.channels)
  const componentStats = computeOpaqueComponentStats(rgba, info.width, info.height, info.channels)
  const boundsEdge = bounds
    ? countOpaqueBoundsEdgePixels(rgba, info.width, info.channels, bounds)
    : { count: 0, ratio: 0 }
  const opaquePinkBackdropPixels = countOpaquePinkBackdropPixels(rgba, info.channels)
  let opaqueEdgePixels = 0
  let transparentDirtyPixels = 0
  let transparentCornerDirtyPixels = 0
  const cornerBandX = Math.max(1, Math.ceil(info.width * 0.08))
  const cornerBandY = Math.max(1, Math.ceil(info.height * 0.08))

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels
      const r = rgba[idx]
      const g = rgba[idx + 1]
      const b = rgba[idx + 2]
      const a = rgba[idx + 3]
      const onEdge = x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1
      if (onEdge && a > UI_ASSET_ALPHA_THRESHOLD) opaqueEdgePixels++
      if (a <= UI_ASSET_ALPHA_THRESHOLD && (r !== 0 || g !== 0 || b !== 0)) {
        transparentDirtyPixels++
        const inCornerBand = (
          (x < cornerBandX && y < cornerBandY)
          || (x >= info.width - cornerBandX && y < cornerBandY)
          || (x < cornerBandX && y >= info.height - cornerBandY)
          || (x >= info.width - cornerBandX && y >= info.height - cornerBandY)
        )
        if (inCornerBand) transparentCornerDirtyPixels++
      }
    }
  }

  const occupancyWidth = bounds ? bounds.contentW / info.width : 0
  const occupancyHeight = bounds ? bounds.contentH / info.height : 0
  const opaqueBoundsFillRatio = bounds
    ? componentStats.opaquePixelCount / Math.max(1, bounds.contentW * bounds.contentH)
    : 0
  const opaqueBoundsEdgeRatio = boundsEdge.ratio
  return {
    width: info.width,
    height: info.height,
    contentWidth: bounds?.contentW ?? 0,
    contentHeight: bounds?.contentH ?? 0,
    occupancyWidth,
    occupancyHeight,
    opaqueEdgePixels,
    transparentDirtyPixels,
    transparentCornerDirtyPixels,
    opaquePixelCount: componentStats.opaquePixelCount,
    opaqueBoundsFillRatio,
    opaqueBoundsEdgeRatio,
    opaquePinkBackdropRatio: componentStats.opaquePixelCount > 0
      ? opaquePinkBackdropPixels / componentStats.opaquePixelCount
      : 0,
    opaquePlateLikeRatio: computeOpaquePlateLikeRatio({
      occupancyWidth,
      occupancyHeight,
      opaqueBoundsFillRatio,
      opaqueBoundsEdgeRatio,
    }),
    textLikeRowScore: computeTextLikeRowScore(rgba, info.width, info.height, info.channels),
    denseTextBlockScore: computeDenseTextBlockScore(rgba, info.width, info.height, info.channels),
    captionBandScore: computeCaptionBandScore(rgba, info.width, info.height, info.channels, bounds),
    interiorDetailScore: computeInteriorDetailScore(rgba, info.width, info.channels, bounds),
    solidSlotPlateScore: computeSolidSlotPlateScore({
      occupancyWidth,
      occupancyHeight,
      opaqueBoundsFillRatio,
      opaqueBoundsEdgeRatio,
      largestComponentRatio: componentStats.largestComponentRatio,
      fragmentationRatio: componentStats.fragmentationRatio,
    }),
    opaqueComponentCount: componentStats.opaqueComponentCount,
    largestComponentPixels: componentStats.largestComponentPixels,
    fragmentationRatio: componentStats.fragmentationRatio,
    largestComponentRatio: componentStats.largestComponentRatio,
  }
}

export async function normalizeUiAssetForCanvas(
  dataUrl: string,
  options: NormalizeUiAssetForCanvasOptions,
): Promise<string> {
  const parsed = parseDataUrlImage(dataUrl)
  if (!parsed) return dataUrl

  try {
    const buf = Buffer.from(parsed.base64, 'base64')
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const rgba = Buffer.from(data)
    const bounds = measureOpaqueBounds(rgba, info.width, info.height, info.channels)
    if (!bounds) return dataUrl

    const extracted = await sharp(buf)
      .extract({
        left: bounds.minX,
        top: bounds.minY,
        width: bounds.contentW,
        height: bounds.contentH,
      })
      .png()
      .toBuffer()

    const scale = Math.min(
      (options.targetWidth * options.maxFillWidth) / bounds.contentW,
      (options.targetHeight * options.maxFillHeight) / bounds.contentH,
    )
    const outW = Math.max(1, Math.round(bounds.contentW * scale))
    const outH = Math.max(1, Math.round(bounds.contentH * scale))
    const left = Math.round((options.targetWidth - outW) / 2)
    const top = Math.round((options.targetHeight - outH) / 2)
    const resized = await sharp(extracted)
      .resize(outW, outH, { fit: 'fill', kernel: options.kernel ?? 'nearest' })
      .png()
      .toBuffer()
    const composited = await sharp({
      create: {
        width: options.targetWidth,
        height: options.targetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: resized, left, top }])
      .png()
      .toBuffer()

    const finalRaw = await sharp(composited).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const finalRgba = Buffer.from(finalRaw.data)
    zeroTransparentRgb(finalRgba, finalRaw.info.channels)
    const result = await sharp(finalRgba, {
      raw: {
        width: finalRaw.info.width,
        height: finalRaw.info.height,
        channels: finalRaw.info.channels,
      },
    }).png().toBuffer()
    return `data:image/png;base64,${result.toString('base64')}`
  } catch {
    return dataUrl
  }
}

export async function cutoutIconAsset(
  dataUrl: string,
  options: { mode?: UiAssetCleanupMode; chromeEdgeRefine?: ChromeEdgeRefine } = {},
): Promise<string> {
  const parsed = parseDataUrlImage(dataUrl)
  if (!parsed) return dataUrl

  try {
    const mode = options.mode ?? 'icon'
    const chromeEdgeRefine = options.chromeEdgeRefine
    const buf = Buffer.from(parsed.base64, 'base64')
    const image = sharp(buf)
    const meta = await image.metadata()
    const W = meta.width ?? 1024
    const H = meta.height ?? 1024
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let rgba = Buffer.from(data)
    const channels = info.channels
    const originalRgba = Buffer.from(rgba)

    clearEdgeConnectedBackground(rgba, W, H, channels, mode)
    if (mode === 'chrome') {
      scorchChromaKeyPixelsGlobally(rgba, W, H, channels)
      scrubChromaFringe(rgba, W, H, channels)
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
      }
      if (chromeEdgeRefine === 'dark-ui') {
        refineChromeEdgesForDarkUi(rgba, W, H, channels)
      }
    }
    if (mode === 'icon') {
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
      }
      refineIconCutout(rgba, W, H, channels)
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
        refineIconCutout(rgba, W, H, channels)
      }
    }
    if (mode === 'chrome') {
      const before = computeOpaqueComponentStats(originalRgba, W, H, channels)
      const after = computeOpaqueComponentStats(rgba, W, H, channels)
      const overCleaned = (
        after.opaquePixelCount < before.opaquePixelCount * 0.38
        || after.largestComponentRatio < 0.62
        || after.fragmentationRatio > 0.35
      )
      if (overCleaned) {
        rgba = Buffer.from(originalRgba)
        removeChromaOrMonoByEdgeFlood(rgba, W, H, channels)
        scorchChromaKeyPixelsGlobally(rgba, W, H, channels)
        scrubChromaFringe(rgba, W, H, channels)
        if (chromeEdgeRefine === 'dark-ui') {
          refineChromeEdgesForDarkUi(rgba, W, H, channels)
        }
      }
    }
    zeroTransparentRgb(rgba, channels)
    const result = await sharp(rgba, {
      raw: { width: W, height: H, channels },
    }).png().toBuffer()
    return `data:image/png;base64,${result.toString('base64')}`
  } catch {
    return dataUrl
  }
}

export async function normalizeStandaloneUiAsset(
  dataUrl: string,
  options: number | NormalizeStandaloneUiAssetOptions = 0.72,
): Promise<string> {
  const parsed = parseDataUrlImage(dataUrl)
  if (!parsed) return dataUrl

  try {
    const fillRatio = typeof options === 'number' ? options : (options.fillRatio ?? 0.72)
    const mode = typeof options === 'number' ? 'icon' : (options.mode ?? 'icon')
    const chromeEdgeRefine = typeof options === 'number' ? undefined : options.chromeEdgeRefine
    const buf = Buffer.from(parsed.base64, 'base64')
    const image = sharp(buf)
    const meta = await image.metadata()
    const W = meta.width ?? 1024
    const H = meta.height ?? 1024
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let rgba = Buffer.from(data)
    const channels = info.channels
    const originalRgba = Buffer.from(rgba)

    clearEdgeConnectedBackground(rgba, W, H, channels, mode)
    if (mode === 'chrome') {
      scorchChromaKeyPixelsGlobally(rgba, W, H, channels)
      scrubChromaFringe(rgba, W, H, channels)
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
      }
      if (chromeEdgeRefine === 'dark-ui') {
        refineChromeEdgesForDarkUi(rgba, W, H, channels)
      }
    }
    if (mode === 'icon') {
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
      }
      refineIconCutout(rgba, W, H, channels)
      if (countOpaqueEdgePixels(rgba, W, H, channels) > 0) {
        scrubDarkNeutralEdgeBackdrop(rgba, W, H, channels)
        refineIconCutout(rgba, W, H, channels)
      }
    }
    if (mode === 'chrome') {
      const before = computeOpaqueComponentStats(originalRgba, W, H, channels)
      const after = computeOpaqueComponentStats(rgba, W, H, channels)
      const overCleaned = (
        after.opaquePixelCount < before.opaquePixelCount * 0.38
        || after.largestComponentRatio < 0.62
        || after.fragmentationRatio > 0.35
      )
      if (overCleaned) {
        rgba = Buffer.from(originalRgba)
        removeChromaOrMonoByEdgeFlood(rgba, W, H, channels)
        scorchChromaKeyPixelsGlobally(rgba, W, H, channels)
        scrubChromaFringe(rgba, W, H, channels)
        if (chromeEdgeRefine === 'dark-ui') {
          refineChromeEdgesForDarkUi(rgba, W, H, channels)
        }
      }
    }
    zeroTransparentRgb(rgba, channels)

    if (mode === 'chrome') {
      const result = await sharp(rgba, {
        raw: { width: W, height: H, channels },
      }).png().toBuffer()
      return `data:image/png;base64,${result.toString('base64')}`
    }

    const bounds = measureOpaqueBounds(rgba, W, H, channels)
    if (!bounds) return dataUrl
    const extracted = await sharp(rgba, { raw: { width: W, height: H, channels } })
      .extract({ left: bounds.minX, top: bounds.minY, width: bounds.contentW, height: bounds.contentH })
      .png()
      .toBuffer()

    const targetMax = Math.round(Math.min(W, H) * fillRatio)
    const scale = targetMax / Math.max(bounds.contentW, bounds.contentH)
    const targetW = Math.max(1, Math.round(bounds.contentW * scale))
    const targetH = Math.max(1, Math.round(bounds.contentH * scale))
    const left = Math.round((W - targetW) / 2)
    const top = Math.round((H - targetH) / 2)

    const resized = await sharp(extracted).resize(targetW, targetH, { fit: 'contain' }).png().toBuffer()
    const canvas = sharp({
      create: {
        width: W,
        height: H,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png()
    const composited = await canvas.composite([{ input: resized, left, top }]).png().toBuffer()
    const finalRaw = await sharp(composited).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const finalRgba = Buffer.from(finalRaw.data)
    zeroTransparentRgb(finalRgba, finalRaw.info.channels)
    const result = await sharp(finalRgba, {
      raw: {
        width: finalRaw.info.width,
        height: finalRaw.info.height,
        channels: finalRaw.info.channels,
      },
    }).png().toBuffer()
    return `data:image/png;base64,${result.toString('base64')}`
  } catch {
    return dataUrl
  }
}
