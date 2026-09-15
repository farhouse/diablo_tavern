import type { Item } from '~/types/game'
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
  VisitorView
} from '~/shared/types/v2-game-view'
import { V2DomainRuleError } from '~/shared/errors/v2-domain'
import type { PersistenceDependencies, PersistedGameV3 } from '~/server/utils/savegame'

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
  const visitors: Record<string, PersistedCycleVisitor> = {}
  for (const round of [game.visitRound, ...game.visitHistory]) {
    for (const slot of round.slots) {
      const source = slot.visitor
      if (!source || visitors[source.id]) continue
      const departed = source.state === 'departed'
      visitors[source.id] = {
        visitorId: source.id,
        name: source.name,
        state: departed ? 'departed' : 'available',
        departureSignal: 'possible',
        contractOptions: departed ? [] : contractOptions(source.id, game.createdAt),
        ...(departed ? {
          departedAt: source.departedAt ?? game.createdAt,
          lastExpeditionId: source.commission?.id ?? `legacy-${source.id}`
        } : {})
      }
    }
  }
  return { visitors, contracts: {}, expeditions: {}, settlements: {}, recoveries: {} }
}

export function isVisitorCycle(value: unknown): value is PersistedVisitorCycle {
  if (!isRecord(value)) return false
  const cycle = value as Record<string, unknown>
  if (!hasOnlyKeys(cycle, ['visitors', 'contracts', 'expeditions', 'settlements', 'recoveries'])) return false
  if (![cycle.visitors, cycle.contracts, cycle.expeditions, cycle.settlements, cycle.recoveries]
    .every((entry) => isRecord(entry))) return false
  const typed = value as unknown as PersistedVisitorCycle
  return Object.entries(typed.visitors).every(([id, visitor]) => id === visitor.visitorId && isCycleVisitor(visitor))
    && Object.entries(typed.contracts).every(([id, contract]) => id === contract.contractId && isContract(contract))
    && Object.entries(typed.expeditions).every(([id, expedition]) => id === expedition.expeditionId && isExpedition(expedition))
    && Object.entries(typed.settlements).every(([id, settlement]) => id === settlement.settlementId && isSettlement(settlement))
    && Object.entries(typed.recoveries).every(([id, recovery]) => id === recovery.recoveryId && isRecovery(recovery))
    && validateCycleReferences(typed)
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
      visitor.contractOptions = contractOptions(visitor.visitorId, now.toISOString())
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
      if (expedition.currentHp <= 0) resolveExpedition(game, expedition, contract, 'death', event.occursAt, deps)
      else if (contract.option.retreatThreshold !== null && expedition.currentHp <= contract.option.retreatThreshold) {
        resolveExpedition(game, expedition, contract, 'retreated', event.occursAt, deps)
      } else if (expedition.nextEventIndex === expedition.events.length) {
        resolveExpedition(game, expedition, contract, 'returned', event.occursAt, deps)
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
}

function resolveExpedition(
  game: PersistedGameV3,
  expedition: PersistedCycleExpedition,
  contract: PersistedMissionContract,
  outcome: ExpeditionOutcome,
  resolvedAt: string,
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
    createdAt: resolvedAt, expiresAt: new Date(Date.parse(resolvedAt) + SETTLEMENT_TTL_MS).toISOString(),
    grossGold: gross, caravanGold, visitorGold: gross - caravanGold,
    loanItemIds: [...contract.loanItemIds], choiceGroups: [], departureSignal: visitor.departureSignal,
    departureResolution: outcome === 'death' ? 'dead' : contract.departureResolution
  }
  game.visitorCycle.settlements[settlementId] = settlement
  game.settlementsById[settlementId] = {
    id: settlementId, itemIds: [], projection: { kind: 'settlement', expeditionId: expedition.expeditionId, outcome, appliedAt: resolvedAt }
  }
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
  game.gold += settlement.caravanGold
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
  } else if (settlement.departureResolution === 'departs') {
    visitor.state = 'departed'
    visitor.departedAt = now.toISOString()
    visitor.lastExpeditionId = expedition.expeditionId
    visitor.contractOptions = []
  } else {
    visitor.state = 'available'
    visitor.contractOptions = contractOptions(visitor.visitorId, now.toISOString())
  }
  delete visitor.contractId
  if (settlement.departureResolution !== 'dead') delete visitor.expeditionId
  delete visitor.settlementId
  delete visitor.outcome
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
    const actions: ActionAvailability[] = visitor.busyRecoveryId || live.length === 0 ? [] : [{
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

function contractOptions(visitorId: string, from: string): PersistedContractOption[] {
  const expiresAt = new Date(Date.parse(from) + CONTRACT_TTL_MS).toISOString()
  return [
    {
      optionId: `${visitorId}:standard`, label: text('contract.standard', 'Contrato estándar'),
      description: text('contract.standard.description', 'Reparto equilibrado con retirada segura'),
      durationSeconds: 90, caravanGoldShareBps: 2500, lootPriority: 'caravan_first', retreatThreshold: 10,
      loanFeeGold: 2, consequences: [], expiresAt
    },
    {
      optionId: `${visitorId}:bold`, label: text('contract.bold', 'Contrato arriesgado'),
      description: text('contract.bold.description', 'Más exposición y sin retirada por vida'),
      durationSeconds: 150, caravanGoldShareBps: 2500, lootPriority: 'visitor_first', retreatThreshold: null,
      loanFeeGold: 3, consequences: [], expiresAt
    }
  ]
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
  return isRecord(value) && typeof value.visitorId === 'string' && typeof value.name === 'string'
    && ['available', 'negotiating', 'contracted', 'away', 'awaiting_settlement', 'departed', 'dead'].includes(String(value.state))
    && ['unlikely', 'possible', 'likely'].includes(String(value.departureSignal)) && Array.isArray(value.contractOptions)
}

function isContract(value: unknown): value is PersistedMissionContract {
  return isRecord(value) && ['contractId', 'visitorId', 'expeditionId', 'acceptedAt'].every((key) => typeof value[key] === 'string')
    && isRecord(value.option) && Array.isArray(value.loanItemIds) && ['stays', 'departs'].includes(String(value.departureResolution))
}

function isExpedition(value: unknown): value is PersistedCycleExpedition {
  return isRecord(value) && ['expeditionId', 'visitorId', 'contractId', 'startsAt'].every((key) => typeof value[key] === 'string')
    && ['scheduled', 'active', 'awaiting_settlement', 'settled'].includes(String(value.state))
    && Number.isInteger(value.nextEventIndex) && typeof value.currentHp === 'number' && typeof value.maxHp === 'number'
    && Array.isArray(value.events) && typeof value.grossGold === 'number'
}

function isSettlement(value: unknown): value is PersistedCycleSettlement {
  return isRecord(value) && ['settlementId', 'expeditionId', 'createdAt', 'expiresAt'].every((key) => typeof value[key] === 'string')
    && ['preview_ready', 'settled'].includes(String(value.state)) && Number.isInteger(value.previewVersion)
    && ['returned', 'retreated', 'death'].includes(String(value.outcome)) && Array.isArray(value.loanItemIds)
    && Array.isArray(value.choiceGroups)
}

function isRecovery(value: unknown): value is PersistedCycleRecovery {
  return isRecord(value) && ['recoveryId', 'sourceExpeditionId', 'expiresAt'].every((key) => typeof value[key] === 'string')
    && ['open', 'assigned', 'recovered', 'failed', 'abandoned'].includes(String(value.state))
    && Array.isArray(value.itemIds) && Array.isArray(value.options) && Array.isArray(value.supportLoanItemIds)
}

function validateCycleReferences(cycle: PersistedVisitorCycle): boolean {
  return Object.values(cycle.contracts).every((contract) => cycle.visitors[contract.visitorId]
    && cycle.expeditions[contract.expeditionId]?.contractId === contract.contractId)
    && Object.values(cycle.expeditions).every((expedition) => cycle.visitors[expedition.visitorId] && cycle.contracts[expedition.contractId])
    && Object.values(cycle.settlements).every((settlement) => cycle.expeditions[settlement.expeditionId])
    && Object.values(cycle.recoveries).every((recovery) => cycle.expeditions[recovery.sourceExpeditionId])
}

export function ownedCycleItems(game: PersistedGameV3): Item[] {
  return Object.entries(game.itemPlacements)
    .filter(([, placement]) => placement.ownerKind !== 'tombstone')
    .flatMap(([itemId]) => game.itemsById[itemId] ? [game.itemsById[itemId]!] : [])
}
