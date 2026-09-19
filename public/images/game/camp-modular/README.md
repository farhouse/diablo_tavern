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

Coordinates use a top-left origin and a top-left anchor. The expanded scene below the UI is made exclusively from `camp-base.png` and the two expansion PNGs. Run `scripts/build-camp-modular.swift` after compiling it with `swiftc` to reproduce the sizing, placement, UI extraction, and comparisons from the approved reference and the three selected ImageGen outputs.

### Generation method and prompts

All three raster assets were produced with the built-in ImageGen tool. The approved ALTA-51 image was the edit target for the clean base and the explicit subject/style reference for both transparent pieces.

Base prompt:

> Create the clean base camp background by removing only the purchasable stash wagon at upper left and the purple appraiser tent at right, plus the resource HUD and bottom hero/interface bar. Reconstruct exposed forest, tents, dirt, rocks, vegetation, and lighting naturally. Preserve the central tavern, campfire, forge, map table, background tents, exact elevated 3/4 framing, pixel art, sunset/night palette, and amber light. No interface, counters, heroes, text, watermark, seams, shadows, glow, or traces from removed expansions.

Stash wagon prompt:

> Isolate the upper-left covered stash wagon with chassis, wheels, attached supplies and steps, plus only its own contact shadow and amber spill. Preserve the source pixel art, 3/4 perspective, scale and night lighting. Tight transparent crop; no banner, detached crates/barrels, terrain, HUD, heroes, text, matte, checkerboard, watermark, or halos.

Appraiser prompt:

> Isolate the complete right-side purple appraiser tent with poles, canopy, work surfaces, shelves, bottles, orb and lamps, plus only its own contact shadow and violet spill. Preserve the source pixel art, 3/4 perspective, scale and night lighting. Tight transparent crop; no surrounding props, terrain, map table, HUD, heroes, text, matte, checkerboard, watermark, or halos.

### Scope

These files are production candidates only. Nothing here changes game pages, components, economy, progression, APIs, saves, or runtime behavior.
