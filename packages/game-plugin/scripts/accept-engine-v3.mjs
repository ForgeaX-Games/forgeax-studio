import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Run against an installed packed consumer, not a source checkout.
const [cliArg, rootArg] = process.argv.slice(2);
if (!cliArg || !rootArg) throw new Error('usage: node scripts/accept-engine-v3.mjs <installed-cli> <initialized-game>');
const cli = realpathSync(cliArg);
const root = realpathSync(rootArg);
assert(cli.includes('/node_modules/@forgeax/game/dist/'));
const manifest = JSON.parse(readFileSync(resolve(root, 'forge.json'), 'utf8'));
assert.equal(manifest.schemaVersion, '3.0.0');
assert.equal(manifest.entry, undefined);
assert.match(manifest.roots?.engine ?? '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const child = spawn(process.execPath, [cli, 'mcp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 0;
let buffer = '';
let errors = '';
child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  }
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolveRequest, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}: ${errors}`)); }, 180000);
    pending.set(id, response => {
      clearTimeout(timeout);
      pending.delete(id);
      response.error ? reject(new Error(JSON.stringify(response.error))) : resolveRequest(response.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packed-engine-v3-acceptance', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await request('tools/list', {});
  assert(tools.tools.some(tool => tool.name === 'forgeax_run_current_game'));
  const result = await request('tools/call', { name: 'forgeax_run_current_game', arguments: { target_dir: root } });
  const text = result.content?.map(item => item.text ?? '').join('\n') ?? '';
  console.log(text);
  assert(!result.isError, 'MCP run returned an error');
  for (const field of ['preview.status: ready', 'preview_url:', 'preview.root:', 'preview.build_digest:', 'preview.instance_id:']) assert(text.includes(field), `missing ${field}`);
  assert(text.includes(root));
  const url = text.match(/^preview_url: (.+)$/m)?.[1];
  const response = await fetch(url);
  assert(response.ok, 'Preview URL is not reachable');
  console.log('PASS_SUPPORTING: packed MCP recognizes Engine v3 and returns Engine-owned Preview identity; visible gameplay not tested.');
  // Keep the real MCP owner alive during a bounded manual/browser inspection.
  if (process.argv.includes('--hold-for-browser')) {
    console.log('Browser inspection window: 300 seconds; owner closes afterwards.');
    await new Promise(resolveWait => setTimeout(resolveWait, 300000));
  }
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
