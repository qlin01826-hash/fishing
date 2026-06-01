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
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  STANDALONE single-file mode
 * ─────────────────────────────────────────────────────────────────────────
 * Set the `STANDALONE` env var to produce a single self-contained
 * `web/dist-standalone/index.html` that bundles JS + CSS + assets inline,
 * so it can be opened directly with `file://` (double-click) and shared
 * as a single attachment.
 *
 *   PowerShell:  $env:STANDALONE='1'; pnpm exec vite build --config web/vite.config.ts
 *   cmd.exe:     set STANDALONE=1 && pnpm exec vite build --config web/vite.config.ts
 */
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const STANDALONE = !!process.env.STANDALONE

// Legacy custom inline plugin kept for reference only — replaced by
// the battle-tested `vite-plugin-singlefile` (used in `plugins` below).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _legacyInlineSingleFilePlugin(): any {
  return {
    name: 'minigame:inline-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // eslint-disable-next-line no-console
      console.log(
        `[STANDALONE] inlining: ${Object.keys(bundle).join(', ')}`,
      )
      for (const htmlKey of Object.keys(bundle)) {
        const htmlAsset = bundle[htmlKey]
        if (htmlAsset.type !== 'asset' || !htmlKey.endsWith('.html')) continue

        let source = String(htmlAsset.source)
        const inlinedKeys: string[] = []

        for (const key of Object.keys(bundle)) {
          const item = bundle[key]
          const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

          if (item.type === 'asset' && key.endsWith('.css')) {
            const css = String(item.source)
            const linkRe = new RegExp(
              `<link[^>]*?href=["']?[^"'>]*${escKey}["']?[^>]*?\\/?>`,
              'g',
            )
            const before = source
            source = source.replace(linkRe, `<style>\n${css}\n</style>`)
            if (before !== source) inlinedKeys.push(key)
          } else if (item.type === 'chunk' && key.endsWith('.js')) {
            const closingMatches = item.code.match(/<\/script/gi) || []
            const commentMatches = item.code.match(/<!--/g) || []
            // eslint-disable-next-line no-console
            console.log(
              `[STANDALONE] ${key}: code length=${item.code.length}, ` +
              `</script count=${closingMatches.length}, ` +
              `<!-- count=${commentMatches.length}`,
            )
            const safe = item.code
              .replace(/<\/script/gi, '<\\/script')
              .replace(/<!--/g, '<\\!--')
            // eslint-disable-next-line no-console
            console.log(
              `[STANDALONE] after escape: safe length=${safe.length}, ` +
              `delta=${safe.length - item.code.length}`,
            )
            const scriptRe = new RegExp(
              `<script[^>]*?src=["']?[^"'>]*${escKey}["']?[^>]*?>\\s*</script>`,
              'g',
            )
            const before = source
            source = source.replace(scriptRe, `<script type="module">\n${safe}\n</script>`)
            if (before !== source) inlinedKeys.push(key)
          }
        }

        // modulepreload hints reference chunks that no longer have their own file
        source = source.replace(
          /<link[^>]*?rel=["']?modulepreload["']?[^>]*?\/?>/g,
          '',
        )

        htmlAsset.source = source
        for (const k of inlinedKeys) delete bundle[k]
      }
    },
  }
}

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
  plugins: STANDALONE
    ? [
        viteSingleFile({
          // Remove Vite's runtime `__vitePreload` polyfill — useless once
          // every chunk is inlined, and it leaves stray `__VITE_PRELOAD__`
          // identifiers in the bundle that can break parsing.
          removeViteModuleLoader: true,
          useRecommendedBuildConfig: true,
        }),
      ]
    : [],
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
    outDir: STANDALONE
      ? resolve(__dirname, 'dist-standalone')
      : resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'ES2020',
    minify: 'esbuild',
    cssCodeSplit: !STANDALONE,
    // In standalone mode we want everything (images, fonts, etc.) inlined.
    assetsInlineLimit: STANDALONE ? 100_000_000_000 : 4096,
    rollupOptions: {
      output: STANDALONE
        ? {
            inlineDynamicImports: true,
            entryFileNames: 'assets/main.js',
            assetFileNames: 'assets/[name][extname]',
          }
        : {
            manualChunks: {
              pixi: ['pixi.js'],
            },
            chunkFileNames: 'assets/[name]-[hash].js',
            entryFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash].[ext]',
          },
    },
    chunkSizeWarningLimit: STANDALONE ? 10_000 : 2000,
  },
})
