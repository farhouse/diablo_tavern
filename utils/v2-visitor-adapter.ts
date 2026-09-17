import type {
  AbandonRecoveryAction,
  AcceptContractAction,
  ActionAvailability,
  AssignRecoveryAction,
  ConfirmSettlementAction,
  GameView,
  Id,
  ReconcileGameAction,
  RecoveryView,
  SettlementView,
  StartExpeditionAction,
  VisitorView
} from '~/shared/types/v2-game-view'

export type VisitorV2Selection =
  | { kind: 'contract'; visitorId: Id; optionId: Id; loanItemIds: Id[] }
  | { kind: 'settlement'; settlementId: Id; selectedOptionIds: Record<Id, Id> }
  | { kind: 'recovery'; recoveryId: Id; visitorId: Id; optionId: Id; loanItemIds: Id[] }
  | { kind: 'abandon_recovery'; recoveryId: Id; acknowledgementId: Id }

export type AcceptContractPayload = {
  visitorId: Id
  optionId: Id
  loanItemIds: Id[]
}

export type StartExpeditionPayload = {
  contractId: Id
}

export type ConfirmSettlementPayload = {
  settlementId: Id
  previewVersion: number
  selectedOptionIds: Id[]
}

export type AssignRecoveryPayload = {
  recoveryId: Id
  visitorId: Id
  optionId: Id
  loanItemIds: Id[]
}

export type AbandonRecoveryPayload = {
  recoveryId: Id
  acknowledgementId: Id
}

export function visitorCycleProjection(game: GameView | null) {
  return {
    visitors: game?.visitors ?? [],
    expeditions: game?.expeditions ?? [],
    settlements: game?.settlements ?? [],
    recoveries: game?.recoveries ?? [],
    items: game?.items ?? [],
    serverNow: game?.serverNow ?? null,
    nextTransitionAt: game?.nextTransitionAt ?? null,
    revision: game?.revision ?? null
  }
}

export function invalidateVisitorV2Selection(game: GameView, selection: VisitorV2Selection | null): VisitorV2Selection | null {
  if (!selection) return null
  switch (selection.kind) {
    case 'contract':
      return canAcceptContract(game, selection) ? selection : null
    case 'settlement':
      return canConfirmSettlement(game, selection) ? selection : null
    case 'recovery':
      return canAssignRecovery(game, selection) ? selection : null
    case 'abandon_recovery':
      return canAbandonRecovery(game, selection) ? selection : null
    default:
      return assertNever(selection)
  }
}

export function acceptContractPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'contract' }>): AcceptContractPayload {
  const visitor = findVisitor(game, selection.visitorId)
  const action = findEnabledAction<AcceptContractAction>(visitor?.actions, 'accept_contract')
  const binding = action?.execution.bindings.find((candidate) => candidate.optionId === selection.optionId)
  const publishedOption = visitor && contractOptions(visitor).some((option) => option.optionId === selection.optionId)
  if (!visitor || !action || action.targetId !== visitor.visitorId || action.execution.visitorId !== visitor.visitorId || !binding || !publishedOption) {
    throw new Error('contract_selection_unavailable')
  }
  if (hasDuplicates(selection.loanItemIds) || !isSubset(selection.loanItemIds, binding.eligibleLoanItemIds) || selection.loanItemIds.some((itemId) => !findItem(game, itemId))) {
    throw new Error('contract_loan_unavailable')
  }
  return {
    visitorId: action.execution.visitorId,
    optionId: binding.optionId,
    loanItemIds: [...selection.loanItemIds]
  }
}

export function startExpeditionPayload(game: GameView, visitorId: Id): StartExpeditionPayload {
  const visitor = findVisitor(game, visitorId)
  const action = findEnabledAction<StartExpeditionAction>(visitor?.actions, 'start_expedition')
  if (!visitor || visitor.state !== 'contracted' || !action || action.targetId !== visitor.visitorId || action.execution.contractId !== visitor.contractId) {
    throw new Error('start_expedition_unavailable')
  }
  return { contractId: action.execution.contractId }
}

export function reconcileGamePayload(game: GameView): Record<string, never> {
  const action = findEnabledAction<ReconcileGameAction>(game.actions, 'reconcile_game')
  if (!action) throw new Error('reconcile_unavailable')
  return action.execution
}

export function confirmSettlementPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'settlement' }>): ConfirmSettlementPayload {
  const settlement = findSettlement(game, selection.settlementId)
  const action = findEnabledAction<ConfirmSettlementAction>(settlement?.actions, 'confirm_settlement')
  if (
    !settlement
    || settlement.state !== 'preview_ready'
    || !action
    || action.targetId !== settlement.settlementId
    || action.execution.settlementId !== settlement.settlementId
    || action.execution.previewVersion !== settlement.previewVersion
    || action.execution.expiresAt !== settlement.expiresAt
    || !hasSameUniqueIds(action.execution.groups.map((group) => group.groupId), settlement.choiceGroups.map((group) => group.groupId))
  ) {
    throw new Error('settlement_selection_unavailable')
  }
  if (Object.keys(selection.selectedOptionIds).some((groupId) => !action.execution.groups.some((group) => group.groupId === groupId))) {
    throw new Error('settlement_option_unavailable')
  }
  const selectedOptionIds = action.execution.groups.map((group) => {
    const choiceGroup = findChoiceGroup(settlement, group.groupId)
    const selected = selection.selectedOptionIds[group.groupId] ?? choiceGroup?.defaultOptionId
    if (!choiceGroup || !selected || !group.eligibleOptionIds.includes(selected) || !choiceGroup.options.some((option) => option.optionId === selected)) {
      throw new Error('settlement_option_unavailable')
    }
    return selected
  })
  return {
    settlementId: action.execution.settlementId,
    previewVersion: action.execution.previewVersion,
    selectedOptionIds
  }
}

export function assignRecoveryPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'recovery' }>): AssignRecoveryPayload {
  const recovery = findRecovery(game, selection.recoveryId)
  const action = findEnabledAction<AssignRecoveryAction>(recovery?.actions, 'assign_recovery')
  const binding = action?.execution.bindings.find((candidate) =>
    candidate.optionId === selection.optionId && candidate.visitorId === selection.visitorId
  )
  const publishedOption = recovery?.state === 'open' && recovery.options.some((option) => option.optionId === selection.optionId)
  if (!recovery || !action || action.targetId !== recovery.recoveryId || action.execution.recoveryId !== recovery.recoveryId || !binding || !publishedOption || !findVisitor(game, selection.visitorId)) {
    throw new Error('recovery_selection_unavailable')
  }
  if (hasDuplicates(selection.loanItemIds) || !isSubset(selection.loanItemIds, binding.eligibleLoanItemIds) || selection.loanItemIds.some((itemId) => !findItem(game, itemId))) {
    throw new Error('recovery_loan_unavailable')
  }
  return {
    recoveryId: action.execution.recoveryId,
    visitorId: binding.visitorId,
    optionId: binding.optionId,
    loanItemIds: [...selection.loanItemIds]
  }
}

export function abandonRecoveryPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>): AbandonRecoveryPayload {
  const recovery = findRecovery(game, selection.recoveryId)
  const action = findEnabledAction<AbandonRecoveryAction>(recovery?.actions, 'abandon_recovery')
  if (!recovery || !action || action.targetId !== recovery.recoveryId || action.execution.recoveryId !== recovery.recoveryId) {
    throw new Error('abandon_recovery_unavailable')
  }
  if (action.execution.acknowledgement.acknowledgementId !== selection.acknowledgementId) throw new Error('recovery_acknowledgement_unavailable')
  return {
    recoveryId: action.execution.recoveryId,
    acknowledgementId: action.execution.acknowledgement.acknowledgementId
  }
}

export function enabledAction<T extends ActionAvailability>(actions: readonly ActionAvailability[] | undefined, action: T['action']): T | null {
  return findEnabledAction<T>(actions, action)
}

function canAcceptContract(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'contract' }>): boolean {
  try {
    acceptContractPayload(game, selection)
    return true
  } catch {
    return false
  }
}

function canConfirmSettlement(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'settlement' }>): boolean {
  try {
    confirmSettlementPayload(game, selection)
    return true
  } catch {
    return false
  }
}

function canAssignRecovery(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'recovery' }>): boolean {
  try {
    assignRecoveryPayload(game, selection)
    return true
  } catch {
    return false
  }
}

function canAbandonRecovery(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>): boolean {
  try {
    abandonRecoveryPayload(game, selection)
    return true
  } catch {
    return false
  }
}

function findVisitor(game: GameView, visitorId: Id): VisitorView | undefined {
  return game.visitors.find((visitor) => visitor.visitorId === visitorId)
}

function findItem(game: GameView, itemId: Id) {
  return game.items.find((item) => item.itemId === itemId)
}

function contractOptions(visitor: VisitorView) {
  if (visitor.state === 'available') return visitor.contractOptions
  if (visitor.state === 'negotiating') return visitor.options
  return []
}

function findSettlement(game: GameView, settlementId: Id): SettlementView | undefined {
  return game.settlements.find((settlement) => settlement.settlementId === settlementId)
}

function findRecovery(game: GameView, recoveryId: Id): RecoveryView | undefined {
  return game.recoveries.find((recovery) => recovery.recoveryId === recoveryId)
}

function findChoiceGroup(settlement: SettlementView, groupId: Id) {
  return 'choiceGroups' in settlement ? settlement.choiceGroups.find((group) => group.groupId === groupId) : undefined
}

function findEnabledAction<T extends ActionAvailability>(actions: readonly ActionAvailability[] | undefined, action: T['action']): T | null {
  const match = actions?.find((candidate) => candidate.action === action && candidate.enabled)
  return match ? match as T : null
}

function isSubset(values: readonly Id[], allowed: readonly Id[]): boolean {
  return values.every((value) => allowed.includes(value))
}

function hasDuplicates(values: readonly Id[]): boolean {
  return new Set(values).size !== values.length
}

function hasSameUniqueIds(left: readonly Id[], right: readonly Id[]): boolean {
  return !hasDuplicates(left) && !hasDuplicates(right) && left.length === right.length && isSubset(left, right)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selection: ${JSON.stringify(value)}`)
}
