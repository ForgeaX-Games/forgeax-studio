/**
 * MCP defer 装配接线 e2e —— 验证 `assembleCapabilities` 把 `decideMcpDeferMode`
 * 的裁决落到每个 MCP 工具的 `shouldDefer` 标记上(M1 注入治理在生产路径生效)。
 *
 * 这根线之前缺失:assemble 调 2-参 `mcpPack` → 所有 MCP 工具一律 sync 全量进
 * turn-0。本测试钉住接线后的行为矩阵:
 *   - 默认(env 未设 → defer):MCP 工具 shouldDefer()===true(首轮不上线)。
 *   - `defer_loading:false`:强制 sync,工具不 defer。
 *   - `defer_loading:true` + `FORGEAX_MCP_DEFER_DEFAULT=auto`:强制 async,defer。
 *   - auto 模式阈值:工具数 < 阈值 → sync;>= → async。
 *
 * agent.ts 的 defer ENGINE 用 `t.shouldDefer?.()===true && t.alwaysLoad!==true`
 * 计算 deferred 集 + 建 ToolSearch(已被 mcp-stdio / tool-completion e2e 覆盖),
 * 故这里只断言 assemble 出墙的工具标记正确 —— 即新接的那一段。
 *
 * Boundary: test 层。
 */
import { test, expect, describe } from 'bun:test';
import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';
import type {
  MCPClient,
  MCPTool,
  MCPToolResult,
  MCPCallOptions,
} from '../src/capability/mcp/client';
import type { ResolveMcpDeps } from '../src/capability/mcp/index';

// ─── helpers ────────────────────────────────────────────────────────────────

/** 假 MCPClient —— 返回 N 个无害工具,callTool 回固定结果。 */
class FakeMCPClient implements MCPClient {
  constructor(
    readonly serverName: string,
    readonly tools: MCPTool[],
  ) {}
  async listTools(): Promise<MCPTool[]> {
    return this.tools;
  }
  async callTool(
    _name: string,
    _args: Record<string, unknown>,
    _opts?: MCPCallOptions,
  ): Promise<MCPToolResult> {
    return { content: 'ok' };
  }
}

/** n 个工具:tN_0 … tN_{n-1}。 */
function nTools(n: number): MCPTool[] {
  return Array.from({ length: n }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } }));
}

/** sdk-type config → 经 sdkFactory 注入对应的 FakeMCPClient(按 server 名取工具数)。 */
function depsFor(counts: Record<string, number>): ResolveMcpDeps {
  return {
    sdkFactory: (name) => new FakeMCPClient(name, nTools(counts[name] ?? 1)),
  };
}

/** 装配后取某 server 全部工具的 shouldDefer 结果。 */
async function assembleAndProbe(args: {
  mcpServers: Record<string, unknown>;
  counts: Record<string, number>;
  env?: Record<string, string | undefined>;
}): Promise<{ deferOf: (server: string) => boolean[]; dispose: () => Promise<void> }> {
  const assembled = await assembleCapabilities({
    bus: new EventBus(),
    mcp: {
      config: { mcpServers: args.mcpServers },
      deps: depsFor(args.counts),
      env: args.env,
    },
  });
  const deferOf = (server: string): boolean[] =>
    assembled.tools
      .filter((t) => t.name.startsWith(`mcp__${server}__`))
      .map((t) => t.shouldDefer?.() === true);
  const dispose = async (): Promise<void> => {
    for (const d of assembled.disposers) await d();
  };
  return { deferOf, dispose };
}

// ─── 接线矩阵 ───────────────────────────────────────────────────────────────

describe('MCP defer 装配接线 (decideMcpDeferMode → shouldDefer)', () => {
  test('默认(env 未设):MCP 工具 shouldDefer===true(首轮不上线)', async () => {
    const { deferOf, dispose } = await assembleAndProbe({
      mcpServers: { srv: { type: 'sdk', name: 'srv' } },
      counts: { srv: 3 },
    });
    try {
      const flags = deferOf('srv');
      expect(flags.length).toBe(3);
      expect(flags.every((d) => d === true)).toBe(true);
    } finally {
      await dispose();
    }
  });

  test('defer_loading:false → 强制 sync,工具不 defer', async () => {
    const { deferOf, dispose } = await assembleAndProbe({
      mcpServers: { srv: { type: 'sdk', name: 'srv', defer_loading: false } },
      counts: { srv: 2 },
    });
    try {
      const flags = deferOf('srv');
      expect(flags.length).toBe(2);
      expect(flags.every((d) => d === false)).toBe(true);
    } finally {
      await dispose();
    }
  });

  test('defer_loading:true + auto 默认 → 强制 async,defer', async () => {
    const { deferOf, dispose } = await assembleAndProbe({
      mcpServers: { srv: { type: 'sdk', name: 'srv', defer_loading: true } },
      counts: { srv: 1 },
      env: { FORGEAX_MCP_DEFER_DEFAULT: 'auto' },
    });
    try {
      const flags = deferOf('srv');
      expect(flags.length).toBe(1);
      expect(flags.every((d) => d === true)).toBe(true);
    } finally {
      await dispose();
    }
  });

  test('auto 模式阈值:工具数 < 阈值 → sync;>= → async', async () => {
    // 阈值设 20,一个 19 工具 server(sync)+ 一个 20 工具 server(async)。
    // 注:auto 模式比阈值用的是「auto/forced-sync server 工具数之和」,故两个
    // server 分开各测,避免和被累加越过阈值。
    const env = { FORGEAX_MCP_DEFER_DEFAULT: 'auto', FORGEAX_MCP_SYNC_THRESHOLD: '20' };

    const below = await assembleAndProbe({
      mcpServers: { small: { type: 'sdk', name: 'small' } },
      counts: { small: 19 },
      env,
    });
    try {
      expect(below.deferOf('small').every((d) => d === false)).toBe(true); // < 20 → sync
    } finally {
      await below.dispose();
    }

    const atThreshold = await assembleAndProbe({
      mcpServers: { big: { type: 'sdk', name: 'big' } },
      counts: { big: 20 },
      env,
    });
    try {
      expect(atThreshold.deferOf('big').every((d) => d === true)).toBe(true); // >= 20 → async
    } finally {
      await atThreshold.dispose();
    }
  });
});
