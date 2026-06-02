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

/**
 * Standalone single-file builds inline the bundle into the HTML. The
 * `vite-plugin-singlefile` plugin emits it as `<script type="module">`,
 * but module scripts run with a `null` origin under `file://`, which
 * Chrome / WeChat / most mobile in-app browsers REFUSE to execute — the
 * page then spins forever on the loading screen when the file is opened
 * directly (double-click / shared attachment) instead of via a server.
 *
 * Paired with an `iife` rollup output (a classic, import/export-free
 * bundle), this post-plugin rewrites the inlined module script into a
 * plain `<script>` so it runs when opened directly on ANY device.
 *
 * Two subtleties handled here:
 *  1. Module scripts are implicitly DEFERRED (run after the DOM is
 *     parsed); a classic inline `<script>` runs IMMEDIATELY where it
 *     sits. Vite injects the entry into `<head>`, so a naive demote
 *     would execute before `#game-container` exists ("Missing
 *     #game-container"). We therefore MOVE the demoted script to the
 *     very end of `<body>` to preserve the deferred-execution ordering.
 *  2. Leftover `modulepreload` hints reference chunks that no longer
 *     exist once everything is inlined, so we strip them.
 */
function demoteToClassicScriptPlugin(): any {
  return {
    name: 'minigame:demote-to-classic-script',
    enforce: 'post',
    generateBundle(_options: any, bundle: Record<string, any>) {
      for (const key of Object.keys(bundle)) {
        const asset = bundle[key]
        if (asset.type !== 'asset' || !key.endsWith('.html')) continue
        let html = String(asset.source)

        // Strip now-dangling module-preload hints.
        html = html.replace(/<link[^>]+rel=(["'])?modulepreload\1?[^>]*>/gi, '')

        // Pull every inlined `<script type="module">…</script>` out of
        // wherever Vite placed it (usually <head>) and collect its code.
        const collected: string[] = []
        html = html.replace(
          /<script\s+type=(["'])module\1[^>]*>([\s\S]*?)<\/script>/gi,
          (_m: string, _q: string, code: string) => {
            collected.push(code)
            return ''
          },
        )

        if (collected.length > 0) {
          // Re-emit as classic scripts at the very end of <body> so the
          // DOM (incl. #game-container) is fully parsed before they run.
          const tags = collected.map((code) => `<script>${code}</script>`).join('\n')
          // IMPORTANT: insert via slice, NOT String.replace — the bundle
          // is full of `$` sequences ($&, $1, $$, …) that String.replace
          // would interpret as replacement patterns and corrupt the JS
          // (manifests as "Uncaught SyntaxError: Unexpected token '<'").
          const idx = html.lastIndexOf('</body>')
          html =
            idx !== -1
              ? `${html.slice(0, idx)}${tags}\n${html.slice(idx)}`
              : html + tags
        }

        asset.source = html
      }
    },
  }
}

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
          // We drive the build config explicitly below (incl. the `iife`
          // output that makes the file:// fix possible), so don't let the
          // plugin re-impose its own ESM-oriented recommended config.
          useRecommendedBuildConfig: false,
        }),
        // Runs AFTER singlefile has inlined everything: turns the inlined
        // module script into a classic one so the file opens via file://.
        demoteToClassicScriptPlugin(),
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
            // `iife` = one classic, import/export-free bundle. Combined
            // with the demote-to-classic-script plugin this is what lets
            // the single file run when opened directly via file:// on
            // phones / WeChat / in-app browsers (where `type="module"`
            // scripts are blocked).
            format: 'iife',
            name: 'fishingPenguin',
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
