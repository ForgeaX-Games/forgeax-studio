// 鬼市门资产映射 —— 源文件名 ↔ blob 规范名 ↔ mediaId 的单一真相源(SSOT)。
// 导入脚本(拷贝+manifest)与 scenario 组装(battle media.ref)都从这里读。
// category: battle=接战斗蓝图 clipId; story=剧情线场景; spare=仅导入不编排。
// clipId: 仅 battle 段有,对应 demo-001 场景引用的演出编号。

export interface ClipEntry {
  /** 源目录中的文件名(可能含空格/逗号) */
  src: string
  /** blob 规范文件名(无空格) */
  blob: string
  /** 场景 media.ref 与 manifest meta.mediaId 的匹配键 */
  mediaId: string
  category: 'battle' | 'story' | 'spare'
  /** battle 段对应 demo-001 的 clipId(演出编号) */
  clipId?: string
}

export const CLIP_MAP: ClipEntry[] = [
  // ---- 战斗 14(clipId 对应 demo-001)----
  { src: 'idle01.mp4', blob: 'clip-idle.mp4', mediaId: 'm-clip-idle', category: 'battle', clipId: 'vd-wcc-idle' },
  { src: 'difanggongjiqianyao.mp4', blob: 'clip-qianyao.mp4', mediaId: 'm-clip-qianyao', category: 'battle', clipId: 'vd-wcc-qianyao' },
  { src: 'pugong.mp4', blob: 'clip-pugong.mp4', mediaId: 'm-clip-pugong', category: 'battle', clipId: 'vd-wcc-pugong' },
  { src: 'pugong2.mp4', blob: 'clip-pugong2.mp4', mediaId: 'm-clip-pugong2', category: 'battle', clipId: 'vd-wcc-pugong2' },
  { src: 'zhonggongji.mp4', blob: 'clip-zhong.mp4', mediaId: 'm-clip-zhong', category: 'battle', clipId: 'vd-wcc-zhong' },
  { src: 'zhonggongji2.mp4', blob: 'clip-zhong2.mp4', mediaId: 'm-clip-zhong2', category: 'battle', clipId: 'vd-wcc-zhong2' },
  { src: 'qinggongjizhisi.mp4', blob: 'clip-qinggong.mp4', mediaId: 'm-clip-qinggong', category: 'battle', clipId: 'vd-wcc-qinggong' },
  { src: 'dazhao.mp4', blob: 'clip-dazhao.mp4', mediaId: 'm-clip-dazhao', category: 'battle', clipId: 'vd-wcc-dazhao' },
  { src: 'fangfan.mp4', blob: 'clip-fangfan.mp4', mediaId: 'm-clip-fangfan', category: 'battle', clipId: 'vd-wcc-fangfan' },
  { src: 'shanbi.mp4', blob: 'clip-shanbi.mp4', mediaId: 'm-clip-shanbi', category: 'battle', clipId: 'vd-wcc-shanbi' },
  { src: 'huiqi.mp4', blob: 'clip-huiqi.mp4', mediaId: 'm-clip-huiqi', category: 'battle', clipId: 'vd-wcc-huiqi' },
  { src: 'shouji.mp4', blob: 'clip-shouji.mp4', mediaId: 'm-clip-shouji', category: 'battle', clipId: 'vd-wcc-shouji' },
  { src: 'shengli.mp4', blob: 'clip-shengli.mp4', mediaId: 'm-clip-shengli', category: 'battle', clipId: 'vd-wcc-shengli' },
  { src: 'shibai.mp4', blob: 'clip-shibai.mp4', mediaId: 'm-clip-shibai', category: 'battle', clipId: 'vd-wcc-shibai' },
  // ---- 剧情 17(mediaId 供剧情线场景 media.ref)----
  { src: 'video.ch1.opening.mp4', blob: 'nar-opening.mp4', mediaId: 'm-nar-opening', category: 'story' },
  { src: 'video.ch1.door.mp4', blob: 'nar-door.mp4', mediaId: 'm-nar-door', category: 'story' },
  { src: 'video.ch1.talking .mp4', blob: 'nar-talking.mp4', mediaId: 'm-nar-talking', category: 'story' },
  { src: 'video.ch1.3.river.mp4', blob: 'nar-river.mp4', mediaId: 'm-nar-river', category: 'story' },
  { src: 'video.ch1.3a,river-1.mp4', blob: 'nar-river1.mp4', mediaId: 'm-nar-river1', category: 'story' },
  { src: 'video.chi1.4.boarding-1.mp4', blob: 'nar-boarding.mp4', mediaId: 'm-nar-boarding', category: 'story' },
  { src: 'video.1.4a.mask talking.mp4', blob: 'nar-mask-talking.mp4', mediaId: 'm-nar-mask-talking', category: 'story' },
  { src: 'video.ch1.5.meet mengpo-1.mp4', blob: 'nar-meet-mengpo.mp4', mediaId: 'm-nar-meet-mengpo', category: 'story' },
  { src: 'video.ch2,1 drink tea.mp4', blob: 'nar-drink-tea.mp4', mediaId: 'm-nar-drink-tea', category: 'story' },
  { src: 'video.ch2,1,a drinking.mp4', blob: 'nar-drinking.mp4', mediaId: 'm-nar-drinking', category: 'story' },
  { src: 'video.chi2.1.b no drinking.mp4', blob: 'nar-no-drinking.mp4', mediaId: 'm-nar-no-drinking', category: 'story' },
  { src: 'video.ch2.2.follow the guide.mp4', blob: 'nar-follow-guide.mp4', mediaId: 'm-nar-follow-guide', category: 'story' },
  { src: 'video.ch2.2 use the light.mp4', blob: 'nar-use-light.mp4', mediaId: 'm-nar-use-light', category: 'story' },
  { src: 'vedio.ch2.2.b guide use light.mp4', blob: 'nar-guide-use-light.mp4', mediaId: 'm-nar-guide-use-light', category: 'story' },
  { src: 'video.ch2.3 donot follow.mp4', blob: 'nar-donot-follow.mp4', mediaId: 'm-nar-donot-follow', category: 'story' },
  { src: 'video.ch2.3.b get lotus.mp4', blob: 'nar-get-lotus.mp4', mediaId: 'm-nar-get-lotus', category: 'story' },
  { src: 'video.ch2.3.b .no lotus.mp4', blob: 'nar-no-lotus.mp4', mediaId: 'm-nar-no-lotus', category: 'story' },
  // ---- 备用 9(仅导入,不编排)----
  { src: 'video-ch1.1.door.2.mp4', blob: 'nar-door2.mp4', mediaId: 'm-nar-door2', category: 'spare' },
  { src: 'video.ch1.4.b. mask answer.mp4', blob: 'nar-mask-answer.mp4', mediaId: 'm-nar-mask-answer', category: 'spare' },
  { src: 'video.ch3.1 victory.mp4', blob: 'nar-ch3-victory.mp4', mediaId: 'm-nar-ch3-victory', category: 'spare' },
  { src: 'video.ch3.2.free mode.mp4', blob: 'nar-ch3-free.mp4', mediaId: 'm-nar-ch3-free', category: 'spare' },
  { src: 'video.ch4.1 catched.mp4', blob: 'nar-ch4-catched.mp4', mediaId: 'm-nar-ch4-catched', category: 'spare' },
  { src: 'video.ch4.1.zhiniang.mp4', blob: 'nar-ch4-zhiniang.mp4', mediaId: 'm-nar-ch4-zhiniang', category: 'spare' },
  { src: 'video.ch4.3.a ending.mp4', blob: 'nar-ch4-ending.mp4', mediaId: 'm-nar-ch4-ending', category: 'spare' },
  { src: 'video.ch4.3.b no.mp4', blob: 'nar-ch4-no.mp4', mediaId: 'm-nar-ch4-no', category: 'spare' },
  { src: 'video.ch4.3.kill or not.mp4', blob: 'nar-ch4-kill-or-not.mp4', mediaId: 'm-nar-ch4-kill-or-not', category: 'spare' },
]

const CLIPID_TO_MEDIA = new Map(
  CLIP_MAP.filter((e) => e.clipId).map((e) => [e.clipId as string, e.mediaId]),
)

export function mediaIdForClipId(clipId: string): string | undefined {
  return CLIPID_TO_MEDIA.get(clipId)
}
