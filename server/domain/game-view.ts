import type { Item } from '~/types/game'
import type {
  ExpeditionView,
  CaravanOwner,
  ExpeditionCustody,
  GameView,
  ItemBase,
  ItemCustody,
  ItemView,
  RecoveryCustody,
  RecoveryView,
  ServiceCustody,
  ServiceJobView,
  SettlementCustody,
  SettlementView,
  StashCustody,
  VisitorCustody,
  VisitorOwner,
  VisitorView
} from '~/shared/types/v2-game-view'
export type { GameView } from '~/shared/types/v2-game-view'
import { validateGameView } from '~/server/utils/game-view-validator'
import {
  getSaveGame,
  getPersistedGameV3,
  type PersistedGameV3,
  type PersistedItemPlacement
} from '~/server/utils/savegame'

export async function getGameView(userId: string, now = new Date()): Promise<GameView> {
  await getSaveGame(userId, { now: () => now, random: Math.random, uuid: crypto.randomUUID })
  const persisted = await getPersistedGameV3(userId)
  return mapPersistedGameToGameView(persisted, now)
}

export function mapPersistedGameToGameView(game: PersistedGameV3, now = new Date()): GameView {
  const visitors: VisitorView[] = [game.visitRound, ...game.visitHistory].flatMap<VisitorView>((round) => round.slots.flatMap<VisitorView>((slot) => {
    const visitor = slot.visitor
    if (!visitor) return []
    const base = {
      visitorId: visitor.id,
      name: { key: `visitor.${visitor.id}`, fallback: visitor.name },
      actions: []
    }
    if (visitor.state === 'departed') {
      if (!visitor.departedAt || !visitor.commission?.id) return []
      return [{ ...base, state: 'departed', departedAt: visitor.departedAt, lastExpeditionId: visitor.commission.id }]
    }
    // Stage 1 persists legacy visitor records but not authoritative V2
    // contract options or lifecycle discriminants. Omit them until the later
    // domain stages persist a complete public projection.
    return []
  }))
  const projectedVisitorIds = new Set(visitors.map((visitor) => visitor.visitorId))
  for (const expedition of Object.values(game.expeditionsById)) {
    const target = expedition.projection
    if (target?.kind !== 'expedition' || projectedVisitorIds.has(target.visitorId) || !target.retainedVisitor) continue
    visitors.push({
      visitorId: target.visitorId,
      name: { key: `visitor.${target.visitorId}`, fallback: target.retainedVisitor.name },
      state: 'departed',
      departedAt: target.retainedVisitor.departedAt,
      lastExpeditionId: expedition.id,
      actions: []
    })
    projectedVisitorIds.add(target.visitorId)
  }
  const transitions = collectTransitions(game).filter((timestamp) => Date.parse(timestamp) > now.getTime()).sort()
  // These persisted Stage 1 containers intentionally carry only identity and
  // custody bookkeeping. They do not yet carry enough facts to select a V2
  // lifecycle variant without inventing state, so the public collections stay
  // empty until their owning domain stages persist exact projections.
  const expeditions: ExpeditionView[] = []
  const settlements: SettlementView[] = []
  const recoveries: RecoveryView[] = []
  const serviceJobs: ServiceJobView[] = []
  const items = Object.entries(game.itemsById).flatMap<ItemView>(([itemId, item]) => {
    const placement = game.itemPlacements[itemId]
    if (!placement || placement.custodyKind === 'tombstone') return []
    if (placement.custodyKind === 'stash' && placement.ownerKind === 'caravan') {
      return [mapItem(item, placement, game)]
    }
    if (placement.custodyKind === 'visitor' && placement.ownerKind === 'visitor'
      && placement.ownerId && projectedVisitorIds.has(placement.ownerId)) {
      return [mapItem(item, placement, game)]
    }
    return []
  })
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
    visitors,
    expeditions,
    settlements,
    recoveries,
    serviceJobs,
    items,
    actions: []
  }
  validateGameView(view)
  validateSemanticGameView(view)
  return view
}

export function validateSemanticGameView(view: GameView): void {
  assertUnique(view.visitors, 'visitorId')
  assertUnique(view.expeditions, 'expeditionId')
  assertUnique(view.settlements, 'settlementId')
  assertUnique(view.recoveries, 'recoveryId')
  assertUnique(view.serviceJobs, 'jobId')
  const itemIds = new Set<string>()
  const visitorIds = new Set(view.visitors.map((visitor) => visitor.visitorId))
  const expeditionVisitors = new Map(view.expeditions.map((entry) => [entry.expeditionId, entry.visitorId]))
  const targetIds = {
    expedition: new Set(expeditionVisitors.keys()),
    settlement: new Set(view.settlements.map((entry) => entry.settlementId)),
    recovery: new Set(view.recoveries.map((entry) => entry.recoveryId)),
    service: new Set(view.serviceJobs.map((entry) => entry.jobId))
  }
  for (const expedition of view.expeditions) {
    if (!visitorIds.has(expedition.visitorId)) throw new Error(`Unknown expedition visitor for ${expedition.expeditionId}`)
  }
  for (const settlement of view.settlements) {
    if (!targetIds.expedition.has(settlement.expeditionId)) throw new Error(`Unknown settlement expedition for ${settlement.settlementId}`)
  }
  for (const recovery of view.recoveries) {
    if (!targetIds.expedition.has(recovery.sourceExpeditionId)) throw new Error(`Unknown recovery expedition for ${recovery.recoveryId}`)
  }
  for (const item of view.items) {
    if (itemIds.has(item.itemId)) throw new Error(`Duplicate public itemId ${item.itemId}`)
    if (item.owner.kind === 'caravan' && !['stash', 'service', 'expedition', 'settlement', 'recovery'].includes(item.custody.kind)) {
      throw new Error(`Invalid caravan custody for ${item.itemId}`)
    }
    if (item.owner.kind === 'visitor' && (!item.owner.visitorId || !visitorIds.has(item.owner.visitorId))) {
      throw new Error(`Unknown visitor owner for ${item.itemId}`)
    }
    if (item.custody.kind === 'visitor') {
      const visitorId = item.custody.visitorId
      if (item.owner.kind !== 'visitor' || visitorId !== item.owner.visitorId || !visitorIds.has(visitorId)) {
        throw new Error(`Invalid visitor custody for ${item.itemId}`)
      }
    }
    if (item.custody.kind === 'expedition' && item.custody.expeditionId
      && expeditionVisitors.get(item.custody.expeditionId) !== item.custody.visitorId) {
      throw new Error(`Expedition visitor mismatch for ${item.itemId}`)
    }
    if (!hasPublicCustodyTarget(item.custody, targetIds)) {
      throw new Error(`Dangling ${item.custody.kind} custody for ${item.itemId}`)
    }
    itemIds.add(item.itemId)
  }
  if (view.capacity.used > view.capacity.limit) throw new Error('Owned item capacity exceeds its limit')
}

function hasPublicCustodyTarget(
  custody: ItemCustody,
  targets: { expedition: Set<string>; settlement: Set<string>; recovery: Set<string>; service: Set<string> }
): boolean {
  switch (custody.kind) {
    case 'expedition': return targets.expedition.has(custody.expeditionId)
    case 'settlement': return targets.settlement.has(custody.settlementId)
    case 'recovery': return targets.recovery.has(custody.recoveryId)
    case 'service': return targets.service.has(custody.jobId)
    case 'stash':
    case 'visitor': return true
  }
}

function assertUnique<T, K extends keyof T>(values: T[], key: K): void {
  const ids = values.map((value) => value[key])
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate public ${String(key)}`)
}

function mapItem(item: Item, placement: PersistedItemPlacement, game: PersistedGameV3): ItemView {
  const slot: ItemBase['slot'] = item.type === 'weapon'
    ? 'weapon'
    : ['ring', 'amulet', 'charm'].includes(item.type) ? 'accessory' : 'armor'
  const rarity: ItemBase['rarity'] = item.rarity === 'normal'
    ? 'common'
    : item.rarity === 'unique' ? 'legendary' : item.rarity
  const ownership = mapOwnershipAndCustody(placement, game)
  const base = {
    itemId: item.id,
    name: { key: `item.${item.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, fallback: item.displayName },
    slot,
    rarity,
    level: Math.max(1, item.requiredLevel),
    ...ownership,
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

function mapOwnershipAndCustody(
  placement: PersistedItemPlacement,
  game: PersistedGameV3
): ItemOwnershipAndCustody {
  const custody = mapCustody(placement, game)
  if (placement.ownerKind === 'visitor') {
    const visitorId = requireId(placement.ownerId, 'visitor owner')
    if (custody.kind !== 'visitor' || custody.visitorId !== visitorId) {
      throw new Error(`Visitor owner ${visitorId} has incompatible ${custody.kind} custody`)
    }
    return { owner: { kind: 'visitor', visitorId }, custody }
  }
  if (placement.ownerKind !== 'caravan' || custody.kind === 'visitor') {
    throw new Error(`Invalid public owner/custody projection: ${placement.ownerKind}/${custody.kind}`)
  }
  return { owner: { kind: 'caravan' }, custody }
}

type ItemOwnershipAndCustody =
  | { owner: VisitorOwner; custody: VisitorCustody }
  | {
      owner: CaravanOwner
      custody: StashCustody | ExpeditionCustody | RecoveryCustody | SettlementCustody | ServiceCustody
    }

function mapCustody(placement: PersistedItemPlacement, game: PersistedGameV3): ItemCustody {
  switch (placement.custodyKind) {
    case 'visitor': return { kind: 'visitor', visitorId: requireId(placement.custodyId, 'visitor custody') }
    case 'service': return { kind: 'service', jobId: requireId(placement.custodyId, 'service custody') }
    case 'expedition': {
      const expeditionId = requireId(placement.custodyId, 'expedition custody')
      const target = game.expeditionsById[expeditionId]?.projection
      if (target?.kind !== 'expedition') throw new Error(`Missing expedition projection for ${expeditionId}`)
      return { kind: 'expedition', expeditionId, visitorId: target.visitorId }
    }
    case 'settlement': return { kind: 'settlement', settlementId: requireId(placement.custodyId, 'settlement custody') }
    case 'recovery': return { kind: 'recovery', recoveryId: requireId(placement.custodyId, 'recovery custody') }
    default: return { kind: 'stash' }
  }
}

function requireId(value: string | undefined, context: string): string {
  if (!value) throw new Error(`Missing ${context} id`)
  return value
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
