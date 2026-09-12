import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CaravanUpgradeId, HeroClass, ItemType } from '~/types/game'
import { caravanSpriteByUpgrade, heroSpriteByClass, itemSpriteByType } from '~/utils/game-assets'

describe('game asset maps', () => {
  it('maps every domain enum to exactly one stable asset', () => {
    const classes: HeroClass[] = ['barbarian', 'sorceress', 'paladin', 'necromancer']
    const itemTypes: ItemType[] = ['weapon', 'armor', 'helmet', 'gloves', 'boots', 'ring', 'amulet', 'charm']
    const upgrades: CaravanUpgradeId[] = ['wagons', 'scoutTable', 'stashWagon', 'infirmary', 'appraiser']

    expect(Object.keys(heroSpriteByClass)).toEqual(classes)
    expect(Object.keys(itemSpriteByType)).toEqual(itemTypes)
    expect(Object.keys(caravanSpriteByUpgrade)).toEqual(upgrades)
    expect(Object.values(itemSpriteByType).every(path => !/(normal|magic|rare|unique)/.test(path))).toBe(true)
  })

  it('points every map entry at a committed, non-empty RGBA PNG', () => {
    const paths = [
      ...Object.values(heroSpriteByClass),
      ...Object.values(itemSpriteByType),
      ...Object.values(caravanSpriteByUpgrade),
      '/images/game/tavern/background.png'
    ]

    for (const assetPath of paths) {
      const filePath = new URL(`../public${assetPath}`, import.meta.url)
      expect(existsSync(filePath), assetPath).toBe(true)
      const png = readFileSync(filePath)
      expect(png.subarray(1, 4).toString(), assetPath).toBe('PNG')
      expect(png.readUInt32BE(16), `${assetPath} width`).toBeGreaterThan(0)
      expect(png.readUInt32BE(20), `${assetPath} height`).toBeGreaterThan(0)
      expect(png[25], `${assetPath} must use RGBA color`).toBe(6)

      const width = png.readUInt32BE(16)
      const height = png.readUInt32BE(20)
      if (assetPath.includes('/items/')) expect([width, height]).toEqual([96, 96])
      if (assetPath.includes('/caravan/')) expect(Math.max(width, height)).toBeLessThanOrEqual(256)
      if (assetPath.includes('/tavern/')) expect([width, height]).toEqual([1280, 720])
    }
  })
})
