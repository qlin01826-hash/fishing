/**
 * Standalone public web build — fully independent of the Kubee internal build.
 *
 * - `root` is THIS folder (`web/`) so the entry HTML is `web/index.html`.
 * - The game source still lives in `../game/client/...`; we reference it via
 *   the relative `<script src="../game/client/main.ts">` in `index.html`.
 * - `@minigame/*` workspace packages are resolved via Vite aliases pointing
 *   directly at their `source/*.ts` entries — no workspace symlinks needed.
 * - `pixi.js` is resolved from the parent `node_modules/` (installed at the
 *   project root) and BUNDLED into the output (no externals, no importmap).
 * - Output goes to `web/dist/` and is fully self-contained: drop it onto any
 *   static host (Vercel / Netlify / Cloudflare Pages / GitHub Pages / your
 *   own nginx) and it will run.
 *
 * Run from the project root (the same place where `pnpm install` was run):
 *
 *   pnpm exec vite --config web/vite.config.ts            # dev server
 *   pnpm exec vite build --config web/vite.config.ts      # production build
 *   pnpm exec vite preview --config web/vite.config.ts    # preview built dist
 *
 * For path-prefix hosts (e.g. GitHub Pages under `/repo/`):
 *
 *   cross-env VITE_BASE=/repo/ pnpm exec vite build --config web/vite.config.ts
 */
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

export default defineConfig({
  root: __dirname,
  publicDir: false,
  // Use './' so the build works whether it's served from `/` or from a
  // subdirectory (e.g. GitHub Pages, file:// for quick local testing).
  base: process.env.VITE_BASE ?? './',
  define: {
    // The runtime i18n module reads this. 'locked' = bundle messages from JSON
    // imports without devtools — perfect for production.
    'import.meta.env.VITE_I18N_MODE': JSON.stringify(process.env.VITE_I18N_MODE ?? 'locked'),
  },
  resolve: {
    alias: [
      // Subpath aliases MUST come before their bare-name parents so they
      // match first (Vite's `find` is evaluated in order).
      { find: '@minigame/i18n/vite',          replacement: resolve(ROOT, 'packages/i18n/source/vite.ts') },
      { find: '@minigame/render-adapter/pixi', replacement: resolve(ROOT, 'packages/render-adapter/source/pixi.ts') },
      { find: '@minigame/render-adapter/three', replacement: resolve(ROOT, 'packages/render-adapter/source/three.ts') },
      { find: '@minigame/i18n',                replacement: resolve(ROOT, 'packages/i18n/source/index.ts') },
      { find: '@minigame/platform',            replacement: resolve(ROOT, 'packages/platform/source/index.ts') },
      { find: '@minigame/render-adapter',      replacement: resolve(ROOT, 'packages/render-adapter/source/index.ts') },
      { find: '@minigame/core',                replacement: resolve(ROOT, 'game/core/source/index.ts') },
    ],
  },
  server: {
    host: true,
    port: 4173,
    strictPort: false,
    cors: true,
    // Allow Vite's dev server to read files outside `web/` (the game source
    // and the workspace packages live above us).
    fs: { allow: [ROOT] },
  },
  preview: {
    host: true,
    port: 4174,
    strictPort: false,
    cors: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'ES2020',
    minify: 'esbuild',
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    chunkSizeWarningLimit: 2000,
  },
})
