/**
 * @forgeax/agent-runtime — public API.
 *
 * Phase C1 establishes the contract surface every cli-provider driver
 * speaks: a Driver maps a Session (thread+agent+persona) onto a
 * concrete LLM backend (codex / cursor / forgeax-native).
 *
 * The daemon implementation behind these contracts lives in
 * `packages/cli/` today and migrates here in follow-up PRs (split into
 * mv-with-alias then delete-legacy per roadmap §C1 risk plan).
 *
 * See docs/v2-vision/architecture-evolution/05-CLI-PROVIDERS.md.
 */
export * from './driver';
export * from './session';
export * from './contract';
export * from './noop-kernel';
