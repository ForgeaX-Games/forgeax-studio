import { test, expect } from 'bun:test'
import { NARR_CLIPS, SCENARIO_ID } from './clip-map'

test('17 narrative clips, all fields unique', () => {
  expect(NARR_CLIPS.length).toBe(17)
  for (const key of ['src', 'blob', 'mediaId', 'sceneId'] as const) {
    expect(new Set(NARR_CLIPS.map((c) => c[key])).size).toBe(17)
  }
})
test('blob names have no spaces/commas', () => {
  for (const c of NARR_CLIPS) expect(c.blob).toMatch(/^[a-z0-9-]+\.mp4$/)
})
test('every sceneId is n_ prefixed; durMs positive', () => {
  for (const c of NARR_CLIPS) {
    expect(c.sceneId.startsWith('n_')).toBe(true)
    expect(c.durMs).toBeGreaterThan(0)
  }
})
test('scenario id is nodia-main (not reserved demo-001)', () => { expect(SCENARIO_ID).toBe('nodia-main') })
