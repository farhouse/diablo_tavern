import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      const expectedCaravanDimensions: Record<string, [number, number]> = {
        '/images/game/caravan/wagons.png': [212, 256],
        '/images/game/caravan/scout-table.png': [200, 256],
        '/images/game/caravan/stash-wagon.png': [226, 256],
        '/images/game/caravan/infirmary.png': [195, 256],
        '/images/game/caravan/appraiser.png': [195, 256]
      }
      if (assetPath.includes('/caravan/')) expect([width, height]).toEqual(expectedCaravanDimensions[assetPath])
      if (assetPath.includes('/tavern/')) expect([width, height]).toEqual([1280, 720])
    }
  })

  it.skipIf(process.platform !== 'darwin')('restores the previous asset tree when installation fails after backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprite-atlas-rollback-'))
    const publicImagesRoot = join(root, 'public', 'images')
    const previousAssets = join(publicImagesRoot, 'game')

    try {
      mkdirSync(previousAssets, { recursive: true })
      writeFileSync(join(previousAssets, 'sentinel.txt'), 'known-good-assets')

      const result = spawnSync('swift', ['scripts/extract-sprite-atlases.swift'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: {
          ...process.env,
          SPRITE_ATLAS_PUBLIC_IMAGES_ROOT: publicImagesRoot,
          SPRITE_ATLAS_TEST_FAIL_AFTER_BACKUP: '1'
        }
      })

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('Injected replacement failure after backup')
      expect(readFileSync(join(previousAssets, 'sentinel.txt'), 'utf8')).toBe('known-good-assets')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
