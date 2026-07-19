import { test, expect } from 'bun:test'
import { durationMsFromMp4Buffer } from './mp4-duration'

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(payload, 8)
  return out
}

test('durationMsFromMp4Buffer reads version-0 mvhd timescale and duration', () => {
  const mvhdPayload = new Uint8Array(4 + 4 + 4 + 4 + 4)
  const view = new DataView(mvhdPayload.buffer)
  view.setUint32(12, 1_000) // timescale
  view.setUint32(16, 12_345) // duration units

  const buffer = box('moov', box('mvhd', mvhdPayload))

  expect(durationMsFromMp4Buffer(buffer)).toBe(12_345)
})

