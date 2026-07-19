import { buildStoryScenes, NARR_VARIABLES, NARR_ROOT } from './story-scenes'
import { SCENARIO_ID } from './clip-map'

/**
 * 合并叙事进战斗 scenario。
 * @param updatedAt 写给 item.updatedAt —— 必须比前端 localStorage 里的旧副本新,
 *   否则前端磁盘对账(scenarioPersistBoot line 477: diskActive.updatedAt > localActive.updatedAt)
 *   不会采纳磁盘改动,导入内容到不了运行时。导入脚本传 Date.now();测试传固定值。
 */
export function assembleDb(rawDb: any, updatedAt?: number): any {
  const db = structuredClone(rawDb)
  const item = db.items?.[0]
  const sc = item?.scenario
  if (!sc) throw new Error('scenarios.json: items[0].scenario 缺失')
  if (!sc.scenes?.enter) throw new Error('战斗入口 enter 不存在，拒绝合并')

  const story = buildStoryScenes()
  // sceneId 冲突校验
  for (const id of Object.keys(story)) {
    if (sc.scenes[id]) throw new Error(`叙事 sceneId 与战斗冲突: ${id}`)
  }
  // 变量名冲突校验
  for (const id of Object.keys(NARR_VARIABLES)) {
    if (sc.variables?.[id]) throw new Error(`叙事变量与战斗冲突: ${id}`)
  }
  sc.scenes = { ...sc.scenes, ...story }
  sc.variables = { ...(sc.variables ?? {}), ...NARR_VARIABLES }
  sc.rootSceneId = NARR_ROOT

  // 改名脱离保留 id 'demo-001'(前端 bundled demo 会整本顶替同 id 剧本)。
  // 三处协同:db.activeId / item.id / scenario.id 必须一致,manifest.meta.scenarioId
  // 由 clip-map SCENARIO_ID 写同值。
  item.id = SCENARIO_ID
  sc.id = SCENARIO_ID
  db.activeId = SCENARIO_ID

  // bump updatedAt,让前端磁盘对账采纳本次导入(否则等于旧值→陈旧 localStorage 恒胜)。
  if (updatedAt != null) item.updatedAt = updatedAt
  return db
}


