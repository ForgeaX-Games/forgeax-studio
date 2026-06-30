/**
 * useResizeRedraw —— 终端 resize 时做「干净全量重绘」,返回一个随 resize 自增的 staticKey。
 *
 * 病根:同窗口开新分屏会把老 pane 挤窄 → 老进程收 SIGWINCH。stock ink 的 resized() 用
 * `eraseLines`(按 reflow 前行数)擦旧帧,而真终端在 resize 时会 reflow 已打印的行 → 擦错
 * → 输入框残影/重复(pyte 规范模拟器复现不出,真终端必现)。
 *
 * 修法:resize(debounce 300ms)→
 *   ① inkInstanceRef.resetStaticOutput() 清 ink 的 Static 累加器与动态区记账;
 *   ② 写 clearTerminal(2J+3J+H)整屏清(含 scrollback),抹掉 reflow 残影;
 *   ③ bump staticKey → 调用方把它用作 `<Static key={staticKey}>`,React 重挂载 Static →
 *      整段 transcript 在新宽度下重新 emit。三步合起来 = 新尺寸下干净重绘,绕开 reflow 残影。
 *
 * Boundary(HOST 层):react + node(process.stdout)+ 相对 import。
 */
import { useEffect, useState } from 'react';
import { inkInstanceRef } from './ink-instance-ref';

/** clearTerminal = ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME(对齐 ansi-escapes.clearTerminal)。 */
const ESC = String.fromCharCode(27); // 避免源码内裸 ESC 字节被 formatter 弄坏
const CLEAR_TERMINAL = `${ESC}[2J${ESC}[3J${ESC}[H`;

/**
 * 干净全量重绘的「清场」两步:① 清 ink 的 Static 累加器 + 动态区记账;② 整屏清(含 scrollback)。
 *
 * 注意:这两步只「清旧」;真正让 `<Static>` **重新 emit 全部条目**还需调用方给它换 key
 * 重挂载(见 useResizeRedraw 的 staticKey / Transcript 的 redrawNonce)。resize 与
 * /resume 整体替换 transcript 都复用本函数,避免清场逻辑两处漂移。
 */
export function cleanRedraw(): void {
  inkInstanceRef.current?.resetStaticOutput?.();
  try {
    process.stdout.write(CLEAR_TERMINAL);
  } catch {
    /* 写失败也无妨,调用方的 remount 仍会重绘 */
  }
}

export function useResizeRedraw(): number {
  const [staticKey, setStaticKey] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      // debounce:resize 期间终端常连发多个事件,等稳定后再做一次重绘。
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanRedraw();
        setStaticKey((k) => k + 1);
      }, 300);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return staticKey;
}
