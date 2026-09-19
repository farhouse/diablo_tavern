## Camp modular raster set

This directory decomposes the approved ALTA-51 camp composition into a clean base, two purchasable expansions, and a separate hero UI strip. `comparison-base.png` and `comparison-expanded.png` are review artifacts rebuilt from those layers at the integer coordinates in `manifest.json`.

### Gameplay evidence

- `types/game.ts` defines `CaravanUpgradeId` as only `stashWagon | appraiser`.
- `utils/game-data.ts` supplies costs for both, and `utils/game-logic.ts` implements their purchase and level behavior.
- `pages/caravan.vue` exposes both active upgrades.
- `tests/game-assets.pages.test.ts` verifies the appraiser is shown and the legacy infirmary is not.
- `wagons` is the caravan's base visual. `scoutTable` and `infirmary` remain legacy sprite identifiers and are deliberately excluded from the modular expansion set.

### Files and composition

- `camp-base.png`: 1672×941 clean camp, with no expansions, HUD, resources, or heroes.
- `expansion-stash-wagon.png`: 360×272 RGBA, placed at `(70, 91)`.
- `expansion-appraiser.png`: 447×321 RGBA, placed at `(1225, 215)`.
- `heroes-ui-strip.png`: 1672×161 presentation layer, placed at `(0, 780)` only in comparisons.
- `comparison-base.png`: `campBase + heroesUI`.
- `comparison-expanded.png`: `campBase + stashWagon + appraiser + heroesUI`.

Coordinates use a top-left origin and a top-left anchor. The expanded scene below the UI is made exclusively from `camp-base.png` and the two expansion PNGs. Rebuild and verify from the tracked sources with:

```sh
swiftc scripts/build-camp-modular.swift -o .multica/build-camp-modular
.multica/build-camp-modular
.multica/build-camp-modular --verify
```

Build mode reads every dimension and placement from `manifest.json`. Verify mode reloads that manifest, validates dimensions, alpha ranges and alpha bounds, recomposes both comparisons, and fails unless their RGBA pixels match the committed images exactly.

### Generation method and prompts

All three raster assets were produced with the built-in ImageGen tool. The approved ALTA-51 attachment is tracked for this task at `references/alta-53/01-campamento-anochecer-v2.png`; it was the edit target for the clean base and the explicit subject/style reference for both transparent pieces. The selected ImageGen sources are tracked separately from finals:

- `references/alta-53/imagegen/camp-base-selected.png` — SHA-256 `b7ec534666fe2350d30b469aaef01fa8d14032c392939a9c945fec86500d0b9d`
- `references/alta-53/imagegen/stash-wagon-selected.png` — SHA-256 `8d62beff0ce716e89529fd5e82fc0029907c27c4f94435300babe9a04c44deca`
- `references/alta-53/imagegen/appraiser-selected.png` — SHA-256 `0a6008eb9f397626c2c7ece2de032d5c7a9f09f1ca29cec0a09376591c890298`

The builder clears only near-transparent fringe pixels (alpha 1–3) before trimming, then preserves the remaining alpha range. This leaves a one-pixel transparent margin around both final pieces and avoids invisible border specks affecting layout bounds.

Base prompt:

> Create the clean base camp background by removing only the purchasable stash wagon at upper left and the purple appraiser tent at right, plus the resource HUD and bottom hero/interface bar. Reconstruct exposed forest, tents, dirt, rocks, vegetation, and lighting naturally. Preserve the central tavern, campfire, forge, map table, background tents, exact elevated 3/4 framing, pixel art, sunset/night palette, and amber light. No interface, counters, heroes, text, watermark, seams, shadows, glow, or traces from removed expansions.

Stash wagon prompt:

> Isolate the upper-left covered stash wagon with chassis, wheels, attached supplies and steps, plus only its own contact shadow and amber spill. Preserve the source pixel art, 3/4 perspective, scale and night lighting. Tight transparent crop; no banner, detached crates/barrels, terrain, HUD, heroes, text, matte, checkerboard, watermark, or halos.

Appraiser prompt:

> Isolate the complete right-side purple appraiser tent with poles, canopy, work surfaces, shelves, bottles, orb and lamps, plus only its own contact shadow and violet spill. Preserve the source pixel art, 3/4 perspective, scale and night lighting. Tight transparent crop; no surrounding props, terrain, map table, HUD, heroes, text, matte, checkerboard, watermark, or halos.

### Scope

These files are production candidates only. Nothing here changes game pages, components, economy, progression, APIs, saves, or runtime behavior.
