#!/usr/bin/env node
/**
 * Single binary, two modes.
 *
 * With no arguments this is a stdio MCP server, because that is how local AI clients
 * launch one. The explicit `mcp --transport http` mode serves the same MCP surface
 * over stateless Streamable HTTP for loopback daemons and authenticated gateways.
 * With any other subcommand it is an ordinary CLI.
 */
import { resolve } from 'node:path';
import { runStdioServer } from './mcp/stdio';
import { createForgeaxMcpServer } from './mcp/forgeax-server';
import { startHttpMcpServer } from './mcp/http';
import { runCli } from './cli/dispatch';

const argv = process.argv.slice(2);

interface ParsedMcpArgs {
  readonly transport: 'stdio' | 'http';
  readonly host: string;
  readonly port: number;
  readonly root: string;
  readonly requireAuth: boolean;
  readonly allowedOrigins: readonly string[];
}

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`MCP HTTP port must be an integer from 0 to 65535, got ${raw}`);
  }
  return value;
}

function parseMcpArgs(args: readonly string[]): ParsedMcpArgs {
  let transport: 'stdio' | 'http' = 'stdio';
  let host = process.env.FORGEAX_MCP_HOST?.trim() || '127.0.0.1';
  let port = parsePort(process.env.FORGEAX_MCP_PORT?.trim() || '18940');
  let root = process.env.FORGEAX_MCP_ROOT?.trim() || process.cwd();
  let requireAuth = process.env.FORGEAX_MCP_REQUIRE_AUTH === '1';
  let allowedOrigins = (process.env.FORGEAX_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--transport') {
      const value = valueAfter(args, i, arg);
      if (value !== 'stdio' && value !== 'http') throw new Error('--transport must be stdio or http');
      transport = value;
      i++;
    } else if (arg.startsWith('--transport=')) {
      const value = arg.slice('--transport='.length);
      if (value !== 'stdio' && value !== 'http') throw new Error('--transport must be stdio or http');
      transport = value;
    } else if (arg === '--host') {
      host = valueAfter(args, i, arg);
      i++;
    } else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
    else if (arg === '--port') {
      port = parsePort(valueAfter(args, i, arg));
      i++;
    } else if (arg.startsWith('--port=')) port = parsePort(arg.slice('--port='.length));
    else if (arg === '--root') {
      root = valueAfter(args, i, arg);
      i++;
    } else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg === '--require-auth') requireAuth = true;
    else if (arg === '--allowed-origin') {
      allowedOrigins = [...allowedOrigins, valueAfter(args, i, arg)];
      i++;
    } else if (arg.startsWith('--allowed-origin=')) {
      allowedOrigins = [...allowedOrigins, arg.slice('--allowed-origin='.length)];
    } else throw new Error(`unknown MCP option: ${arg}`);
  }
  return { transport, host, port, root: resolve(root), requireAuth, allowedOrigins };
}

async function runMcp(args: readonly string[]): Promise<void> {
  const options = parseMcpArgs(args);
  if (options.transport === 'stdio') {
    if (args.length > 0) {
      const unsupported = args.filter((arg) => arg !== '--transport' && arg !== 'stdio' && arg !== '--transport=stdio');
      if (unsupported.length > 0) throw new Error('stdio MCP does not accept HTTP listener options');
    }
    runStdioServer(createForgeaxMcpServer());
    return;
  }

  const running = await startHttpMcpServer(
    createForgeaxMcpServer({
      root: options.root,
      authoringTools: true,
      allowTargetDir: false,
      existingServicesOnly: process.env.FORGEAX_MCP_EXISTING_SERVICES === '1',
      publicOrigin: process.env.FORGEAX_PUBLIC_ORIGIN,
    }),
    {
      host: options.host,
      port: options.port,
      authToken: process.env.FORGEAX_REMOTE_MCP_TOKEN,
      requireAuth: options.requireAuth,
      allowedOrigins: options.allowedOrigins,
    },
  );
  process.stderr.write(`forgeax-game MCP listening at ${running.url} (root=${options.root})\n`);
  const close = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (argv.length === 0 || argv[0] === 'mcp') {
  void runMcp(argv.length === 0 ? [] : argv.slice(1)).catch((error: unknown) => {
    process.stderr.write(`forgeax-game: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  void runCli(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`forgeax-game: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
