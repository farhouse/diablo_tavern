import type { Item } from '~/types/game'
import { validateGameView } from '~/server/utils/game-view-validator'
import {
  getPersistedGameV3,
  type PersistedGameV3,
  type PersistedItemPlacement
} from '~/server/utils/savegame'

export interface GameView {
  contractVersion: 'v2-etapa0-3'
  labelCatalogVersion: 'es-AR-v1'
  revision: number
  serverNow: string
  nextTransitionAt: string | null
  resources: { gold: number; materials: Record<string, number> }
  capacity: { used: number; limit: number; reserved: number; blockers: unknown[] }
  visitors: unknown[]
  expeditions: unknown[]
  settlements: unknown[]
  recoveries: unknown[]
  serviceJobs: unknown[]
  items: unknown[]
  actions: unknown[]
}

export async function getGameView(userId: string, now = new Date()): Promise<GameView> {
  const persisted = await getPersistedGameV3(userId)
  return mapPersistedGameToGameView(persisted, now)
}

export function mapPersistedGameToGameView(game: PersistedGameV3, now = new Date()): GameView {
  const items = Object.entries(game.itemsById).flatMap(([itemId, item]) => {
    const placement = game.itemPlacements[itemId]
    if (!placement || placement.ownerKind !== 'caravan' || placement.custodyKind === 'tombstone') return []
    return [mapItem(item, placement)]
  })
  const transitions = collectTransitions(game).filter((timestamp) => Date.parse(timestamp) > now.getTime()).sort()
  const view: GameView = {
    contractVersion: 'v2-etapa0-3',
    labelCatalogVersion: 'es-AR-v1',
    revision: game.revision,
    serverNow: now.toISOString(),
    nextTransitionAt: transitions[0] ?? null,
    resources: { gold: game.gold, materials: structuredClone(game.materials) },
    capacity: {
      used: Object.values(game.itemPlacements).filter((placement) => placement.ownerKind === 'caravan').length,
      limit: game.stashLimit,
      reserved: 0,
      blockers: []
    },
    visitors: [],
    expeditions: [],
    settlements: [],
    recoveries: [],
    serviceJobs: [],
    items,
    actions: []
  }
  validateGameView(view)
  validateSemanticGameView(view)
  return view
}

export function validateSemanticGameView(view: GameView): void {
  const itemIds = new Set<string>()
  for (const item of view.items as Array<{ itemId: string; owner: { kind: string }; custody: { kind: string } }>) {
    if (itemIds.has(item.itemId)) throw new Error(`Duplicate public itemId ${item.itemId}`)
    if (item.owner.kind === 'caravan' && !['stash', 'service', 'expedition', 'settlement', 'recovery'].includes(item.custody.kind)) {
      throw new Error(`Invalid caravan custody for ${item.itemId}`)
    }
    itemIds.add(item.itemId)
  }
  if (view.capacity.used > view.capacity.limit) throw new Error('Owned item capacity exceeds its limit')
}

function mapItem(item: Item, placement: PersistedItemPlacement): Record<string, unknown> {
  const base = {
    itemId: item.id,
    name: { key: `item.${item.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, fallback: item.displayName },
    slot: item.type === 'weapon' ? 'weapon' : ['ring', 'amulet', 'charm'].includes(item.type) ? 'accessory' : 'armor',
    rarity: item.rarity === 'normal' ? 'common' : item.rarity === 'unique' ? 'legendary' : item.rarity,
    level: Math.max(1, item.requiredLevel),
    owner: { kind: 'caravan' },
    custody: placement.custodyKind === 'service'
      ? { kind: 'service', jobId: placement.custodyId }
      : { kind: 'stash' },
    actions: []
  }
  if (!item.identified) return { ...base, identification: 'unidentified' }
  return {
    ...base,
    identification: 'identified',
    affixes: item.affixes.map((affix, index) => ({
      affixId: `${item.id}-affix-${index}`,
      name: { key: `affix.${affix.stat}`, fallback: affix.stat },
      valueText: { key: `affix.${affix.stat}.value`, fallback: String(affix.value) }
    })),
    activeImprint: null
  }
}

function collectTransitions(game: PersistedGameV3): string[] {
  const result: string[] = []
  for (const round of [game.visitRound, ...game.visitHistory]) {
    for (const slot of round.slots) {
      if (slot.nextArrivalCheckAt) result.push(slot.nextArrivalCheckAt)
      if (slot.visitor?.commission?.finishesAt) result.push(slot.visitor.commission.finishesAt)
    }
  }
  for (const job of game.caravan.services.appraiserQueue) result.push(job.finishesAt)
  return result
}
