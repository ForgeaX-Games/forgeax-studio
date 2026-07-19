import animate from 'tailwindcss-animate'
// Relative import (not the '@forgeax/design' alias): Tailwind's config loader
// resolves modules itself and does not see Vite/tsconfig aliases.
import { createForgeaxPreset } from '../interface/packages/design/preset'

const config = {
  // The shared design preset bridges --fx-* / --radius-* into Tailwind's
  // semantic color + radius scale and sets darkMode: ['selector', '[data-theme="dark"]'].
  presets: [createForgeaxPreset()],
  // Studio is a thin assembly shell — virtually every component it renders
  // lives in packages/interface/src/ (loaded via the `forgeax-interface/...`
  // vite alias, see vite.config.ts §resolve.alias) and packages/marketplace/
  // plugin panels. Tailwind's JIT does NOT follow vite aliases when scanning
  // for class names — it needs literal file globs. Limit the content glob to
  // studio/src/ and the JIT silently drops every class only used in interface
  // (e.g. ui/popover.tsx's `z-[var(--z-menu)]`), which is what made TopBar
  // dropdowns fall behind the Sidebar/Workbench rails in tauri after the P0
  // skeleton landed (#15). Mirror interface's effective scan surface here.
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../interface/index.html',
    '../interface/src/**/*.{ts,tsx}',
    '../marketplace/extensions/**/src/**/*.{ts,tsx}',
    // 关键：上面的 `**` 会穿透各插件的 node_modules / dist（如
    // plugins/wb-reel/node_modules/<pkg>/src/**.ts），让 Tailwind JIT 扫描
    // 成千上万个依赖源文件 → PostCSS 在首个 CSS 请求时卡死，导致 interface
    // (18920) 入口 body 迟迟不返回、浏览器「无法启动」。用 `!` 忽略模式把
    // node_modules / dist 剪掉，只保留插件自身的 src。
    '!../marketplace/extensions/**/node_modules/**',
    '!../marketplace/extensions/**/dist/**',
  ],
  // Preflight is Tailwind's CSS reset; keep it OFF so the migration is purely
  // additive and the existing hand-written CSS is never zeroed out. Re-evaluate
  // at the end of the migration (see rearch plan 03 §6 / 05 §7).
  corePlugins: { preflight: false },
  plugins: [animate],
}

export default config
