// 鬼市门叙事装配:读游戏目录 blobs/ 里已就位的 17 段 narr-*.mp4 → 写 manifest + 合并 scenarios。
// 视频源就是游戏目录本身(game-video/assets/blobs/),不再从外部拷贝。
// 用法: bun scripts/import-nodia-narrative.ts
//   前提:17 段 narr-*.mp4(文件名见 clip-map 的 blob)已放在
//   packages/games/game-nodia-fighting/game-video/assets/blobs/(gitignored,随 rsync/手拷分发)。
// 幂等:重跑覆盖 manifest,scenarios 需纯战斗基线(见 docs/RUN-nodia.md)。
/* eslint-disable no-console */
import { writeFileSync, readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { NARR_CLIPS, SCENARIO_ID, type NarrClip } from './nodia-narrative/clip-map'
import { assembleDb } from './nodia-narrative/assemble'

const GV = join(import.meta.dir, '../packages/games/game-nodia-fighting/game-video')
const BLOBS = join(GV, 'assets/blobs')
const NOW = 1751500000000 // 固定时间戳保证幂等

export function buildManifest(clips: Array<NarrClip & { bytes: number }>) {
  return {
    version: 1,
    assets: clips.map((c) => ({
      id: c.blob.replace(/\.mp4$/, ''),
      kind: 'video' as const,
      filename: `blobs/${c.blob}`,
      mimeType: 'video/mp4',
      bytes: c.bytes,
      createdAt: NOW,
      meta: { mediaId: c.mediaId, scenarioId: SCENARIO_ID, source: 'local-import' },
    })),
  }
}

function main() {
  // 0) 前置:blobs/ 里 17 段视频齐全(视频源即游戏目录)
  const missing = NARR_CLIPS.filter((c) => !existsSync(join(BLOBS, c.blob)))
  if (missing.length) {
    console.error(
      `游戏目录缺少叙事视频 —— ${BLOBS}\n` +
        `缺失: ${missing.map((m) => m.blob).join(', ')}\n` +
        '请先把 17 段 narr-*.mp4 放到该 blobs/ 目录(见 docs/RUN-nodia.md)。',
    )
    process.exit(1)
  }

  // 1) 读 blobs 里已就位的视频,记录 bytes
  const withBytes = NARR_CLIPS.map((c) => ({
    ...c,
    bytes: statSync(join(BLOBS, c.blob)).size,
  }))

  // 2) 写 manifest
  writeFileSync(join(GV, 'assets/manifest.json'), JSON.stringify(buildManifest(withBytes), null, 2))

  // 3) 合并 scenarios.json —— updatedAt 用 Date.now() bump,确保前端磁盘对账采纳本次装配
  //    (否则等于旧值,陈旧 localStorage 恒胜,装配到不了运行时)。
  const rawDb = JSON.parse(readFileSync(join(GV, 'scenarios.json'), 'utf8'))
  writeFileSync(join(GV, 'scenarios.json'), JSON.stringify(assembleDb(rawDb, Date.now()), null, 2))

  console.log(`✓ 装配 ${withBytes.length} 段叙事视频(游戏目录 blobs/),合并 scenarios(root=n_open)`)
}

if (import.meta.main) main()
