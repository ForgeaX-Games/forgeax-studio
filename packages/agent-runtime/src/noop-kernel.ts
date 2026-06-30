/**
 * NoopKernel — proves the neutral `AgentKernel` spine is implementable and
 * serves as a test double. It is NOT a production fallback: a missing or
 * unresolved kernel surfaces an explicit `KernelError{kernel_unavailable}`
 * via the resolver (v9 decision #6 / M5), never a silent downgrade to this.
 *
 * The reference turn is intentionally minimal but obeys the contract's two
 * load-bearing invariants so it can stand in for a real kernel in tests:
 *   1. `turn.usage` is emitted BEFORE `turn.done` (B5), on every path
 *      including abort.
 *   2. an aborted turn ends with `turn.done{reason:'cancelled'}`.
 *
 * Pass `echo:true` (default) and it emits a single `message.delta` echoing
 * the input text, so consumers have something to assert on; pass `echo:false`
 * for a truly silent turn.
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  ModelRef,
  PermissionMode,
  TurnHandle,
  TurnRequest,
} from './contract';

export interface NoopKernelOptions {
  /** Emit a `message.delta` echoing `req.input.text`. Default true. */
  echo?: boolean;
}

export class NoopKernel implements AgentKernel {
  readonly id = 'noop';
  readonly capabilities: KernelCapabilities = {
    streaming: true,
    thinking: false,
    toolCalls: false,
    midTurnInject: false,
  };

  private readonly echo: boolean;

  constructor(opts: NoopKernelOptions = {}) {
    this.echo = opts.echo ?? true;
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    if (signal.aborted) {
      // usage-before-done invariant holds even on the immediate-abort path.
      yield { kind: 'turn.usage', inputTokens: 0, outputTokens: 0 };
      yield { kind: 'turn.done', reason: 'cancelled' };
      return;
    }

    if (this.echo) {
      yield { kind: 'message.delta', role: 'assistant', text: req.input.text };
    }

    yield {
      kind: 'turn.usage',
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 0,
    };
    yield { kind: 'turn.done', reason: 'stop' };
  }

  openHandle(_callId: string): TurnHandle {
    return {
      async setPermissionMode(_mode: PermissionMode): Promise<void> {},
      async setModel(_model: ModelRef): Promise<void> {},
      async interrupt(): Promise<void> {},
      async cancel(): Promise<void> {},
    };
  }

  async probe(): Promise<KernelHealth> {
    return { ok: true, kernelId: this.id, detail: 'noop kernel (test double)' };
  }
}
