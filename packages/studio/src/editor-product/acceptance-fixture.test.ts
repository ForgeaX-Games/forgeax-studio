import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Meta = {
  readonly kind?: string;
  readonly importer?: string;
  readonly subAssets?: readonly {
    readonly kind?: string;
    readonly sourceKey?: string;
  }[];
};

const BED_META = resolve(
  import.meta.dir,
  '../../../..',
  'packages/games/spin-cube/assets/bed.glb.meta.json',
);

describe('Studio acceptance game asset metadata', () => {
  it('publishes stable source keys so the per-game catalog can instantiate spin-cube', () => {
    const meta = JSON.parse(readFileSync(BED_META, 'utf8')) as Meta;
    const outputs = meta.subAssets ?? [];

    expect(meta.kind).toBe('external-asset-package');
    expect(meta.importer).toBe('gltf');
    expect(outputs.map((output) => output.sourceKey)).toEqual([
      'mesh:Mesh bed',
      'material:leafsDark',
      'material:woodBirch',
      'material:wood',
      'scene',
    ]);
    expect(new Set(outputs.map((output) => output.sourceKey)).size).toBe(outputs.length);
  });
});
