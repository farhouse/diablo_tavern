import type { Item } from '~/types/game'
import type {
  ActionAvailability,
  ExpeditionView,
  CaravanOwner,
  ExpeditionCustody,
  GameView,
  ItemBase,
  ItemCustody,
  ItemView,
  ImprintView,
  LocalizedText,
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
import { projectVisitorCycle } from '~/server/domain/visitor-cycle'
import {
  getSaveGame,
  reconcilePersistedGameV3,
  type PersistedGameV3,
  type PersistedItemPlacement
} from '~/server/utils/savegame'
import {
  canUseEquipmentService,
  getBlacksmithOption,
  getDismantleOption,
  getEnchanterOption,
  getIdentifyOption,
  getImprintOption,
  equipmentActionExpiresAt,
  sealEquipmentActionToken,
  type EquipmentV2Action
} from '~/server/domain/equipment-v2'

export async function getGameView(userId: string, now = new Date()): Promise<GameView> {
  await getSaveGame(userId, { now: () => now, random: Math.random, uuid: crypto.randomUUID })
  const persisted = await reconcilePersistedGameV3(userId, { now: () => now, random: Math.random, uuid: crypto.randomUUID })
  return mapPersistedGameToGameView(persisted, now)
}

export function mapPersistedGameToGameView(game: PersistedGameV3, now = new Date()): GameView {
  const cycle = projectVisitorCycle(game, now)
  const visitors: VisitorView[] = cycle.visitors
  const projectedVisitorIds = new Set(visitors.map((visitor) => visitor.visitorId))
  const transitions = [...collectTransitions(game), ...cycle.transitions]
    .filter((timestamp) => Date.parse(timestamp) > now.getTime()).sort()
  const expeditions: ExpeditionView[] = cycle.expeditions
  const settlements: SettlementView[] = cycle.settlements
  const recoveries: RecoveryView[] = cycle.recoveries
  const serviceJobs = mapServiceJobs(game)
  const items = Object.entries(game.itemsById).flatMap<ItemView>(([itemId, item]) => {
    const placement = game.itemPlacements[itemId]
    if (!placement || placement.custodyKind === 'tombstone') return []
    if (placement.custodyKind === 'service') {
      const target = game.serviceJobsById[placement.custodyId ?? '']
      if (target?.projection?.kind === 'legacy_appraiser') {
        return [mapItem(item, { ownerKind: 'caravan', custodyKind: 'stash' }, game, now)]
      }
      if (target?.projection?.kind === 'service' && game.serviceJobStateById[target.id]) {
        return [mapItem(item, placement, game, now)]
      }
    }
    const custodyIsProjected = placement.custodyKind === 'stash'
      || (placement.custodyKind === 'expedition' && Boolean(game.visitorCycle.expeditions[placement.custodyId ?? '']))
      || (placement.custodyKind === 'settlement' && Boolean(game.visitorCycle.settlements[placement.custodyId ?? '']))
      || (placement.custodyKind === 'recovery' && Boolean(game.visitorCycle.recoveries[placement.custodyId ?? '']))
    if (placement.ownerKind === 'caravan' && custodyIsProjected) {
      return [mapItem(item, placement, game, now)]
    }
    if (placement.custodyKind === 'visitor' && placement.ownerKind === 'visitor'
      && placement.ownerId && projectedVisitorIds.has(placement.ownerId)) {
      return [mapItem(item, placement, game, now)]
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
    actions: cycle.actions
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

function mapItem(item: Item, placement: PersistedItemPlacement, game: PersistedGameV3, now: Date): ItemView {
  const slot: ItemBase['slot'] = item.type === 'weapon'
    ? 'weapon'
    : ['ring', 'amulet', 'charm'].includes(item.type) ? 'accessory' : 'armor'
  const rarity: ItemBase['rarity'] = item.rarity === 'normal'
    ? 'common'
    : item.rarity === 'unique' ? 'legendary' : item.rarity
  const ownership = mapOwnershipAndCustody(placement, game)
  const actions = itemActions(item, placement, game, now)
  const base = {
    itemId: item.id,
    name: { key: `item.${item.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, fallback: item.displayName },
    slot,
    rarity,
    level: Math.max(1, item.requiredLevel),
    ...ownership,
    actions
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
    activeImprint: mapImprint(game.itemV2ById[item.id]?.activeImprint)
  }
}

function itemActions(item: Item, placement: PersistedItemPlacement, game: PersistedGameV3, now = new Date(game.updatedAt)): ActionAvailability[] {
  if (!canUseEquipmentService(game, item.id) || placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') return []
  const expiresAt = equipmentActionExpiresAt(now)
  const state = game.itemV2ById[item.id]
  const actions: ActionAvailability[] = []
  if (!item.identified) {
    const option = getIdentifyOption(item)
    actions.push(sealedAction(game, 'identify_item', item.id, 'Identificar', [{
      optionId: sealEquipmentActionToken(game, item.id, 'identify_item', option.optionId, 'option', expiresAt), expiresAt,
      label: text('identify.label', 'Identificar'),
      description: text('identify.description', `Cuesta ${option.gold} oro`),
      consequences: option.gold > 0 ? [spendGold(option.gold)] : []
    }]))
  }

  const blacksmith = getBlacksmithOption(item, state)
  actions.push(sealedAction(game, 'queue_blacksmith_job', item.id, 'Herrero', [{
    optionId: sealEquipmentActionToken(game, item.id, 'queue_blacksmith_job', blacksmith.optionId, 'option', expiresAt), expiresAt,
    label: text('blacksmith.label', 'Mejorar en herrero'),
    description: text('blacksmith.description', `Cuesta ${blacksmith.gold} oro`),
    consequences: [spendGold(blacksmith.gold)]
  }]))

  const enchanter = getEnchanterOption(item, state)
  actions.push(sealedAction(game, 'queue_enchanter_job', item.id, 'Encantador', [{
    optionId: sealEquipmentActionToken(game, item.id, 'queue_enchanter_job', enchanter.optionId, 'option', expiresAt), expiresAt,
    label: text('enchanter.label', 'Encantar'),
    description: text('enchanter.description', `Cuesta ${enchanter.gold} oro`),
    consequences: [spendGold(enchanter.gold)]
  }]))

  const dismantle = getDismantleOption(item)
  actions.push(sealedAction(game, 'dismantle_item', item.id, 'Desmantelar', [{
    optionId: sealEquipmentActionToken(game, item.id, 'dismantle_item', dismantle.optionId, 'option', expiresAt), expiresAt,
    label: text('dismantle.label', 'Desmantelar'),
    description: text('dismantle.description', 'Convierte el objeto en materiales'),
    consequences: [destroyItem(item.id)],
    acknowledgement: { acknowledgementId: sealEquipmentActionToken(game, item.id, 'dismantle_item', dismantle.acknowledgementId, 'acknowledgement', expiresAt), expiresAt, text: text('dismantle.ack', 'Confirmar desmantelado irreversible') }
  }]))

  const imprint = item.identified ? getImprintOption(item, state) : null
  if (imprint) {
    actions.push(sealedAction(game, 'replace_boss_imprint', item.id, 'Reemplazar impronta', [{
      optionId: sealEquipmentActionToken(game, item.id, 'replace_boss_imprint', imprint.optionId, 'option', expiresAt), expiresAt,
      label: text('imprint.label', 'Reemplazar impronta'),
      description: text('imprint.description', 'Activa la impronta pendiente'),
      consequences: [],
      acknowledgement: { acknowledgementId: sealEquipmentActionToken(game, item.id, 'replace_boss_imprint', imprint.acknowledgementId, 'acknowledgement', expiresAt), expiresAt, text: text('imprint.ack', 'Confirmar reemplazo de impronta') }
    }]))
  }

  return actions
}

function sealedAction(game: PersistedGameV3, action: EquipmentV2Action, itemId: string, label: string, options: unknown[]): ActionAvailability {
  return {
    authorizationId: sealEquipmentActionToken(game, itemId, action, action, 'authorization', getActionExpiresAt(options)),
    action,
    enabled: true,
    label: text(`${action}.label`, label),
    consequences: [],
    targetId: itemId,
    execution: { itemId, options }
  } as ActionAvailability
}

function getActionExpiresAt(options: unknown[]): string {
  const option = options[0] as { expiresAt?: string } | undefined
  return option?.expiresAt ?? equipmentActionExpiresAt(new Date())
}

function text(key: string, fallback: string): LocalizedText {
  return { key, fallback }
}

function spendGold(amount: number): Record<string, unknown> {
  return { kind: 'spend_resource', irreversible: true, resourceId: 'gold', amount, text: text('resource.gold.spend', `${amount} oro`) }
}

function destroyItem(itemId: string): Record<string, unknown> {
  return { kind: 'destroy_items', irreversible: true, itemIds: [itemId], text: text('item.destroy', 'El objeto se destruye') }
}

function mapImprint(imprint: PersistedGameV3['itemV2ById'][string]['activeImprint']): ImprintView | null {
  if (!imprint) return null
  return {
    imprintId: imprint.imprintId,
    bossId: 'act-boss',
    name: text(`imprint.${imprint.imprintId}`, imprint.label),
    effectText: text(`imprint.${imprint.imprintId}.effect`, imprint.label)
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

function mapServiceJobs(game: PersistedGameV3): ServiceJobView[] {
  return Object.entries(game.serviceJobsById).flatMap<ServiceJobView>(([jobId, container]) => {
    if (container.projection?.kind !== 'service') return []
    const state = game.serviceJobStateById[jobId]
    const itemId = container.itemIds[0] ?? state?.itemId
    if (!state || !itemId) return []
    const base = {
      jobId,
      itemId,
      service: state.service,
      label: text(`service.${jobId}`, 'Servicio de artesano'),
      actions: []
    }
    switch (state.status) {
      case 'queued':
        return [{ ...base, state: 'queued', queuedAt: state.queuedAt, startsAt: state.startedAt }]
      case 'active':
        return [{ ...base, state: 'active', startedAt: state.startedAt, completesAt: state.completesAt }]
      case 'completed':
        return [{ ...base, state: 'completed', completedAt: state.completedAt ?? state.completesAt, resultText: text(`service.${jobId}.result`, 'Servicio completado') }]
      case 'failed':
        return [{ ...base, state: 'failed', failedAt: state.failedAt ?? state.completesAt, reasonText: text(`service.${jobId}.failed`, 'El servicio no pudo completarse'), consequences: [] }]
      case 'cancelled':
        return [{ ...base, state: 'cancelled', cancelledAt: state.cancelledAt ?? state.completesAt, consequences: [] }]
    }
  })
}

function collectTransitions(game: PersistedGameV3): string[] {
  const result: string[] = []
  for (const round of [game.visitRound, ...game.visitHistory]) {
    for (const slot of round.slots) {
      if (slot.nextArrivalCheckAt) result.push(slot.nextArrivalCheckAt)
    }
  }
  for (const job of game.caravan.services.appraiserQueue) result.push(job.finishesAt)
  for (const state of Object.values(game.serviceJobStateById)) {
    if (state.status === 'active') result.push(state.completesAt)
  }
  return result
}
