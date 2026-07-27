export interface SharedAssetRecord {
  id: string
  kind: string
  [key: string]: unknown
}

export interface SharedAssetManifest {
  version: 2
  assets: SharedAssetRecord[]
  [key: string]: unknown
}

function assertRecords(assets: unknown): asserts assets is SharedAssetRecord[] {
  if (!Array.isArray(assets)) throw new Error('invalid shared asset manifest')
  const ids = new Set<string>()
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error('invalid shared asset manifest record')
    }
    const record = asset as Record<string, unknown>
    const id = record.id
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof record.kind !== 'string' ||
      record.kind.length === 0 ||
      ids.has(id)
    ) {
      throw new Error('invalid or duplicate shared asset id')
    }
    ids.add(id)
  }
}

function isProviderVideo(asset: SharedAssetRecord): boolean {
  return asset.kind === 'video' && Object.hasOwn(asset, 'provider')
}

export function mergeSharedAssetManifest(
  existing: unknown,
  replacements: SharedAssetRecord[],
): SharedAssetManifest {
  assertRecords(replacements)
  if (!replacements.every(isProviderVideo)) {
    throw new Error('video import may only write provider-backed video assets')
  }
  const base =
    existing === undefined
      ? { version: 2 as const, assets: [] }
      : existing
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new Error('invalid shared asset manifest')
  }
  const parsed = base as Record<string, unknown>
  if (parsed.version !== 2) throw new Error('shared asset manifest must use version 2')
  assertRecords(parsed.assets)

  const replacementById = new Map(replacements.map((asset) => [asset.id, asset]))
  const assets: SharedAssetRecord[] = []
  for (const asset of parsed.assets) {
    const replacement = replacementById.get(asset.id)
    if (!replacement) {
      assets.push(asset)
      continue
    }
    if (!isProviderVideo(asset)) {
      throw new Error(`asset id is owned by another asset domain: ${asset.id}`)
    }
    assets.push(replacement)
    replacementById.delete(asset.id)
  }
  assets.push(...replacementById.values())
  return { ...parsed, version: 2, assets }
}
