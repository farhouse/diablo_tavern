import type { Item } from '~/types/game'
import { validateGameView } from '~/server/utils/game-view-validator'
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
  const persisted = await reconcilePersistedGameV3(userId, { now: () => now, random: Math.random, uuid: crypto.randomUUID })
  return mapPersistedGameToGameView(persisted, now)
}

export function mapPersistedGameToGameView(game: PersistedGameV3, now = new Date()): GameView {
  const items = Object.entries(game.itemsById).flatMap(([itemId, item]) => {
    const placement = game.itemPlacements[itemId]
    // The legacy V1 appraiser is intentionally isolated: the normative V2
    // contract only defines blacksmith/enchanter jobs.
    if (!placement || placement.custodyKind === 'tombstone') return []
    if (placement.custodyKind === 'service') {
      const target = game.serviceJobsById[placement.custodyId ?? '']
      if (target?.projection?.kind === 'legacy_appraiser') {
        return [mapItem(item, { ownerKind: 'caravan', custodyKind: 'stash' }, game, now)]
      }
    }
    return [mapItem(item, placement, game, now)]
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
      if (!visitor.departedAt) throw new Error(`Missing authoritative departure time for ${visitor.id}`)
      return [{ ...base, state: 'departed', departedAt: visitor.departedAt, lastExpeditionId: visitor.commission?.id ?? `legacy-${visitor.id}` }]
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
  const projectedVisitorIds = new Set((visitors as Array<{ visitorId: string }>).map((visitor) => visitor.visitorId))
  for (const expedition of Object.values(game.expeditionsById)) {
    const target = expedition.projection
    if (target?.kind !== 'expedition' || projectedVisitorIds.has(target.visitorId)) continue
    if (!target.retainedVisitor) throw new Error(`Missing retained visitor identity for ${expedition.id}`)
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
  const expeditions = Object.values(game.expeditionsById).flatMap((container) => {
    const target = container.projection
    if (target?.kind !== 'expedition') return []
    return [{
      expeditionId: container.id, visitorId: target.visitorId, contractId: target.contractId,
      state: 'scheduled', actions: [], startsAt: target.startsAt
    }]
  })
  const settlements = Object.values(game.settlementsById).flatMap((container) => {
    const target = container.projection
    if (target?.kind !== 'settlement') return []
    return [{
      settlementId: container.id, expeditionId: target.expeditionId, state: 'settled', outcome: target.outcome,
      appliedAt: target.appliedAt, appliedBy: 'confirmation', appliedChoices: [], visitorResolution: 'stays', actions: []
    }]
  })
  const recoveries = Object.values(game.recoveriesById).flatMap((container) => {
    const target = container.projection
    if (target?.kind !== 'recovery') return []
    return [{
      recoveryId: container.id, sourceExpeditionId: target.sourceExpeditionId, itemIds: [...container.itemIds],
      state: 'recovered', actions: [], resolvedAt: target.resolvedAt, recoveredItemIds: [...container.itemIds]
    }]
  })
  const serviceJobs: unknown[] = Object.values(game.serviceJobsById).flatMap<unknown>((container) => {
    const target = container.projection
    if (target?.kind !== 'service') return []
      const state = game.serviceJobStateById[container.id]
      const itemId = container.itemIds[0] ?? state?.itemId
      if (!itemId) return []
      const base = {
        jobId: container.id, itemId, service: target.service,
        label: { key: `service.${container.id}`, fallback: 'Servicio de artesano' },
        actions: []
      }
      if (state?.status === 'completed') {
        return [{ ...base, state: 'completed', completedAt: state.completedAt ?? state.completesAt, resultText: { key: `service.${container.id}.result`, fallback: 'Servicio completado' } }]
      }
      return [{
        ...base,
        ...(state?.status === 'failed'
          ? { state: 'failed', failedAt: state.failedAt, reasonText: text(`service.${container.id}.failed`, 'El servicio no pudo completarse'), consequences: [] }
          : state?.status === 'cancelled'
            ? { state: 'cancelled', cancelledAt: state.cancelledAt, consequences: [] }
            : {
                state: state?.status === 'active' ? 'active' : 'queued',
                ...(state?.status === 'active'
                  ? { startedAt: state.startedAt, completesAt: state.completesAt }
                  : { queuedAt: state?.queuedAt, startsAt: state?.startedAt })
              })
      }]
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
  assertUnique(view.visitors as Array<Record<string, unknown>>, 'visitorId')
  assertUnique(view.expeditions as Array<Record<string, unknown>>, 'expeditionId')
  assertUnique(view.settlements as Array<Record<string, unknown>>, 'settlementId')
  assertUnique(view.recoveries as Array<Record<string, unknown>>, 'recoveryId')
  assertUnique(view.serviceJobs as Array<Record<string, unknown>>, 'jobId')
  const itemIds = new Set<string>()
  const visitorIds = new Set((view.visitors as Array<{ visitorId: string }>).map((visitor) => visitor.visitorId))
  const expeditionVisitors = new Map((view.expeditions as Array<{ expeditionId: string; visitorId: string }>).map((entry) => [entry.expeditionId, entry.visitorId]))
  const targetIds = {
    expedition: new Set(expeditionVisitors.keys()),
    settlement: new Set((view.settlements as Array<{ settlementId: string }>).map((entry) => entry.settlementId)),
    recovery: new Set((view.recoveries as Array<{ recoveryId: string }>).map((entry) => entry.recoveryId)),
    service: new Set((view.serviceJobs as Array<{ jobId: string }>).map((entry) => entry.jobId))
  }
  for (const expedition of view.expeditions as Array<{ expeditionId: string; visitorId: string }>) {
    if (!visitorIds.has(expedition.visitorId)) throw new Error(`Unknown expedition visitor for ${expedition.expeditionId}`)
  }
  for (const settlement of view.settlements as Array<{ settlementId: string; expeditionId: string }>) {
    if (!targetIds.expedition.has(settlement.expeditionId)) throw new Error(`Unknown settlement expedition for ${settlement.settlementId}`)
  }
  for (const recovery of view.recoveries as Array<{ recoveryId: string; sourceExpeditionId: string }>) {
    if (!targetIds.expedition.has(recovery.sourceExpeditionId)) throw new Error(`Unknown recovery expedition for ${recovery.recoveryId}`)
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
    if (item.custody.kind === 'expedition' && item.custody.expeditionId
      && expeditionVisitors.get(item.custody.expeditionId) !== item.custody.visitorId) {
      throw new Error(`Expedition visitor mismatch for ${item.itemId}`)
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

function mapItem(item: Item, placement: PersistedItemPlacement, game: PersistedGameV3, now: Date): Record<string, unknown> {
  const actions = itemActions(item, placement, game, now)
  const base = {
    itemId: item.id,
    name: { key: `item.${item.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, fallback: item.displayName },
    slot: item.type === 'weapon' ? 'weapon' : ['ring', 'amulet', 'charm'].includes(item.type) ? 'accessory' : 'armor',
    rarity: item.rarity === 'normal' ? 'common' : item.rarity === 'unique' ? 'legendary' : item.rarity,
    level: Math.max(1, item.requiredLevel),
    owner: placement.ownerKind === 'visitor'
      ? { kind: 'visitor', visitorId: placement.ownerId }
      : { kind: 'caravan' },
    custody: mapCustody(placement, game),
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

function itemActions(item: Item, placement: PersistedItemPlacement, game: PersistedGameV3, now = new Date(game.updatedAt)): unknown[] {
  if (!canUseEquipmentService(game, item.id) || placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') return []
  const expiresAt = equipmentActionExpiresAt(now)
  const state = game.itemV2ById[item.id]
  const actions: unknown[] = []
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

function sealedAction(game: PersistedGameV3, action: EquipmentV2Action, itemId: string, label: string, options: unknown[]): Record<string, unknown> {
  return {
    authorizationId: sealEquipmentActionToken(game, itemId, action, action, 'authorization', getActionExpiresAt(options)),
    action,
    enabled: true,
    label: text(`${action}.label`, label),
    consequences: [],
    targetId: itemId,
    execution: { itemId, options }
  }
}

function getActionExpiresAt(options: unknown[]): string {
  const option = options[0] as { expiresAt?: string } | undefined
  return option?.expiresAt ?? equipmentActionExpiresAt(new Date())
}

function text(key: string, fallback: string): Record<string, string> {
  return { key, fallback }
}

function spendGold(amount: number): Record<string, unknown> {
  return { kind: 'spend_resource', irreversible: true, resourceId: 'gold', amount, text: text('resource.gold.spend', `${amount} oro`) }
}

function destroyItem(itemId: string): Record<string, unknown> {
  return { kind: 'destroy_items', irreversible: true, itemIds: [itemId], text: text('item.destroy', 'El objeto se destruye') }
}

function mapImprint(imprint: PersistedGameV3['itemV2ById'][string]['activeImprint']): Record<string, unknown> | null {
  if (!imprint) return null
  return {
    imprintId: imprint.imprintId,
    bossId: 'act-boss',
    name: text(`imprint.${imprint.imprintId}`, imprint.label),
    effectText: text(`imprint.${imprint.imprintId}.effect`, imprint.label)
  }
}

function mapCustody(placement: PersistedItemPlacement, game: PersistedGameV3): Record<string, unknown> {
  switch (placement.custodyKind) {
    case 'visitor': return { kind: 'visitor', visitorId: placement.custodyId }
    case 'service': return { kind: 'service', jobId: placement.custodyId }
    case 'expedition': {
      const target = game.expeditionsById[placement.custodyId ?? '']?.projection
      return { kind: 'expedition', expeditionId: placement.custodyId, visitorId: target?.kind === 'expedition' ? target.visitorId : '' }
    }
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
  for (const state of Object.values(game.serviceJobStateById)) {
    if (state.status === 'active') result.push(state.completesAt)
  }
  return result
}
