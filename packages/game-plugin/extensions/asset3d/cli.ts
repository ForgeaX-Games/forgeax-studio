import type { ExtensionContext } from '../../src/extensions/contract';
import { checkAssetLibraryAccess, resolveAssetLibrarySelection, type AssetLibraryId } from './src/aw-access';
import { acquireAwKey, defaultAwCredentialFile, writeAwCredential } from './src/credentials';
import { INSTALL_SCHEMA } from './src/constants';
import { canonicalizeOrigins } from './src/origins';
import { candidatesAsset3d, importAsset3d, parseAsset3dArgs } from './src/library';
import { doctorAsset3d } from './src/transaction';

export async function check(context: ExtensionContext, args: readonly string[]) {
  let library: AssetLibraryId | undefined;
  let baseUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (option === '--json') continue;
    if (option === '--library' && ['aw', 'ea'].includes(args[i + 1]!)) library = args[++i] as AssetLibraryId;
    else if (option === '--base-url' && args[i + 1]) baseUrl = args[++i];
    else throw new Error('asset3d_arguments_invalid: enable [--library aw|ea] [--base-url URL]');
  }
  const selected = resolveAssetLibrarySelection({ library, baseUrl });
  const credentialFile = defaultAwCredentialFile();
  const credential = await acquireAwKey(credentialFile, !args.includes('--json'));
  const pending = writeAwCredential(credentialFile, credential.key);
  try {
    const access = await checkAssetLibraryAccess({ ...selected, credentialFile });
    pending.commit();
    return { schemaVersion: INSTALL_SCHEMA, adapterVersion: context.packageVersion,
      ...selected, credentialFile, downloadOrigins: access.downloadOrigins,
      originSetDigest: canonicalizeOrigins(access.downloadOrigins).digest };
  } catch (error) { pending.rollback(); throw error; }
}

export async function run(context: ExtensionContext, args: readonly string[]) {
  const [operation, ...rest] = args;
  if (operation === 'doctor') {
    if (rest.some(arg => arg !== '--json')) throw new Error('asset3d_arguments_invalid');
    return doctorAsset3d(context.projectRoot);
  }
  if (operation === 'candidates' || operation === 'import') {
    const parsed = parseAsset3dArgs(rest, operation === 'import');
    return operation === 'candidates' ? candidatesAsset3d(context.projectRoot, parsed.query, parsed.options)
      : importAsset3d(context.projectRoot, parsed.query, parsed.assetId, parsed.options, parsed.versionName);
  }
  throw new Error('asset3d_arguments_invalid: expected candidates, import, or doctor');
}
