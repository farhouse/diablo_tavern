import type { Item } from '~/types/game'
import { createHash } from 'node:crypto'
import type {
  ActionAvailability,
  ChoiceGroup,
  ContractOptionView,
  ExpeditionOutcome,
  ExpeditionView,
  GameView,
  RecoveryOptionView,
  RecoveryView,
  SettlementView,
  UnavailableReason,
  VisitorView
} from '~/shared/types/v2-game-view'
import { V2DomainRuleError } from '~/shared/errors/v2-domain'
import type { PersistenceDependencies, PersistedGameV3, PersistedVisitorCommission } from '~/server/utils/savegame'
import { settlementReservationKey, visitorCapacityLimit } from '~/server/domain/caravan-v2'

const CONTRACT_TTL_MS = 24 * 60 * 60 * 1000
const SETTLEMENT_TTL_MS = 5 * 60 * 1000
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000
const RECOVERY_DURATION_MS = 60 * 1000
const MAX_HP = 18

export interface PersistedContractOption extends ContractOptionView {
  expiresAt: string
}

export interface PersistedCycleVisitor {
  visitorId: string
  name: string
  state: 'available' | 'negotiating' | 'contracted' | 'away' | 'awaiting_settlement' | 'departed' | 'dead'
  departureSignal: 'unlikely' | 'possible' | 'likely'
  contractOptions: PersistedContractOption[]
  negotiationId?: string
  expiresAt?: string
  contractId?: string
  expeditionId?: string
  settlementId?: string
  outcome?: ExpeditionOutcome
  departedAt?: string
  diedAt?: string
  recoveryId?: string
  lastExpeditionId?: string
  busyRecoveryId?: string
}

export interface PersistedMissionContract {
  contractId: string
  visitorId: string
  option: PersistedContractOption
  loanItemIds: string[]
  acceptedAt: string
  departureResolution: 'stays' | 'departs'
  expeditionId: string
}

export interface PersistedExpeditionEvent {
  eventId: string
  occursAt: string
  damage: number
  gold: number
}

export interface PersistedCycleExpedition {
  expeditionId: string
  visitorId: string
  contractId: string
  state: 'scheduled' | 'active' | 'awaiting_settlement' | 'settled'
  startsAt: string
  startedAt?: string
  nextEventIndex: number
  currentHp: number
  maxHp: number
  events: PersistedExpeditionEvent[]
  grossGold: number
  outcome?: ExpeditionOutcome
  resolvedAt?: string
  settlementId?: string
  settledAt?: string
  visitorResolution?: 'stays' | 'departs' | 'dead'
}

export interface PersistedCycleSettlement {
  settlementId: string
  expeditionId: string
  state: 'preview_ready' | 'settled'
  previewVersion: number
  outcome: ExpeditionOutcome
  createdAt: string
  expiresAt: string
  grossGold: number
  caravanGold: number
  visitorGold: number
  loanItemIds: string[]
  rewardItemIds: string[]
  choiceGroups: ChoiceGroup[]
  departureSignal: 'unlikely' | 'possible' | 'likely'
  departureResolution: 'stays' | 'departs' | 'dead'
  appliedAt?: string
  appliedBy?: 'confirmation' | 'expiry_default'
  appliedChoices?: Array<{ groupId: string; optionId: string; label: { key: string; fallback: string } }>
}

export interface PersistedCycleRecovery {
  recoveryId: string
  sourceExpeditionId: string
  itemIds: string[]
  state: 'open' | 'assigned' | 'recovered' | 'failed' | 'abandoned'
  expiresAt: string
  options: RecoveryOptionView[]
  assignedVisitorId?: string
  assignedAt?: string
  completesAt?: string
  supportLoanItemIds: string[]
  succeeds?: boolean
  resolvedAt?: string
  recoveredItemIds?: string[]
}

export interface PersistedVisitorCycle {
  visitors: Record<string, PersistedCycleVisitor>
  contracts: Record<string, PersistedMissionContract>
  expeditions: Record<string, PersistedCycleExpedition>
  settlements: Record<string, PersistedCycleSettlement>
  recoveries: Record<string, PersistedCycleRecovery>
}

export type VisitorCycleCommand =
  | { action: 'accept_contract'; visitorId: string; optionId: string; loanItemIds: string[] }
  | { action: 'start_expedition'; contractId: string }
  | { action: 'reconcile_game' }
  | { action: 'confirm_settlement'; settlementId: string; previewVersion: number; selectedOptionIds: string[] }
  | { action: 'assign_recovery'; recoveryId: string; visitorId: string; optionId: string; loanItemIds: string[] }
  | { action: 'abandon_recovery'; recoveryId: string; acknowledgementId: string }

export class VisitorCycleError extends V2DomainRuleError {
  override name = 'VisitorCycleError'
}

export function createVisitorCycle(game: Pick<PersistedGameV3, 'visitRound' | 'visitHistory' | 'createdAt'>): PersistedVisitorCycle {
  const cycle: PersistedVisitorCycle = { visitors: {}, contracts: {}, expeditions: {}, settlements: {}, recoveries: {} }
  const visitors: Record<string, PersistedCycleVisitor> = {}
  for (const round of [game.visitRound, ...game.visitHistory]) {
    for (const slot of round.slots) {
      const source = slot.visitor
      if (!source || visitors[source.id]) continue
      const departed = source.state === 'departed'
      const cycleVisitor: PersistedCycleVisitor = {
        visitorId: source.id,
        name: source.name,
        state: departed ? 'departed' : 'available',
        departureSignal: 'possible',
        contractOptions: departed ? [] : contractOptions(source.id, game.createdAt, 0),
        ...(departed ? {
          departedAt: source.departedAt ?? game.createdAt,
          lastExpeditionId: source.commission?.id ?? `legacy-${source.id}`
        } : {})
      }
      visitors[source.id] = cycleVisitor
      if (!departed && source.commission && source.commission.status !== 'claimed') {
        migrateLegacyCommission(cycle, cycleVisitor, source.commission)
      }
    }
  }
  cycle.visitors = visitors
  return cycle
}

function migrateLegacyCommission(
  cycle: PersistedVisitorCycle,
  visitor: PersistedCycleVisitor,
  commission: PersistedVisitorCommission
): void {
  const contractId = commission.id
  const expeditionId = commission.id
  const option: PersistedContractOption = {
    optionId: sealedOptionId(visitor.visitorId, commission.id, 'legacy'),
    label: text('contract.legacy', commission.title),
    description: text('contract.legacy.description', commission.failureConsequence),
    durationSeconds: Math.max(1, Math.ceil(commission.durationMs / 1000)),
    caravanGoldShareBps: 10_000,
    lootPriority: 'caravan_first',
    retreatThreshold: 10,
    loanFeeGold: 0,
    consequences: [],
    expiresAt: new Date(Date.parse(commission.startedAt) + CONTRACT_TTL_MS).toISOString()
  }
  const outcome = commission.outcome === 'complete'
    ? 'returned'
    : commission.outcome === 'partial' ? 'retreated'
      : commission.outcome === 'failed' ? 'death'
        : commission.outcomeRoll <= commission.successChance ? 'returned'
          : commission.outcomeRoll <= Math.min(0.97, commission.successChance + 0.25) ? 'retreated' : 'death'
  const grossGold = commission.rewardGold ?? (outcome === 'returned'
    ? commission.fullRewardGold
    : outcome === 'retreated' ? commission.partialRewardGold : 0)
  const damage = outcome === 'death' ? MAX_HP : outcome === 'retreated' ? MAX_HP - 10 : 0
  const event: PersistedExpeditionEvent = {
    eventId: `legacy-event-${commission.id}`, occursAt: commission.finishesAt, damage, gold: grossGold
  }
  cycle.contracts[contractId] = {
    contractId, visitorId: visitor.visitorId, option, loanItemIds: [], acceptedAt: commission.startedAt,
    departureResolution: 'stays', expeditionId
  }
  if (commission.status === 'active') {
    cycle.expeditions[expeditionId] = {
      expeditionId, visitorId: visitor.visitorId, contractId, state: 'active', startsAt: commission.startedAt,
      startedAt: commission.startedAt, nextEventIndex: 0, currentHp: MAX_HP, maxHp: MAX_HP,
      events: [event], grossGold: 0
    }
    visitor.state = 'away'
    visitor.contractId = contractId
    visitor.expeditionId = expeditionId
    return
  }

  const settlementId = commission.id
  const rewardItemIds = commission.rewardItemId ? [commission.rewardItemId] : []
  const choiceGroups: ChoiceGroup[] = rewardItemIds.length === 0 ? [] : [{
    groupId: `legacy-reward-${commission.id}`, required: true, defaultOptionId: `keep-${commission.rewardItemId}`,
    label: text('settlement.legacy.reward', 'Recompensa pendiente'),
    options: [{
      optionId: `keep-${commission.rewardItemId}`, label: text('settlement.legacy.keep', 'Guardar recompensa'),
      itemIds: rewardItemIds, capacityDelta: 0, consequences: []
    }]
  }]
  cycle.expeditions[expeditionId] = {
    expeditionId, visitorId: visitor.visitorId, contractId, state: 'awaiting_settlement', startsAt: commission.startedAt,
    startedAt: commission.startedAt, nextEventIndex: 1, currentHp: Math.max(0, MAX_HP - damage), maxHp: MAX_HP,
    events: [event], grossGold, outcome, resolvedAt: commission.finishesAt, settlementId
  }
  cycle.settlements[settlementId] = {
    settlementId, expeditionId, state: 'preview_ready', previewVersion: 1, outcome,
    createdAt: commission.finishesAt, expiresAt: new Date(Date.parse(commission.finishesAt) + SETTLEMENT_TTL_MS).toISOString(),
    grossGold, caravanGold: grossGold, visitorGold: 0, loanItemIds: [], rewardItemIds, choiceGroups,
    departureSignal: visitor.departureSignal, departureResolution: outcome === 'death' ? 'dead' : 'stays'
  }
  visitor.state = 'awaiting_settlement'
  visitor.contractId = contractId
  visitor.expeditionId = expeditionId
  visitor.settlementId = settlementId
  visitor.outcome = outcome
}

export function isVisitorCycle(value: unknown): value is PersistedVisitorCycle {
  if (!isRecord(value)) return false
  const cycle = value as Record<string, unknown>
  if (!hasOnlyKeys(cycle, ['visitors', 'contracts', 'expeditions', 'settlements', 'recoveries'])) return false
  if (![cycle.visitors, cycle.contracts, cycle.expeditions, cycle.settlements, cycle.recoveries]
    .every((entry) => isRecord(entry))) return false
  const typed = value as unknown as PersistedVisitorCycle
  const valid = Object.entries(typed.visitors).every(([id, visitor]) => id === visitor.visitorId && isCycleVisitor(visitor))
    && Object.entries(typed.contracts).every(([id, contract]) => id === contract.contractId && isContract(contract))
    && Object.entries(typed.expeditions).every(([id, expedition]) => id === expedition.expeditionId && isExpedition(expedition))
    && Object.entries(typed.settlements).every(([id, settlement]) => id === settlement.settlementId && isSettlement(settlement))
    && Object.entries(typed.recoveries).every(([id, recovery]) => id === recovery.recoveryId && isRecovery(recovery))
    && validateCycleReferences(typed)
  return valid
}

export function applyVisitorCycleCommand(
  current: PersistedGameV3,
  command: VisitorCycleCommand,
  dependencies: PersistenceDependencies
): PersistedGameV3 {
  const game = structuredClone(current)
  const now = dependencies.now()
  switch (command.action) {
    case 'accept_contract': acceptContract(game, command, now, dependencies); break
    case 'start_expedition': startExpedition(game, command.contractId, now, dependencies); break
    case 'reconcile_game': reconcileGame(game, now, dependencies); break
    case 'confirm_settlement': confirmSettlement(game, command, now, dependencies); break
    case 'assign_recovery': assignRecovery(game, command, now, dependencies); break
    case 'abandon_recovery': abandonRecovery(game, command, now); break
  }
  return game
}

export function projectVisitorCycle(game: PersistedGameV3, now: Date): {
  visitors: VisitorView[]
  expeditions: ExpeditionView[]
  settlements: SettlementView[]
  recoveries: RecoveryView[]
  actions: ActionAvailability[]
  transitions: string[]
} {
  const cycle = game.visitorCycle
  const eligibleLoans = caravanStashItemIds(game)
  const visitors = Object.values(cycle.visitors).map<VisitorView>((visitor) => projectVisitor(visitor, cycle, eligibleLoans, now))
  const expeditions = Object.values(cycle.expeditions).map<ExpeditionView>(projectExpedition)
  const settlements = Object.values(cycle.settlements).map<SettlementView>((settlement) => projectSettlement(settlement, now))
  const recoveries = Object.values(cycle.recoveries).map<RecoveryView>((recovery) => projectRecovery(recovery, cycle, eligibleLoans, now))
  const transitions = [
    ...Object.values(cycle.expeditions).flatMap((entry) => entry.state === 'active' ? [entry.events[entry.nextEventIndex]?.occursAt].filter(Boolean) as string[] : []),
    ...Object.values(cycle.settlements).flatMap((entry) => entry.state === 'preview_ready' ? [entry.expiresAt] : []),
    ...Object.values(cycle.recoveries).flatMap((entry) => entry.state === 'open' ? [entry.expiresAt] : entry.state === 'assigned' && entry.completesAt ? [entry.completesAt] : [])
  ]
  return {
    visitors, expeditions, settlements, recoveries,
    actions: [enabledAction('reconcile_game', undefined, {})],
    transitions
  }
}

function acceptContract(
  game: PersistedGameV3,
  command: Extract<VisitorCycleCommand, { action: 'accept_contract' }>,
  now: Date,
  deps: PersistenceDependencies
): void {
  const visitor = requireVisitor(game.visitorCycle, command.visitorId)
  if (visitor.state === 'departed' || visitor.state === 'dead') throw rule('Terminal visitor cannot contract', 'TERMINAL_ENTITY')
  if (visitor.state !== 'available' || visitor.busyRecoveryId) throw rule('Visitor is not available', 'VISITOR_NOT_AVAILABLE')
  const option = visitor.contractOptions.find((entry) => entry.optionId === command.optionId)
  if (!option || now.getTime() >= Date.parse(option.expiresAt)) throw rule('Contract option is stale', 'OPTION_STALE')
  const loanItemIds = uniqueSelection(command.loanItemIds, 'loanItemIds')
  requireEligibleStashItems(game, loanItemIds)
  const contractId = `contract-${deps.uuid()}`
  const expeditionId = `expedition-${deps.uuid()}`
  visitor.state = 'negotiating'
  visitor.negotiationId = `negotiation-${deps.uuid()}`
  visitor.expiresAt = option.expiresAt
  game.visitorCycle.contracts[contractId] = {
    contractId, visitorId: visitor.visitorId, option: structuredClone(option), loanItemIds,
    acceptedAt: now.toISOString(), departureResolution: deps.random() < 0.25 ? 'departs' : 'stays', expeditionId
  }
  game.visitorCycle.expeditions[expeditionId] = {
    expeditionId, visitorId: visitor.visitorId, contractId, state: 'scheduled', startsAt: now.toISOString(),
    nextEventIndex: 0, currentHp: MAX_HP, maxHp: MAX_HP, events: [], grossGold: 0
  }
  game.expeditionsById[expeditionId] = {
    id: expeditionId, itemIds: [], projection: {
      kind: 'expedition', visitorId: visitor.visitorId, contractId, startsAt: now.toISOString()
    }
  }
  for (const itemId of loanItemIds) moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'expedition', custodyId: expeditionId })
  visitor.state = 'contracted'
  visitor.contractId = contractId
  delete visitor.negotiationId
  delete visitor.expiresAt
}

function startExpedition(game: PersistedGameV3, contractId: string, now: Date, deps: PersistenceDependencies): void {
  const contract = game.visitorCycle.contracts[contractId]
  if (!contract) throw rule('Contract is stale', 'OPTION_STALE')
  const visitor = requireVisitor(game.visitorCycle, contract.visitorId)
  const expedition = game.visitorCycle.expeditions[contract.expeditionId]
  if (visitor.state !== 'contracted' || visitor.contractId !== contractId || expedition?.state !== 'scheduled') {
    throw rule('Expedition is not ready', 'EXPEDITION_NOT_READY')
  }
  const duration = Math.max(3, contract.option.durationSeconds) * 1000
  expedition.state = 'active'
  expedition.startedAt = now.toISOString()
  expedition.events = Array.from({ length: 3 }, (_, index) => ({
    eventId: `event-${deps.uuid()}`,
    occursAt: new Date(now.getTime() + Math.floor(duration * (index + 1) / 3)).toISOString(),
    damage: Math.floor(deps.random() * 19),
    gold: 20 + Math.floor(deps.random() * 31)
  }))
  visitor.state = 'away'
  visitor.expeditionId = expedition.expeditionId
}

export function reconcileGame(game: PersistedGameV3, now: Date, deps: PersistenceDependencies): void {
  for (const visitor of Object.values(game.visitorCycle.visitors)) {
    if (visitor.state === 'available' && visitor.contractOptions.every((option) => now.getTime() >= Date.parse(option.expiresAt))) {
      visitor.contractOptions = contractOptions(visitor.visitorId, now.toISOString(), contractCount(game.visitorCycle, visitor.visitorId))
    }
  }
  for (const expedition of Object.values(game.visitorCycle.expeditions)) {
    if (expedition.state !== 'active') continue
    const contract = game.visitorCycle.contracts[expedition.contractId]
    if (!contract) throw new Error(`Missing contract ${expedition.contractId}`)
    while (expedition.state === 'active') {
      const event = expedition.events[expedition.nextEventIndex]
      if (!event || Date.parse(event.occursAt) > now.getTime()) break
      expedition.currentHp = Math.max(0, expedition.currentHp - event.damage)
      expedition.grossGold += event.gold
      expedition.nextEventIndex += 1
      if (expedition.currentHp <= 0) resolveExpedition(game, expedition, contract, 'death', event.occursAt, now, deps)
      else if (contract.option.retreatThreshold !== null && expedition.currentHp <= contract.option.retreatThreshold) {
        resolveExpedition(game, expedition, contract, 'retreated', event.occursAt, now, deps)
      } else if (expedition.nextEventIndex === expedition.events.length) {
        resolveExpedition(game, expedition, contract, 'returned', event.occursAt, now, deps)
      }
    }
  }
  for (const settlement of Object.values(game.visitorCycle.settlements)) {
    if (settlement.state === 'preview_ready' && now.getTime() >= Date.parse(settlement.expiresAt)) {
      applySettlement(game, settlement, settlement.choiceGroups.map((group) => group.defaultOptionId), 'expiry_default', now, deps)
    }
  }
  for (const recovery of Object.values(game.visitorCycle.recoveries)) {
    if (recovery.state === 'open' && now.getTime() >= Date.parse(recovery.expiresAt)) abandonRecoveryInternal(game, recovery, now)
    if (recovery.state === 'assigned' && recovery.completesAt && now.getTime() >= Date.parse(recovery.completesAt)) {
      resolveRecovery(game, recovery, now)
    }
  }
  reconcileSettlementReservations(game)
  ensureAvailableVisitors(game, now, deps)
}

function resolveExpedition(
  game: PersistedGameV3,
  expedition: PersistedCycleExpedition,
  contract: PersistedMissionContract,
  outcome: ExpeditionOutcome,
  resolvedAt: string,
  materializedAt: Date,
  deps: PersistenceDependencies
): void {
  if (expedition.state !== 'active') return
  const settlementId = `settlement-${deps.uuid()}`
  const visitor = requireVisitor(game.visitorCycle, expedition.visitorId)
  const gross = outcome === 'death' ? 0 : expedition.grossGold
  const fee = contract.loanItemIds.length * contract.option.loanFeeGold
  const caravanGold = Math.min(gross, Math.floor(gross * contract.option.caravanGoldShareBps / 10_000) + fee)
  expedition.state = 'awaiting_settlement'
  expedition.outcome = outcome
  expedition.resolvedAt = resolvedAt
  expedition.settlementId = settlementId
  visitor.state = 'awaiting_settlement'
  visitor.outcome = outcome
  visitor.settlementId = settlementId
  const settlement: PersistedCycleSettlement = {
    settlementId, expeditionId: expedition.expeditionId, state: 'preview_ready', previewVersion: 1, outcome,
    createdAt: materializedAt.toISOString(), expiresAt: new Date(materializedAt.getTime() + SETTLEMENT_TTL_MS).toISOString(),
    grossGold: gross, caravanGold, visitorGold: gross - caravanGold,
    loanItemIds: [...contract.loanItemIds], choiceGroups: [], departureSignal: visitor.departureSignal,
    rewardItemIds: [],
    departureResolution: outcome === 'death' ? 'dead' : contract.departureResolution
  }
  game.visitorCycle.settlements[settlementId] = settlement
  if (settlement.rewardItemIds.length) {
    const reservationKey = settlementReservationKey(settlementId)
    game.caravanV2.capacityReservations[reservationKey] = {
      reservationId: reservationKey, sourceKind: 'settlement', sourceId: settlementId,
      slots: settlement.rewardItemIds.length, createdAt: materializedAt.toISOString()
    }
  }
  game.settlementsById[settlementId] = {
    id: settlementId, itemIds: [], projection: { kind: 'settlement', expeditionId: expedition.expeditionId, outcome, appliedAt: resolvedAt }
  }
  retireLegacyCommission(game, visitor.visitorId, expedition.expeditionId)
}

function confirmSettlement(
  game: PersistedGameV3,
  command: Extract<VisitorCycleCommand, { action: 'confirm_settlement' }>,
  now: Date,
  deps: PersistenceDependencies
): void {
  const settlement = game.visitorCycle.settlements[command.settlementId]
  if (!settlement || settlement.state !== 'preview_ready') throw rule('Settlement was already applied', 'SETTLEMENT_PENDING')
  if (now.getTime() >= Date.parse(settlement.expiresAt)) throw rule('Settlement preview expired; reconcile first', 'OPTION_STALE')
  if (settlement.previewVersion !== command.previewVersion) throw rule('Settlement preview version is stale', 'OPTION_STALE')
  validateSettlementChoices(settlement.choiceGroups, command.selectedOptionIds)
  applySettlement(game, settlement, command.selectedOptionIds, 'confirmation', now, deps)
}

function applySettlement(
  game: PersistedGameV3,
  settlement: PersistedCycleSettlement,
  selectedOptionIds: string[],
  appliedBy: 'confirmation' | 'expiry_default',
  now: Date,
  deps: PersistenceDependencies
): void {
  if (settlement.state !== 'preview_ready') return
  const expedition = game.visitorCycle.expeditions[settlement.expeditionId]
  if (!expedition) throw new Error(`Missing expedition ${settlement.expeditionId}`)
  const visitor = requireVisitor(game.visitorCycle, expedition.visitorId)
  delete game.caravanV2.capacityReservations[settlementReservationKey(settlement.settlementId)]
  game.gold += settlement.caravanGold
  for (const itemId of settlement.rewardItemIds) {
    moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'stash' })
  }
  retireLegacyCommission(game, visitor.visitorId, expedition.expeditionId)
  let recoveryId: string | undefined
  if (settlement.outcome === 'death') {
    recoveryId = `recovery-${deps.uuid()}`
    const recovery: PersistedCycleRecovery = {
      recoveryId, sourceExpeditionId: expedition.expeditionId, itemIds: [...settlement.loanItemIds], state: 'open',
      expiresAt: new Date(now.getTime() + RECOVERY_TTL_MS).toISOString(), options: recoveryOptions(recoveryId, settlement.loanItemIds),
      supportLoanItemIds: []
    }
    game.visitorCycle.recoveries[recoveryId] = recovery
    game.recoveriesById[recoveryId] = {
      id: recoveryId, itemIds: [], projection: { kind: 'recovery', sourceExpeditionId: expedition.expeditionId, resolvedAt: now.toISOString() }
    }
    for (const itemId of settlement.loanItemIds) moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'recovery', custodyId: recoveryId })
  } else {
    for (const itemId of settlement.loanItemIds) moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'stash' })
  }
  const appliedChoices = settlement.choiceGroups.map((group) => {
    const option = group.options.find((entry) => selectedOptionIds.includes(entry.optionId))!
    return { groupId: group.groupId, optionId: option.optionId, label: structuredClone(option.label) }
  })
  settlement.state = 'settled'
  settlement.appliedAt = now.toISOString()
  settlement.appliedBy = appliedBy
  settlement.appliedChoices = appliedChoices
  expedition.state = 'settled'
  expedition.settledAt = now.toISOString()
  expedition.visitorResolution = settlement.departureResolution
  if (settlement.departureResolution === 'dead') {
    visitor.state = 'dead'
    visitor.diedAt = now.toISOString()
    visitor.recoveryId = recoveryId!
    archiveLegacyVisitor(game, visitor.visitorId, now)
  } else if (settlement.departureResolution === 'departs') {
    visitor.state = 'departed'
    visitor.departedAt = now.toISOString()
    visitor.lastExpeditionId = expedition.expeditionId
    visitor.contractOptions = []
    archiveLegacyVisitor(game, visitor.visitorId, now)
  } else {
    visitor.state = 'available'
    visitor.contractOptions = contractOptions(visitor.visitorId, now.toISOString(), contractCount(game.visitorCycle, visitor.visitorId))
  }
  delete visitor.contractId
  if (settlement.departureResolution !== 'dead') delete visitor.expeditionId
  delete visitor.settlementId
  delete visitor.outcome
}

function retireLegacyCommission(game: PersistedGameV3, visitorId: string, expeditionId: string): void {
  for (const round of [game.visitRound, ...game.visitHistory]) {
    const legacyVisitor = round.slots.find((slot) => slot.visitor?.id === visitorId)?.visitor
    if (legacyVisitor?.commission?.id !== expeditionId) continue
    legacyVisitor.state = 'traded'
    delete legacyVisitor.commission
  }
}

function ensureAvailableVisitors(game: PersistedGameV3, now: Date, deps: PersistenceDependencies): void {
  const cycle = game.visitorCycle
  const target = visitorCapacityLimit(game.caravanV2.upgrades.visitor_quarters)
  let activeCount = Object.values(cycle.visitors).filter((visitor) => visitor.state !== 'departed' && visitor.state !== 'dead').length
  while (activeCount < target) {
    let visitorId = `visitor-${deps.uuid()}`
    let suffix = 1
    while (cycle.visitors[visitorId]) visitorId = `visitor-${deps.uuid()}-${suffix++}`
    cycle.visitors[visitorId] = {
      visitorId,
      name: `Mercenario ${activeCount + 1}`,
      state: 'available',
      departureSignal: 'possible',
      contractOptions: contractOptions(visitorId, now.toISOString(), 0)
    }
    activeCount += 1
  }
}

function archiveLegacyVisitor(game: PersistedGameV3, visitorId: string, now: Date): void {
  const slot = game.visitRound.slots.find((entry) => entry.visitor?.id === visitorId)
  if (!slot?.visitor) return
  slot.visitor.state = 'departed'
  slot.visitor.departedAt = now.toISOString()
  game.visitHistory.unshift({
    id: `${game.visitRound.id}:${visitorId}`,
    number: game.visitRound.number,
    slots: game.visitRound.slots.map((entry) => entry.id === slot.id
      ? { id: entry.id, visitor: structuredClone(slot.visitor!) }
      : { id: entry.id }),
    createdAt: now.toISOString()
  })
  game.visitHistory = game.visitHistory.slice(0, 20)
  tombstoneEvictedVisitorItems(game)
  delete slot.visitor
  delete slot.nextArrivalCheckAt
}

function reconcileSettlementReservations(game: PersistedGameV3): void {
  const expected = new Map<string, number>()
  for (const settlement of Object.values(game.visitorCycle.settlements)) {
    const slots = settlement.rewardItemIds.filter((itemId) => game.itemPlacements[itemId]?.ownerKind !== 'caravan').length
    if (settlement.state === 'preview_ready' && slots) expected.set(settlement.settlementId, slots)
  }
  for (const [id, reservation] of Object.entries(game.caravanV2.capacityReservations)) {
    const settlementId = id.startsWith('settlement:') ? id.slice('settlement:'.length) : ''
    const canonicalKey = settlementReservationKey(settlementId)
    if (expected.get(settlementId) !== reservation.slots || reservation.reservationId !== canonicalKey || reservation.sourceId !== settlementId || reservation.sourceKind !== 'settlement') delete game.caravanV2.capacityReservations[id]
  }
  for (const [id, slots] of expected) {
    const key = settlementReservationKey(id)
    game.caravanV2.capacityReservations[key] = {
      reservationId: key, sourceKind: 'settlement', sourceId: id, slots, createdAt: game.visitorCycle.settlements[id]!.createdAt
    }
  }
}

function tombstoneEvictedVisitorItems(game: PersistedGameV3): void {
  const retainedVisitorIds = new Set([game.visitRound, ...game.visitHistory]
    .flatMap((round) => round.slots.flatMap((slot) => slot.visitor ? [slot.visitor.id] : [])))
  for (const [itemId, placement] of Object.entries(game.itemPlacements)) {
    if (placement.ownerKind !== 'visitor' || !placement.ownerId || retainedVisitorIds.has(placement.ownerId)) continue
    game.itemPlacements[itemId] = { ownerKind: 'tombstone', custodyKind: 'tombstone' }
  }
}

function assignRecovery(
  game: PersistedGameV3,
  command: Extract<VisitorCycleCommand, { action: 'assign_recovery' }>,
  now: Date,
  deps: PersistenceDependencies
): void {
  const recovery = game.visitorCycle.recoveries[command.recoveryId]
  if (!recovery || recovery.state !== 'open') throw rule('Recovery is not open', 'OPTION_STALE')
  if (now.getTime() >= Date.parse(recovery.expiresAt)) throw rule('Recovery expired; reconcile first', 'OPTION_STALE')
  const visitor = requireVisitor(game.visitorCycle, command.visitorId)
  if (!['available', 'negotiating'].includes(visitor.state) || visitor.busyRecoveryId) throw rule('Visitor is not available', 'VISITOR_NOT_AVAILABLE')
  if (!recovery.options.some((entry) => entry.optionId === command.optionId)) throw rule('Recovery option is stale', 'OPTION_STALE')
  const loanItemIds = uniqueSelection(command.loanItemIds, 'loanItemIds')
  requireEligibleStashItems(game, loanItemIds)
  for (const itemId of loanItemIds) moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'recovery', custodyId: recovery.recoveryId })
  recovery.state = 'assigned'
  recovery.assignedVisitorId = visitor.visitorId
  recovery.assignedAt = now.toISOString()
  recovery.completesAt = new Date(now.getTime() + RECOVERY_DURATION_MS).toISOString()
  recovery.supportLoanItemIds = loanItemIds
  recovery.succeeds = deps.random() >= 0.25
  visitor.busyRecoveryId = recovery.recoveryId
}

function abandonRecovery(
  game: PersistedGameV3,
  command: Extract<VisitorCycleCommand, { action: 'abandon_recovery' }>,
  now: Date
): void {
  const recovery = game.visitorCycle.recoveries[command.recoveryId]
  if (!recovery || recovery.state !== 'open') throw rule('Recovery is not open', 'OPTION_STALE')
  if (command.acknowledgementId !== acknowledgementId(recovery.recoveryId)) throw rule('Acknowledgement is stale', 'OPTION_STALE')
  if (now.getTime() >= Date.parse(recovery.expiresAt)) throw rule('Recovery expired; reconcile first', 'OPTION_STALE')
  abandonRecoveryInternal(game, recovery, now)
}

function abandonRecoveryInternal(game: PersistedGameV3, recovery: PersistedCycleRecovery, now: Date): void {
  if (recovery.state !== 'open') return
  for (const itemId of recovery.itemIds) moveItem(game, itemId, { ownerKind: 'tombstone', custodyKind: 'tombstone', custodyId: recovery.recoveryId })
  recovery.state = 'abandoned'
  recovery.resolvedAt = now.toISOString()
  const container = game.recoveriesById[recovery.recoveryId]
  if (container?.projection?.kind === 'recovery') container.projection.resolvedAt = now.toISOString()
}

function resolveRecovery(game: PersistedGameV3, recovery: PersistedCycleRecovery, now: Date): void {
  if (recovery.state !== 'assigned') return
  const visitor = recovery.assignedVisitorId ? game.visitorCycle.visitors[recovery.assignedVisitorId] : undefined
  if (visitor) delete visitor.busyRecoveryId
  if (recovery.succeeds) {
    for (const itemId of [...recovery.itemIds, ...recovery.supportLoanItemIds]) {
      moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'stash' })
    }
    recovery.state = 'recovered'
    recovery.recoveredItemIds = [...recovery.itemIds]
  } else {
    for (const itemId of recovery.itemIds) moveItem(game, itemId, { ownerKind: 'tombstone', custodyKind: 'tombstone', custodyId: recovery.recoveryId })
    for (const itemId of recovery.supportLoanItemIds) moveItem(game, itemId, { ownerKind: 'caravan', custodyKind: 'stash' })
    recovery.state = 'failed'
  }
  recovery.resolvedAt = now.toISOString()
}

function projectVisitor(
  visitor: PersistedCycleVisitor,
  cycle: PersistedVisitorCycle,
  eligibleLoans: string[],
  now: Date
): VisitorView {
  const base = { visitorId: visitor.visitorId, name: text(`visitor.${visitor.visitorId}`, visitor.name) }
  if (visitor.state === 'available') {
    const live = visitor.contractOptions.filter((option) => now.getTime() < Date.parse(option.expiresAt))
    const publicOptions = visitor.contractOptions.map(publicContractOption)
    const actions: ActionAvailability[] = visitor.busyRecoveryId
      ? [disabledAction(
          'accept_contract', visitor.visitorId, 'VISITOR_NOT_AVAILABLE',
          'El visitante está ocupado con una recuperación.'
        )]
      : live.length === 0
        ? [disabledAction(
            'accept_contract', visitor.visitorId, 'OPTION_STALE',
            'Los contratos vencieron. Reconciliá la partida para recibir nuevas propuestas.'
          )]
        : [{
            ...enabledAction('accept_contract', visitor.visitorId, {
              visitorId: visitor.visitorId,
              bindings: live.map((option) => ({ optionId: option.optionId, eligibleLoanItemIds: eligibleLoans, expiresAt: option.expiresAt }))
            })
          }]
    return { ...base, state: 'available', departureSignal: visitor.departureSignal, contractOptions: publicOptions, actions }
  }
  if (visitor.state === 'negotiating') return {
    ...base, state: 'negotiating', negotiationId: visitor.negotiationId!, options: visitor.contractOptions.map(publicContractOption),
    expiresAt: visitor.expiresAt!, actions: []
  }
  if (visitor.state === 'contracted') return {
    ...base, state: 'contracted', contractId: visitor.contractId!,
    actions: [enabledAction('start_expedition', visitor.visitorId, { contractId: visitor.contractId! })]
  }
  if (visitor.state === 'away') return {
    ...base, state: 'away', contractId: visitor.contractId!, expeditionId: visitor.expeditionId!, actions: []
  }
  if (visitor.state === 'awaiting_settlement') {
    const settlement = cycle.settlements[visitor.settlementId!]
    return {
      ...base, state: 'awaiting_settlement', expeditionId: visitor.expeditionId!, settlementId: visitor.settlementId!,
      outcome: visitor.outcome!, actions: settlement && now.getTime() < Date.parse(settlement.expiresAt)
        ? [confirmAction(settlement, visitor.visitorId)] : []
    }
  }
  if (visitor.state === 'departed') return {
    ...base, state: 'departed', departedAt: visitor.departedAt!, lastExpeditionId: visitor.lastExpeditionId!, actions: []
  }
  return {
    ...base, state: 'dead', diedAt: visitor.diedAt!, expeditionId: visitor.expeditionId!, recoveryId: visitor.recoveryId!, actions: []
  }
}

function projectExpedition(expedition: PersistedCycleExpedition): ExpeditionView {
  const base = {
    expeditionId: expedition.expeditionId, visitorId: expedition.visitorId,
    contractId: expedition.contractId, actions: []
  }
  if (expedition.state === 'scheduled') return { ...base, state: 'scheduled', startsAt: expedition.startsAt }
  if (expedition.state === 'active') return {
    ...base, state: 'active', startedAt: expedition.startedAt!,
    nextEventAt: expedition.events[expedition.nextEventIndex]!.occursAt,
    currentHp: expedition.currentHp, maxHp: expedition.maxHp
  }
  if (expedition.state === 'awaiting_settlement') return {
    ...base, state: 'awaiting_settlement', outcome: expedition.outcome!, resolvedAt: expedition.resolvedAt!, settlementId: expedition.settlementId!
  }
  return {
    ...base, state: 'settled', outcome: expedition.outcome!, settledAt: expedition.settledAt!,
    settlementId: expedition.settlementId!, visitorResolution: expedition.visitorResolution!
  }
}

function projectSettlement(settlement: PersistedCycleSettlement, now: Date): SettlementView {
  if (settlement.state === 'settled') return {
    settlementId: settlement.settlementId, expeditionId: settlement.expeditionId, state: 'settled', outcome: settlement.outcome,
    appliedAt: settlement.appliedAt!, appliedBy: settlement.appliedBy!, appliedChoices: settlement.appliedChoices!,
    visitorResolution: settlement.departureResolution, actions: []
  }
  const base = {
    settlementId: settlement.settlementId, expeditionId: settlement.expeditionId,
    previewVersion: settlement.previewVersion, outcome: settlement.outcome, createdAt: settlement.createdAt,
    expiresAt: settlement.expiresAt,
    gold: { gross: settlement.grossGold, caravan: settlement.caravanGold, visitor: settlement.visitorGold },
    loans: settlement.loanItemIds.map((itemId) => ({ itemId, resolution: settlement.outcome === 'death' ? 'recovery' as const : 'return' as const })),
    choiceGroups: settlement.choiceGroups, departureSignal: settlement.departureSignal,
    departureResolution: settlement.departureResolution
  }
  if (now.getTime() >= Date.parse(settlement.expiresAt)) return { ...base, state: 'preview_expired', actions: [] }
  return { ...base, state: 'preview_ready', actions: [confirmAction(settlement, settlement.settlementId)] }
}

function projectRecovery(
  recovery: PersistedCycleRecovery,
  cycle: PersistedVisitorCycle,
  eligibleLoans: string[],
  now: Date
): RecoveryView {
  const base = { recoveryId: recovery.recoveryId, sourceExpeditionId: recovery.sourceExpeditionId, itemIds: recovery.itemIds }
  if (recovery.state === 'open') {
    const live = now.getTime() < Date.parse(recovery.expiresAt)
    const visitors = Object.values(cycle.visitors).filter((visitor) => ['available', 'negotiating'].includes(visitor.state) && !visitor.busyRecoveryId)
    return {
      ...base, state: 'open', expiresAt: recovery.expiresAt, options: recovery.options,
      actions: live ? [
        enabledAction('assign_recovery', recovery.recoveryId, {
          recoveryId: recovery.recoveryId,
          bindings: visitors.flatMap((visitor) => recovery.options.map((option) => ({
            optionId: option.optionId, visitorId: visitor.visitorId, eligibleLoanItemIds: eligibleLoans, expiresAt: recovery.expiresAt
          })))
        }),
        enabledAction('abandon_recovery', recovery.recoveryId, {
          recoveryId: recovery.recoveryId,
          acknowledgement: {
            acknowledgementId: acknowledgementId(recovery.recoveryId), expiresAt: recovery.expiresAt,
            text: text('recovery.abandon.ack', 'Entiendo que los objetos se perderán')
          }
        }, [{ kind: 'fail_recovery', irreversible: true, recoveryId: recovery.recoveryId, destroyedItemIds: recovery.itemIds, text: text('recovery.abandon', 'Los objetos prestados se perderán') }])
      ] : []
    }
  }
  if (recovery.state === 'assigned') return {
    ...base, state: 'assigned', assignedVisitorId: recovery.assignedVisitorId!, assignedAt: recovery.assignedAt!, completesAt: recovery.completesAt!, actions: []
  }
  if (recovery.state === 'recovered') return {
    ...base, state: 'recovered', resolvedAt: recovery.resolvedAt!, recoveredItemIds: recovery.recoveredItemIds!, actions: []
  }
  const consequence = {
    kind: 'fail_recovery' as const, irreversible: true as const, recoveryId: recovery.recoveryId, destroyedItemIds: recovery.itemIds,
    text: text(`recovery.${recovery.state}`, recovery.state === 'failed' ? 'La recuperación falló' : 'La recuperación fue abandonada')
  }
  return { ...base, state: recovery.state, resolvedAt: recovery.resolvedAt!, consequence, actions: [] }
}

function confirmAction(settlement: PersistedCycleSettlement, targetId: string): ActionAvailability {
  return enabledAction('confirm_settlement', targetId, {
    settlementId: settlement.settlementId, previewVersion: settlement.previewVersion, expiresAt: settlement.expiresAt,
    groups: settlement.choiceGroups.map((group) => ({ groupId: group.groupId, eligibleOptionIds: group.options.map((option) => option.optionId) }))
  })
}

function enabledAction(
  action: ActionAvailability['action'],
  targetId: string | undefined,
  execution: Record<string, unknown>,
  consequences: ActionAvailability['consequences'] = []
): ActionAvailability {
  return {
    authorizationId: `auth-${action}-${targetId ?? 'game'}`, action, enabled: true,
    label: text(`action.${action}`, action.replaceAll('_', ' ')), consequences,
    ...(targetId ? { targetId } : {}), execution
  } as ActionAvailability
}

function disabledAction(
  action: ActionAvailability['action'],
  targetId: string,
  reason: UnavailableReason,
  fallback: string
): ActionAvailability {
  return {
    authorizationId: `auth-${action}-${targetId}`,
    action,
    targetId,
    enabled: false,
    label: text(`action.${action}`, action.replaceAll('_', ' ')),
    reason,
    reasonText: text(`unavailable.${reason.toLowerCase()}`, fallback),
    consequences: []
  }
}

function contractOptions(visitorId: string, from: string, sequence: number): PersistedContractOption[] {
  const expiresAt = new Date(Date.parse(from) + CONTRACT_TTL_MS).toISOString()
  return [
    {
      optionId: sealedOptionId(visitorId, String(sequence), 'standard'), label: text('contract.standard', 'Contrato estándar'),
      description: text('contract.standard.description', 'Reparto equilibrado con retirada segura'),
      durationSeconds: 90, caravanGoldShareBps: 2500, lootPriority: 'caravan_first', retreatThreshold: 10,
      loanFeeGold: 2, consequences: [], expiresAt
    },
    {
      optionId: sealedOptionId(visitorId, String(sequence), 'bold'), label: text('contract.bold', 'Contrato arriesgado'),
      description: text('contract.bold.description', 'Más exposición y sin retirada por vida'),
      durationSeconds: 150, caravanGoldShareBps: 2500, lootPriority: 'visitor_first', retreatThreshold: null,
      loanFeeGold: 3, consequences: [], expiresAt
    }
  ]
}

function contractCount(cycle: PersistedVisitorCycle, visitorId: string): number {
  return Object.values(cycle.contracts).filter((contract) => contract.visitorId === visitorId).length
}

function sealedOptionId(visitorId: string, generation: string, variant: string): string {
  const digest = createHash('sha256').update(`${visitorId}\0${generation}\0${variant}`).digest('hex').slice(0, 24)
  return `contract-option-${digest}-${variant}`
}

function publicContractOption(option: PersistedContractOption): ContractOptionView {
  const { expiresAt: _expiresAt, ...publicOption } = option
  return publicOption
}

function recoveryOptions(recoveryId: string, itemIds: string[]): RecoveryOptionView[] {
  return [{
    optionId: `${recoveryId}:cautious`, label: text('recovery.cautious', 'Recuperación cautelosa'),
    description: text('recovery.cautious.description', 'Intentar recuperar los préstamos perdidos'),
    durationSeconds: RECOVERY_DURATION_MS / 1000,
    consequences: [{ kind: 'fail_recovery', irreversible: true, recoveryId, destroyedItemIds: [...itemIds], text: text('recovery.risk', 'El intento puede fracasar') }]
  }]
}

function validateSettlementChoices(groups: ChoiceGroup[], selected: string[]): void {
  if (new Set(selected).size !== selected.length || selected.length !== groups.length) throw rule('Settlement selection is incomplete', 'OPTION_STALE')
  for (const group of groups) {
    if (group.options.filter((option) => selected.includes(option.optionId)).length !== 1) throw rule('Settlement selection is invalid', 'OPTION_STALE')
  }
}

function moveItem(game: PersistedGameV3, itemId: string, placement: PersistedGameV3['itemPlacements'][string]): void {
  if (!game.itemsById[itemId] || !game.itemPlacements[itemId]) throw rule('Item does not exist', 'ITEM_NOT_OWNED')
  game.stash = game.stash.filter((candidate) => candidate !== itemId)
  for (const containers of [game.expeditionsById, game.settlementsById, game.recoveriesById, game.serviceJobsById]) {
    for (const container of Object.values(containers)) container.itemIds = container.itemIds.filter((candidate) => candidate !== itemId)
  }
  game.itemPlacements[itemId] = placement
  if (placement.ownerKind === 'caravan' && placement.custodyKind === 'stash') game.stash.push(itemId)
  const maps = {
    expedition: game.expeditionsById, settlement: game.settlementsById,
    recovery: game.recoveriesById, service: game.serviceJobsById
  }
  if (placement.custodyKind in maps) maps[placement.custodyKind as keyof typeof maps][placement.custodyId!]!.itemIds.push(itemId)
}

function requireEligibleStashItems(game: PersistedGameV3, itemIds: string[]): void {
  for (const itemId of itemIds) {
    const placement = game.itemPlacements[itemId]
    if (!placement || placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') {
      throw rule('Loan item is not eligible', placement?.ownerKind === 'caravan' ? 'ITEM_IN_USE' : 'ITEM_NOT_OWNED')
    }
  }
}

function caravanStashItemIds(game: PersistedGameV3): string[] {
  return Object.entries(game.itemPlacements)
    .filter(([, placement]) => placement.ownerKind === 'caravan' && placement.custodyKind === 'stash')
    .map(([itemId]) => itemId)
}

function uniqueSelection(values: string[], field: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value) || new Set(values).size !== values.length) {
    throw rule(`${field} is invalid`, 'OPTION_STALE')
  }
  return [...values]
}

function requireVisitor(cycle: PersistedVisitorCycle, visitorId: string): PersistedCycleVisitor {
  const visitor = cycle.visitors[visitorId]
  if (!visitor) throw rule('Visitor does not exist', 'VISITOR_NOT_AVAILABLE')
  return visitor
}

function acknowledgementId(recoveryId: string): string {
  return `${recoveryId}:abandon`
}

function text(key: string, fallback: string): { key: string; fallback: string } {
  return { key, fallback }
}

function rule(message: string, reason?: ConstructorParameters<typeof V2DomainRuleError>[1]): VisitorCycleError {
  return new VisitorCycleError(message, reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isCycleVisitor(value: unknown): value is PersistedCycleVisitor {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'visitorId', 'name', 'state', 'departureSignal', 'contractOptions', 'negotiationId', 'expiresAt',
    'contractId', 'expeditionId', 'settlementId', 'outcome', 'departedAt', 'diedAt', 'recoveryId',
    'lastExpeditionId', 'busyRecoveryId'
  ])) return false
  if (!isId(value.visitorId) || !isId(value.name)
    || !['available', 'negotiating', 'contracted', 'away', 'awaiting_settlement', 'departed', 'dead'].includes(String(value.state))
    || !['unlikely', 'possible', 'likely'].includes(String(value.departureSignal))
    || !Array.isArray(value.contractOptions) || !value.contractOptions.every(isContractOption)) return false
  if (value.busyRecoveryId !== undefined && !isId(value.busyRecoveryId)) return false
  const common = ['visitorId', 'name', 'state', 'departureSignal', 'contractOptions', 'busyRecoveryId']
  switch (value.state) {
    case 'available': return hasOnlyKeys(value, common)
    case 'negotiating': return hasOnlyKeys(value, [...common, 'negotiationId', 'expiresAt'])
      && isId(value.negotiationId) && isUtc(value.expiresAt)
    case 'contracted': return hasOnlyKeys(value, [...common, 'contractId']) && isId(value.contractId)
    case 'away': return hasOnlyKeys(value, [...common, 'contractId', 'expeditionId'])
      && isId(value.contractId) && isId(value.expeditionId)
    case 'awaiting_settlement': return hasOnlyKeys(value, [...common, 'contractId', 'expeditionId', 'settlementId', 'outcome'])
      && isId(value.contractId) && isId(value.expeditionId) && isId(value.settlementId) && isOutcome(value.outcome)
    case 'departed': return hasOnlyKeys(value, [...common, 'departedAt', 'lastExpeditionId'])
      && isUtc(value.departedAt) && isId(value.lastExpeditionId) && value.contractOptions.length === 0
    case 'dead': return hasOnlyKeys(value, [...common, 'diedAt', 'expeditionId', 'recoveryId'])
      && isUtc(value.diedAt) && isId(value.expeditionId) && isId(value.recoveryId)
    default: return false
  }
}

function isContract(value: unknown): value is PersistedMissionContract {
  return isRecord(value) && hasOnlyKeys(value, [
    'contractId', 'visitorId', 'option', 'loanItemIds', 'acceptedAt', 'departureResolution', 'expeditionId'
  ]) && [value.contractId, value.visitorId, value.expeditionId].every(isId) && isUtc(value.acceptedAt)
    && isContractOption(value.option) && isStringArray(value.loanItemIds)
    && ['stays', 'departs'].includes(String(value.departureResolution))
}

function isExpedition(value: unknown): value is PersistedCycleExpedition {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'expeditionId', 'visitorId', 'contractId', 'state', 'startsAt', 'startedAt', 'nextEventIndex',
    'currentHp', 'maxHp', 'events', 'grossGold', 'outcome', 'resolvedAt', 'settlementId', 'settledAt',
    'visitorResolution'
  ])) return false
  if (![value.expeditionId, value.visitorId, value.contractId].every(isId) || !isUtc(value.startsAt)
    || !['scheduled', 'active', 'awaiting_settlement', 'settled'].includes(String(value.state))
    || !isNonNegativeInteger(value.nextEventIndex) || !isNonNegativeInteger(value.currentHp)
    || !isPositiveInteger(value.maxHp) || Number(value.currentHp) > Number(value.maxHp)
    || !Array.isArray(value.events) || !value.events.every(isExpeditionEvent)
    || Number(value.nextEventIndex) > value.events.length || !isNonNegativeInteger(value.grossGold)) return false
  if (!value.events.every((event, index, events) => index === 0 || Date.parse(events[index - 1]!.occursAt) < Date.parse(event.occursAt))) return false
  const common = [
    'expeditionId', 'visitorId', 'contractId', 'state', 'startsAt', 'nextEventIndex',
    'currentHp', 'maxHp', 'events', 'grossGold'
  ]
  if (value.state === 'scheduled') return hasOnlyKeys(value, common) && value.events.length === 0 && value.nextEventIndex === 0
  if (!isUtc(value.startedAt) || value.events.length === 0) return false
  if (value.state === 'active') return hasOnlyKeys(value, [...common, 'startedAt']) && Number(value.nextEventIndex) < value.events.length
  if (!isOutcome(value.outcome) || !isUtc(value.resolvedAt) || !isId(value.settlementId)) return false
  if (value.state === 'awaiting_settlement') {
    return hasOnlyKeys(value, [...common, 'startedAt', 'outcome', 'resolvedAt', 'settlementId'])
  }
  return hasOnlyKeys(value, [...common, 'startedAt', 'outcome', 'resolvedAt', 'settlementId', 'settledAt', 'visitorResolution'])
    && isUtc(value.settledAt) && ['stays', 'departs', 'dead'].includes(String(value.visitorResolution))
}

function isSettlement(value: unknown): value is PersistedCycleSettlement {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'settlementId', 'expeditionId', 'state', 'previewVersion', 'outcome', 'createdAt', 'expiresAt',
    'grossGold', 'caravanGold', 'visitorGold', 'loanItemIds', 'rewardItemIds', 'choiceGroups', 'departureSignal',
    'departureResolution', 'appliedAt', 'appliedBy', 'appliedChoices'
  ])) return false
  if (![value.settlementId, value.expeditionId].every(isId) || !isUtc(value.createdAt) || !isUtc(value.expiresAt)
    || !['preview_ready', 'settled'].includes(String(value.state)) || !isPositiveInteger(value.previewVersion)
    || !isOutcome(value.outcome) || !isNonNegativeInteger(value.grossGold) || !isNonNegativeInteger(value.caravanGold)
    || !isNonNegativeInteger(value.visitorGold) || Number(value.caravanGold) + Number(value.visitorGold) !== Number(value.grossGold)
    || !isStringArray(value.loanItemIds) || !isStringArray(value.rewardItemIds)
    || !Array.isArray(value.choiceGroups) || !value.choiceGroups.every(isChoiceGroup)
    || !['unlikely', 'possible', 'likely'].includes(String(value.departureSignal))
    || !['stays', 'departs', 'dead'].includes(String(value.departureResolution))) return false
  if (value.state === 'preview_ready') return value.appliedAt === undefined && value.appliedBy === undefined && value.appliedChoices === undefined
  return isUtc(value.appliedAt) && ['confirmation', 'expiry_default'].includes(String(value.appliedBy))
    && Array.isArray(value.appliedChoices) && value.appliedChoices.every(isAppliedChoice)
}

function isRecovery(value: unknown): value is PersistedCycleRecovery {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'recoveryId', 'sourceExpeditionId', 'itemIds', 'state', 'expiresAt', 'options', 'assignedVisitorId',
    'assignedAt', 'completesAt', 'supportLoanItemIds', 'succeeds', 'resolvedAt', 'recoveredItemIds'
  ])) return false
  if (![value.recoveryId, value.sourceExpeditionId].every(isId) || !isUtc(value.expiresAt)
    || !['open', 'assigned', 'recovered', 'failed', 'abandoned'].includes(String(value.state))
    || !isStringArray(value.itemIds) || !Array.isArray(value.options) || !value.options.every(isRecoveryOption)
    || !isStringArray(value.supportLoanItemIds)) return false
  const common = ['recoveryId', 'sourceExpeditionId', 'itemIds', 'state', 'expiresAt', 'options', 'supportLoanItemIds']
  if (value.state === 'open') return hasOnlyKeys(value, common)
  const assigned = [...common, 'assignedVisitorId', 'assignedAt', 'completesAt', 'succeeds']
  if (value.state === 'assigned') return hasOnlyKeys(value, assigned) && isId(value.assignedVisitorId) && isUtc(value.assignedAt)
    && isUtc(value.completesAt) && typeof value.succeeds === 'boolean' && value.resolvedAt === undefined
  if (!isUtc(value.resolvedAt)) return false
  if (value.state === 'abandoned') return hasOnlyKeys(value, [...common, 'resolvedAt'])
  if (!hasOnlyKeys(value, [...assigned, 'resolvedAt', ...(value.state === 'recovered' ? ['recoveredItemIds'] : [])])) return false
  return value.state !== 'recovered' || (isStringArray(value.recoveredItemIds) && sameIds(value.recoveredItemIds, value.itemIds as string[]))
}

function isContractOption(value: unknown): value is PersistedContractOption {
  return isRecord(value) && hasOnlyKeys(value, [
    'optionId', 'label', 'description', 'durationSeconds', 'caravanGoldShareBps', 'lootPriority',
    'retreatThreshold', 'loanFeeGold', 'consequences', 'expiresAt'
  ]) && isId(value.optionId) && isLocalizedText(value.label) && isLocalizedText(value.description)
    && isPositiveInteger(value.durationSeconds) && isNonNegativeInteger(value.caravanGoldShareBps)
    && Number(value.caravanGoldShareBps) <= 10_000 && ['caravan_first', 'visitor_first'].includes(String(value.lootPriority))
    && (value.retreatThreshold === null || isNonNegativeInteger(value.retreatThreshold))
    && isNonNegativeInteger(value.loanFeeGold) && Array.isArray(value.consequences)
    && value.consequences.every(isConsequence) && isUtc(value.expiresAt)
}

function isRecoveryOption(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['optionId', 'label', 'description', 'durationSeconds', 'consequences'])
    && isId(value.optionId) && isLocalizedText(value.label) && isLocalizedText(value.description)
    && isPositiveInteger(value.durationSeconds) && Array.isArray(value.consequences) && value.consequences.every(isConsequence)
}

function isExpeditionEvent(value: unknown): value is PersistedExpeditionEvent {
  return isRecord(value) && hasOnlyKeys(value, ['eventId', 'occursAt', 'damage', 'gold'])
    && isId(value.eventId) && isUtc(value.occursAt) && isNonNegativeInteger(value.damage) && isNonNegativeInteger(value.gold)
}

function isChoiceGroup(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['groupId', 'required', 'defaultOptionId', 'label', 'options'])
    && isId(value.groupId) && value.required === true && isId(value.defaultOptionId) && isLocalizedText(value.label)
    && Array.isArray(value.options) && value.options.length > 0 && value.options.every(isChoiceOption)
    && uniqueBy(value.options, 'optionId') && value.options.some((option) => isRecord(option) && option.optionId === value.defaultOptionId)
}

function isChoiceOption(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['optionId', 'label', 'itemIds', 'capacityDelta', 'consequences'])
    && isId(value.optionId) && isLocalizedText(value.label) && isStringArray(value.itemIds)
    && Number.isInteger(value.capacityDelta) && Array.isArray(value.consequences) && value.consequences.every(isConsequence)
}

function isAppliedChoice(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['groupId', 'optionId', 'label'])
    && isId(value.groupId) && isId(value.optionId) && isLocalizedText(value.label)
}

function isConsequence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string' || value.irreversible !== true || !isLocalizedText(value.text)) return false
  const keysByKind: Record<string, string[]> = {
    lose_items: ['kind', 'irreversible', 'itemIds', 'text'],
    destroy_items: ['kind', 'irreversible', 'itemIds', 'text'],
    transfer_items: ['kind', 'irreversible', 'itemIds', 'newOwner', 'text'],
    spend_resource: ['kind', 'irreversible', 'resourceId', 'amount', 'text'],
    renounce_reward: ['kind', 'irreversible', 'rewardItemIds', 'text'],
    replace_imprint: ['kind', 'irreversible', 'itemId', 'replacedImprint', 'text'],
    depart_visitor: ['kind', 'irreversible', 'visitorId', 'text'],
    fail_recovery: ['kind', 'irreversible', 'recoveryId', 'destroyedItemIds', 'text']
  }
  const allowed = keysByKind[value.kind]
  if (!allowed || !hasOnlyKeys(value, allowed)) return false
  if (value.kind === 'lose_items' || value.kind === 'destroy_items') return isStringArray(value.itemIds)
  if (value.kind === 'renounce_reward') return isStringArray(value.rewardItemIds)
  if (value.kind === 'fail_recovery') return isId(value.recoveryId) && isStringArray(value.destroyedItemIds)
  if (value.kind === 'transfer_items') return isStringArray(value.itemIds) && isItemOwner(value.newOwner)
  if (value.kind === 'spend_resource') return isId(value.resourceId) && isPositiveInteger(value.amount)
  if (value.kind === 'replace_imprint') return isId(value.itemId) && isLocalizedText(value.replacedImprint)
  return isId(value.visitorId)
}

function isItemOwner(value: unknown): boolean {
  return isRecord(value) && ((value.kind === 'caravan' && hasOnlyKeys(value, ['kind']))
    || (value.kind === 'visitor' && hasOnlyKeys(value, ['kind', 'visitorId']) && isId(value.visitorId)))
}

function isLocalizedText(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['key', 'fallback']) && isId(value.key) && isId(value.fallback)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isUtc(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isId) && new Set(value).size === value.length
}

function isOutcome(value: unknown): value is ExpeditionOutcome {
  return ['returned', 'retreated', 'death'].includes(String(value))
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id))
}

function uniqueBy(values: unknown[], key: string): boolean {
  const ids = values.map((value) => isRecord(value) ? value[key] : undefined)
  return ids.every(isId) && new Set(ids).size === ids.length
}

function validateCycleReferences(cycle: PersistedVisitorCycle): boolean {
  return Object.values(cycle.visitors).every((visitor) => {
    if (!uniqueBy(visitor.contractOptions, 'optionId')) return false
    if (visitor.busyRecoveryId) {
      const recovery = cycle.recoveries[visitor.busyRecoveryId]
      if (!recovery || recovery.state !== 'assigned' || recovery.assignedVisitorId !== visitor.visitorId) return false
    }
    if (visitor.state === 'contracted') return cycle.contracts[visitor.contractId!]?.visitorId === visitor.visitorId
    if (visitor.state === 'away') return cycle.expeditions[visitor.expeditionId!]?.visitorId === visitor.visitorId
    if (visitor.state === 'awaiting_settlement') {
      return cycle.expeditions[visitor.expeditionId!]?.visitorId === visitor.visitorId
        && cycle.settlements[visitor.settlementId!]?.expeditionId === visitor.expeditionId
    }
    if (visitor.state === 'dead') return cycle.recoveries[visitor.recoveryId!]?.sourceExpeditionId === visitor.expeditionId
    if (visitor.state === 'departed') return isId(visitor.lastExpeditionId)
    return true
  }) && Object.values(cycle.contracts).every((contract) => cycle.visitors[contract.visitorId]
    && cycle.expeditions[contract.expeditionId]?.contractId === contract.contractId)
    && Object.values(cycle.expeditions).every((expedition) => cycle.visitors[expedition.visitorId]
      && cycle.contracts[expedition.contractId]?.expeditionId === expedition.expeditionId
      && (expedition.settlementId === undefined || cycle.settlements[expedition.settlementId]?.expeditionId === expedition.expeditionId))
    && Object.values(cycle.settlements).every((settlement) => cycle.expeditions[settlement.expeditionId]?.settlementId === settlement.settlementId
      && uniqueBy(settlement.choiceGroups, 'groupId'))
    && Object.values(cycle.recoveries).every((recovery) => cycle.expeditions[recovery.sourceExpeditionId]
      && uniqueBy(recovery.options, 'optionId')
      && (recovery.state !== 'assigned' || cycle.visitors[recovery.assignedVisitorId!]?.busyRecoveryId === recovery.recoveryId))
}

export function ownedCycleItems(game: PersistedGameV3): Item[] {
  return Object.entries(game.itemPlacements)
    .filter(([, placement]) => placement.ownerKind !== 'tombstone')
    .flatMap(([itemId]) => game.itemsById[itemId] ? [game.itemsById[itemId]!] : [])
}
