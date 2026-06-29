# @forgeax/studio

The **Studio UI shell** — the web app served at `http://localhost:18920`. It composes the
React UI from [`@forgeax/interface`](../interface) (chat, live engine preview, the visual
workbench panels) into the full studio experience, and adds the desktop packaging entry.

## Layout

```
packages/studio/
├── package.json            # name=@forgeax/studio (depends on @forgeax/interface)
├── index.html              # Vite entry
├── vite.config.ts          # Vite config (+ brand plugin)
├── vite-plugin-brand.ts
├── tsconfig.json · tailwind.config.ts · postcss.config.js
└── src/                    # app entry + composed UI (App, components, layouts)
```

## Run modes (driven by the top-level scripts)

| Mode | Command | What loads |
|:--|:--|:--|
| Web / dev | `bun run start` (default) | Vite dev server from `packages/studio/` at `:18920` |
| Desktop / dev | `bun run app` | Tauri window pointing at the dev server |
| Desktop / packaged | `bun run app build` then open | Tauri loads the built `packages/studio/dist/` |

`STUDIO=1` (the default) serves this package; set `STUDIO=0` to serve the thinner
[`@forgeax/interface`](../interface) package directly instead.

## More

Run everything from the repo root — see the [root README](../../README.md) and
[DEVELOPMENT.md](../../DEVELOPMENT.md). The AppKit composition API lives in
`packages/interface/src/app-kit.ts`.
