/**
 * @forgeax/extension-discovery — node-side extension discovery.
 *
 * The single source of the disk/npm manifest scan. Consumers (orchestrator's
 * registry, server) import from here instead of hosting their own scanner.
 */
export {
  scanAllExtensionOrigins,
  defaultExtensionRoots,
  isSafeBoot,
  isProduction,
} from './scanner';
export type {
  ExtensionOrigin,
  ScannedManifest,
  ScanError,
  ScanResult,
} from './scanner';
