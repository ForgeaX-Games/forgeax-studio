import { NARR_CLIPS } from './clip-map'
// Scene 类型来自插件；脚本侧用结构化字面量即可(assemble 时并入 scenarios.json)。
type AnyScene = Record<string, unknown>

export const NARR_ROOT = 'n_open'

export const NARR_VARIABLES = {
  lizhi:     { id: 'lizhi',     name: '理智', kind: 'number', initial: 5,  min: 0, max: 12 },
  foxing:    { id: 'foxing',    name: '佛性', kind: 'number', initial: 10, min: 0, max: 12 },
  yezhang:   { id: 'yezhang',   name: '业障', kind: 'number', initial: 1,  min: 0, max: 12 },
  chi:       { id: 'chi',       name: '痴',   kind: 'number', initial: 1,  min: 0, max: 12 },
  guihuo:    { id: 'guihuo',    name: '鬼火种', kind: 'number', initial: 0, min: 0 },
  lotusClue: { id: 'lotusClue', name: '莲花妖线索', kind: 'flag', initial: 0 },
} as const

const dur = (sceneId: string) => NARR_CLIPS.find((c) => c.sceneId === sceneId)!.durMs
const ref = (sceneId: string) => NARR_CLIPS.find((c) => c.sceneId === sceneId)!.mediaId

function base(sceneId: string, title: string, hud: string): AnyScene {
  return {
    id: sceneId, title,
    media: { kind: 'VIDEO', ref: ref(sceneId), meta: {} },
    durationMs: dur(sceneId),
    episodeId: 'ep-narrative',
    hudPreset: hud,
    dialogue: [],
  }
}

// 纯演出：播完 auto 到 next
function story(sceneId: string, title: string, next: string, extra: AnyScene = {}): AnyScene {
  return { ...base(sceneId, title, 'narrative'), kind: 'story',
    branches: [{ id: `${sceneId}-out`, kind: 'auto', targetSceneId: next, label: 'Out' }], ...extra }
}

// 叩 QTE：9–11s 显示，点中→pass，超时→fail
function kou(sceneId: string, title: string, passTo: string, failTo: string): AnyScene {
  return { ...base(sceneId, title, 'hidden'), kind: 'qte',
    ext: { qteUi: 'inkKou' },
    qte: {
      cues: [{ id: 'kou', shape: 'tap', x: 0.58, y: 0.39, appearAt: 9000, targetAt: dur(sceneId) - 1000, label: '叩' }],
      window: { perfect: 200, great: 400, good: 700 },
      score: { perfect: 100, great: 70, good: 40, miss: 0 },
      timeoutMs: dur(sceneId),
      outcomeLabels: { pass: '叩中', good: '叩中', fail: '错过' },
    },
    branches: [
      { id: `${sceneId}-pass`, kind: 'qte_pass', qteOutcome: 'pass', targetSceneId: passTo, label: '叩' },
      { id: `${sceneId}-fail`, kind: 'qte_fail', qteOutcome: 'fail', targetSceneId: failTo, label: '超时' },
    ] }
}

// 应/默：视频末尾前 3s 弹出并 latch，超时 8s 落「默」
function choice(sceneId: string, title: string, yingTo: string, moTo: string, extra: AnyScene = {}): AnyScene {
  const moId = `${sceneId}-mo`
  // 引擎 choiceWindowEnd 缺省=durationMs;窗口须非空且盖住视频末尾那一刻。
  // 一旦 elapsed 进窗 choiceLatched 锁定显示;timeoutMs 由 InkYingMoLayer 倒计时消费→超时落 defaultBranchId(默)。
  const windowStartMs = Math.max(0, dur(sceneId) - 3000)
  return { ...base(sceneId, title, 'narrative'), kind: 'choice',
    ext: { choiceUi: 'inkYingMo' },
    decision: { optType: 'timed', fireAt: 'video_end', windowStartMs, windowEndMs: dur(sceneId), timeoutMs: 8000, defaultBranchId: moId, prompt: '' },
    branches: [
      { id: `${sceneId}-ying`, kind: 'choice', label: '應', targetSceneId: yingTo },
      { id: moId,             kind: 'choice', label: '默', targetSceneId: moTo },
    ], ...extra }
}

export function buildStoryScenes(): Record<string, AnyScene> {
  const drink = story('n_drink', '饮汤应答', 'n_follow')
  // 唯一四维飘字：理智-1 业障+1(挂在 auto 分支 effects，进场即结算)
  ;(drink.branches as AnyScene[])[0].effects = [
    { id: 'drink-lizhi', kind: 'var', varId: 'lizhi', op: 'add', value: -1 },
    { id: 'drink-yezhang', kind: 'var', varId: 'yezhang', op: 'add', value: 1 },
  ]
  const nolotus = story('n_nolotus', '不要莲藕', 'enter')
  ;(nolotus.branches as AnyScene[])[0].effects = [
    { id: 'nolotus-clue', kind: 'flag', varId: 'lotusClue', value: true },
  ]
  const list: AnyScene[] = [
    story('n_open', '序章', 'n_door', { hudPreset: 'hidden' }),
    kou('n_door', '慈悲狱门口', 'n_soul', 'n_river'),
    story('n_soul', '小魂对话', 'n_river'),
    choice('n_river', '划船渡河', 'n_child', 'n_land'),
    story('n_child', '小孩对话', 'n_land'),
    choice('n_land', '上岸', 'n_mask', 'n_mengpo'),
    story('n_mask', '灯笼对话', 'n_mengpo'),
    story('n_mengpo', '过桥见孟婆', 'n_tea'),
    choice('n_tea', '喝孟婆汤', 'n_drink', 'n_nodrink'),
    drink,
    choice('n_nodrink', '不喝', 'n_follow', 'n_nofollow'),
    choice('n_follow', '跟随引魂', 'n_getlight', 'n_nolight'),
    story('n_getlight', '获取道具', 'enter'),
    story('n_nolight', '没能道具', 'enter'),
    choice('n_nofollow', '不跟随', 'n_lotus', 'n_nolotus'),
    story('n_lotus', '接过莲藕', 'enter'),
    nolotus,
  ]
  return Object.fromEntries(list.map((s) => [s.id as string, s]))
}
