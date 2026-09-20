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
  const binding = findUnique(action?.execution.bindings, (candidate) => candidate.optionId === selection.optionId)
  if (!visitor || !action || !validAcceptContractAction(game, visitor, action) || !binding) {
    throw new Error('contract_selection_unavailable')
  }
  if (hasDuplicates(selection.loanItemIds) || !isSubset(selection.loanItemIds, binding.eligibleLoanItemIds) || selection.loanItemIds.some((itemId) => !isLoanableItem(game, itemId))) {
    throw new Error('contract_loan_unavailable')
  }
  if (!validLoanBindings(game, action.execution.bindings)) throw new Error('contract_selection_unavailable')
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
  return {}
}

export function confirmSettlementPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'settlement' }>): ConfirmSettlementPayload {
  const settlement = findSettlement(game, selection.settlementId)
  const action = findEnabledAction<ConfirmSettlementAction>(settlement?.actions, 'confirm_settlement')
  if (!settlement || !action || !validConfirmSettlementAction(game, settlement, action)) {
    throw new Error('settlement_selection_unavailable')
  }
  if (!hasSameUniqueIds(Object.keys(selection.selectedOptionIds), action.execution.groups.map(({ groupId }) => groupId))) {
    throw new Error('settlement_option_unavailable')
  }
  const selectedOptionIds = action.execution.groups.map((group) => {
    const choiceGroup = findChoiceGroup(settlement, group.groupId)
    const selected = selection.selectedOptionIds[group.groupId]
    const eligibleOption = selected && findUnique(group.eligibleOptionIds, (optionId) => optionId === selected)
    const publishedOption = selected && findUnique(choiceGroup?.options, (option) => option.optionId === selected)
    if (!choiceGroup || !selected || !eligibleOption || !publishedOption) {
      throw new Error('settlement_option_unavailable')
    }
    return selected
  })
  if (!validSettlementGroups(settlement, action)) throw new Error('settlement_selection_unavailable')
  return {
    settlementId: action.execution.settlementId,
    previewVersion: action.execution.previewVersion,
    selectedOptionIds
  }
}

export function assignRecoveryPayload(game: GameView, selection: Extract<VisitorV2Selection, { kind: 'recovery' }>): AssignRecoveryPayload {
  const recovery = findRecovery(game, selection.recoveryId)
  const action = findEnabledAction<AssignRecoveryAction>(recovery?.actions, 'assign_recovery')
  const binding = findUnique(action?.execution.bindings, (candidate) =>
    candidate.optionId === selection.optionId && candidate.visitorId === selection.visitorId
  )
  if (!recovery || !action || !validAssignRecoveryAction(game, recovery, action) || !binding) {
    throw new Error('recovery_selection_unavailable')
  }
  if (hasDuplicates(selection.loanItemIds) || !isSubset(selection.loanItemIds, binding.eligibleLoanItemIds) || selection.loanItemIds.some((itemId) => !isLoanableItem(game, itemId))) {
    throw new Error('recovery_loan_unavailable')
  }
  if (!validLoanBindings(game, action.execution.bindings)) throw new Error('recovery_selection_unavailable')
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
  if (!recovery || recovery.state !== 'open' || !action || action.targetId !== recovery.recoveryId || action.execution.recoveryId !== recovery.recoveryId) {
    throw new Error('abandon_recovery_unavailable')
  }
  if (action.execution.acknowledgement.acknowledgementId !== selection.acknowledgementId || !isFresh(action.execution.acknowledgement.expiresAt, game.serverNow)) throw new Error('recovery_acknowledgement_unavailable')
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

function validAcceptContractAction(game: GameView, visitor: VisitorView, action: AcceptContractAction): boolean {
  const options = contractOptions(visitor)
  return uniqueIds(game.visitors, ({ visitorId }) => visitorId)
    && uniqueIds(options, ({ optionId }) => optionId)
    && action.targetId === visitor.visitorId
    && action.execution.visitorId === visitor.visitorId
    && uniqueIds(action.execution.bindings, ({ optionId }) => optionId)
    && action.execution.bindings.every(binding =>
      isFresh(binding.expiresAt, game.serverNow)
      && findUnique(options, ({ optionId }) => optionId === binding.optionId) !== undefined
    )
}

function validConfirmSettlementAction(game: GameView, settlement: SettlementView, action: ConfirmSettlementAction): boolean {
  const visitor = findUnique(game.visitors, candidate =>
    candidate.state === 'awaiting_settlement' && candidate.settlementId === settlement.settlementId
  )
  const visitorAction = findUnique(visitor?.actions, candidate => candidate.action === 'confirm_settlement')
  if (
    settlement.state !== 'preview_ready'
    || !visitor
    || !visitorAction
    || !uniqueIds(game.visitors, ({ visitorId }) => visitorId)
    || !('targetId' in visitorAction)
    || visitorAction.targetId !== visitor.visitorId
    || !sameSettlementAuthorization(action, visitorAction)
    || !uniqueIds(game.settlements, ({ settlementId }) => settlementId)
    || action.targetId !== settlement.settlementId
    || action.execution.settlementId !== settlement.settlementId
    || action.execution.previewVersion !== settlement.previewVersion
    || action.execution.expiresAt !== settlement.expiresAt
    || !isFresh(action.execution.expiresAt, game.serverNow)
    || !hasSameUniqueIds(action.execution.groups.map(({ groupId }) => groupId), settlement.choiceGroups.map(({ groupId }) => groupId))
  ) return false
  return true
}

function sameSettlementAuthorization(settlementAction: ConfirmSettlementAction, visitorAction: ActionAvailability): boolean {
  if (
    visitorAction.action !== settlementAction.action
    || visitorAction.authorizationId !== settlementAction.authorizationId
    || visitorAction.enabled !== settlementAction.enabled
    || actionReason(visitorAction) !== actionReason(settlementAction)
    || !visitorAction.enabled
  ) return false

  return visitorAction.execution.settlementId === settlementAction.execution.settlementId
    && visitorAction.execution.previewVersion === settlementAction.execution.previewVersion
    && visitorAction.execution.expiresAt === settlementAction.execution.expiresAt
    && visitorAction.execution.groups.length === settlementAction.execution.groups.length
    && visitorAction.execution.groups.every((group, index) => {
      const settlementGroup = settlementAction.execution.groups[index]
      return settlementGroup !== undefined
        && group.groupId === settlementGroup.groupId
        && sameIdsInOrder(group.eligibleOptionIds, settlementGroup.eligibleOptionIds)
    })
}

function actionReason(action: ActionAvailability) {
  return 'reason' in action ? action.reason : undefined
}

function validAssignRecoveryAction(game: GameView, recovery: RecoveryView, action: AssignRecoveryAction): boolean {
  if (
    recovery.state !== 'open'
    || !uniqueIds(game.recoveries, ({ recoveryId }) => recoveryId)
    || !uniqueIds(game.visitors, ({ visitorId }) => visitorId)
    || !uniqueIds(recovery.options, ({ optionId }) => optionId)
    || action.targetId !== recovery.recoveryId
    || action.execution.recoveryId !== recovery.recoveryId
    || !uniqueRecoveryBindings(action.execution.bindings)
  ) return false

  return action.execution.bindings.every((binding) => {
    const visitor = findVisitor(game, binding.visitorId)
    return isFresh(binding.expiresAt, game.serverNow)
      && findUnique(recovery.options, ({ optionId }) => optionId === binding.optionId) !== undefined
      && visitor !== undefined
      && ['available', 'negotiating'].includes(visitor.state)
  })
}

function validLoanBindings(game: GameView, bindings: readonly { eligibleLoanItemIds: readonly Id[] }[]): boolean {
  return uniqueIds(game.items, ({ itemId }) => itemId)
    && bindings.every(binding =>
      uniqueIds(binding.eligibleLoanItemIds, itemId => itemId)
      && binding.eligibleLoanItemIds.every(itemId => isLoanableItem(game, itemId))
    )
}

function validSettlementGroups(settlement: SettlementView, action: ConfirmSettlementAction): boolean {
  if (settlement.state !== 'preview_ready') return false
  const publishedOptionIds = settlement.choiceGroups.flatMap(group => group.options.map(({ optionId }) => optionId))
  const eligibleOptionIds = action.execution.groups.flatMap(group => group.eligibleOptionIds)
  return !hasDuplicates(publishedOptionIds)
    && !hasDuplicates(eligibleOptionIds)
    && action.execution.groups.every((group) => {
      const choiceGroup = findChoiceGroup(settlement, group.groupId)
      return choiceGroup !== undefined
        && hasSameUniqueIds(group.eligibleOptionIds, choiceGroup.options.map(({ optionId }) => optionId))
    })
}

function findVisitor(game: GameView, visitorId: Id): VisitorView | undefined {
  return findUnique(game.visitors, (visitor) => visitor.visitorId === visitorId)
}

function findItem(game: GameView, itemId: Id) {
  return findUnique(game.items, (item) => item.itemId === itemId)
}

function isLoanableItem(game: GameView, itemId: Id): boolean {
  const item = findItem(game, itemId)
  return item?.owner.kind === 'caravan' && item.custody.kind === 'stash'
}

function isFresh(expiresAt: string, serverNow: string): boolean {
  return Date.parse(expiresAt) > Date.parse(serverNow)
}

function contractOptions(visitor: VisitorView) {
  if (visitor.state === 'available') return visitor.contractOptions
  if (visitor.state === 'negotiating') return visitor.options
  return []
}

function findSettlement(game: GameView, settlementId: Id): SettlementView | undefined {
  return findUnique(game.settlements, (settlement) => settlement.settlementId === settlementId)
}

function findRecovery(game: GameView, recoveryId: Id): RecoveryView | undefined {
  return findUnique(game.recoveries, (recovery) => recovery.recoveryId === recoveryId)
}

function findChoiceGroup(settlement: SettlementView, groupId: Id) {
  return 'choiceGroups' in settlement ? findUnique(settlement.choiceGroups, (group) => group.groupId === groupId) : undefined
}

function findEnabledAction<T extends ActionAvailability>(actions: readonly ActionAvailability[] | undefined, action: T['action']): T | null {
  const match = findUnique(actions, (candidate) => candidate.action === action)
  return match?.enabled ? match as T : null
}

function findUnique<T>(values: readonly T[] | undefined, predicate: (value: T) => boolean): T | undefined {
  const matches = values?.filter(predicate)
  return matches?.length === 1 ? matches[0] : undefined
}

function isSubset(values: readonly Id[], allowed: readonly Id[]): boolean {
  return values.every((value) => allowed.includes(value))
}

function hasDuplicates(values: readonly Id[]): boolean {
  return new Set(values).size !== values.length
}

function uniqueIds<T>(values: readonly T[], id: (value: T) => Id): boolean {
  return !hasDuplicates(values.map(id))
}

function uniqueRecoveryBindings(bindings: readonly { optionId: Id; visitorId: Id }[]): boolean {
  return bindings.every((binding, index) =>
    bindings.findIndex(candidate => candidate.optionId === binding.optionId && candidate.visitorId === binding.visitorId) === index
  )
}

function hasSameUniqueIds(left: readonly Id[], right: readonly Id[]): boolean {
  return !hasDuplicates(left) && !hasDuplicates(right) && left.length === right.length && isSubset(left, right)
}

function sameIdsInOrder(left: readonly Id[], right: readonly Id[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selection: ${JSON.stringify(value)}`)
}
