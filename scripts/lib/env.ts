// scripts/lib/env.ts — minimal .env loader (mirrors bash `set -a; source .env`).
//
// Parses KEY=value lines and injects them into process.env (without clobbering
// vars already set in the real environment, matching shell `source` semantics
// where an exported value wins only if the file assigns it). Returns the parsed
// map too, for callers that want the values directly.

import { existsSync, readFileSync } from 'node:fs';

export function loadDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as string;
    let val = (m[2] as string).trim();
    // strip surrounding matching quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    // `source` overwrites the running shell's value, so we mirror that.
    process.env[key] = val;
  }
  return out;
}
