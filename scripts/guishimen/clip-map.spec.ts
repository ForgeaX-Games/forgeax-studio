import { test, expect } from 'bun:test'
import { CLIP_MAP, mediaIdForClipId } from './clip-map'

test('40 entries, split 14/17/9', () => {
  expect(CLIP_MAP.length).toBe(40)
  expect(CLIP_MAP.filter((e) => e.category === 'battle').length).toBe(14)
  expect(CLIP_MAP.filter((e) => e.category === 'story').length).toBe(17)
  expect(CLIP_MAP.filter((e) => e.category === 'spare').length).toBe(9)
})

test('mediaId, blob, src all unique', () => {
  for (const key of ['mediaId', 'blob', 'src'] as const) {
    const vals = CLIP_MAP.map((e) => e[key])
    expect(new Set(vals).size).toBe(40)
  }
})

test('every battle entry has a clipId; story/spare have none', () => {
  for (const e of CLIP_MAP) {
    if (e.category === 'battle') expect(e.clipId).toBeTruthy()
    else expect(e.clipId).toBeUndefined()
  }
})

test('mediaIdForClipId resolves the 13 clipIds demo-001 uses', () => {
  const used = ['vd-wcc-idle','vd-wcc-qianyao','vd-wcc-pugong','vd-wcc-pugong2','vd-wcc-zhong','vd-wcc-zhong2','vd-wcc-dazhao','vd-wcc-fangfan','vd-wcc-shanbi','vd-wcc-huiqi','vd-wcc-shouji','vd-wcc-shengli','vd-wcc-shibai']
  for (const c of used) expect(mediaIdForClipId(c)).toMatch(/^m-clip-/)
})
