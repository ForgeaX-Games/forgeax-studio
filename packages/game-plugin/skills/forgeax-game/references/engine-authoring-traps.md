# Verified Engine authoring traps

Each entry below was hit while authoring a working game against this Engine pin and
confirmed against Engine source. They are the failures that do **not** announce
themselves: the game keeps running, nothing throws, and only the picture or the input
is wrong. Check them before debugging anything else.

## Camera `fov` is vertical **radians**

`Camera.fov` is passed unchanged to `mat4.perspective(out, fovYRadians, …)`. Degrees
silently frame the wrong volume — the scene renders, so it reads as a layout bug.

```ts
// wrong: 50 radians
perspective({ fov: 50, aspect, near: 0.1, far: 200 })
// right
perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 200 })
```

Some doc comments in `camera.ts` show `fov: 60`, and the preview host's own fallback
camera does the same. Trust `mat4.perspective`, not those examples.

## Keyboard is dead until an InputMap resource exists

The input scan system publishes `INPUT_SNAPSHOT_RESOURCE_KEY` only when an InputMap is
registered. Without it `hasResource` is false forever and every key read is skipped —
with no error.

```ts
const KEY = (key: string) => ({ type: 'key', key } as const);
world.insertResource(INPUT_MAP_KEY, [
  { action: 'up', bindings: [KEY('ArrowUp'), KEY('w')] },
] satisfies ActionConfig[]);
```

The snapshot also lands only after the first `world.update`, so read
`createInputSnapshot()` as an empty fallback rather than branching every frame.

## Action readpoints are functions, not properties

```ts
input.action('up').justPressed    // a function object — always truthy, fires every frame
input.action('up').justPressed()  // the actual edge
```

`isPressed`, `justPressed` and `justReleased` are all calls; `strength` is a number.

## Diagnose "nothing renders" with `frustumStats`, not screenshots

`__forgeax.renderer.frustumStats` reports `{ culled, total }`. `culled` equal to
`total` means the camera is aimed away from the content — an orientation or `fov`
problem, not a material or mesh problem. `__forgeax` also exposes `world`, `app`
(with `lastError`) and `renderer.perFramePassNames`.

## An unlit dark material is indistinguishable from the cleared background

`Materials.standard` with a low `baseColor` and no `emissive` renders as near-black on
a dark `clearColor`, which looks identical to "not rendering". Give static geometry a
small `emissive` value while bringing a scene up, then tune once it is visibly drawing.

## A pure top-down camera hits the degenerate `up` path

`quat.fromLookAt(out, eye, target, up)` auto-selects an alternative `up` when `up` is
collinear with the view direction. Prefer a tilted eye, and prefer `fromLookAt` over a
hand-built axis-angle pitch so the forward/up convention stays the Engine's.

## The entry is `bootstrap(world, ctx)` — world first

The preview host instantiates the default scene, then calls
`export async function bootstrap(world: World, ctx?: BootstrapContext)`. It only spawns
its own fallback camera when no game entry resolves, so a game that exports `bootstrap`
owns the camera.

## `Materials.standard` returns the asset, not a Result

```ts
world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ … }))
```

The `.value` seen in some `mesh-renderer.ts` examples belongs to
`engine.assets.catalog(...)`, not to `Materials.standard`.
