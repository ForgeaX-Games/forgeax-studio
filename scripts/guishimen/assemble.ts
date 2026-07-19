// 组装鬼市门合并 scenario:剧情线 + 战斗段(demo-001 补 media.ref)。
// 键冲突(sceneId / 变量名)必须为零 —— fail fast。
// 剧情段 durationMs 从 mp4 真实时长 + offset 派生(见 story-scenario DURATION_OFFSETS)。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  buildStoryScenes,
  STORY_VARIABLES,
  STORY_ROOT_SCENE_ID,
  BATTLE_ENTRY_SCENE_ID,
  STORY_MEDIA_IDS,
  type DurationResolver,
} from './story-scenario'
import { loadDemo001Scenario, loadBattleScenes } from './battle-scenes'
import { CLIP_MAP } from './clip-map'
import { readMp4DurationMs } from './mp4-duration'

export const SCENARIO_ID = 'guishimen-main'
const TITLE = '鬼市门 · 幽冥渡'

const HERE = dirname(fileURLToPath(import.meta.url)) // <repo>/scripts/guishimen
const REPO_ROOT = join(HERE, '..', '..') // <repo>
const BLOBS_DIR = join(REPO_ROOT, '.forgeax/games/guishimen/game-video/assets/blobs')

/**
 * 真实时长解析器:mediaId → mp4 真实时长(ms)。
 * 走 CLIP_MAP 找到 blob 文件名,读 mp4 头。文件缺失/读不到返回 undefined
 * (story-scenario 内部有 FALLBACK 兜底,但正常路径应能读到)。
 */
export function makeDurationResolver(): DurationResolver {
  const blobByMedia = new Map(CLIP_MAP.map((e) => [e.mediaId, e.blob]))
  const cache = new Map<string, number | undefined>()
  return (mediaId: string) => {
    if (cache.has(mediaId)) return cache.get(mediaId)
    const blob = blobByMedia.get(mediaId)
    const p = blob ? join(BLOBS_DIR, blob) : undefined
    const dur = p && existsSync(p) ? readMp4DurationMs(p) : undefined
    cache.set(mediaId, dur)
    return dur
  }
}

export function assembleScenario(durationOf: DurationResolver = makeDurationResolver()): any {
  const battle = loadBattleScenes(loadDemo001Scenario())
  const storyScenes = buildStoryScenes(durationOf)

  // 键冲突检测(剧情 vs 战斗)
  const storySceneIds = Object.keys(storyScenes)
  const battleSceneIds = Object.keys(battle.scenes)
  const sceneClash = storySceneIds.filter((id) => battleSceneIds.includes(id))
  if (sceneClash.length) throw new Error(`sceneId clash story↔battle: ${sceneClash.join(',')}`)

  const storyVarIds = Object.keys(STORY_VARIABLES)
  const battleVarIds = Object.keys(battle.variables)
  const varClash = storyVarIds.filter((id) => battleVarIds.includes(id))
  if (varClash.length) throw new Error(`variable clash story↔battle: ${varClash.join(',')}`)

  // 战斗入口存在性
  if (!battle.scenes[BATTLE_ENTRY_SCENE_ID]) throw new Error(`battle entry ${BATTLE_ENTRY_SCENE_ID} missing`)

  return {
    id: SCENARIO_ID,
    title: TITLE,
    synopsis: '幽冥渡:叩问三关(鬼门/渡河/上岸)→ 孟婆桥抉择(应/默)→ 引路驱雾 → 决战无常豺。剧情线接回合制战斗。',
    originIdea: '从现成武侠幽冥视频素材 + 战斗蓝图(demo-001)迁移,照《叙事流程》搭剧情线。',
    rootSceneId: STORY_ROOT_SCENE_ID,
    defaultCharMs: 32,
    schemaVersion: 10,
    modules: { gameplay: true, rules: true },
    variables: { ...STORY_VARIABLES, ...battle.variables },
    entities: battle.entities,
    ui: battle.ui,
    characters: {},
    locations: {},
    ext: battle.ext,
    // 战斗子流程图(subFlow):a_my/b_ai 的 subFlowRef 靠它重定向到技能栏 wait / 受击QTE bt。
    blueprintGraphs: battle.blueprintGraphs,
    scenes: { ...storyScenes, ...battle.scenes },
  }
}

export function assembleDb(now: number): any {
  const scenario = assembleScenario()
  return {
    version: 1,
    activeId: SCENARIO_ID,
    items: [{ id: SCENARIO_ID, title: TITLE, scenario, createdAt: now, updatedAt: now }],
  }
}

export { STORY_MEDIA_IDS }
