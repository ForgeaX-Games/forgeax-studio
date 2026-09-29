import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INSTALL_SCHEMA } from './constants';
import { canonicalizeOrigins } from './origins';
import { normalizeAssetLibraryServiceRoot, type AssetLibraryId } from './aw-access';

export interface Asset3dInstallManifest {
  schemaVersion: typeof INSTALL_SCHEMA;
  adapterVersion: string;
  serviceRoot: string;
  library: AssetLibraryId;
  credentialFile: string;
  downloadOrigins: readonly string[];
  originSetDigest: string;
}

export function readAsset3dConfig(root: string): Asset3dInstallManifest {
  const bytes = readFileSync(resolve(root, '.forgeax/extensions/asset3d/config.json'));
  if (bytes.length > 65536) throw new Error('asset3d_config_invalid');
  const value = JSON.parse(bytes.toString()) as Asset3dInstallManifest;
  if (value.schemaVersion !== INSTALL_SCHEMA || !['aw', 'ea'].includes(value.library) ||
      typeof value.credentialFile !== 'string' || !Array.isArray(value.downloadOrigins) ||
      normalizeAssetLibraryServiceRoot(value.serviceRoot) !== value.serviceRoot ||
      canonicalizeOrigins(value.downloadOrigins).digest !== value.originSetDigest) throw new Error('asset3d_config_invalid');
  return value;
}
