/**
 * Qr —— 终端内渲染可扫二维码(half-block 垂直打包,横竖都紧凑)。
 *
 * 每个**字符**用上半块 `▀`(U+2580)同时表达「上下两个模块」:前景色=上模块色、背景色=下模块色。
 *   上暗→fg black、下暗→bg black;浅→白。四种组合覆盖 (暗/浅)×(暗/浅)。
 * 于是:横向 1 字符/模块、纵向 1 字符/两模块 → 行数减半。配合终端字符 ~1:2 高宽比,整码近正方,
 *   且比旧「2 空格/模块、1 行/模块」版本横竖都小一倍,相机可识别。
 *
 * ⚠️ `▀` 是 East-Asian「歧义宽」字符。多数 Mac 终端(VSCode 集成终端 / iTerm 默认)按**窄**(宽 1)
 *   渲染,与 ink 的 string-width 计宽一致 → 不触发残影铁律(forgeax-tui-ghost-rootcause)。
 *   仅当某终端把歧义宽当双宽时,二维码会变宽且可能残影 —— 那是终端设置问题,可改设置或回退纯空格版。
 *   (这是唯一为「纵向也变小」对铁律做的让步:纯空格全角格子无法低于 1 行/模块,纵向缩不了。)
 *
 * 终端太窄放不下整码时,graceful 降级:只打印原始 payload 字符串(用户可自行转码 / 手机打开)。
 *
 * Boundary(HOST 层):react + ink + 相对 import + qrcode(已声明依赖)。
 */
import React from 'react';
import { Box, Text } from 'ink';
import QRCode from 'qrcode';

/** 静默区(模块数);标准为 4,终端取 2 省地方,实测多数相机可识别。 */
const QUIET = 2;
/** 上半块字符:fg 画上半、bg 露下半 → 一字符承载上下两模块。 */
const HALF = '▀';

export interface QrMatrix {
  size: number;
  /** 行优先 0/1,长度 size*size。 */
  data: Uint8Array;
}

/** 生成 QR 模块矩阵(失败 → null,绝不抛)。 */
export function qrMatrix(text: string): QrMatrix | null {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    return { size: qr.modules.size, data: qr.modules.data as Uint8Array };
  } catch {
    return null;
  }
}

/** 含静默区后整码的终端字符宽(每模块 1 字符宽)。 */
export function qrWidthChars(size: number): number {
  return size + QUIET * 2;
}

/** 含静默区后整码的终端字符高(每字符行承载两模块 → 行数减半,向上取整)。 */
export function qrHeightChars(size: number): number {
  return Math.ceil((size + QUIET * 2) / 2);
}

/** 取「含静默区」坐标 (x,y) 处模块明暗:静默区一律浅(false)。 */
function paddedDark(m: QrMatrix, x: number, y: number): boolean {
  const inQuiet = y < QUIET || y >= QUIET + m.size || x < QUIET || x >= QUIET + m.size;
  if (inQuiet) return false;
  return m.data[(y - QUIET) * m.size + (x - QUIET)] === 1;
}

/** 一段同「上下色对」的连续列(渲染合并,减少元素数)。 */
export interface QrHalfRun {
  topDark: boolean;
  bottomDark: boolean;
  width: number;
}

/**
 * 矩阵 → 逐「字符行」同色段(含静默区,half-block 垂直两两打包)。纯函数,供渲染 + 单测。
 * 字符行数 = ceil((size + 2*QUIET) / 2);每行各段 width 之和 = size + 2*QUIET。
 */
export function qrHalfRows(m: QrMatrix): QrHalfRun[][] {
  const full = m.size + QUIET * 2;
  const rows: QrHalfRun[][] = [];
  for (let y = 0; y < full; y += 2) {
    const runs: QrHalfRun[] = [];
    for (let x = 0; x < full; x++) {
      const topDark = paddedDark(m, x, y);
      const bottomDark = y + 1 < full ? paddedDark(m, x, y + 1) : false; // 末行无下半 → 当浅(静默)
      const last = runs[runs.length - 1];
      if (last && last.topDark === topDark && last.bottomDark === bottomDark) last.width += 1;
      else runs.push({ topDark, bottomDark, width: 1 });
    }
    rows.push(runs);
  }
  return rows;
}

export interface QrProps {
  /** 待编码的 payload(扫码登录字符串)。 */
  payload: string;
  /** 可用终端列宽(默认 process.stdout.columns 或 80)。窄于整码 → 降级打印 payload。 */
  cols?: number;
}

export function Qr(props: QrProps): React.ReactElement {
  const cols = props.cols ?? process.stdout.columns ?? 80;
  const m = qrMatrix(props.payload);
  if (!m) {
    return <Text>{`(二维码生成失败)登录串:${props.payload}`}</Text>;
  }
  // 太窄放不下 → 降级:打印 payload 让用户自行转码 / 手机打开。
  if (qrWidthChars(m.size) > cols) {
    return (
      <Box flexDirection="column">
        <Text>{'终端过窄,无法渲染二维码。请放大窗口,或用以下登录串自行转码:'}</Text>
        <Text>{props.payload}</Text>
      </Box>
    );
  }
  const rows = qrHalfRows(m);
  return (
    <Box flexDirection="column">
      {rows.map((runs, y) => (
        <Box key={y} flexDirection="row">
          {runs.map((r, i) => (
            <Text key={i} color={r.topDark ? 'black' : 'white'} backgroundColor={r.bottomDark ? 'black' : 'white'}>
              {HALF.repeat(r.width)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
