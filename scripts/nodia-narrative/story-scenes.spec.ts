import { test, expect } from 'bun:test'
import { buildStoryScenes, NARR_VARIABLES, NARR_ROOT } from './story-scenes'

const S = buildStoryScenes()

test('17 scenes, root is n_open', () => {
  expect(Object.keys(S).length).toBe(17)
  expect(NARR_ROOT).toBe('n_open')
  expect(S['n_open']).toBeDefined()
})
test('six variables with HTML-authoritative initials', () => {
  expect(NARR_VARIABLES.lizhi.initial).toBe(5)
  expect(NARR_VARIABLES.foxing.initial).toBe(10)
  expect(NARR_VARIABLES.yezhang.initial).toBe(1)
  expect(NARR_VARIABLES.chi.initial).toBe(1)
  expect(NARR_VARIABLES.guihuo).toBeDefined()
  expect(NARR_VARIABLES.lotusClue.kind).toBe('flag')
})
test('n_door is inkKou qte: pass→n_soul, fail(timeout)→n_river', () => {
  const d = S['n_door']
  expect(d.kind).toBe('qte')
  expect(d.ext?.qteUi).toBe('inkKou')
  expect(d.hudPreset).toBe('hidden')
  expect(d.qte?.cues?.[0]?.appearAt).toBe(9000)
  const pass = d.branches.find((b) => b.kind === 'qte_pass')
  const fail = d.branches.find((b) => b.kind === 'qte_fail')
  expect(pass?.targetSceneId).toBe('n_soul')
  expect(fail?.targetSceneId).toBe('n_river')
})
test('choice scenes are inkYingMo, timed, video_end, 8s timeout to 默', () => {
  for (const id of ['n_river','n_land','n_tea','n_nodrink','n_follow','n_nofollow']) {
    const s = S[id]
    expect(s.kind).toBe('choice')
    expect(s.ext?.choiceUi).toBe('inkYingMo')
    expect(s.decision?.optType).toBe('timed')
    expect(s.decision?.fireAt).toBe('video_end')
    expect(s.decision?.timeoutMs).toBe(8000)
    expect(s.decision?.defaultBranchId).toBeDefined()
    const mo = s.branches.find((b) => b.id === s.decision?.defaultBranchId)
    expect(mo?.label).toBe('默')
    // 窗口必须非空且盖住视频末尾(否则选项永不弹 —— 回归防护)
    expect(s.decision.windowStartMs).toBeLessThan(s.decision.windowEndMs)
    expect(s.decision.windowEndMs).toBe(s.durationMs)
    expect(s.decision.windowStartMs).toBeGreaterThanOrEqual(0)
  }
})
test('n_drink is the ONLY narrative scene with effects (理智-1 业障+1)', () => {
  const withEffects = Object.entries(S).filter(([, s]) => (s.branches ?? []).some((b) => (b.effects?.length ?? 0) > 0) || (s.performance?.cues?.length ?? 0) > 0)
  // drink 与 nolotus 都带 effect(nolotus 置 flag)；四维飘字只 drink
  const drink = S['n_drink']
  const eff = (drink.branches[0].effects ?? [])
  expect(eff).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'var', varId: 'lizhi', op: 'add', value: -1 }),
    expect.objectContaining({ kind: 'var', varId: 'yezhang', op: 'add', value: 1 }),
  ]))
})
test('all four terminal scenes route to battle entry enter', () => {
  for (const id of ['n_getlight','n_nolight','n_lotus','n_nolotus']) {
    expect(S[id].branches[0].targetSceneId).toBe('enter')
  }
})
test('every branch target exists within narrative or is enter', () => {
  const ids = new Set(Object.keys(S))
  for (const s of Object.values(S)) {
    for (const b of s.branches) {
      expect(ids.has(b.targetSceneId) || b.targetSceneId === 'enter').toBe(true)
    }
  }
})
