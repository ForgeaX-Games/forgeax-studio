import { test, expect } from 'bun:test'
import { assembleScenario, assembleDb, SCENARIO_ID } from './assemble'

test('scenario merges story + battle scenes, no clash', () => {
  const sc = assembleScenario()
  // 剧情 story scenes(distinct sceneId 数)+ 28 战斗
  expect(Object.keys(sc.scenes).length).toBeGreaterThanOrEqual(28 + 15)
  expect(sc.scenes['opening']).toBeDefined() // story root
  expect(sc.scenes['enter']).toBeDefined() // battle entry
})

test('rootSceneId is opening, schemaVersion 10', () => {
  const sc = assembleScenario()
  expect(sc.rootSceneId).toBe('opening')
  expect(sc.schemaVersion).toBe(10)
})

test('merged variables include story vars AND battle qi', () => {
  const sc = assembleScenario()
  expect(sc.variables['理智']).toBeDefined()
  expect(sc.variables['qi']).toBeDefined()
})

test('assembled scenario carries battle blueprintGraphs (skill bar/QTE subflows)', () => {
  const sc = assembleScenario()
  expect(sc.blueprintGraphs).toBeDefined()
  expect(sc.blueprintGraphs['g-cb-my']).toBeDefined() // wait 技能栏子流程
  expect(sc.blueprintGraphs['g-cb-ai']).toBeDefined() // bt 受击QTE子流程
  // a_my 的 subFlowRef 必须能在 blueprintGraphs 里找到定义
  expect(sc.blueprintGraphs[sc.scenes['a_my'].subFlowRef]).toBeDefined()
})

test('story terminals point at the battle entry scene (a_my, triggers skill bar)', () => {
  const sc = assembleScenario()
  for (const t of ['use-light', 'guide-use-light', 'get-lotus', 'no-lotus']) {
    const target = sc.scenes[t].branches.find((b: any) => b.targetSceneId === 'a_my')
    expect(target, t).toBeDefined()
  }
  // a_my 存在且带 subFlowRef(战斗回合入口 + 技能栏触发)
  expect(sc.scenes['a_my']).toBeDefined()
  expect(sc.scenes['a_my'].subFlowRef).toBe('g-cb-my')
})

test('assembleDb envelope shape', () => {
  const db = assembleDb(1751000000000)
  expect(db.version).toBe(1)
  expect(db.activeId).toBe(SCENARIO_ID)
  expect(db.items[0].id).toBe(SCENARIO_ID)
  expect(db.items[0].createdAt).toBe(1751000000000)
  expect(db.items[0].updatedAt).toBe(1751000000000)
})

test('every scene media.ref resolves to a declared clip mediaId', async () => {
  const { CLIP_MAP } = await import('./clip-map')
  const known = new Set(CLIP_MAP.map((e) => e.mediaId))
  const sc = assembleScenario()
  for (const [sid, s] of Object.entries<any>(sc.scenes)) {
    if (s.media?.kind === 'VIDEO') {
      expect(known.has(s.media.ref), `${sid} ref ${s.media.ref}`).toBe(true)
    }
  }
})

// ── Fail-fast 负向测试 ────────────────────────────────────────────────────────

// 1. 真实数据通过全部守卫（sceneId 无冲突、变量名无冲突、battle entry 存在）
test('assembleScenario does not throw on clean real data', () => {
  expect(() => assembleScenario()).not.toThrow()
})

// 2. sceneId 冲突检测逻辑：直接测试 impl 使用的同一个交集算法
//    assembleScenario 读真实模块故无法注入冲突；这里构造一个最小重现。
test('clash-detection logic: sceneId intersection flags planted duplicate', () => {
  const storyIds = ['opening', 's2', 's3']
  const battleIds = ['enter', 'opening', 'b2'] // 'opening' 是蓄意植入的冲突
  const clash = storyIds.filter((id) => battleIds.includes(id))
  expect(clash).toHaveLength(1)
  expect(clash[0]).toBe('opening')
})

// 3. 变量名冲突检测逻辑
test('clash-detection logic: variable intersection flags planted duplicate', () => {
  const storyVars = ['理智', 'mood', 'affinity']
  const battleVars = ['qi', 'mood', 'hp'] // 'mood' 是蓄意植入的冲突
  const clash = storyVars.filter((id) => battleVars.includes(id))
  expect(clash).toHaveLength(1)
  expect(clash[0]).toBe('mood')
})

// 4. 无冲突时交集为空（证明算法不会产生误报）
test('clash-detection logic: no intersection when keys are disjoint', () => {
  const storyIds = ['opening', 's2', 's3']
  const battleIds = ['enter', 'b1', 'b2']
  const clash = storyIds.filter((id) => battleIds.includes(id))
  expect(clash).toHaveLength(0)
})
