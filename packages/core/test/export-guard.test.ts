/**
 * WS-B EXPORT GUARD — locks the sidecar 收口 demotion.
 *
 * `ForgeaxCoreKernel` is the sidecar's internal engine (constructed only by
 * `src/cli/serve.ts` via a relative import). It is intentionally NOT part of the
 * public `@forgeax/forgeax-core` `.` export. This test fails if anyone re-adds
 * `export * from './kernel-facade/...'` to `src/index.ts`.
 */
import { test, expect } from 'bun:test';
import * as pkg from '../src/index';

test('public export omits ForgeaxCoreKernel (sidecar-internal facade)', () => {
  expect('ForgeaxCoreKernel' in pkg).toBe(false);
});
