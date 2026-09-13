import type { Item } from '~/types/game'
import { validateGameView } from '~/server/utils/game-view-validator'
import {
  getSaveGame,
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
  await getSaveGame(userId, { now: () => now, random: Math.random, uuid: crypto.randomUUID })
  const persisted = await getPersistedGameV3(userId)
  return mapPersistedGameToGameView(persisted, now)
}

export function mapPersistedGameToGameView(game: PersistedGameV3, now = new Date()): GameView {
  const items = Object.entries(game.itemsById).flatMap(([itemId, item]) => {
    const placement = game.itemPlacements[itemId]
    // The legacy V1 appraiser is intentionally isolated: the normative V2
    // contract only defines blacksmith/enchanter jobs.
    if (!placement || placement.custodyKind === 'tombstone') return []
    return [mapItem(item, placement)]
  })
  const visitors: unknown[] = [game.visitRound, ...game.visitHistory].flatMap<unknown>((round) => round.slots.flatMap<unknown>((slot) => {
    const visitor = slot.visitor
    if (!visitor) return []
    const base = {
      visitorId: visitor.id,
      name: { key: `visitor.${visitor.id}`, fallback: visitor.name },
      actions: []
    }
    if (visitor.state === 'departed') {
      return [{ ...base, state: 'departed', departedAt: visitor.departedAt ?? game.updatedAt, lastExpeditionId: visitor.commission?.id ?? `legacy-${visitor.id}` }]
    }
    if (visitor.state === 'commissioned' || visitor.state === 'returned') {
      return [{ ...base, state: 'contracted', contractId: visitor.commission?.id ?? `legacy-${visitor.id}` }]
    }
    return [{
      ...base,
      state: 'available',
      departureSignal: 'possible',
      contractOptions: visitor.commissionOptions.map((option) => ({
        optionId: option.optionId,
        label: { key: `contract.${option.optionId}`, fallback: option.title },
        description: { key: `contract.${option.optionId}.description`, fallback: option.failureConsequence },
        durationSeconds: Math.max(1, Math.ceil(option.durationMs / 1000)),
        caravanGoldShareBps: option.optionId === 'safe' ? 2500 : 4000,
        lootPriority: 'caravan_first',
        retreatThreshold: option.optionId === 'safe' ? 10 : null,
        loanFeeGold: 0,
        consequences: []
      }))
    }]
  }))
  const transitions = collectTransitions(game).filter((timestamp) => Date.parse(timestamp) > now.getTime()).sort()
  const expeditions = Object.values(game.expeditionsById).map((container) => ({
    expeditionId: container.id, visitorId: `visitor-${container.id}`, contractId: `contract-${container.id}`,
    state: 'scheduled', actions: [], startsAt: game.updatedAt
  }))
  const settlements = Object.values(game.settlementsById).map((container) => ({
    settlementId: container.id, expeditionId: `expedition-${container.id}`, state: 'settled', outcome: 'returned',
    appliedAt: game.updatedAt, appliedBy: 'confirmation', appliedChoices: [], visitorResolution: 'stays', actions: []
  }))
  const recoveries = Object.values(game.recoveriesById).map((container) => ({
    recoveryId: container.id, sourceExpeditionId: `expedition-${container.id}`, itemIds: [...container.itemIds],
    state: 'recovered', actions: [], resolvedAt: game.updatedAt, recoveredItemIds: [...container.itemIds]
  }))
  const serviceJobs = Object.values(game.serviceJobsById).flatMap((container) => container.itemIds.slice(0, 1).map((itemId) => ({
    jobId: container.id, itemId, service: 'blacksmith', state: 'queued',
    label: { key: `service.${container.id}`, fallback: 'Servicio de artesano' }, actions: [],
    queuedAt: game.updatedAt, startsAt: game.updatedAt
  })))
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
  assertUnique(view.visitors as Array<Record<string, unknown>>, 'visitorId')
  assertUnique(view.expeditions as Array<Record<string, unknown>>, 'expeditionId')
  assertUnique(view.settlements as Array<Record<string, unknown>>, 'settlementId')
  assertUnique(view.recoveries as Array<Record<string, unknown>>, 'recoveryId')
  assertUnique(view.serviceJobs as Array<Record<string, unknown>>, 'jobId')
  const itemIds = new Set<string>()
  const visitorIds = new Set((view.visitors as Array<{ visitorId: string }>).map((visitor) => visitor.visitorId))
  const targetIds = {
    expedition: new Set((view.expeditions as Array<{ expeditionId: string }>).map((entry) => entry.expeditionId)),
    settlement: new Set((view.settlements as Array<{ settlementId: string }>).map((entry) => entry.settlementId)),
    recovery: new Set((view.recoveries as Array<{ recoveryId: string }>).map((entry) => entry.recoveryId)),
    service: new Set((view.serviceJobs as Array<{ jobId: string }>).map((entry) => entry.jobId))
  }
  for (const item of view.items as Array<{ itemId: string; owner: { kind: string; visitorId?: string }; custody: { kind: string; visitorId?: string; expeditionId?: string; settlementId?: string; recoveryId?: string; jobId?: string } }>) {
    if (itemIds.has(item.itemId)) throw new Error(`Duplicate public itemId ${item.itemId}`)
    if (item.owner.kind === 'caravan' && !['stash', 'service', 'expedition', 'settlement', 'recovery'].includes(item.custody.kind)) {
      throw new Error(`Invalid caravan custody for ${item.itemId}`)
    }
    if (item.owner.kind === 'visitor' && (!item.owner.visitorId || !visitorIds.has(item.owner.visitorId))) {
      throw new Error(`Unknown visitor owner for ${item.itemId}`)
    }
    if (item.custody.kind === 'visitor') {
      const visitorId = item.custody.visitorId
      if (!visitorId || visitorId !== item.owner.visitorId || !visitorIds.has(visitorId)) {
        throw new Error(`Invalid visitor custody for ${item.itemId}`)
      }
    }
    const reference = item.custody.kind === 'expedition' ? item.custody.expeditionId
      : item.custody.kind === 'settlement' ? item.custody.settlementId
        : item.custody.kind === 'recovery' ? item.custody.recoveryId
          : item.custody.kind === 'service' ? item.custody.jobId : undefined
    if (item.custody.kind in targetIds && (!reference || !targetIds[item.custody.kind as keyof typeof targetIds].has(reference))) {
      throw new Error(`Dangling ${item.custody.kind} custody for ${item.itemId}`)
    }
    itemIds.add(item.itemId)
  }
  if (view.capacity.used > view.capacity.limit) throw new Error('Owned item capacity exceeds its limit')
}

function assertUnique(values: Array<Record<string, unknown>>, key: string): void {
  const ids = values.map((value) => value[key])
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate public ${key}`)
}

function mapItem(item: Item, placement: PersistedItemPlacement): Record<string, unknown> {
  const base = {
    itemId: item.id,
    name: { key: `item.${item.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, fallback: item.displayName },
    slot: item.type === 'weapon' ? 'weapon' : ['ring', 'amulet', 'charm'].includes(item.type) ? 'accessory' : 'armor',
    rarity: item.rarity === 'normal' ? 'common' : item.rarity === 'unique' ? 'legendary' : item.rarity,
    level: Math.max(1, item.requiredLevel),
    owner: placement.ownerKind === 'visitor'
      ? { kind: 'visitor', visitorId: placement.ownerId }
      : { kind: 'caravan' },
    custody: mapCustody(placement),
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

function mapCustody(placement: PersistedItemPlacement): Record<string, unknown> {
  switch (placement.custodyKind) {
    case 'visitor': return { kind: 'visitor', visitorId: placement.custodyId }
    case 'service': return { kind: 'service', jobId: placement.custodyId }
    case 'expedition': return { kind: 'expedition', expeditionId: placement.custodyId, visitorId: placement.ownerId ?? placement.custodyId }
    case 'settlement': return { kind: 'settlement', settlementId: placement.custodyId }
    case 'recovery': return { kind: 'recovery', recoveryId: placement.custodyId }
    default: return { kind: 'stash' }
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
