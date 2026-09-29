import { afterEach, describe, expect, test } from 'bun:test';
import { resolveLiteLlmConfig } from '../src/gen/config';

const previousBaseUrl = process.env.FORGEAX_LITELLM_BASE_URL;
const previousApiKey = process.env.FORGEAX_LITELLM_API_KEY;

afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.FORGEAX_LITELLM_BASE_URL;
  else process.env.FORGEAX_LITELLM_BASE_URL = previousBaseUrl;
  if (previousApiKey === undefined) delete process.env.FORGEAX_LITELLM_API_KEY;
  else process.env.FORGEAX_LITELLM_API_KEY = previousApiKey;
});

describe('LiteLLM configuration', () => {
  test('requires an explicitly configured gateway', () => {
    delete process.env.FORGEAX_LITELLM_BASE_URL;
    process.env.FORGEAX_LITELLM_API_KEY = 'test-key';
    expect(() => resolveLiteLlmConfig()).toThrow('FORGEAX_LITELLM_BASE_URL is not set');
  });

  test('uses the configured gateway and normalizes trailing slashes', () => {
    process.env.FORGEAX_LITELLM_BASE_URL = 'https://litellm.example.com///';
    process.env.FORGEAX_LITELLM_API_KEY = 'test-key';
    expect(resolveLiteLlmConfig().baseUrl).toBe('https://litellm.example.com');
  });
});
