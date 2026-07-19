import { test, expect } from 'bun:test'
import { loadDemo001Scenario, loadBattleScenes } from './battle-scenes'

test('demo-001 loads with 28 scenes and enter present', () => {
  const sc = loadDemo001Scenario()
  expect(Object.keys(sc.scenes).length).toBe(28)
  expect(sc.scenes['enter']).toBeDefined()
})

test('battle scenes pass through verbatim — media unchanged (stays PLACEHOLDER)', () => {
  const before = loadDemo001Scenario()
  const { scenes } = loadBattleScenes(before)
  for (const [sid, s] of Object.entries<any>(scenes)) {
    // media 必须与 demo-001 原样一致(战斗保持 PLACEHOLDER,不接真视频,
    // 否则 loop+VIDEO 下 static choice 技能菜单会消失 → 攻击操作没了)
    expect(s.media, sid).toEqual(before.scenes[sid].media)
    if (before.scenes[sid].clipId) expect(s.clipId, sid).toBe(before.scenes[sid].clipId)
  }
})

test('wait scene keeps PLACEHOLDER + loop + static choice (attack menu intact)', () => {
  const { scenes } = loadBattleScenes(loadDemo001Scenario())
  const wait = scenes['wait']
  expect(wait.media.kind).toBe('PLACEHOLDER')
  expect(wait.mediaPlayMode).toBe('loop')
  expect(wait.kind).toBe('choice')
  const labels = wait.branches.map((b: any) => b.label)
  expect(labels).toEqual(expect.arrayContaining(['轻攻击', '重攻击', '冥想', '灭世']))
})

test('non-clip fields (performance/branches/decision) are untouched', () => {
  const before = loadDemo001Scenario()
  const { scenes } = loadBattleScenes(before)
  // 'pu' has a performance cue with entityStat -80; must survive verbatim
  expect(scenes['pu'].performance).toEqual(before.scenes['pu'].performance)
  expect(scenes['pu'].branches).toEqual(before.scenes['pu'].branches)
  expect(scenes['wait'].decision).toEqual(before.scenes['wait'].decision)
})

test('entities and combatRules carried over', () => {
  const { entities, ext } = loadBattleScenes(loadDemo001Scenario())
  expect(entities['ent-player']).toBeDefined()
  expect(entities['ent-boss']).toBeDefined()
  expect(ext.combatRules).toBeDefined()
})

test('blueprintGraphs (battle subflows) carried over — skill bar/QTE depend on them', () => {
  const before = loadDemo001Scenario()
  const { blueprintGraphs } = loadBattleScenes(before)
  // g-cb-my(rootScene wait 技能栏)/ g-cb-ai(rootScene bt 受击QTE)必须带过来
  expect(blueprintGraphs['g-cb-my']).toBeDefined()
  expect(blueprintGraphs['g-cb-ai']).toBeDefined()
  expect(blueprintGraphs).toEqual(before.blueprintGraphs)
})

test('scenes retain subFlowRef (a_my→g-cb-my redirect to skill bar)', () => {
  const { scenes } = loadBattleScenes(loadDemo001Scenario())
  expect(scenes['a_my'].subFlowRef).toBe('g-cb-my')
  expect(scenes['b_ai'].subFlowRef).toBe('g-cb-ai')
})
