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
  const action = findEnabledAction<AcceptContractAction>(findVisitor(game, selection.visitorId)?.actions, 'accept_contract')
  const binding = action?.execution.bindings.find((candidate) => candidate.optionId === selection.optionId)
  if (!action || action.execution.visitorId !== selection.visitorId || !binding) throw new Error('contract_selection_unavailable')
  if (!isSubset(selection.loanItemIds, binding.eligibleLoanItemIds)) throw new Error('contract_loan_unavailable')
  return {
    visitorId: action.execution.visitorId,
    optionId: binding.optionId,
    loanItemIds: [...selection.loanItemIds]
  }
}

export function startExpeditionPayload(game: GameView, visitorId: Id): StartExpeditionPayload {
  const action = findEnabledAction<StartExpeditionAction>(findVisitor(game, visitorId)?.actions, 'start_expedition')
  if (!action) throw new Error('start_expedition_unavailable')
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
  if (!settlement || !action || action.execution.settlementId !== selection.settlementId) throw new Error('settlement_selection_unavailable')
  const selectedOptionIds = action.execution.groups.map((group) => {
    const selected = selection.selectedOptionIds[group.groupId] ?? findChoiceGroup(settlement, group.groupId)?.defaultOptionId
    if (!selected || !group.eligibleOptionIds.includes(selected)) throw new Error('settlement_option_unavailable')
    return selected
  })
  return {
    settlementId: action.execution.settlementId,
    previewVersion: action.execution.previewVersion,
    selectedOptionIds
  }
}

export function assignRecoveryPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'recovery' }>): AssignRecoveryPayload {
  const action = findEnabledAction<AssignRecoveryAction>(findRecovery(game, selection.recoveryId)?.actions, 'assign_recovery')
  const binding = action?.execution.bindings.find((candidate) =>
    candidate.optionId === selection.optionId && candidate.visitorId === selection.visitorId
  )
  if (!action || action.execution.recoveryId !== selection.recoveryId || !binding) throw new Error('recovery_selection_unavailable')
  if (!isSubset(selection.loanItemIds, binding.eligibleLoanItemIds)) throw new Error('recovery_loan_unavailable')
  return {
    recoveryId: action.execution.recoveryId,
    visitorId: binding.visitorId,
    optionId: binding.optionId,
    loanItemIds: [...selection.loanItemIds]
  }
}

export function abandonRecoveryPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>): AbandonRecoveryPayload {
  const action = findEnabledAction<AbandonRecoveryAction>(findRecovery(game, selection.recoveryId)?.actions, 'abandon_recovery')
  if (!action || action.execution.recoveryId !== selection.recoveryId) throw new Error('abandon_recovery_unavailable')
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

function assertNever(value: never): never {
  throw new Error(`Unhandled selection: ${JSON.stringify(value)}`)
}
