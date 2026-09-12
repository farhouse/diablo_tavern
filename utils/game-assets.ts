import type { HeroClass, ItemType } from '~/types/game'

export type CaravanSpriteId = keyof typeof caravanSpriteByUpgrade

export const heroSpriteByClass = {
  barbarian: '/images/game/heroes/barbarian.png',
  sorceress: '/images/game/heroes/sorceress.png',
  paladin: '/images/game/heroes/paladin.png',
  necromancer: '/images/game/heroes/necromancer.png'
} satisfies Record<HeroClass, string>

export const itemSpriteByType = {
  weapon: '/images/game/items/weapon.png',
  armor: '/images/game/items/armor.png',
  helmet: '/images/game/items/helmet.png',
  gloves: '/images/game/items/gloves.png',
  boots: '/images/game/items/boots.png',
  ring: '/images/game/items/ring.png',
  amulet: '/images/game/items/amulet.png',
  charm: '/images/game/items/charm.png'
} satisfies Record<ItemType, string>

export const caravanSpriteByUpgrade = {
  wagons: '/images/game/caravan/wagons.png',
  scoutTable: '/images/game/caravan/scout-table.png',
  stashWagon: '/images/game/caravan/stash-wagon.png',
  infirmary: '/images/game/caravan/infirmary.png',
  appraiser: '/images/game/caravan/appraiser.png'
} as const

export const heroClassLabel = {
  barbarian: 'Barbarian',
  sorceress: 'Sorceress',
  paladin: 'Paladin',
  necromancer: 'Necromancer'
} satisfies Record<HeroClass, string>
