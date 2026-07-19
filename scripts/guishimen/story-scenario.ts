// 鬼市门剧情线 —— 严格照《叙事流程》图翻译,纯 scenario 数据,零引擎依赖。
// 类型用宽松别名(不 import 插件类型);字段名对齐 wb-game-video types.ts。
// 叩 = 单键QTE(kind:'qte',单 cue label"叩";qte_pass=按中→支线+奖励,qte_fail=超时→推进)。
// 应/默 = 限时二选一(kind:'choice',decision.optType:'timed',defaultBranchId 超时兜底)。
//
// durationMs 不再硬编码:由调用方注入 durationOf(mediaId)=视频真实时长(ms),
// 场景 durationMs = 真实时长 + 可配置 offset(视频自然结束后多停留的尾巴,
// 给选择/叩/飘字留操作窗口)。offset 见 DURATION_OFFSETS。
/* eslint-disable @typescript-eslint/no-explicit-any */

type Scene = Record<string, any>
type Var = { id: string; name: string; kind: 'number' | 'flag'; initial: number; min?: number; max?: number }
/** 注入的真实时长解析器:mediaId → mp4 真实时长(ms)。找不到返回 undefined。 */
export type DurationResolver = (mediaId: string) => number | undefined

export const STORY_ROOT_SCENE_ID = 'opening'
// 战斗入口 = demo-001 的 rootSceneId 'a_my'(我方回合),它带 subFlowRef→g-cb-my
// 会重定向到技能栏 wait。不能接 'enter'(idle LOOP,不自动推进,会卡住且不触发技能栏)。
export const BATTLE_ENTRY_SCENE_ID = 'a_my'

/**
 * 每类场景在视频真实结束后额外停留的尾巴(ms)。可配置。
 *   - story:小尾巴,让画面收尾/飘字飘完再切
 *   - choice:较长尾巴,视频放完后玩家仍有时间读题并在"应/默"里做选择
 *   - qte(叩):中等尾巴,视频放完后"叩"按钮仍有窗口可按
 * choice/qte 的 offset 必须 ≥ 各自的 timeoutMs,否则窗口会被 durationMs 截断。
 */
export const DURATION_OFFSETS = {
  story: 800,
  choice: 6500, // ≥ choice timeoutMs(6000)
  qte: 2500, // ≥ qte timeoutMs(2000)
} as const

/** 读不到真实时长时的兜底(ms)—— 正常路径不该走到(assemble 会真读 mp4)。 */
const FALLBACK_DURATION = 12000

function resolveDuration(mediaId: string, durationOf: DurationResolver, kind: keyof typeof DURATION_OFFSETS): number {
  const real = durationOf(mediaId)
  const base = real && real > 0 ? real : FALLBACK_DURATION
  return base + DURATION_OFFSETS[kind]
}

// 复用的飘字工厂:绑在场景上、进场即飘。sticker 是 numeric,text 直接显示。
function sticker(id: string, text: string, color = '#ffd27a'): Scene {
  return { id, startMs: 400, endMs: 2600, kind: 'numeric', text, x: 0.5, y: 0.32, color, enter: 'pop', exit: 'fade', sizePct: 10 }
}

/**
 * 叩QTE cue 时机 —— 相对"视频真实结束点"定位,保证"叩"按钮在视频结束前就弹出,
 * 玩家来得及看到并按。realMs = 视频真实时长;durationMs = realMs + qte offset。
 *   - targetAt:视频结束前 1200ms(留出反应)
 *   - appearAt:targetAt 前 900ms(按钮提前出现)
 * 极短视频兜底:appearAt 不早于 600ms。
 */
function knockCueTiming(realMs: number): { appearAt: number; targetAt: number } {
  const targetAt = Math.max(1500, realMs - 1200)
  const appearAt = Math.max(600, targetAt - 900)
  return { appearAt, targetAt }
}

// 叩QTE 场景工厂:videoMediaId 播放;视频结束前弹单键"叩";按中→yesScene,超时→noScene。
function knock(id: string, title: string, mediaId: string, durationOf: DurationResolver, yesScene: string, noScene: string, cueLabel = '叩'): Scene {
  const realMs = durationOf(mediaId) ?? FALLBACK_DURATION
  const cue = knockCueTiming(realMs)
  return {
    id, title,
    media: { kind: 'VIDEO', ref: mediaId },
    durationMs: resolveDuration(mediaId, durationOf, 'qte'),
    kind: 'qte',
    hudPreset: 'hidden',
    dialogue: [],
    decision: { optType: 'timed_qte', qteKind: 'timing' },
    qte: {
      cues: [{ id: `${id}-knock`, shape: 'tap', x: 0.5, y: 0.6, appearAt: cue.appearAt, targetAt: cue.targetAt, label: cueLabel }],
      window: { perfect: 220, great: 420, good: 700 },
      score: { perfect: 100, great: 60, good: 30, miss: 0 },
      timeoutMs: 2000,
    },
    branches: [
      { id: `${id}-yes`, kind: 'qte_pass', targetSceneId: yesScene, label: '是' },
      { id: `${id}-no`, kind: 'qte_fail', targetSceneId: noScene, label: '否' },
    ],
  }
}

// 应/默 二选一场景工厂。默认(超时)走 defaultBranchId。
function choice(id: string, title: string, mediaId: string, durationOf: DurationResolver, opts: { yesLabel: string; yesScene: string; yesEffects?: any[]; noLabel: string; noScene: string; noEffects?: any[]; defaultBranch: 'yes' | 'no' }): Scene {
  const realMs = durationOf(mediaId) ?? FALLBACK_DURATION
  return {
    id, title,
    media: { kind: 'VIDEO', ref: mediaId },
    durationMs: resolveDuration(mediaId, durationOf, 'choice'),
    kind: 'choice',
    hudPreset: 'hidden',
    dialogue: [],
    // 选项在视频接近结束时出现,视频结束后仍有 offset 尾巴可选;超时走 default。
    decision: { optType: 'timed', windowStartMs: Math.max(500, realMs - 3000), timeoutMs: 6000, defaultBranchId: `${id}-${opts.defaultBranch}` },
    branches: [
      { id: `${id}-yes`, kind: 'choice', label: opts.yesLabel, targetSceneId: opts.yesScene, ...(opts.yesEffects ? { effects: opts.yesEffects } : {}) },
      { id: `${id}-no`, kind: 'choice', label: opts.noLabel, targetSceneId: opts.noScene, ...(opts.noEffects ? { effects: opts.noEffects } : {}) },
    ],
  }
}

function story(id: string, title: string, mediaId: string, durationOf: DurationResolver, next: string, stickers?: Scene[]): Scene {
  const s: Scene = {
    id, title,
    media: { kind: 'VIDEO', ref: mediaId },
    durationMs: resolveDuration(mediaId, durationOf, 'story'),
    hudPreset: 'hidden',
    dialogue: [],
    branches: [{ id: `${id}-out`, kind: 'auto', targetSceneId: next, label: 'Out' }],
  }
  if (stickers) s.stickerClips = stickers
  return s
}

const varAdd = (id: string, varId: string, value: number) => ({ id, kind: 'var', varId, op: 'add', value })
const flagSet = (id: string, varId: string, value: boolean) => ({ id, kind: 'flag', varId, value })

export const STORY_VARIABLES: Record<string, Var> = {
  理智: { id: '理智', name: '理智', kind: 'number', initial: 0, min: 0 },
  痴: { id: '痴', name: '痴', kind: 'number', initial: 0, min: 0 },
  佛性: { id: '佛性', name: '佛性', kind: 'number', initial: 0 }, // 道德轴,可为负(不设下限),负值表示"入魔"方向
  鬼火种: { id: '鬼火种', name: '鬼火种', kind: 'number', initial: 0, min: 0 },
  莲花妖线索: { id: '莲花妖线索', name: '莲花妖线索', kind: 'flag', initial: 0 },
}

/** 剧情线用到的全部 media id(供 assemble 校验真实时长可解析)。 */
export const STORY_MEDIA_IDS = [
  'm-nar-opening', 'm-nar-door', 'm-nar-talking', 'm-nar-river', 'm-nar-river1',
  'm-nar-boarding', 'm-nar-mask-talking', 'm-nar-meet-mengpo', 'm-nar-drink-tea',
  'm-nar-drinking', 'm-nar-no-drinking', 'm-nar-follow-guide', 'm-nar-use-light',
  'm-nar-guide-use-light', 'm-nar-donot-follow', 'm-nar-get-lotus', 'm-nar-no-lotus',
] as const

/**
 * 构建剧情线场景图。durationOf 注入视频真实时长(ms);durationMs 由真实时长 + offset 派生。
 * 纯函数、无副作用、无文件 IO —— 单测可注入假 durationOf。
 */
export function buildStoryScenes(durationOf: DurationResolver): Record<string, Scene> {
  const scenes: Record<string, Scene> = {
    // ===== 第一章 · 叩 =====
    opening: story('opening', '开场', 'm-nar-opening', durationOf, 'door'),

    door: knock('door', '鬼门前', 'm-nar-door', durationOf, 'talking', 'river'),
    // 叩中→小孩对话(理智+1)→ 汇回 river
    talking: story('talking', '小孩对话', 'm-nar-talking', durationOf, 'river',
      [sticker('talking-fx', '理智 +1')]),

    river: knock('river', '划船渡河', 'm-nar-river', durationOf, 'river1', 'boarding'),
    river1: story('river1', '小孩对话', 'm-nar-river1', durationOf, 'boarding',
      [sticker('river1-fx', '鬼火种 +1')]),

    boarding: knock('boarding', '上岸', 'm-nar-boarding', durationOf, 'mask-talking', 'meet-mengpo'),
    'mask-talking': story('mask-talking', '灯笼对话', 'm-nar-mask-talking', durationOf, 'meet-mengpo',
      [sticker('mask-talking-fx', '痴 +1')]),

    // ===== 第二章 · 应/默 =====
    'meet-mengpo': story('meet-mengpo', '过桥见孟婆', 'm-nar-meet-mengpo', durationOf, 'drink-tea'),

    'drink-tea': choice('drink-tea', '喝孟婆汤', 'm-nar-drink-tea', durationOf, {
      yesLabel: '应', yesScene: 'drinking', yesEffects: [varAdd('drink-yes-fo', '佛性', -1), varAdd('drink-yes-chi', '痴', 1)],
      noLabel: '默', noScene: 'no-drinking',
      defaultBranch: 'no',
    }),
    drinking: story('drinking', '喝', 'm-nar-drinking', durationOf, 'guide-choice',
      [sticker('drinking-fx', '佛性 -1 · 痴 +1', '#ff9d6c')]),
    'no-drinking': story('no-drinking', '不喝', 'm-nar-no-drinking', durationOf, 'guide-choice'),

    // D2:跟随 / 不跟随 —— 无自有视频,复用 meet-mengpo 素材做背景静帧承载"应/默"选择。
    'guide-choice': choice('guide-choice', '是否跟随引路', 'm-nar-meet-mengpo', durationOf, {
      yesLabel: '应', yesScene: 'follow-guide',
      noLabel: '默', noScene: 'donot-follow',
      defaultBranch: 'no',
    }),

    // 跟随 → QTE 检查鬼火种:有(鬼火种>0)且按中→use-light;否→guide-use-light
    'follow-guide': knock('follow-guide', '跟随', 'm-nar-follow-guide', durationOf, 'use-light', 'guide-use-light', '鬼火'),

    'use-light': story('use-light', '驱散迷雾', 'm-nar-use-light', durationOf, BATTLE_ENTRY_SCENE_ID),
    'guide-use-light': story('guide-use-light', '驱散迷雾', 'm-nar-guide-use-light', durationOf, BATTLE_ENTRY_SCENE_ID),

    'donot-follow': choice('donot-follow', '不跟随', 'm-nar-donot-follow', durationOf, {
      yesLabel: '应', yesScene: 'get-lotus',
      noLabel: '默', noScene: 'no-lotus',
      noEffects: [flagSet('no-lotus-flag', '莲花妖线索', true)],
      defaultBranch: 'no',
    }),
    'get-lotus': story('get-lotus', '接过莲瓣', 'm-nar-get-lotus', durationOf, BATTLE_ENTRY_SCENE_ID),
    'no-lotus': story('no-lotus', '不要莲瓣', 'm-nar-no-lotus', durationOf, BATTLE_ENTRY_SCENE_ID,
      [sticker('no-lotus-fx', '获得线索 <莲花妖>', '#9cd6ff')]),
  }

  // follow-guide 的"跟随"QTE:qte_pass 分支需鬼火种≥1 才走 use-light,否则(无鬼火种/超时)走 guide-use-light。
  // knock() 默认 qte_pass 无条件,这里补上鬼火种门控。
  const fg = scenes['follow-guide']
  const fgYes = (fg.branches as any[]).find((b) => b.id === 'follow-guide-yes')
  fgYes.condition = { all: [{ type: 'var', varId: '鬼火种', op: 'gte', value: 1 }] }
  fgYes.gateMode = 'hide'

  // 一章"叩中→奖励":变量真实变化挂在 knock 场景的 qte_pass 分支上(飘字在目标场景显示)。
  const reward = (sceneId: string, effects: any[]) => {
    const b = (scenes[sceneId].branches as any[]).find((x) => x.id === `${sceneId}-yes`)
    b.effects = effects
  }
  reward('door', [varAdd('door-yes-fx', '理智', 1)])
  reward('river', [varAdd('river-yes-fx', '鬼火种', 1)])
  reward('boarding', [varAdd('boarding-yes-fx', '痴', 1)])

  return scenes
}
