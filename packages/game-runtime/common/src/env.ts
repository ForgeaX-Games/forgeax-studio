/** Environment names deliberately passed to a Runtime child process. */
export const RUNTIME_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'FORGEAX_SERVER_PORT',
  'FORGEAX_ENGINE_PORT',
  'FORGEAX_INTERFACE_PORT',
  'FORGEAX_INTERFACE_HTTPS',
  'FORGEAX_RUNTIME_CACHE',
  'FORGEAX_RUNTIME_VERSION',
  'FORGEAX_PROJECT_ROOT',
  'FORGEAX_RESOURCE_ROOT',
  'FORGEAX_STARTUP_PROFILE',
] as const;

export type RuntimeEnvOverrides = Record<string, string | undefined>;

/** Copy only known, non-secret process settings; never pass the host environment wholesale. */
export function runtimeEnvironment(
  overrides: RuntimeEnvOverrides = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of RUNTIME_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!(RUNTIME_ENV_ALLOWLIST as readonly string[]).includes(name)) continue;
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
