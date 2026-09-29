export const ASSET_TYPES = [1, 2, 3, 5, 6, 7, 8, 9, 11] as const;
export const ART_STYLES = ['realistic', 'semi-realistic', 'stylized', 'cartoon', 'pixel art', 'voxel art', 'low poly', 'hand-drawn', 'minimalist', 'generic'];
export const THEME_STYLES = ['urban', 'rural', 'industrial', 'military', 'ancient', 'medieval', 'traditional chinese', 'traditional japanese', 'wild west', 'aquatic', 'fantasy', 'xianxia', 'steampunk', 'cyberpunk', 'science fiction', 'space', 'post-apocalyptic', 'horror', 'nature', 'prehistoric', 'generic'];

export interface SearchOptions {
  assetType?: number;
  category?: string;
  artStyle?: string;
  themeStyle?: string;
  engineVersion?: string;
}

export function searchBody(library: string, query: string, options: SearchOptions = {}) {
  if (typeof query !== 'string' || query.length > 200) throw new Error('asset3d_query_invalid');
  const assetType = options.assetType ?? 1;
  if (!(ASSET_TYPES as readonly number[]).includes(assetType)) throw new Error('asset3d_asset_type_invalid');
  const filter: Record<string, string> = {};
  for (const [option, field] of [['category', 'category'], ['artStyle', 'art_style'], ['themeStyle', 'theme_style'], ['engineVersion', 'engine_versions']] as const) {
    const value = options[option];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('asset3d_filter_invalid');
    if (field === 'category' && ![1, 2, 5, 6, 7, 8, 9].includes(assetType)) throw new Error('asset3d_filter_not_applicable');
    if (['art_style', 'theme_style'].includes(field) && ![1, 2, 5, 6, 8, 9].includes(assetType)) throw new Error('asset3d_filter_not_applicable');
    if (field === 'art_style' && !ART_STYLES.includes(value)) throw new Error('asset3d_art_style_invalid');
    if (field === 'theme_style' && !THEME_STYLES.includes(value)) throw new Error('asset3d_theme_style_invalid');
    filter[field] = value;
  }
  return { depot_name: library, asset_type: assetType,
    ...(query.trim() ? { content: query.trim() } : {}),
    ...(Object.keys(filter).length ? { filter } : {}), similarity_score: 0.3, page_size: 10 };
}
