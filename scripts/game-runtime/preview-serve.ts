#!/usr/bin/env bun

import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readPreviewManifest, validatePreviewOutput } from './preview-contract';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

const outputRoot = resolve(requiredOption('--output-root'));
if (!isAbsolute(outputRoot) || !existsSync(outputRoot) || !statSync(outputRoot).isDirectory()) {
  throw new Error(`preview output root is missing: ${outputRoot}`);
}
const manifest = readPreviewManifest(outputRoot);
validatePreviewOutput(outputRoot);
const host = option('--host')?.trim() || '127.0.0.1';
const port = Number(option('--port') ?? '0');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid preview port: ${port}`);

const isolationHeaders = {
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
};

function containedFile(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const relativePath = decoded.replace(/^\/preview\/?/, '') || 'index.html';
  const candidate = resolve(outputRoot, relativePath);
  const rel = relative(outputRoot, candidate);
  if (!rel || rel === 'index.html') return resolve(outputRoot, 'index.html');
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (!extname(relativePath)) return resolve(outputRoot, 'index.html');
  return undefined;
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/preview/__forgeax_health') {
      return Response.json({
        ...manifest,
        status: 'ok',
      }, { headers: isolationHeaders });
    }
    if (!url.pathname.startsWith('/preview')) return new Response('Not found', { status: 404 });
    const file = containedFile(url.pathname);
    if (!file || !existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(file), {
      headers: {
        ...isolationHeaders,
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      },
    });
  },
});

console.log(JSON.stringify({
  previewUrl: `http://${host}:${server.port}/preview/`,
  healthUrl: `http://${host}:${server.port}/preview/__forgeax_health`,
  pid: process.pid,
  manifest,
}));
