# PixiJS 2D Template - AI Guide

This project is an **AI-facing web game template**, not a fully built production game.

The delivery target is still **one browser game**. The workspace layout exists only to keep a few reusable capabilities decoupled:

- `game/` holds game-specific code
- `packages/i18n` holds the lightweight i18n runtime and Vite plugin
- `packages/platform` holds cross-platform input helpers

Treat this as **single-product delivery with a small internal monorepo layout**, not as several independently shipped apps.

## What To Modify First

Most changes should happen here:

- `game/client/source/game/MainScene.ts`
- `game/client/source/entities/`
- `game/client/source/systems/`
- `game/client/source/ui/`
- `i18n/en.json`
- `i18n/zh.json`

Usually you should **not** need to change `packages/` unless you are extending shared infrastructure.

## Working Rules

Keep these rules simple:

1. Build gameplay in `game/client/source/`.
2. Keep user-visible text in `i18n/*.json` and read it with `t()`.
3. Prefer `@minigame/platform` for input so desktop and mobile stay aligned.
4. Keep the template easy for the next AI pass to read and extend.

## Project Shape

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

## Responsibilities

- `game/client/main.ts`: bootstrap Pixi and i18n.
- `game/client/source/game/MainScene.ts`: current gameplay example.
- `packages/i18n/`: translation runtime and build-time helper.
- `packages/platform/`: unified desktop/mobile input abstraction.

## i18n Guidance

All player-facing text should go through `@minigame/i18n`.

Example:

```ts
import { t } from '@minigame/i18n'

this.add.text(10, 10, t('game.score', { score: String(score) }))
```

When adding a key, update both:

- `i18n/en.json`
- `i18n/zh.json`

## Input Guidance

Use `PlatformInput` unless you have a strong reason not to.

```ts
this.platformInput = new PlatformInput({
  mode: 'joystick',
  canvas: this.game.canvas,
})
```

The template already shows the intended pattern:

- mobile uses virtual controls through `@minigame/platform`
- desktop can still merge keyboard input in scene code

## Pixi Runtime Rule

Use Pixi containers and graphics as the rendering layer, and keep gameplay flow in `MainScene.ts`.

## Template Mindset

This repository is optimized for:

- fast iteration
- AI readability
- easy extension from a minimal playable example

It is not trying to pre-solve every production concern. Avoid turning the guide into a heavy process document unless the template genuinely needs that constraint.
