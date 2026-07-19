import { test, expect } from 'bun:test'
import { buildStoryScenes, STORY_VARIABLES, STORY_ROOT_SCENE_ID, BATTLE_ENTRY_SCENE_ID, STORY_MEDIA_IDS, DURATION_OFFSETS } from './story-scenario'

// 注入一个固定的假真实时长(所有片段 15000ms),让场景图可独立测试(不依赖 mp4)。
const FAKE_MS = 15000
const fakeDurationOf = () => FAKE_MS
const SCENES = buildStoryScenes(fakeDurationOf)

test('root scene exists', () => {
  expect(SCENES[STORY_ROOT_SCENE_ID]).toBeDefined()
})

test('every branch targets an existing story scene OR the battle entry', () => {
  const ids = new Set(Object.keys(SCENES))
  for (const [sid, scene] of Object.entries(SCENES)) {
    for (const b of (scene as any).branches ?? []) {
      const ok = ids.has(b.targetSceneId) || b.targetSceneId === BATTLE_ENTRY_SCENE_ID
      expect(ok, `${sid} → ${b.targetSceneId} dangling`).toBe(true)
    }
  }
})

test('four story terminals lead into battle entry', () => {
  const terminals = ['use-light', 'guide-use-light', 'get-lotus', 'no-lotus']
  for (const t of terminals) {
    const outs = (SCENES[t] as any).branches.map((b: any) => b.targetSceneId)
    expect(outs).toContain(BATTLE_ENTRY_SCENE_ID)
  }
})

test('knock scenes are qte with a single tap cue (door/river/boarding labelled 叩)', () => {
  for (const id of ['door', 'river', 'boarding']) {
    const s = SCENES[id] as any
    expect(s.kind).toBe('qte')
    expect(s.qte.cues.length).toBe(1)
    expect(s.qte.cues[0].label).toBe('叩')
    expect(s.branches.some((b: any) => b.kind === 'qte_pass')).toBe(true)
    expect(s.branches.some((b: any) => b.kind === 'qte_fail')).toBe(true)
  }
})

test('choice scenes have timed decision with a valid defaultBranchId', () => {
  for (const id of ['drink-tea', 'guide-choice', 'donot-follow']) {
    const s = SCENES[id] as any
    expect(s.kind).toBe('choice')
    expect(s.decision.optType).toBe('timed')
    const ids = s.branches.map((b: any) => b.id)
    expect(ids).toContain(s.decision.defaultBranchId)
  }
})

test('all media.ref are m-nar-* VIDEO refs', () => {
  for (const s of Object.values(SCENES) as any[]) {
    expect(s.media.kind).toBe('VIDEO')
    expect(s.media.ref).toMatch(/^m-nar-/)
  }
})

test('variables declare the five story vars', () => {
  expect(Object.keys(STORY_VARIABLES).sort()).toEqual(['佛性', '莲花妖线索', '理智', '痴', '鬼火种'].sort())
})

// ── 时长修复(问题1/2)回归测试 ──────────────────────────────────────

test('durationMs is derived as real duration + per-kind offset (not hardcoded)', () => {
  // story 段
  expect((SCENES['opening'] as any).durationMs).toBe(FAKE_MS + DURATION_OFFSETS.story)
  // qte(叩)段
  expect((SCENES['door'] as any).durationMs).toBe(FAKE_MS + DURATION_OFFSETS.qte)
  // choice(应/默)段
  expect((SCENES['drink-tea'] as any).durationMs).toBe(FAKE_MS + DURATION_OFFSETS.choice)
})

test('knock cue targetAt lands BEFORE real video end (so 叩 button actually appears)', () => {
  // 这是问题2的根因回归:cue 必须在视频真实结束(FAKE_MS)之前弹出,否则永不出现。
  for (const id of ['door', 'river', 'boarding', 'follow-guide']) {
    const cue = (SCENES[id] as any).qte.cues[0]
    expect(cue.appearAt, `${id} appearAt`).toBeGreaterThanOrEqual(600)
    expect(cue.targetAt, `${id} targetAt < real end`).toBeLessThan(FAKE_MS)
    expect(cue.appearAt, `${id} appearAt < targetAt`).toBeLessThan(cue.targetAt)
  }
})

test('choice/qte offsets are >= their timeout windows (window not truncated by durationMs)', () => {
  // choice timeoutMs=6000 必须 ≤ choice offset;qte timeoutMs=2000 ≤ qte offset。
  const choiceTimeout = (SCENES['drink-tea'] as any).decision.timeoutMs
  const qteTimeout = (SCENES['door'] as any).qte.timeoutMs
  expect(DURATION_OFFSETS.choice).toBeGreaterThanOrEqual(choiceTimeout)
  expect(DURATION_OFFSETS.qte).toBeGreaterThanOrEqual(qteTimeout)
})

test('STORY_MEDIA_IDS matches the media.ref set used by the graph', () => {
  const usedRefs = new Set(Object.values(SCENES).map((s: any) => s.media.ref))
  for (const ref of usedRefs) expect(STORY_MEDIA_IDS).toContain(ref)
})

// ── 分支/效果回归测试 ────────────────────────────────────────────

test('chapter-1 all three qte_pass branches carry correct var effects', () => {
  const door = (SCENES['door'] as any).branches.find((b: any) => b.id === 'door-yes')
  expect(door.effects[0]).toMatchObject({ kind: 'var', varId: '理智', op: 'add', value: 1 })
  const river = (SCENES['river'] as any).branches.find((b: any) => b.id === 'river-yes')
  expect(river.effects[0]).toMatchObject({ kind: 'var', varId: '鬼火种', op: 'add', value: 1 })
  const boarding = (SCENES['boarding'] as any).branches.find((b: any) => b.id === 'boarding-yes')
  expect(boarding.effects[0]).toMatchObject({ kind: 'var', varId: '痴', op: 'add', value: 1 })
})

test('follow-guide qte_pass branch has condition requiring 鬼火种>=1', () => {
  const fg = SCENES['follow-guide'] as any
  const passBranch = fg.branches.find((b: any) => b.kind === 'qte_pass')
  expect(passBranch).toBeDefined()
  const condAll: any[] = passBranch.condition.all
  expect(condAll).toContainEqual({ type: 'var', varId: '鬼火种', op: 'gte', value: 1 })
})

test('donot-follow no branch sets 莲花妖线索 flag to true', () => {
  const df = SCENES['donot-follow'] as any
  const noBranch = df.branches.find((b: any) => b.targetSceneId === 'no-lotus')
  expect(noBranch).toBeDefined()
  const flagEffect = (noBranch.effects as any[]).find((e: any) => e.kind === 'flag' && e.varId === '莲花妖线索')
  expect(flagEffect).toBeDefined()
  expect(flagEffect.value).toBe(true)
})
