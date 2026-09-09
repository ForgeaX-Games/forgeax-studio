import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { basename, join } from 'node:path';
import {
  validateArtifactManifest,
  type ArtifactManifestV1,
} from '../../packages/recursive-input-contract/src/artifact-manifest.ts';

export interface DownloadArtifactOptions {
  readonly cacheRoot: string;
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function artifactFilename(manifest: ArtifactManifestV1): string {
  const remoteName = basename(new URL(manifest.url).pathname) || 'artifact.bin';
  return remoteName.replace(/[^a-zA-Z0-9._-]/gu, '_');
}

async function cachedArtifactValid(path: string, manifest: ArtifactManifestV1): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== manifest.compressedBytes) return false;
  return await sha256File(path) === manifest.sha256;
}

export async function downloadArtifact(
  value: unknown,
  options: DownloadArtifactOptions,
): Promise<string> {
  const validation = validateArtifactManifest(value);
  if (!validation.ok) throw new Error(`invalid artifact manifest: ${validation.errors.map((error) => error.code).join(', ')}`);
  const manifest = validation.manifest;
  const directory = join(options.cacheRoot, manifest.name, manifest.version, manifest.sha256);
  const destination = join(directory, artifactFilename(manifest));
  mkdirSync(directory, { recursive: true });
  if (await cachedArtifactValid(destination, manifest)) return destination;

  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(manifest.url);
    if (!response.ok || !response.body) throw new Error(`artifact download failed (${response.status})`);
    if (response.url && !response.url.startsWith('https://')) throw new Error('artifact redirect must keep HTTPS');
    const hash = createHash('sha256');
    let bytes = 0;
    const digesting = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), digesting, createWriteStream(temporary, { flags: 'wx' }));
    const digest = hash.digest('hex');
    if (bytes !== manifest.compressedBytes) {
      throw new Error(`artifact size mismatch: expected ${manifest.compressedBytes}, got ${bytes}`);
    }
    if (digest !== manifest.sha256) {
      throw new Error(`artifact checksum mismatch: expected ${manifest.sha256}, got ${digest}`);
    }
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
