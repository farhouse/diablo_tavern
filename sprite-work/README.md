# Sprite asset pipeline

The approved ALTA-27 source PNGs and their design brief live in this directory so the frontend assets can be reproduced from a clean checkout.

Run the extractor from the repository root on macOS:

```bash
swift scripts/extract-sprite-atlases.swift
```

The command copies the four hero sprites and Tavern background, extracts the eight square equipment icons, crops the five caravan buildings at verified atlas gutters, and writes all runtime files under `public/images/game`.

Validate the generated file set, PNG dimensions, and alpha channels with:

```bash
pnpm test -- tests/game-assets.test.ts
```

The source files were supplied as approved issue attachments. Their intended order, mapping, visual constraints, and allowed v1 usage are recorded in `SPRITE-BRIEF.md`.
