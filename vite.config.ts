import { i18nPlugin } from '@minigame/i18n/vite'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { visualizer } from 'rollup-plugin-visualizer'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const isAnalyze = process.env.NODE_ENV === 'analyze'

export default defineConfig({
  plugins: [
    {
      name: 'html-inject-pkg-name',
      transformIndexHtml: (html: string) => html.replace(/<title>[^<]*<\/title>/, `<title>${pkg.name}</title>`),
    },
    i18nPlugin({ localeDir: resolve(__dirname, 'i18n') }),
    isAnalyze && visualizer({ open: true, filename: 'dist/stats.html', gzipSize: true }),
  ],
  define: {
    'import.meta.env.VITE_I18N_MODE': JSON.stringify(process.env.VITE_I18N_MODE ?? 'dev'),
  },
  publicDir: 'public',
  server: {
    host: true,
    port: 15173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'ES2020',
    minify: 'esbuild',
    rollupOptions: {
      // pixi.js is served from CDN via importmap in index.html — exclude from bundle
      external: ['pixi.js'],
      output: {
        manualChunks: {
          'platform': ['@minigame/platform', '@minigame/render-adapter'],
          'game-logic': ['@minigame/core', '@minigame/i18n'],
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
