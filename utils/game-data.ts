import type { Affix, BaseStats, HeroClass, Item, ItemType, Quest } from '~/types/game'

export const heroClassStats: Record<HeroClass, { label: string; baseStats: BaseStats }> = {
  barbarian: {
    label: 'Barbarian',
    baseStats: { strength: 15, dexterity: 9, vitality: 14, energy: 5 }
  },
  sorceress: {
    label: 'Sorceress',
    baseStats: { strength: 5, dexterity: 8, vitality: 7, energy: 16 }
  },
  paladin: {
    label: 'Paladin',
    baseStats: { strength: 12, dexterity: 10, vitality: 12, energy: 8 }
  },
  necromancer: {
    label: 'Necromancer',
    baseStats: { strength: 8, dexterity: 9, vitality: 9, energy: 13 }
  }
}

export const quests: Quest[] = [
  { id: 'blood-moor', name: 'Blood Moor', act: 1, difficulty: 34, minLevel: 1, rewards: { xp: 70, gold: 90 }, lootTableId: 'act1-low' },
  { id: 'den-of-evil', name: 'Den of Evil', act: 1, difficulty: 50, minLevel: 2, requirements: { completedQuestIds: ['blood-moor'] }, rewards: { xp: 110, gold: 130 }, lootTableId: 'act1-low' },
  { id: 'cold-plains', name: 'Cold Plains', act: 1, difficulty: 68, minLevel: 3, requirements: { completedQuestIds: ['den-of-evil'] }, rewards: { xp: 145, gold: 170 }, lootTableId: 'act1-mid' },
  { id: 'burial-grounds', name: 'Burial Grounds', act: 1, difficulty: 90, minLevel: 4, requirements: { completedQuestIds: ['cold-plains'] }, rewards: { xp: 190, gold: 220 }, lootTableId: 'act1-mid' },
  { id: 'forgotten-tower', name: 'Forgotten Tower', act: 1, difficulty: 118, minLevel: 5, requirements: { completedQuestIds: ['burial-grounds'] }, rewards: { xp: 250, gold: 310 }, lootTableId: 'act1-high' },
  { id: 'catacombs', name: 'Catacombs', act: 1, difficulty: 152, minLevel: 6, requirements: { completedQuestIds: ['forgotten-tower'] }, rewards: { xp: 340, gold: 390 }, lootTableId: 'act1-high' },
  { id: 'act-boss', name: 'Act Boss', act: 1, difficulty: 205, minLevel: 7, requirements: { completedQuestIds: ['catacombs'] }, rewards: { xp: 520, gold: 700 }, lootTableId: 'act1-boss' }
]

export const itemBases: Array<Pick<Item, 'baseName' | 'type' | 'width' | 'height' | 'requiredLevel' | 'value'> & { implicit?: Affix[] }> = [
  { baseName: 'Short Sword', type: 'weapon', width: 1, height: 3, requiredLevel: 1, value: 35, implicit: [{ stat: 'attackPower', value: 8 }] },
  { baseName: 'Axe', type: 'weapon', width: 2, height: 3, requiredLevel: 2, value: 55, implicit: [{ stat: 'attackPower', value: 12 }] },
  { baseName: 'Crystal Wand', type: 'weapon', width: 1, height: 2, requiredLevel: 3, value: 72, implicit: [{ stat: 'mana', value: 12 }, { stat: 'attackPower', value: 9 }] },
  { baseName: 'War Hammer', type: 'weapon', width: 2, height: 3, requiredLevel: 5, value: 120, implicit: [{ stat: 'attackPower', value: 20 }] },
  { baseName: 'Quilted Armor', type: 'armor', width: 2, height: 3, requiredLevel: 1, value: 40, implicit: [{ stat: 'defense', value: 8 }] },
  { baseName: 'Scale Mail', type: 'armor', width: 2, height: 3, requiredLevel: 3, value: 85, implicit: [{ stat: 'defense', value: 16 }] },
  { baseName: 'Bone Helm', type: 'helmet', width: 2, height: 2, requiredLevel: 2, value: 52, implicit: [{ stat: 'defense', value: 6 }] },
  { baseName: 'Leather Gloves', type: 'gloves', width: 2, height: 2, requiredLevel: 1, value: 28, implicit: [{ stat: 'dexterity', value: 1 }] },
  { baseName: 'Heavy Boots', type: 'boots', width: 2, height: 2, requiredLevel: 1, value: 30, implicit: [{ stat: 'defense', value: 4 }] },
  { baseName: 'Ring', type: 'ring', width: 1, height: 1, requiredLevel: 1, value: 65 },
  { baseName: 'Amulet', type: 'amulet', width: 1, height: 1, requiredLevel: 2, value: 75 },
  { baseName: 'Small Charm', type: 'charm', width: 1, height: 1, requiredLevel: 1, value: 45 }
]

export const affixPool: Affix[] = [
  { stat: 'strength', value: 3 },
  { stat: 'dexterity', value: 3 },
  { stat: 'vitality', value: 3 },
  { stat: 'life', value: 12 },
  { stat: 'mana', value: 12 },
  { stat: 'attackPower', value: 7 },
  { stat: 'defense', value: 8 },
  { stat: 'fireResist', value: 12 },
  { stat: 'coldResist', value: 12 },
  { stat: 'lightningResist', value: 12 },
  { stat: 'poisonResist', value: 12 },
  { stat: 'magicFind', value: 8 }
]

export const uniqueItems: Array<Omit<Item, 'id' | 'identified' | 'position'>> = [
  {
    baseName: 'Ring',
    displayName: 'Storm Loop',
    type: 'ring',
    rarity: 'unique',
    width: 1,
    height: 1,
    requiredLevel: 4,
    affixes: [
      { stat: 'strength', value: 6 },
      { stat: 'lightningResist', value: 24 },
      { stat: 'magicFind', value: 12 }
    ],
    value: 420
  },
  {
    baseName: 'War Hammer',
    displayName: 'Ashen Verdict',
    type: 'weapon',
    rarity: 'unique',
    width: 2,
    height: 3,
    requiredLevel: 6,
    affixes: [
      { stat: 'attackPower', value: 34 },
      { stat: 'fireResist', value: 18 }
    ],
    value: 620
  }
]

export const itemTypeToSlots: Record<ItemType, string[]> = {
  weapon: ['weapon'],
  armor: ['armor'],
  helmet: ['helmet'],
  gloves: ['gloves'],
  boots: ['boots'],
  ring: ['ring1', 'ring2'],
  amulet: ['amulet'],
  charm: []
}
