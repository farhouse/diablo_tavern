// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CaravanUpgradeSprite from '../components/CaravanUpgradeSprite.vue'
import HeroSprite from '../components/HeroSprite.vue'
import ItemSprite from '../components/ItemSprite.vue'

describe('game asset components', () => {
  it('renders every hero class with an intrinsic 46×70 sprite and useful identity text', () => {
    const cases = [
      ['barbarian', 'Barbarian'],
      ['sorceress', 'Sorceress'],
      ['paladin', 'Paladin'],
      ['necromancer', 'Necromancer']
    ] as const

    for (const [heroClass, label] of cases) {
      const image = mount(HeroSprite, { props: { heroClass, alt: `${label} visitor` } }).get('img')
      expect(image.attributes()).toMatchObject({
        src: `/images/game/heroes/${heroClass}.png`,
        alt: `${label} visitor`,
        width: '46',
        height: '70'
      })
    }
  })

  it('keeps generic item art decorative and rarity outside the asset', () => {
    const image = mount(ItemSprite, { props: { itemType: 'weapon' } }).get('img')

    expect(image.attributes('src')).toBe('/images/game/items/weapon.png')
    expect(image.attributes('alt')).toBe('')
    expect(image.attributes('src')).not.toMatch(/normal|magic|rare|unique/)
  })

  it('keeps caravan art decorative when the adjacent heading names the upgrade', () => {
    const image = mount(CaravanUpgradeSprite, { props: { upgradeId: 'appraiser' } }).get('img')

    expect(image.attributes('src')).toBe('/images/game/caravan/appraiser.png')
    expect(image.attributes('alt')).toBe('')
  })
})
