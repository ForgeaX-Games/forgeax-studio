import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "coverage",
  ".cache",
  ".turbo",
  ".npm"
]);

const SAFE_EXAMPLE = /^(?:\$\{\{?[^\n}]+\}?\}|<[^>\n]+>|\.\.\.|…|YOUR_[A-Z0-9_]+|REDACTED|(?:CHANGE|REPLACE|INSERT)_[A-Z0-9_]+|(?:EXAMPLE|DUMMY|TEST|FAKE|MOCK|CHANGEME)(?:[-_][A-Z0-9_]+)?)$/iu;
const SAFE_LITERAL = new Set(["", "...", "…", "include", "omit", "same-origin", "anonymous", "public", "string", "unknown", "undefined", "null", "true", "false"]);
const LOCAL_ABSOLUTE_PATH = /(?:^|[\s"'`=:])(?:\/(?:Users|home|root|Volumes)(?:\/|$)|[A-Z]:[\\/](?:Users|Documents and Settings)[\\/])[^\s"'`),;]*/u;
const SENSITIVE_FILENAME = /(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]*)?$|(?:^|\/)(?:id_rsa|credentials?|secrets?|private[-_]?key|(?:auth[-_]?|session[-_]?)?(?:token|cookie))(?:\.[^/]*)?$|\.(?:pem|p12|pfx|key)$/iu;

const VALUE_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["npm-token", /\bnpm_[A-Za-z0-9_-]{20,}\b/u],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["openai-token", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u],
  ["credential-url", /https?:\/\/[^\s"'/:]+:[^@\s"']+@/iu],
  ["credential-query", /https?:\/\/[^\s"']+[?&](?:access[_-]?token|api[_-]?key|token|signature|x-amz-security-token)=[^\s"']+/iu]
];

const KEY_ASSIGNMENT = /(?<![\w-])["'`]?(api[_-]?key|access[_-]?token|secret(?:[_-]?key)?|password|credential(?:s)?|session[_-]?token)["'`]?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s#,}\r\n]+))/iu;
const AUTH_ASSIGNMENT = /(?<![\w-])["'`]?(authorization|cookie)["'`]?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,}\r\n]+))/iu;

export function findSensitiveMatches(text, relativePath, { mode = "package" } = {}) {
  assertMode(mode);
  const findings = [];
  const lines = text.split(/\r?\n/u);

  if (SENSITIVE_FILENAME.test(relativePath)) {
    findings.push({ rule: "sensitive-filename", path: relativePath, line: 1 });
  }

  for (const [index, line] of lines.entries()) {
    for (const [rule, pattern] of VALUE_RULES) {
      if (pattern.test(line)) findings.push({ rule, path: relativePath, line: index + 1 });
    }

    if (LOCAL_ABSOLUTE_PATH.test(line)) {
      findings.push({ rule: "local-absolute-path", path: relativePath, line: index + 1 });
    }

    const keyMatch = KEY_ASSIGNMENT.exec(line);
    const keyValue = keyMatch?.slice(2).find((value) => value !== undefined) ?? "";
    const keyValueIsQuoted = Boolean(keyMatch && (isCommentLine(line) || keyMatch.slice(2, 5).some((value) => value !== undefined)));
    if (keyMatch && !isSafeExample(keyValue, { quoted: keyValueIsQuoted })) {
      findings.push({ rule: `credential-field:${keyMatch[1].toLowerCase()}`, path: relativePath, line: index + 1 });
    }

    const authMatch = AUTH_ASSIGNMENT.exec(line);
    const authValue = authMatch?.slice(2).find((value) => value !== undefined) ?? "";
    const authValueIsQuoted = Boolean(authMatch && authMatch.slice(2, 5).some((value) => value !== undefined));
    if (authMatch && !isSafeExample(authValue, { quoted: authValueIsQuoted })) {
      findings.push({ rule: "authorization-or-cookie", path: relativePath, line: index + 1 });
    }
  }

  return findings;
}

export function scanTree(root, { mode = "source" } = {}) {
  assertMode(mode);
  const absoluteRoot = realpathSync(resolve(root));
  const findings = [];
  walk(absoluteRoot, absoluteRoot, findings, mode);
  return findings;
}

function walk(root, current, findings, mode) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = resolve(current, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");

    if (entry.isSymbolicLink()) {
      findings.push({ rule: "symbolic-link", path: relativePath, line: 1 });
      continue;
    }

    if (mode === "source" && SKIP_DIRECTORIES.has(entry.name)) continue;

    if (entry.isDirectory()) {
      walk(root, absolutePath, findings, mode);
      continue;
    }
    if (!entry.isFile()) continue;

    const buffer = readFileSync(absolutePath);
    const text = buffer.includes(0) ? "" : buffer.toString("utf8");
    findings.push(...findSensitiveMatches(text, relativePath, { mode }));
  }
}

function isSafeExample(value, { quoted = false } = {}) {
  const normalized = value.trim().replace(/;$/u, "").replace(/^['"`]|['"`]$/gu, "").replace(/^bearer\s+/iu, "");
  if (SAFE_EXAMPLE.test(normalized) || SAFE_LITERAL.has(normalized.toLowerCase())) return true;
  if (quoted) return false;
  return /^(?:sk-(?:test|compat|direct|anthropic)|(?:tok|cfg)-[A-Za-z0-9-]+|fromProvider)$/u.test(normalized)
    || normalized.startsWith("process.env.")
    || normalized.includes("${")
    || /^!\d+$/u.test(normalized)
    || /^(?:\{|\[)$/u.test(normalized)
    || /^[A-Za-z_$][\w$.]*(?:\[[^\]\r\n]+\])?\(/u.test(normalized)
    || /^[A-Za-z_$][\w$.]*\s*(?:\|\||\?\?)/u.test(normalized)
    || (!/^bearer$/iu.test(normalized) && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\r\n]+\])*$/u.test(normalized))
    || /^(?:opts|input|request|config|headers|metadata|options|value|token|key|credential)\.[A-Za-z_]/u.test(normalized);
}

function assertMode(mode) {
  if (mode !== "source" && mode !== "package") throw new Error(`invalid --mode: ${mode}`);
}

function isCommentLine(line) {
  return /^\s*(?:\/\/|#|\*|<!--|--|;)/u.test(line);
}

function main() {
  const modeIndex = process.argv.indexOf("--mode");
  const pathIndex = process.argv.indexOf("--path");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined;
  const root = pathIndex >= 0 ? process.argv[pathIndex + 1] : undefined;
  if (!mode) throw new Error("--mode requires source or package");
  if (!root) throw new Error("--path requires a directory");

  const findings = scanTree(root, { mode });
  if (findings.length === 0) {
    console.log(`release secret scan passed: ${resolve(root)}`);
    return;
  }

  for (const finding of findings) {
    console.error(`release secret scan blocked: ${finding.rule} at ${finding.path}:${finding.line}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
