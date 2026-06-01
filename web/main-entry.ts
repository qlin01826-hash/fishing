// Thin entry wrapper that lives INSIDE `web/` so Vite can resolve it
// via its normal root-relative `/main-entry.ts` URL.
//
// Why this file exists: `web/index.html` used to load the game with
//   <script type="module" src="../game/client/main.ts"></script>
// In Vite 7+, the dev server normalises that URL to `/game/client/main.ts`
// (above the project root), so the request 404s with:
//   "Pre-transform error: Failed to load url /game/client/main.ts"
// Once the request reaches a file that lives INSIDE the root, however,
// the resulting `import` graph is resolved by Vite's module loader
// (which already has `fs.allow: [project_root]`) and can happily walk
// up into `../game/client/main.ts`.
//
// So: index.html → `/main-entry.ts` (in root) → imports the real entry.
import '../game/client/main.ts'
