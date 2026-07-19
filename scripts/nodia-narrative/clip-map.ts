// 鬼市门叙事资产映射 SSOT：原始文件名 ↔ blob 规范名 ↔ mediaId ↔ sceneId ↔ 真实时长(ms)。
// 视频源就是游戏目录 game-video/assets/blobs/ 里的 narr-*.mp4(blob 字段)。
// 装配脚本(写 manifest)与 assemble(scene.media.ref / decision 时机)都从这里读。
// src 仅作原始来源存档(记录 blob 对应的原始文件名),装配流程已不使用。
export interface NarrClip {
  src: string      // 原始来源文件名(存档用,装配不读)
  blob: string     // 游戏目录 blobs/ 里的规范文件名(无空格)——实际视频源
  mediaId: string  // scene.media.ref 与 manifest meta.mediaId 的匹配键
  sceneId: string  // 叙事场景 id(n_ 前缀)
  durMs: number    // ffprobe 实测时长(ms)
}
// 注意:scenario id 不能用 'demo-001' —— 那是前端 bundled 演示剧本的保留 id
// (demoScenario.ts BUNDLED_DEMO_ID)。复用它会被 refreshBuiltinDemoInDb 整本替换成
// 内置 demo。用独立 id 'nodia-main';manifest.meta.scenarioId 必须与 scenario.id 一致
// (媒体 hydrate 按 scenarioId 过滤)。
export const SCENARIO_ID = 'nodia-main'
export const NARR_CLIPS: NarrClip[] = [
  { src: 'video.ch1.opening.mp4',            blob: 'narr-open.mp4',     mediaId: 'm-narr-open',     sceneId: 'n_open',     durMs: 15975 },
  { src: 'video.ch1.door.mp4',               blob: 'narr-door.mp4',     mediaId: 'm-narr-door',     sceneId: 'n_door',     durMs: 15100 },
  { src: 'video.ch1.talking .mp4',           blob: 'narr-soul.mp4',     mediaId: 'm-narr-soul',     sceneId: 'n_soul',     durMs: 15093 },
  { src: 'video.ch1.3.river.mp4',            blob: 'narr-river.mp4',    mediaId: 'm-narr-river',    sceneId: 'n_river',    durMs: 15069 },
  { src: 'video.ch1.3a,river-1.mp4',         blob: 'narr-child.mp4',    mediaId: 'm-narr-child',    sceneId: 'n_child',    durMs: 12887 },
  { src: 'video.chi1.4.boarding-1.mp4',      blob: 'narr-land.mp4',     mediaId: 'm-narr-land',     sceneId: 'n_land',     durMs: 16200 },
  { src: 'video.1.4a.mask talking.mp4',      blob: 'narr-mask.mp4',     mediaId: 'm-narr-mask',     sceneId: 'n_mask',     durMs: 15093 },
  { src: 'video.ch1.5 mengpo-1.mp4',         blob: 'narr-mengpo.mp4',   mediaId: 'm-narr-mengpo',   sceneId: 'n_mengpo',   durMs: 17136 },
  { src: 'video.ch2,1 drink tea.mp4',        blob: 'narr-tea.mp4',      mediaId: 'm-narr-tea',      sceneId: 'n_tea',      durMs: 15093 },
  { src: 'video.ch2,1,a drinking.mp4',       blob: 'narr-drink.mp4',    mediaId: 'm-narr-drink',    sceneId: 'n_drink',    durMs: 14489 },
  { src: 'video.chi2.1.b no drinking.mp4',   blob: 'narr-nodrink.mp4',  mediaId: 'm-narr-nodrink',  sceneId: 'n_nodrink',  durMs: 15093 },
  { src: 'video.ch2.2.follow the guide.mp4', blob: 'narr-follow.mp4',   mediaId: 'm-narr-follow',   sceneId: 'n_follow',   durMs: 15093 },
  { src: 'video.ch2.2 use the light.mp4',    blob: 'narr-getlight.mp4', mediaId: 'm-narr-getlight', sceneId: 'n_getlight', durMs: 15093 },
  { src: 'vedio.ch2.2.b guide use light.mp4',blob: 'narr-nolight.mp4',  mediaId: 'm-narr-nolight',  sceneId: 'n_nolight',  durMs: 15093 },
  { src: 'video.ch2.3 donot follow.mp4',     blob: 'narr-nofollow.mp4', mediaId: 'm-narr-nofollow', sceneId: 'n_nofollow', durMs: 15093 },
  { src: 'vedio.ch2.3.a get lotus..mp4',     blob: 'narr-lotus.mp4',    mediaId: 'm-narr-lotus',    sceneId: 'n_lotus',    durMs: 15093 },
  { src: 'video.ch2.3.b no lotus.mp4',       blob: 'narr-nolotus.mp4',  mediaId: 'm-narr-nolotus',  sceneId: 'n_nolotus',  durMs: 15069 },
]
