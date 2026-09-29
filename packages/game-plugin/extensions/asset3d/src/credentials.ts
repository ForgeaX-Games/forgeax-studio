import { chmodSync, existsSync, lstatSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { atomicWrite, ensurePrivateDir } from './fs';

export const AW_CREDENTIAL_SCHEMA = 'forgeax.asset3d-credential/1.0.0';
export const AW_KEY_ENV = 'FORGEAX_ASSET3D_AW_SANDBOX_KEY';
const MAX_CREDENTIAL_BYTES = 4096;

interface CredentialRecord {
  readonly schemaVersion: typeof AW_CREDENTIAL_SCHEMA;
  readonly provider: 'aw';
  readonly sandboxKey: string;
}

export interface CredentialTransaction {
  readonly path: string;
  readonly changed: boolean;
  commit(): void;
  rollback(): void;
}

function validateKey(value: string): string {
  if (!value || value.length > 2048 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new Error('asset3d_api_key_invalid: expected a non-empty printable key');
  }
  return value;
}

export function defaultAwCredentialFile(): string {
  const configured = process.env.FORGEAX_ASSET3D_CREDENTIAL_FILE;
  return resolve(configured || resolve(homedir(), '.forgeax', 'credentials', 'asset3d-aw.json'));
}

export function readAwCredential(pathInput: string): string | undefined {
  const path = resolve(pathInput);
  if (!isAbsolute(pathInput)) throw new Error('asset3d_credential_path_invalid: absolute path required');
  if (!existsSync(path)) return undefined;
  try {
    const metadata = lstatSync(path);
    const wrongOwner = typeof process.getuid === 'function' && metadata.uid !== process.getuid();
    if (!metadata.isFile() || metadata.isSymbolicLink() || wrongOwner) throw new Error();
    if ((metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > MAX_CREDENTIAL_BYTES) throw new Error();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialRecord> & Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'provider,sandboxKey,schemaVersion') throw new Error();
    if (parsed.schemaVersion !== AW_CREDENTIAL_SCHEMA || parsed.provider !== 'aw' || typeof parsed.sandboxKey !== 'string') throw new Error();
    return validateKey(parsed.sandboxKey);
  } catch {
    throw new Error('asset3d_credential_invalid: credential file must be an owned 0600 regular file with the supported schema');
  }
}

export async function promptAwKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error(`asset3d_api_key_required: set ${AW_KEY_ENV} or rerun in an interactive terminal`);
  }
  process.stdout.write('AW Asset3D Sandbox Key (input hidden): ');
  const input = process.stdin;
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  try {
    const value = await new Promise<string>((resolveValue, reject) => {
      let collected = '';
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (character === '\u0003') {
            input.off('data', onData);
            reject(new Error('asset3d_api_key_input_cancelled'));
            return;
          }
          if (character === '\r' || character === '\n') {
            input.off('data', onData);
            resolveValue(collected);
            return;
          }
          if (character === '\u007f' || character === '\b') collected = collected.slice(0, -1);
          else collected += character;
        }
      };
      input.on('data', onData);
    });
    process.stdout.write('\n');
    return validateKey(value);
  } finally {
    input.setRawMode(previousRaw ?? false);
    input.pause();
  }
}

export async function acquireAwKey(path: string, interactive = true): Promise<{ key: string; source: 'environment' | 'stored' | 'prompt' }> {
  const fromEnvironment = process.env[AW_KEY_ENV];
  if (fromEnvironment) return { key: validateKey(fromEnvironment), source: 'environment' };
  const stored = readAwCredential(path);
  if (stored) return { key: stored, source: 'stored' };
  if (!interactive) throw new Error('asset3d_api_key_required');
  return { key: await promptAwKey(), source: 'prompt' };
}

export function writeAwCredential(pathInput: string, keyInput: string): CredentialTransaction {
  if (!isAbsolute(pathInput)) throw new Error('asset3d_credential_path_invalid: absolute path required');
  const path = resolve(pathInput);
  const key = validateKey(keyInput);
  const parent = dirname(path);
  ensurePrivateDir(parent);
  const parentMetadata = lstatSync(parent);
  const wrongParentOwner = typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid();
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || wrongParentOwner) {
    throw new Error('asset3d_credential_path_invalid: parent must be an owned regular directory');
  }
  chmodSync(parent, 0o700);
  const existed = existsSync(path);
  if (existed) readAwCredential(path);
  const previous = existed ? readFileSync(path) : undefined;
  const previousMode = existed ? statSync(path).mode & 0o777 : undefined;
  const bytes = `${JSON.stringify({ schemaVersion: AW_CREDENTIAL_SCHEMA, provider: 'aw', sandboxKey: key }, null, 2)}\n`;
  const changed = !previous || !previous.equals(Buffer.from(bytes));
  if (changed) atomicWrite(path, bytes, 0o600);
  chmodSync(path, 0o600);
  let active = true;
  return {
    path,
    changed,
    commit() { active = false; },
    rollback() {
      if (!active || !changed) return;
      if (previous) {
        atomicWrite(path, previous, previousMode ?? 0o600);
        chmodSync(path, previousMode ?? 0o600);
      } else {
        unlinkSync(path);
      }
      active = false;
    },
  };
}
