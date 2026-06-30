/**
 * stderr-guard —— TUI 挂载期把裸 `process.stderr.write` 拦下,退出后再 flush。
 *
 * 病根(对照 cc):我们用的是 stock `ink@6`,它的 `patch-console` 只接管 `console.*`,
 * **不拦** core 在热路径里的裸 `process.stderr.write`(event-bus 订阅者异常 / event-store
 * 落盘失败 / assemble 告警等)。这些裸字节在 ink 重绘之间打进动态帧中间,打乱 ink 的
 * 光标/行计数,下次 `eraseLines` 擦错行数 → 输入框残影/重复(矮终端、CJK 宽字符下更易触发)。
 * cc 的 fork 额外加了一道 `patchStderr()` 专治此事(src/ink/ink.tsx);本模块是等价物。
 *
 * 策略:挂载期把 stderr 写入**缓冲**(不落 TTY,屏幕归 ink 独占);退出、ink 还屏后再把
 * 缓冲一次性 flush 到真 stderr——既不污染画面,又不丢调试信息。带内存上限,防跑飞日志 OOM。
 *
 * ⚠️ 只拦 stderr。ink 的帧走 `process.stdout`,绝不可拦 stdout。
 *
 * Boundary(HOST 层):node 进程 API,无 react/ink 依赖。
 */

/** 缓冲上限(字节)。超出后丢弃最旧内容,只留尾部 + 一行截断提示。错误路径写量很小,余量充足。 */
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * 安装 stderr guard:即刻把 `process.stderr.write` 换成缓冲版。
 * 返回 `restore()`:还原原始 write 并把缓冲 flush 到真 stderr(应在 ink 卸载、终端还屏后调用)。
 */
export function installStderrGuard(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  let buffered = '';
  let dropped = false;

  const append = (chunk: unknown, encoding?: BufferEncoding): void => {
    const s =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString(encoding ?? 'utf8')
          : String(chunk);
    buffered += s;
    if (buffered.length > MAX_BUFFER_BYTES) {
      dropped = true;
      buffered = buffered.slice(buffered.length - MAX_BUFFER_BYTES);
    }
  };

  // 覆盖 write(兼容两种重载:(chunk, cb) 与 (chunk, encoding, cb))。
  //   必须回调 + 返回 true,否则调用方可能因等待 drain/callback 而挂起。
  const patched = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    try {
      append(chunk, encoding);
    } catch {
      /* 缓冲失败也绝不让原始写漏到 TTY */
    }
    if (callback) callback();
    return true;
  }) as typeof process.stderr.write;

  process.stderr.write = patched;

  return function restore(): void {
    // 只在仍是我们装的那个 patched 时还原,避免覆盖他人后续的替换。
    if (process.stderr.write === patched) {
      process.stderr.write = original;
    }
    if (buffered.length > 0) {
      if (dropped) {
        original('[forgeax-core] (TUI 期间较早的 stderr 输出因超量被截断)\n');
      }
      original(buffered);
      buffered = '';
    }
  };
}
