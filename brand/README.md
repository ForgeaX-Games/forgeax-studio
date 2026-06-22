# brand/ — Brand Pack 目录

> **状态：** ForgeaX 是当前**唯一**的默认 brand pack；保留扩展机制为白标预留。

## 目录

```
brand/
├── schema.json                   # BrandConfig JSON Schema (draft-07)
├── defaults.forgeax.json         # 默认 pack 配置
├── defaults.forgeax/             # 默认 pack 的 asset 资源
│   └── assets/
│       ├── favicon.svg           # 浏览器 favicon
│       ├── logo.svg              # TopBar / About logo
│       ├── forge-avatar.png      # ChatPanel Forge agent 头像
│       ├── persona-overlay.zh.md # 白标 persona 覆盖（默认 stub，主仓直接改 marketplace）
│       └── persona-overlay.en.md
└── README.md                     # 本文件
```

## Pack 选择优先级

1. `process.env.FORGEAX_BRAND` — 白标场景。设为 `defaults.<id>.json` 中的 `id`。
2. `<repo-root>/brand/active` — 软链接（dev / 运维直接 `ln -sf defaults.forgeax brand/active`）。
3. `'forgeax'` — 默认 fallback。

## 加什么 / 不加什么

**Brand pack 适合放：** 用户在 Settings 里能改的、面向显示的字符串（产品名、tagline、splash 标题/副标题、agent 名字、repo URL、community URL）和图片资源（favicon、logo、avatar）。

**Brand pack 不放：** npm scope（`@forgeax/`）、env key（`FORGEAX_*`）、磁盘路径（`~/.forgeax/`）、CSS 前缀（`.fgx-boot-*`）这些**契约 / contract** 层 — 它们在源码里一次性 hard-code 改干净（rebrand 计划 C 层），不走 brand layer。

## 添加新 pack（白标）

1. 复制 `defaults.forgeax.json` → `defaults.<your-brand>.json`，编辑字段。
2. 复制 `defaults.forgeax/` → `defaults.<your-brand>/`，替换 asset。
3. 启动时设 `FORGEAX_BRAND=<your-brand>`（**注意 env 名是固定的 `FORGEAX_BRAND`，不会跟着 pack id 变** — 它是 namespace，不是 pack 选择器的 type）。

> Schema 验证：`defaults.*.json` 的 `id` 必须匹配文件名中间段（`defaults.<id>.json`）。loader 会拒绝不符的 pack。

## 引用入口

- Server：[`packages/server/src/brand/{types,loader,router}.ts`](../packages/server/src/brand/)，挂在 `app.route('/api/brand', createBrandRouter())`。
- Interface：[`packages/interface/src/brand/{BrandProvider,useBrand,types}.tsx`](../packages/interface/src/brand/) + `vite-plugin-brand-inject`。
- `index.html` 占位符：`%BRAND_PRODUCT_NAME%`, `%BRAND_SPLASH_TITLE%`, `%BRAND_SPLASH_SUBTITLE%`, `%BRAND_ID%`（vite 启动时替换）。
