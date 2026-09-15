import type { Affix, Item, ItemRarity } from '~/types/game'
import { affixPool, itemBases, quests, uniqueItems } from '~/utils/game-data'
import type { PersistedItemV2State, PersistenceDependencies } from '~/server/utils/savegame'

export const LOOT_CONFIG_VERSION = 'loot-v2.2026-09-15'

interface LootTableEntry {
  weight: number
  baseIndex: number
  rarity: ItemRarity
  combinationId?: string
  imperfectPieceId?: string
}

interface LootTable {
  tableId: string
  entries: LootTableEntry[]
}

const LOOT_TABLES: Record<string, LootTable> = {
  'act1-low': {
    tableId: 'act1-low',
    entries: [
      { weight: 40, baseIndex: 0, rarity: 'normal' },
      { weight: 35, baseIndex: 6, rarity: 'magic', imperfectPieceId: 'frayed-lining' },
      { weight: 25, baseIndex: 13, rarity: 'magic', combinationId: 'scavenger-kit', imperfectPieceId: 'mismatched-pair' }
    ]
  },
  'act1-mid': {
    tableId: 'act1-mid',
    entries: [
      { weight: 30, baseIndex: 1, rarity: 'magic' },
      { weight: 30, baseIndex: 7, rarity: 'magic', imperfectPieceId: 'dented-links' },
      { weight: 25, baseIndex: 17, rarity: 'rare', combinationId: 'wanderer-set' },
      { weight: 15, baseIndex: 18, rarity: 'rare', combinationId: 'wanderer-set', imperfectPieceId: 'cracked-gem' }
    ]
  },
  'act1-high': {
    tableId: 'act1-high',
    entries: [
      { weight: 25, baseIndex: 3, rarity: 'magic' },
      { weight: 25, baseIndex: 8, rarity: 'rare', combinationId: 'tower-armory' },
      { weight: 25, baseIndex: 11, rarity: 'rare', combinationId: 'tower-armory', imperfectPieceId: 'split-crown' },
      { weight: 25, baseIndex: 19, rarity: 'unique' }
    ]
  },
  'act1-boss': {
    tableId: 'act1-boss',
    entries: [
      { weight: 20, baseIndex: 3, rarity: 'rare', combinationId: 'butcher-trophy' },
      { weight: 20, baseIndex: 9, rarity: 'rare', combinationId: 'butcher-trophy' },
      { weight: 30, baseIndex: 17, rarity: 'unique' },
      { weight: 30, baseIndex: 11, rarity: 'unique', imperfectPieceId: 'scorched-sigil' }
    ]
  }
}

export interface LootGenerationContext {
  zoneId: string
  businessKey: string
  droppedAt: string
}

export interface GeneratedLoot {
  item: Item
  state: PersistedItemV2State
}

export function generateLootForZone(context: LootGenerationContext, dependencies: PersistenceDependencies): GeneratedLoot {
  const quest = quests.find((entry) => entry.id === context.zoneId) ?? quests[0]!
  const table = LOOT_TABLES[quest.lootTableId] ?? LOOT_TABLES['act1-low']!
  const entry = pickWeighted(table.entries, dependencies.random())
  const base = itemBases[entry.baseIndex] ?? itemBases[0]!
  const rarity = entry.rarity
  const unique = rarity === 'unique'
    ? uniqueItems.find((item) => item.type === base.type) ?? uniqueItems[0]
    : undefined
  const affixes = unique
    ? cloneAffixes(unique.affixes)
    : rollAffixes([...(base.implicit ?? [])], rarity, dependencies)
  const value = unique
    ? unique.value
    : Math.round(base.value * rarityMultiplier(rarity) * (entry.imperfectPieceId ? 0.85 : 1))
  const item: Item = {
    id: `loot-${dependencies.uuid()}`,
    baseName: unique?.baseName ?? base.baseName,
    displayName: unique?.displayName ?? displayName(rarity, base.baseName, entry),
    type: unique?.type ?? base.type,
    rarity,
    identified: rarity === 'normal',
    width: unique?.width ?? base.width,
    height: unique?.height ?? base.height,
    requiredLevel: unique?.requiredLevel ?? Math.max(base.requiredLevel, quest.minLevel),
    affixes,
    value
  }
  return {
    item,
    state: {
      sealedAffixes: cloneAffixes(affixes),
      provenance: {
        zoneId: context.zoneId,
        lootTableId: table.tableId,
        configVersion: LOOT_CONFIG_VERSION,
        businessKey: context.businessKey,
        ...(entry.combinationId ? { combinationId: entry.combinationId } : {}),
        ...(entry.imperfectPieceId ? { imperfectPieceId: entry.imperfectPieceId } : {}),
        droppedAt: context.droppedAt
      },
      ...(context.zoneId === 'act-boss'
        ? { pendingImprint: { imprintId: `boss-${context.zoneId}`, label: 'Act boss imprint', grantedAt: context.droppedAt } }
        : {})
    }
  }
}

function pickWeighted(entries: LootTableEntry[], random: number): LootTableEntry {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = clampRandom(random) * total
  for (const entry of entries) {
    cursor -= entry.weight
    if (cursor < 0) return entry
  }
  return entries.at(-1)!
}

function rollAffixes(implicit: Affix[], rarity: ItemRarity, dependencies: PersistenceDependencies): Affix[] {
  const affixes = cloneAffixes(implicit)
  const count = rarity === 'normal' ? 0 : rarity === 'magic' ? 1 : 3
  const available = affixPool.map((affix) => ({ ...affix }))
  for (let index = 0; index < count && available.length; index += 1) {
    const selectedIndex = Math.min(available.length - 1, Math.floor(clampRandom(dependencies.random()) * available.length))
    affixes.push(available.splice(selectedIndex, 1)[0]!)
  }
  return affixes
}

function displayName(rarity: ItemRarity, baseName: string, entry: LootTableEntry): string {
  const prefix = rarity === 'normal' ? '' : `${rarity[0]!.toUpperCase()}${rarity.slice(1)} `
  const suffix = entry.imperfectPieceId ? ' (Imperfect)' : ''
  return `${prefix}${baseName}${suffix}`
}

function rarityMultiplier(rarity: ItemRarity): number {
  if (rarity === 'magic') return 1.8
  if (rarity === 'rare') return 3.2
  if (rarity === 'unique') return 5
  return 1
}

function cloneAffixes(affixes: Affix[]): Affix[] {
  return affixes.map((affix) => ({ ...affix }))
}

function clampRandom(value: number): number {
  return Math.max(0, Math.min(0.999999999, value))
}
