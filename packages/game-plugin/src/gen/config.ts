/**
 * Configuration for the LiteLLM-backed asset generation tools.
 *
 * One gateway, one key. Both the image and 3D tools resolve their endpoint and
 * credential here so there is a single place a deployment overrides them and a single
 * error message when the key is missing. The key is a secret and therefore has no
 * default — it must come from the environment the host injects, never from source.
 */

/**
 * Default gateway for teams that run the shared ForgeaX LiteLLM proxy. It is an
 * internal address, not a secret, so baking it in keeps `@forgeax/game` turnkey while
 * still letting any deployment point elsewhere with `FORGEAX_LITELLM_BASE_URL`.
 */
export const DEFAULT_LITELLM_BASE_URL = 'http://21.214.33.175:4000';

/** Verified-available defaults (see docs/evidence). Overridable per call and per env. */
export const DEFAULT_MODELS = {
  // seedream / gpt-image-2 need gateway creds the proxy does not currently carry;
  // gemini-3-pro-image is the verified-working text-to-image default.
  textToImage: 'gemini-3-pro-image',
  textTo3d: 'tripo-3d-text',
  imageTo3d: 'tripo-3d-image',
} as const;

export interface LiteLlmConfig {
  /** Base URL with any trailing slashes stripped, so `${baseUrl}/v1/...` is well-formed. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: {
    readonly textToImage: string;
    readonly textTo3d: string;
    readonly imageTo3d: string;
  };
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve the LiteLLM configuration from the environment.
 *
 * Throws a message that names the exact variable to set rather than failing deep inside
 * a fetch, because a missing key is the single most likely first-run problem and the
 * model relaying the error to the user should be able to state the fix.
 */
export function resolveLiteLlmConfig(): LiteLlmConfig {
  const baseUrl = (env('FORGEAX_LITELLM_BASE_URL') ?? DEFAULT_LITELLM_BASE_URL).replace(/\/+$/, '');
  const apiKey = env('FORGEAX_LITELLM_API_KEY');
  if (!apiKey) {
    throw new Error(
      'FORGEAX_LITELLM_API_KEY is not set. Export the LiteLLM key so the asset tools can reach the gateway, e.g. `export FORGEAX_LITELLM_API_KEY=sk-...`.',
    );
  }
  return {
    baseUrl,
    apiKey,
    models: {
      textToImage: env('FORGEAX_GEN_IMAGE_MODEL') ?? DEFAULT_MODELS.textToImage,
      textTo3d: env('FORGEAX_GEN_3D_TEXT_MODEL') ?? DEFAULT_MODELS.textTo3d,
      imageTo3d: env('FORGEAX_GEN_3D_IMAGE_MODEL') ?? DEFAULT_MODELS.imageTo3d,
    },
  };
}
