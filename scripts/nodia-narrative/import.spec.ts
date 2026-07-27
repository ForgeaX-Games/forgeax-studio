import { test, expect } from 'bun:test'
import { buildManifest } from '../import-nodia-narrative'
import { NARR_CLIPS } from './clip-map'
import { mergeSharedAssetManifest } from '../video-asset-manifest'

test('manifest has 17 canonical v2 provider-backed entries', () => {
  const m: any = buildManifest(NARR_CLIPS.map((c) => ({ ...c, bytes: 100 })))
  expect(m.version).toBe(2)
  expect(m.assets.length).toBe(17)
  const a = m.assets[0]
  expect(a.id).toBe(NARR_CLIPS[0].mediaId)
  expect(a.provider).toEqual({ kind: 'local', ref: `blobs/${NARR_CLIPS[0].blob}` })
  expect(a.meta.scenarioId).toBe('nodia-main')
  expect(a.meta.mediaId).toBeUndefined()
})

test('manifest import replaces narrative ids without deleting foreign assets', () => {
  const imported = buildManifest(NARR_CLIPS.map((c) => ({ ...c, bytes: 100 })))
  const existingNarrative = { ...imported.assets[0], provider: { kind: 'cos', ref: 'old.mp4' } }
  const foreign = {
    id: 'generated-image',
    kind: 'image',
    productionType: 'shot_image',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const merged = mergeSharedAssetManifest(
    { version: 2, styleAxes: { artMedia: 'ink' }, assets: [foreign, existingNarrative] },
    imported.assets,
  )

  expect(merged.version).toBe(2)
  expect(merged.styleAxes).toEqual({ artMedia: 'ink' })
  expect(merged.assets[0]).toEqual(foreign)
  expect(merged.assets.find((asset) => asset.id === imported.assets[0].id)).toEqual(imported.assets[0])
  expect(merged.assets.length).toBe(18)
})

test('manifest import refuses to overwrite an id owned by another asset domain', () => {
  const imported = buildManifest(NARR_CLIPS.map((c) => ({ ...c, bytes: 100 })))
  const collision = {
    id: imported.assets[0].id,
    kind: 'image',
    productionType: 'shot_image',
  }

  expect(() =>
    mergeSharedAssetManifest({ version: 2, assets: [collision] }, imported.assets),
  ).toThrow('asset id is owned by another asset domain')
})
