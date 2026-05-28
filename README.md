# PixiJS 2D Template

This is a **web game template for AI-assisted development**.

It ships as a single browser game, while using a small workspace layout to keep a few reusable concerns decoupled:

- `game/` for game-specific code
- `packages/i18n` for translation runtime and build-time helpers
- `packages/platform` for desktop/mobile input abstraction

The point of the structure is not to produce multiple independent applications. The point is to make one game template easier to evolve, reuse, and extend.

## Features

- **PixiJS 8** for 2D rendering and gameplay
- **TypeScript** with path aliases
- **Vite** for local development and build
- **i18n** via `@minigame/i18n`
- **Desktop/mobile input abstraction** via `@minigame/platform`
- **Template-oriented workspace layout** for shared internal packages

## Quick Start

```bash
pnpm install
pnpm dev
pnpm build
```

Dev server default:

- `http://localhost:15173`

## Project Structure

```text
pixijs-2d/
├── index.html
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── vite.config.ts
├── i18n/
├── game/
│   └── client/
│       ├── main.ts
│       └── source/
│           ├── game/
│           ├── entities/
│           ├── systems/
│           ├── ui/
│           └── utils/
└── packages/
    ├── i18n/
    └── platform/
```

## Where To Work

Most feature work belongs in:

- `game/client/source/game/`
- `game/client/source/entities/`
- `game/client/source/systems/`
- `game/client/source/ui/`
- `i18n/en.json`
- `i18n/zh.json`

You usually do **not** need to touch `packages/` unless you are intentionally extending shared infrastructure.

## Runtime Responsibilities

- `game/client/main.ts` bootstraps Pixi and i18n.
- `game/client/source/game/MainScene.ts` is the current gameplay example.
- `packages/i18n/` provides translation runtime and Vite integration.
- `packages/platform/` provides unified desktop/mobile input helpers.

## i18n

All player-facing text should use `@minigame/i18n`.

```ts
import { t } from '@minigame/i18n'

this.scoreText.setText(t('game.score', { score: String(score) }))
```

When adding a new key, update both locale files:

- `i18n/en.json`
- `i18n/zh.json`

## Input

Use `PlatformInput` as the default integration point for controls.

```ts
this.platformInput = new PlatformInput({
  mode: 'joystick',
  canvas: this.game.canvas,
})
```

The template already demonstrates the intended pattern:

- mobile uses virtual controls from `@minigame/platform`
- desktop can still merge keyboard input in scene code

## Pixi Rendering

Use Pixi primitives and containers for rendering, and keep gameplay logic in `MainScene.ts`.

## Intended Use

This template is meant to be:

- easy for AI to read
- fast to modify
- simple to extend into a concrete game prototype

It is not a full framework and it does not try to pre-package every production pattern.

## License

MIT
