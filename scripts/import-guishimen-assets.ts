// 鬼市门一次性导入:拷贝 40 视频→blobs/(重命名),生成 manifest/forge/scenarios。
// 幂等:重跑覆盖(不追加)。用法:bun scripts/import-guishimen-assets.ts
/* eslint-disable no-console */
import { mkdirSync, copyFileSync, writeFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { CLIP_MAP } from './guishimen/clip-map'
import { assembleDb, SCENARIO_ID } from './guishimen/assemble'

const SRC = '/Users/you/Downloads/video.chi1.4.boarding-1'
const REPO = '/Users/you/github/forgeax-studio'
const GAME = join(REPO, '.forgeax/games/guishimen')
const GV = join(GAME, 'game-video')
const BLOBS = join(GV, 'assets/blobs')
const NOW = 1751414400000 // 固定时间戳,保证幂等(不用 Date.now())

function main() {
  // 0) 前置:源目录齐全
  const missing = CLIP_MAP.filter((e) => !existsSync(join(SRC, e.src)))
  if (missing.length) {
    console.error('MISSING source files:', missing.map((m) => m.src))
    process.exit(1)
  }

  // 1) 目录
  mkdirSync(BLOBS, { recursive: true })

  // 2) 拷贝 + manifest
  const assets = CLIP_MAP.map((e) => {
    const dst = join(BLOBS, e.blob)
    copyFileSync(join(SRC, e.src), dst)
    const bytes = statSync(dst).size
    const id = e.blob.replace(/\.mp4$/, '')
    return {
      id,
      kind: 'video' as const,
      filename: `blobs/${e.blob}`,
      mimeType: 'video/mp4',
      bytes,
      createdAt: NOW,
      meta: { mediaId: e.mediaId, scenarioId: SCENARIO_ID, source: 'local-import' },
    }
  })
  writeFileSync(join(GV, 'assets/manifest.json'), JSON.stringify({ version: 1, assets }, null, 2))

  // 3) forge.json
  writeFileSync(
    join(GAME, 'forge.json'),
    JSON.stringify(
      {
        name: 'guishimen',
        displayName: '鬼市门',
        description: '互动影游 · 幽冥渡(剧情线 + Boss 战 / QTE,wb-game-video)',
        projectType: 'game-video',
        forgeVersion: '1.0.0',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      null,
      2,
    ),
  )

  // 4) scenarios.json
  writeFileSync(join(GV, 'scenarios.json'), JSON.stringify(assembleDb(NOW), null, 2))

  console.log(`imported ${assets.length} videos → ${BLOBS}`)
  console.log(`wrote forge.json + scenarios.json (scenario ${SCENARIO_ID})`)
}

main()
