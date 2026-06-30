/**
 * team-spawn-tool —— coordinator 显式组队工具(设计 §13:explicit team_spawn,非 auto-on-Task)。
 *
 * 边界:本文件**只**是一个 capability 工具,**不** import CoreAgent / EventBus(那是 HOST 层)。
 *   真起 peer 的能力经注入的 `spawnPeer` 函数提供(HOST 层 `cli/peer.ts makeTeamPeerSpawner`),
 *   故 capability→agent 边界不破。
 *
 * 语义:coordinator 调 `team_spawn({members:[{name,brief}]})` →(并发)起 N 个常驻 peer,
 *   各自跑「认领-循环」直到共享板抽干。并发 spawn = 真原子 claim 演练(N peer 抢同板不撞)。
 *   coordinator 经本工具结果 + 自身 inbox 收到 peer 的 SendMessage 双路看进度(task_list 看板)。
 *   只 coordinator 持本工具(peer 工具集剥 team_spawn / Task,防递归 + 单层组队,§13.1#8)。
 */
import { buildTool, type AgentTool } from '../types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';

/** 单个 peer 跑完的终态(HOST 层 spawner 返回;本工具汇总)。 */
export interface PeerSpawnResult {
  name: string;
  ok: boolean;
  /** 终态原因(done.terminal.reason)或失败信息。 */
  reason: string;
}

/** team_spawn 工具依赖:HOST 注入「真起一个 peer」的函数。 */
export interface TeamSpawnToolDeps {
  spawnPeer: (name: string, brief: string, signal?: AbortSignal) => Promise<PeerSpawnResult>;
  /** 兜底成员上限(防一次 spawn 过多;默认 8)。 */
  maxMembers?: number;
}

export interface TeamSpawnInput {
  members: Array<{ name: string; brief: string }>;
}

export interface TeamSpawnOutput {
  ok: boolean;
  /** 每个成员的终态。 */
  roster: PeerSpawnResult[];
  /** 人/AI 可读的一句总结(用于工具结果渲染)。 */
  note: string;
}

function resultEvent(toolUseId: string, ok: boolean, result: unknown): CoreEvent {
  return {
    type: CoreEventType.ToolCallResult,
    payload: { toolUseId, isError: !ok, result: typeof result === 'string' ? result : JSON.stringify(result) },
    ts: Date.now(),
  };
}

/**
 * `team_spawn` —— 显式组队。并发起 peers,各跑认领-循环到板空,汇总终态。
 * 调用前先用 task_create 把任务放上共享板;调用后用 task_list 看结果 + 读 coordinator inbox 收报告。
 */
export function teamSpawnTool(deps: TeamSpawnToolDeps): AgentTool<TeamSpawnInput, TeamSpawnOutput> {
  const maxMembers = deps.maxMembers ?? 8;
  return buildTool<TeamSpawnInput, TeamSpawnOutput>({
    name: 'team_spawn',
    aliases: ['TeamSpawn'],
    searchHint: 'spawn a team of peers to claim and complete tasks from the shared board',
    inputJSONSchema: {
      type: 'object',
      properties: {
        members: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Unique peer name (used for board claim ownership and addressing).' },
              brief: { type: 'string', description: 'What this peer should focus on (it self-drives: claim → do → report).' },
            },
            required: ['name', 'brief'],
            additionalProperties: false,
          },
          description: 'Team members to spawn. Each runs a claim-loop over the shared board until it is drained.',
        },
      },
      required: ['members'],
      additionalProperties: false,
    },
    maxResultSizeChars: 8_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(input, ctx) {
      const members = input.members ?? [];
      if (members.length === 0) {
        return { data: { ok: false, roster: [], note: 'team_spawn: no members given' } };
      }
      if (members.length > maxMembers) {
        return { data: { ok: false, roster: [], note: `team_spawn: too many members (${members.length} > ${maxMembers})` } };
      }
      const names = new Set<string>();
      for (const m of members) {
        if (names.has(m.name)) {
          return { data: { ok: false, roster: [], note: `team_spawn: duplicate member name '${m.name}'` } };
        }
        names.add(m.name);
      }
      // 并发起 peers → 真原子 claim 演练(N peer 抢同板)。各自跑到 done。
      const roster = await Promise.all(members.map((m) => deps.spawnPeer(m.name, m.brief, ctx.signal)));
      const ok = roster.every((r) => r.ok);
      const note = ok
        ? `team of ${roster.length} finished: ${roster.map((r) => `${r.name}(${r.reason})`).join(', ')}. Use task_list to see the board; peer reports arrived via your inbox.`
        : `team finished with errors: ${roster.map((r) => `${r.name}(${r.ok ? 'ok' : 'FAIL:' + r.reason})`).join(', ')}`;
      return { data: { ok, roster, note } };
    },
    mapResult: (o, id) => resultEvent(id, o.ok, o.note),
  });
}
