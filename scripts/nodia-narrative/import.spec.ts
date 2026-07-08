import { test, expect } from 'bun:test'
import { buildManifest } from '../import-nodia-narrative'
import { NARR_CLIPS } from './clip-map'

test('manifest has 17 entries, mediaId+scenarioId in meta', () => {
  const m: any = buildManifest(NARR_CLIPS.map((c) => ({ ...c, bytes: 100 })))
  expect(m.version).toBe(1)
  expect(m.assets.length).toBe(17)
  const a = m.assets[0]
  expect(a.filename).toMatch(/^blobs\//)
  expect(a.meta.scenarioId).toBe('nodia-main')
  expect(a.meta.mediaId).toBe(NARR_CLIPS[0].mediaId)
})
