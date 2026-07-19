// 从 demo-001(wuxia-combat)抽战斗段,原样透传(含 PLACEHOLDER media)。
// 战斗保持 demo-001 已验证状态:PLACEHOLDER 占位帧 + loop/static choice 技能菜单可操作。
// —— 不给战斗场景接真视频:loop+VIDEO 下 static choice 技能菜单不显示(攻击操作会消失),
//    故战斗段一律沿用 demo-001 原 media(与 wuxia-combat 一致)。剧情段才接真视频。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))       // <repo>/scripts/guishimen
const REPO_ROOT = join(HERE, '..', '..')                    // <repo>
const DEMO_PATH = join(REPO_ROOT, '.forgeax/games/wuxia-combat/game-video/scenarios.json')

export function loadDemo001Scenario(): any {
  const db = JSON.parse(readFileSync(DEMO_PATH, 'utf-8'))
  const item = db.items.find((i: any) => i.id === 'demo-001') ?? db.items[0]
  return item.scenario
}

/**
 * 抽取战斗段数据块 —— 场景原样透传(不改 media,保留 demo-001 的 PLACEHOLDER)。
 * 战斗玩法/时序/操作与 wuxia-combat 完全一致。
 */
export function loadBattleScenes(scenario: any): {
  scenes: Record<string, any>
  variables: any
  entities: any
  ext: any
  ui: any
  rootSceneId: string
  blueprintGraphs: any
} {
  const scenes: Record<string, any> = {}
  for (const [sid, raw] of Object.entries<any>(scenario.scenes)) {
    scenes[sid] = { ...raw } // 原样透传,含 media(PLACEHOLDER)、subFlowRef
  }
  return {
    scenes,
    variables: scenario.variables ?? {},
    entities: scenario.entities ?? {},
    ext: scenario.ext ?? {},
    ui: scenario.ui ?? {},
    rootSceneId: scenario.rootSceneId,
    // 战斗子流程定义(g-cb-my/g-cb-ai)—— 技能栏(wait)/受击QTE(bt)靠 scene.subFlowRef
    // 重定向到这些子流程的 rootSceneId。缺了它战斗退化成纯 story 自动播放,攻击操作消失。
    blueprintGraphs: scenario.blueprintGraphs ?? {},
  }
}
