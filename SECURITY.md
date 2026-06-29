# ForgeaX Security Policy

> Version: 0.1 · 2026-05-22 · Aligned with [ADR-0014 trust model](./docs/decisions/0014-trust-model-default-deny-runtime-confirm.md)

## Reporting a vulnerability

Email **dev@forgeax.local** with subject `SECURITY: <one-line summary>`. Encrypt with the project key in `docs/security/forgeax-public.pgp` if you can; plain mail is acceptable. We aim to acknowledge within 72 hours.

Please do **not** open a public GitHub issue for security-sensitive findings.

## Threat model (in scope)

- **Plugin supply-chain.** A plugin authored by a third party is installed via `.fxpack` import or by dropping into `~/.forgeax/plugins/`. The plugin can declare permissions in its manifest; the host renders these to the user before install.
- **Credential leakage at export.** A plugin author exports their plugin without realizing a config file contains an API key. The exporter lints for common secret patterns and rejects.
- **Cross-tenant isolation on a single host.** Multiple game projects share the same daemon process; project-private (L2) plugins must not bleed into other projects' L2 namespace.

## Out of scope (v1)

- **Runtime permission enforcement.** Manifest-declared permissions are advisory in v1: the host does NOT yet gate `fs:*` or `net:*` calls at runtime. A plugin that lies in its manifest can touch arbitrary paths under the daemon's UID. This gap is explicitly tracked under `docs/decisions/0014-...md` "Consequences" and is the next milestone after `.fxpack` portability lands.
- **Sandboxed plugin processes.** Plugins run in-process today. Worker-pool isolation is on the roadmap (`13-MIGRATION-ROADMAP §D4` worker pool).
- **Cross-platform native code.** `.fxpack` exports reject native binaries (`.so/.dll/.dylib/.node`); receivers cannot run them via the standard import flow.
- **Network isolation between plugins.** Plugins on the same host share the daemon's network egress. Use `permissions: ["net:..."]` to declare intent; enforcement is future work.

## Things that ARE enforced today

- **Manifest validation.** Every loaded plugin manifest passes `ManifestSchema.safeParse`. Malformed manifests are rejected at scan time and surfaced as `scanErrors[]` — they do not load.
- **AI tool-call gating.** `caller.kind === 'ai'` is rejected with `{ ok: false, code: 'forbidden' }` for any tool that does not declare `exposedToAI: true`.
- **Skill `requiresTools[]` whitelist.** Inside a TS skill, `ctx.callTool(...)` returns `forbidden` when the requested toolId is not in the skill's declared `requiresTools[]`.
- **Export-time secret lint.** `.fxpack` export rejects when text files contain `sk-...`, `Bearer ...`, `API_KEY = "..."`, or AWS access-key shapes. Conservative — false positives stop a real export but are easy to fix.
- **Export-time native-binary reject.** Same path: `.so/.dll/.dylib/.node` causes `lint_error`.
- **Export-time absolute-path reject.** Catches `/Users/you`, `/home/you`, `/root/...`, `C:\...` outside of allowlisted lockfiles.

## Best practices for plugin authors

1. **Never commit secrets to the plugin tree.** Use `process.env` in the handler. The export linter will reject obvious leaks, but it is not a substitute for review.
2. **Declare the permissions you actually use.** Even though v1 doesn't enforce, the trust panel UI uses these to inform receivers. Lying degrades trust in the marketplace.
3. **Pin your `compatibleWith.forgeax-bus`.** Manifest validation may tighten between versions; pinning gives users a clear error rather than a silent misload.
4. **Validate AI inputs in your handler.** Even though `argsSchema` is declared, treat it as documentation, not as a fully strict gate (future work). Validate again inside the handler when correctness matters.
5. **Test locally with a clean workspace.** Drop your plugin into `<projectRoot>/.forgeax/plugins/` (L2) and verify it still works after `POST /api/plugins/reload`.

## Coordinated disclosure

We follow a 90-day disclosure window from acknowledgement. If we cannot patch within 90 days, we will request an extension with a public status; we will not silently sit on a report.
