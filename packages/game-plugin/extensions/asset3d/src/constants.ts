import { createHash } from 'node:crypto';

export const PROVIDER_RESULT_SCHEMA = 'forgeax.asset3d-search-result/2.0.0';
export const PROVIDER_RECEIPT_SCHEMA = 'forgeax.asset3d-search-receipt/2.0.0';
export const INSTALL_SCHEMA = 'forgeax.asset3d-install/2.0.0';
export const TRANSACTION_SCHEMA = 'forgeax.asset3d-transaction/2.0.0';
export const PROVENANCE_SCHEMA = 'forgeax.asset3d-provenance/2.0.0';
export const MAX_JSON_BYTES = 1024 * 1024;

export const SKILL_MOUNTS = Object.freeze({
  codex: '.agents/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
  trae: '.trae/skills',
  codebuddy: '.codebuddy/skills',
  windsurf: '.codeium/windsurf/skills',
  vscode: '.vscode/skills',
  zcode: '.zcode/skills',
  opencode: '.config/opencode/skills',
} as const);

export type Asset3dClientId = keyof typeof SKILL_MOUNTS;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
