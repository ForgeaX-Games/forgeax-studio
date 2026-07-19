import { test, expect } from 'bun:test'
import { assembleDb } from './assemble'

// 纯战斗基线 fixture —— 自包含,不读工作树 scenarios.json(该文件导入后已是合并态,
// 会让 assemble 二次合并触发冲突)。这里只放 assemble 会校验/保留的战斗字段,
// 校验「叙事并入 + 战斗 scene 深等不变 + sceneId 冲突抛错」三个不变量。
function battleBaseline() {
  return {
    version: 1,
    activeId: 'demo-001',
    items: [
      {
        id: 'demo-001',
        title: '战斗蓝图',
        scenario: {
          id: 'demo-001',
          rootSceneId: 'enter',
          variables: { qi: { id: 'qi', name: '气力', kind: 'number', initial: 0, min: 0, max: 5 } },
          entities: {
            'ent-player': { id: 'ent-player', name: '空藏', kind: 'player', maxHp: 300, initialHp: 300 },
            'ent-boss': { id: 'ent-boss', name: '小怪', kind: 'boss', maxHp: 700, initialHp: 700 },
          },
          scenes: {
            enter: { id: 'enter', title: '进战待机', clipId: 'vd-wcc-idle', branches: [{ id: 'e-init', kind: 'auto', targetSceneId: 'init', label: 'Out' }] },
            init: { id: 'init', title: '出手判断', branches: [{ id: 'i-a', kind: 'auto', targetSceneId: 'settle', label: 'Out' }] },
            settle: { id: 'settle', title: '胜负判定', branches: [{ id: 's-win', kind: 'auto', targetSceneId: 'win', label: 'win' }] },
            win: { id: 'win', title: '战斗胜利', clipId: 'vd-wcc-shengli', branches: [] },
            lose: { id: 'lose', title: '战斗失败', clipId: 'vd-wcc-shibai', branches: [] },
          },
          blueprintGraphs: {
            'g-cb-my': { id: 'g-cb-my', rootSceneId: 'wait', sceneIds: ['wait'], parentSceneId: 'a_my' },
            'g-cb-ai': { id: 'g-cb-ai', rootSceneId: 'bt', sceneIds: ['bt'], parentSceneId: 'b_ai' },
          },
        },
      },
    ],
  }
}

test('assemble adds 17 narrative scenes, keeps battle scenes + root→n_open + renames off demo-001', () => {
  const out: any = assembleDb(battleBaseline())
  const sc = out.items[0].scenario
  expect(sc.rootSceneId).toBe('n_open')
  expect(sc.scenes['enter']).toBeDefined() // 战斗入口不动
  expect(sc.scenes['win']).toBeDefined()
  expect(Object.keys(sc.scenes).length).toBe(5 + 17) // 基线 5 战斗 scene + 17 叙事
  expect(sc.variables.qi).toBeDefined() // 战斗变量不动
  expect(sc.variables.lizhi.initial).toBe(5) // 叙事变量并入
  expect(Object.keys(sc.blueprintGraphs)).toEqual(expect.arrayContaining(['g-cb-my', 'g-cb-ai']))
  // 脱离保留 id demo-001:三处协同改名为 nodia-main
  expect(sc.id).toBe('nodia-main')
  expect(out.items[0].id).toBe('nodia-main')
  expect(out.activeId).toBe('nodia-main')
})

test('battle scenes are byte-identical (deep equal) after assemble', () => {
  const raw = battleBaseline()
  const out: any = assembleDb(raw)
  const before = raw.items[0].scenario.scenes
  const after = out.items[0].scenario.scenes
  for (const id of Object.keys(before)) {
    expect(after[id]).toEqual(before[id]) // 逐个战斗 scene 深等
  }
})

test('throws on sceneId clash', () => {
  const clash = battleBaseline()
  ;(clash.items[0].scenario.scenes as Record<string, unknown>)['n_open'] = { id: 'n_open' }
  expect(() => assembleDb(clash)).toThrow()
})

test('throws when battle entry enter is missing', () => {
  const noEnter = battleBaseline()
  delete (noEnter.items[0].scenario.scenes as Record<string, unknown>)['enter']
  expect(() => assembleDb(noEnter)).toThrow()
})

test('bumps item.updatedAt when provided (so frontend disk-reconcile adopts import)', () => {
  const base = battleBaseline()
  ;(base.items[0] as Record<string, unknown>).updatedAt = 1000
  const out: any = assembleDb(base, 9999)
  expect(out.items[0].updatedAt).toBe(9999)
  // 不传则不动(幂等场景)
  const base2 = battleBaseline()
  ;(base2.items[0] as Record<string, unknown>).updatedAt = 1000
  expect((assembleDb(base2) as any).items[0].updatedAt).toBe(1000)
})
