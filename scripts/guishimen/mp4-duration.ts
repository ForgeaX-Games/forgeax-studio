import { readFileSync } from 'fs'

const HEADER_SIZE = 8

export function readMp4DurationMs(path: string): number | undefined {
  return durationMsFromMp4Buffer(readFileSync(path))
}

export function durationMsFromMp4Buffer(buffer: Uint8Array): number | undefined {
  const mvhd = findBox(buffer, ['moov', 'mvhd'])
  if (!mvhd) return undefined

  const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength)
  const version = view.getUint8(0)
  if (version === 0) {
    const timescale = view.getUint32(12)
    const duration = view.getUint32(16)
    return toMs(duration, timescale)
  }
  if (version === 1) {
    const timescale = view.getUint32(20)
    const duration = Number(view.getBigUint64(24))
    return toMs(duration, timescale)
  }
  return undefined
}

function toMs(duration: number, timescale: number): number | undefined {
  if (!Number.isFinite(duration) || timescale <= 0) return undefined
  return Math.round((duration / timescale) * 1000)
}

function findBox(buffer: Uint8Array, path: string[]): Uint8Array | undefined {
  if (path.length === 0) return buffer
  const [target, ...rest] = path

  let offset = 0
  while (offset + HEADER_SIZE <= buffer.byteLength) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_SIZE)
    const size32 = view.getUint32(0)
    const type = readType(buffer, offset + 4)
    let headerSize = HEADER_SIZE
    let size = size32

    if (size32 === 1) {
      if (offset + 16 > buffer.byteLength) return undefined
      size = Number(new DataView(buffer.buffer, buffer.byteOffset + offset + 8, 8).getBigUint64(0))
      headerSize = 16
    } else if (size32 === 0) {
      size = buffer.byteLength - offset
    }

    if (size < headerSize || offset + size > buffer.byteLength) return undefined

    const payload = buffer.subarray(offset + headerSize, offset + size)
    if (type === target) {
      return findBox(payload, rest)
    }
    offset += size
  }
  return undefined
}

function readType(buffer: Uint8Array, offset: number): string {
  return String.fromCharCode(buffer[offset] ?? 0, buffer[offset + 1] ?? 0, buffer[offset + 2] ?? 0, buffer[offset + 3] ?? 0)
}

