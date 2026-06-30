# forgeax-agent-host

forgeax 的 **ring-0 sidecar**:内核进程监督 + IPC 控制面(R3 阶段1脊梁)。

## 形态

- **自包含叶子**:零 `@forgeax/*` 依赖(协议类型 SoT 在 `src/types.ts`,不引任何兄弟包)。
- **全裸 TS,无 build**:bun 直跑源码。
- 作为运行期工件,被 cli/server 作为 sidecar 拉起(`bin: forgeax-agent-host`)。

## 独立验证

```bash
bun install
bun run typecheck
bun run test
```
