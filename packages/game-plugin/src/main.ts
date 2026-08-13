#!/usr/bin/env node
/**
 * Single binary, two modes.
 *
 * With no arguments this is a stdio MCP server, because that is how every AI client
 * launches one: a bare command, no flags. With a subcommand it is an ordinary CLI.
 * One binary means one thing to install, one version to reason about, and no way for
 * the server and the installer that configures it to fall out of sync.
 */
import { runStdioServer } from './mcp/stdio';
import { createForgeaxMcpServer } from './mcp/forgeax-server';
import { runCli } from './cli/dispatch';

const argv = process.argv.slice(2);

// `mcp` is accepted explicitly so the mode can be pinned in a config file that
// dislikes argument-less commands.
if (argv.length === 0 || argv[0] === 'mcp') {
  runStdioServer(createForgeaxMcpServer());
} else {
  void runCli(argv).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`forgeax-game: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
