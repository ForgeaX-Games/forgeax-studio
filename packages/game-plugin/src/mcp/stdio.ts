/**
 * stdio transport for the MCP server.
 *
 * Two lifecycle rules, both learned from MCP servers misbehaving in the field:
 *
 * 1. Exit only passively — when stdin closes (the AI client went away) or a write
 *    fails with a broken pipe. Never self-terminate on an idle timer: a long-lived
 *    session can sit idle for hours and killing it looks like a crash to the client.
 * 2. stdout is the protocol channel. Nothing may write to it except framed JSON-RPC,
 *    so all diagnostics go to stderr or the crash log.
 */
import { dispatch, errorMessage, type JsonRpcMessage, type McpServerSpec } from './protocol';
import { writeCrashLog } from './crash-log';

/** Write errors that mean "the client is gone" rather than "something is broken". */
const CLIENT_GONE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET']);

function isClientGone(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return code !== undefined && CLIENT_GONE_CODES.has(code);
}

export function runStdioServer<Ctx>(spec: McpServerSpec<Ctx>): void {
  let buffer = '';
  let shuttingDown = false;
  let inputClosed = false;
  let inFlight = 0;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A departed client is normal operation, not a crash. Let Node exit naturally
    // so buffered protocol writes are flushed instead of being truncated by
    // process.exit().
    process.exitCode = 0;
    process.stdin.pause();
  };

  const finishAfterDrain = (): void => {
    if (inputClosed && inFlight === 0) shutdown();
  };

  const send = (payload: unknown): Promise<void> =>
    new Promise((resolve) => {
      try {
        process.stdout.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) {
            if (isClientGone(error)) shutdown();
            else writeCrashLog('stdout-write', error);
          }
          resolve();
        });
      } catch (e) {
        if (isClientGone(e)) shutdown();
        else writeCrashLog('stdout-write', e);
        resolve();
      }
    });

  process.stdout.on('error', (e) => {
    if (isClientGone(e)) shutdown();
    else writeCrashLog('stdout', e);
  });
  process.stderr.on('error', () => {
    /* diagnostics channel died; the crash log still works */
  });

  const handle = (line: string): void => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // malformed frame — the spec says ignore rather than guess
    }
    inFlight++;
    void dispatch(spec, msg)
      .then(async (res) => {
        if (res) await send(res);
      })
      .catch(async (e) => {
        writeCrashLog('dispatch', e);
        if (msg.id != null) {
          await send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: errorMessage(e) } });
        }
      })
      .finally(() => {
        inFlight--;
        finishAfterDrain();
      });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) handle(line);
    }
  });
  const onInputClosed = (): void => {
    inputClosed = true;
    finishAfterDrain();
  };
  process.stdin.on('end', onInputClosed);
  process.stdin.on('close', onInputClosed);

  process.on('uncaughtException', (e) => {
    if (isClientGone(e)) shutdown();
    else writeCrashLog('uncaughtException', e);
  });
  process.on('unhandledRejection', (e) => writeCrashLog('unhandledRejection', e));
}
