/**
 * ink-instance-ref —— 持有当前 ink render() 返回的 Instance(模块级单例 ref)。
 *
 * 用途:resize 时做「干净全量重绘」需要调到 patch 暴露的 `instance.resetStaticOutput()`
 * (清 ink 的 Static 累加器),而该 Instance 只有 runTui 的 render() 处拿得到。组件层
 * (Transcript 的 resize handler)经本 ref 访问。
 *
 * Boundary(HOST 层):无 react/ink 依赖,纯模块状态。
 */

/** ink Instance 的最小形状(只用到 patch 暴露的 resetStaticOutput)。 */
export interface InkInstanceLike {
  resetStaticOutput?: () => void;
}

export const inkInstanceRef: { current: InkInstanceLike | null } = { current: null };
