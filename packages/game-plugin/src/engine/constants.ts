/**
 * The only Engine SDK identity this Game Plugin may execute.
 *
 * Keep these values separate from the carrier resolver so both release checks and
 * bootstrap validation use the same immutable identity without introducing a module
 * cycle.
 */
export const ENGINE_VERSION = '0.3.3' as const;
export const ENGINE_COMMIT = '4ad48ef03d8f8f1bb74f5bf7cde71c4799d51060' as const;
export const ENGINE_SDK_PACKAGE = '@forgeax/engine-sdk' as const;
export const PNPM_VERSION = '11.7.0' as const;
