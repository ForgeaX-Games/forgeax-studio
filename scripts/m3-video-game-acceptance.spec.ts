import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initializeGamePackage } from '../packages/platform-io/src/api/lib/game-package'

const root = resolve(import.meta.dir, '..')
const manifestPath = join(root, 'packages/games/game-nodia-fighting/assets/manifest.json')
type Asset = { id: string; name?: string; provider?: { ref?: string } }

const readCanonicalSeed = () => ({
  blueprint: JSON.parse(readFileSync(join(root, 'packages/games/game-nodia-fighting/blueprint.json'), 'utf8')),
  assetsManifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
})

const collectVideoRefs = (value: unknown, refs = new Set<string>()): Set<string> => {
  if (!value || typeof value !== 'object') return refs
  if (Array.isArray(value)) {
    for (const item of value) collectVideoRefs(item, refs)
    return refs
  }
  const record = value as Record<string, unknown>
  const media = record.media
  if (media && typeof media === 'object' && !Array.isArray(media)) {
    const mediaRecord = media as Record<string, unknown>
    if (mediaRecord.kind === 'VIDEO' && typeof mediaRecord.ref === 'string') refs.add(mediaRecord.ref)
  }
  for (const child of Object.values(record)) collectVideoRefs(child, refs)
  return refs
}

describe('M3 canonical video-game acceptance', () => {
  test('keeps the canonical v2 manifest at 31 assets with qinggongjizhisi', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: number
      assets: Asset[]
    }
    expect(manifest.version).toBe(2)
    expect(manifest.assets).toHaveLength(31)
    expect(manifest.assets.some((asset) => asset.id === 'qinggongjizhisi')).toBe(true)
  })

  test('resolves every canonical provider ref to a built video asset', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { assets: Asset[] }
    const refs = manifest.assets.map((asset) => asset.provider?.ref).filter((ref): ref is string => Boolean(ref))
    expect(refs).toHaveLength(31)
    expect(new Set(refs).size).toBe(31)
    for (const asset of manifest.assets) {
      const ref = asset.provider?.ref
      if (!ref) continue
      const sourceName = asset.name ?? `${asset.id}.mp4`
      expect(existsSync(join(root, 'packages/marketplace/extensions/wb-game-video/src/editor/assets/zhandou', sourceName))).toBe(true)
    }
  })

  test('initializes an empty game from the canonical seed and verifies the written output', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'm3-video-game-'))
    const gameDir = join(tempRoot, 'game-nodia-fighting')
    try {
      const seed = readCanonicalSeed()
      initializeGamePackage(gameDir, 'game-nodia-fighting', seed)

      const outputManifest = JSON.parse(readFileSync(join(gameDir, 'assets/manifest.json'), 'utf8')) as {
        version: number
        assets: Asset[]
      }
      const outputBlueprint = JSON.parse(readFileSync(join(gameDir, 'blueprint.json'), 'utf8'))
      expect(outputManifest.version).toBe(2)
      expect(outputManifest.assets).toHaveLength(31)
      expect(outputManifest.assets.some((asset) => asset.id === 'qinggongjizhisi')).toBe(true)

      const outputRefs = collectVideoRefs(outputBlueprint)
      expect(outputRefs).toHaveLength(30)
      expect(new Set(outputRefs).size).toBe(30)
      for (const ref of outputRefs) {
        const asset = outputManifest.assets.find((candidate) => candidate.id === ref)
        expect(asset?.provider?.ref).toBeString()
        const sourceName = asset?.name ?? `${asset?.id}.mp4`
        expect(existsSync(join(root, 'packages/marketplace/extensions/wb-game-video/src/editor/assets/zhandou', sourceName))).toBe(true)
      }
      expect(existsSync(join(gameDir, 'project.json'))).toBe(true)
      expect(existsSync(join(gameDir, 'blueprint.json'))).toBe(true)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('rejects a mismatched seed without leaving partial package files', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'm3-video-game-bad-seed-'))
    const gameDir = join(tempRoot, 'game-nodia-fighting')
    try {
      const seed = readCanonicalSeed()
      seed.assetsManifest.assets = seed.assetsManifest.assets.slice(0, 30)
      expect(() => initializeGamePackage(gameDir, 'game-nodia-fighting', seed)).toThrow(/exactly 31 assets/)
      expect(existsSync(gameDir)).toBe(false)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
