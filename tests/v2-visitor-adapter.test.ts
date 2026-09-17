import { describe, expect, it } from 'vitest'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import {
  abandonRecoveryPayload,
  acceptContractPayload,
  assignRecoveryPayload,
  confirmSettlementPayload,
  invalidateVisitorV2Selection,
  reconcileGamePayload,
  startExpeditionPayload,
  visitorCycleProjection
} from '../utils/v2-visitor-adapter'
import type { VisitorV2Selection } from '../utils/v2-visitor-adapter'

const cases = fixtures.integratedPositiveCases as Array<{ id: string, value: GameView }>
const negativeCases = fixtures.negativeCases as Array<{ id: string, value: GameView }>

function fixture(id: string): GameView {
  const match = cases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
  return structuredClone(match.value)
}

function negativeFixture(id: string): GameView {
  const match = negativeCases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing negative fixture ${id}`)
  return structuredClone(match.value)
}

function expectRejectedAndInvalidated(game: GameView, selection: VisitorV2Selection, build: () => unknown, error: string) {
  expect(build).toThrow(error)
  expect(invalidateVisitorV2Selection(game, selection)).toBeNull()
}

function syncSettlementExecution(game: GameView) {
  const settlementAction = game.settlements[0]?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
  const visitorAction = game.visitors[0]?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
  if (!settlementAction || settlementAction.action !== 'confirm_settlement' || !settlementAction.enabled
    || !visitorAction || visitorAction.action !== 'confirm_settlement' || !visitorAction.enabled) {
    throw new Error('Expected mirrored settlement actions')
  }
  visitorAction.execution = structuredClone(settlementAction.execution)
}

describe('V2 visitor adapter', () => {
  it('projects only published GameView slices without calculating economy or timers', () => {
    const game = fixture('integrated-contract')
    const projected = visitorCycleProjection(game)

    expect(projected).toMatchObject({
      visitors: game.visitors,
      expeditions: game.expeditions,
      settlements: game.settlements,
      recoveries: game.recoveries,
      serverNow: game.serverNow,
      nextTransitionAt: game.nextTransitionAt,
      revision: game.revision
    })
    expect(JSON.stringify(projected)).not.toMatch(/price|chance|reward/i)
  })

  it('builds an accept-contract payload only from execution bindings and published loans', () => {
    const game = fixture('integrated-contract')

    expect(acceptContractPayload(game, {
      kind: 'contract',
      visitorId: 'v1',
      optionId: 'o1',
      loanItemIds: ['i1']
    })).toEqual({ visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })
    expect(() => acceptContractPayload(game, {
      kind: 'contract',
      visitorId: 'v1',
      optionId: 'made-up',
      loanItemIds: []
    })).toThrow('contract_selection_unavailable')
    expect(() => acceptContractPayload(game, {
      kind: 'contract',
      visitorId: 'v1',
      optionId: 'o1',
      loanItemIds: ['foreign-item']
    })).toThrow('contract_loan_unavailable')
  })

  it.each([
    {
      id: 'foreign-contract-option',
      build: () => acceptContractPayload(negativeFixture('foreign-contract-option'), {
        kind: 'contract', visitorId: 'v1', optionId: 'o-foreign', loanItemIds: []
      }),
      error: 'contract_selection_unavailable'
    },
    {
      id: 'foreign-recovery-visitor',
      build: () => assignRecoveryPayload(negativeFixture('foreign-recovery-visitor'), {
        kind: 'recovery', recoveryId: 'r1', visitorId: 'v-foreign', optionId: 'ro1', loanItemIds: []
      }),
      error: 'recovery_selection_unavailable'
    },
    {
      id: 'foreign-loan-item',
      build: () => acceptContractPayload(negativeFixture('foreign-loan-item'), {
        kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i-foreign']
      }),
      error: 'contract_loan_unavailable'
    }
  ])('rejects normative mixed reference fixture $id', ({ build, error }) => {
    expect(build).toThrow(error)
  })

  it('rejects normative duplicate source entities, options and actions', () => {
    expect(() => acceptContractPayload(negativeFixture('duplicate-source-entity-id'), {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: []
    })).toThrow('contract_selection_unavailable')
    expect(() => acceptContractPayload(negativeFixture('duplicate-source-option-id'), {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: []
    })).toThrow('contract_selection_unavailable')
    expect(() => reconcileGamePayload(negativeFixture('duplicate-action-in-container'))).toThrow('reconcile_unavailable')
  })

  it('rejects duplicate item, settlement, recovery and choice-group sources', () => {
    const duplicateItem = fixture('integrated-contract')
    duplicateItem.items.push(structuredClone(duplicateItem.items[0]!))
    expect(() => acceptContractPayload(duplicateItem, {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1']
    })).toThrow('contract_loan_unavailable')

    const duplicateSettlement = fixture('integrated-settlement')
    duplicateSettlement.settlements.push(structuredClone(duplicateSettlement.settlements[0]!))
    expect(() => confirmSettlementPayload(duplicateSettlement, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    })).toThrow('settlement_selection_unavailable')

    const duplicateChoiceGroup = fixture('integrated-settlement')
    const settlement = duplicateChoiceGroup.settlements[0]
    if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
    settlement.choiceGroups.push(structuredClone(settlement.choiceGroups[0]!))
    expect(() => confirmSettlementPayload(duplicateChoiceGroup, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    })).toThrow('settlement_selection_unavailable')

    const duplicateRecovery = fixture('integrated-recovery')
    duplicateRecovery.recoveries.push(structuredClone(duplicateRecovery.recoveries[0]!))
    expect(() => assignRecoveryPayload(duplicateRecovery, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: []
    })).toThrow('recovery_selection_unavailable')
    expect(() => abandonRecoveryPayload(duplicateRecovery, {
      kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1'
    })).toThrow('abandon_recovery_unavailable')
  })

  it('requires exactly one published option and one action across enabled and disabled variants', () => {
    const duplicateContractOption = fixture('integrated-contract')
    const visitor = duplicateContractOption.visitors[0]
    if (!visitor || visitor.state !== 'available') throw new Error('Expected available visitor')
    visitor.contractOptions.push(structuredClone(visitor.contractOptions[0]!))
    expect(() => acceptContractPayload(duplicateContractOption, {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: []
    })).toThrow('contract_selection_unavailable')

    const duplicateRecoveryOption = fixture('integrated-recovery')
    const recovery = duplicateRecoveryOption.recoveries[0]
    if (!recovery || recovery.state !== 'open') throw new Error('Expected open recovery')
    recovery.options.push(structuredClone(recovery.options[0]!))
    expect(() => assignRecoveryPayload(duplicateRecoveryOption, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: []
    })).toThrow('recovery_selection_unavailable')

    const duplicateSettlementOption = fixture('integrated-settlement')
    const settlement = duplicateSettlementOption.settlements[0]
    if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
    settlement.choiceGroups[0]!.options.push(structuredClone(settlement.choiceGroups[0]!.options[0]!))
    expect(() => confirmSettlementPayload(duplicateSettlementOption, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    })).toThrow('settlement_option_unavailable')

    const duplicateAction = fixture('integrated-contract')
    const actionVisitor = duplicateAction.visitors[0]
    if (!actionVisitor) throw new Error('Expected visitor')
    actionVisitor.actions.push({
      authorizationId: 'auth-disabled-duplicate',
      action: 'accept_contract',
      targetId: 'v1',
      enabled: false,
      label: { key: 'action.accept_contract', fallback: 'Aceptar contrato' },
      reason: 'OPTION_STALE',
      reasonText: { key: 'reason.option_stale', fallback: 'Opción vencida' },
      consequences: []
    })
    expect(() => acceptContractPayload(duplicateAction, {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: []
    })).toThrow('contract_selection_unavailable')
  })

  it('starts expeditions only with the contract id from execution', () => {
    expect(startExpeditionPayload(fixture('integrated-expedition'), 'v1')).toEqual({ contractId: 'c1' })
    expect(() => startExpeditionPayload(fixture('integrated-expedition'), 'wrong-visitor')).toThrow('start_expedition_unavailable')
  })

  it('confirms settlement with binding previewVersion and required group options', () => {
    const game = fixture('integrated-settlement')

    expect(confirmSettlementPayload(game, {
      kind: 'settlement',
      settlementId: 's1',
      selectedOptionIds: { g1: 'renounce' }
    })).toEqual({ settlementId: 's1', previewVersion: 1, selectedOptionIds: ['renounce'] })
    expect(() => confirmSettlementPayload(game, {
      kind: 'settlement',
      settlementId: 's1',
      selectedOptionIds: { g1: 'keep-foreign' }
    })).toThrow('settlement_option_unavailable')

    for (const selectedOptionIds of [{}, { g1: 'renounce', extra: 'renounce' }] as Array<Record<string, string>>) {
      const selection: Extract<VisitorV2Selection, { kind: 'settlement' }> = { kind: 'settlement', settlementId: 's1', selectedOptionIds }
      expectRejectedAndInvalidated(game, selection, () => confirmSettlementPayload(game, selection), 'settlement_option_unavailable')
    }

    const mixedGroup = fixture('integrated-settlement')
    const settlement = mixedGroup.settlements[0]
    if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
    const originalGroup = settlement.choiceGroups[0]
    if (!originalGroup) throw new Error('Expected settlement choice group')
    settlement.choiceGroups.push({
      ...structuredClone(originalGroup),
      groupId: 'g2',
      options: [{ ...structuredClone(originalGroup.options[0]!), optionId: 'other-group-option' }],
      defaultOptionId: 'other-group-option'
    })
    const action = settlement.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
    action.execution.groups[0]?.eligibleOptionIds.push('other-group-option')
    action.execution.groups.push({ groupId: 'g2', eligibleOptionIds: ['other-group-option'] })
    syncSettlementExecution(mixedGroup)
    expect(() => confirmSettlementPayload(mixedGroup, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'other-group-option' }
    })).toThrow('settlement_option_unavailable')
  })

  it('requires parity with the visitor settlement authorization', () => {
    const mismatch = negativeFixture('enabled-disabled-projection-mismatch')
    const selection: VisitorV2Selection = {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    }
    expectRejectedAndInvalidated(mismatch, selection, () => confirmSettlementPayload(mismatch, selection), 'settlement_selection_unavailable')

    const executionMismatch = fixture('integrated-settlement')
    const visitorAction = executionMismatch.visitors[0]?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!visitorAction || visitorAction.action !== 'confirm_settlement' || !visitorAction.enabled) throw new Error('Expected visitor settlement action')
    visitorAction.execution.previewVersion += 1
    expectRejectedAndInvalidated(
      executionMismatch,
      selection,
      () => confirmSettlementPayload(executionMismatch, selection),
      'settlement_selection_unavailable'
    )

    for (const mutate of [
      (game: GameView) => {
        const action = game.visitors[0]?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
        if (!action) throw new Error('Expected visitor settlement action')
        Object.assign(action, { reason: 'TERMINAL_ENTITY' })
      },
      (game: GameView) => {
        const action = game.visitors[0]?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
        if (action) action.targetId = 'foreign-visitor'
      },
      (game: GameView) => { game.visitors.push(structuredClone(game.visitors[0]!)) }
    ]) {
      const game = fixture('integrated-settlement')
      mutate(game)
      expectRejectedAndInvalidated(game, selection, () => confirmSettlementPayload(game, selection), 'settlement_selection_unavailable')
    }
  })

  it.each([
    ['preview version', (game: GameView) => {
      const action = game.settlements[0]?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
      if (action?.action === 'confirm_settlement' && action.enabled) action.execution.previewVersion += 1
    }],
    ['expiry', (game: GameView) => {
      const action = game.settlements[0]?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
      if (action?.action === 'confirm_settlement' && action.enabled) action.execution.expiresAt = '2026-09-16T10:30:00Z'
    }],
    ['missing group', (game: GameView) => {
      const settlement = game.settlements[0]
      if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
      settlement.choiceGroups.push({
        ...structuredClone(settlement.choiceGroups[0]!),
        groupId: 'g2'
      })
    }],
    ['expired preview state', (game: GameView) => {
      const settlement = game.settlements[0]
      if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
      settlement.state = 'preview_expired'
    }]
  ])('rejects settlement execution with mismatched %s', (_name, mutate) => {
    const game = fixture('integrated-settlement')
    mutate(game)
    syncSettlementExecution(game)
    expect(() => confirmSettlementPayload(game, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    })).toThrow('settlement_selection_unavailable')
  })

  it('rejects duplicate loan IDs for contract and recovery payloads', () => {
    const contract = fixture('integrated-contract')
    expect(() => acceptContractPayload(contract, {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1', 'i1']
    })).toThrow('contract_loan_unavailable')

    const recovery = fixture('integrated-recovery')
    const action = recovery.recoveries[0]?.actions.find((candidate) => candidate.action === 'assign_recovery' && candidate.enabled)
    if (!action || action.action !== 'assign_recovery' || !action.enabled) throw new Error('Expected recovery action')
    action.execution.bindings[0]!.eligibleLoanItemIds = ['i4']
    expect(() => assignRecoveryPayload(recovery, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: ['i4', 'i4']
    })).toThrow('recovery_loan_unavailable')
  })

  it('rejects expired contract, settlement, recovery and acknowledgement tokens and invalidates stale selections', () => {
    const expiredContract = negativeFixture('expired-contract-binding')
    const contractSelection: VisitorV2Selection = { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }
    expect(() => acceptContractPayload(expiredContract, contractSelection)).toThrow('contract_selection_unavailable')
    expect(invalidateVisitorV2Selection(expiredContract, contractSelection)).toBeNull()

    const settlement = fixture('integrated-settlement')
    const settlementView = settlement.settlements[0]
    const settlementAction = settlementView?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!settlementView || !('expiresAt' in settlementView) || !settlementAction || settlementAction.action !== 'confirm_settlement' || !settlementAction.enabled) throw new Error('Expected settlement preview')
    settlementView.expiresAt = settlement.serverNow
    settlementAction.execution.expiresAt = settlement.serverNow
    syncSettlementExecution(settlement)
    expect(() => confirmSettlementPayload(settlement, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' }
    })).toThrow('settlement_selection_unavailable')

    const recovery = fixture('integrated-recovery')
    const recoveryView = recovery.recoveries[0]
    const assign = recoveryView?.actions.find((candidate) => candidate.action === 'assign_recovery' && candidate.enabled)
    const abandon = recoveryView?.actions.find((candidate) => candidate.action === 'abandon_recovery' && candidate.enabled)
    if (!assign || assign.action !== 'assign_recovery' || !assign.enabled || !abandon || abandon.action !== 'abandon_recovery' || !abandon.enabled) throw new Error('Expected recovery actions')
    assign.execution.bindings[0]!.expiresAt = recovery.serverNow
    expect(() => assignRecoveryPayload(recovery, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: []
    })).toThrow('recovery_selection_unavailable')

    const expiredAcknowledgement = negativeFixture('expired-acknowledgement').items[0]?.actions
      .find((candidate) => candidate.action === 'dismantle_item' && candidate.enabled)
    if (!expiredAcknowledgement || expiredAcknowledgement.action !== 'dismantle_item' || !expiredAcknowledgement.enabled) throw new Error('Expected normative expired acknowledgement')
    abandon.execution.acknowledgement.expiresAt = expiredAcknowledgement.execution.options[0]!.acknowledgement.expiresAt
    expect(() => abandonRecoveryPayload(recovery, {
      kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1'
    })).toThrow('recovery_acknowledgement_unavailable')
  })

  it.each([
    ['expired binding', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!visitor || visitor.state !== 'available' || !action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      visitor.contractOptions.push({ ...structuredClone(visitor.contractOptions[0]!), optionId: 'o2' })
      action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: [], expiresAt: game.serverNow })
    }],
    ['missing option', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      action.execution.bindings.push({ optionId: 'missing-option', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' })
    }],
    ['ambiguous option', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!visitor || visitor.state !== 'available' || !action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      visitor.contractOptions.push({ ...structuredClone(visitor.contractOptions[0]!), optionId: 'o2' })
      visitor.contractOptions.push(structuredClone(visitor.contractOptions[1]!))
      action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' })
    }],
    ['missing loan', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!visitor || visitor.state !== 'available' || !action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      visitor.contractOptions.push({ ...structuredClone(visitor.contractOptions[0]!), optionId: 'o2' })
      action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: ['missing-item'], expiresAt: '2026-09-15T10:30:00Z' })
    }],
    ['foreign loan', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!visitor || visitor.state !== 'available' || !action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      visitor.contractOptions.push({ ...structuredClone(visitor.contractOptions[0]!), optionId: 'o2' })
      game.items.push({ ...structuredClone(game.items[0]!), itemId: 'i2', owner: { kind: 'visitor', visitorId: 'v1' }, custody: { kind: 'visitor', visitorId: 'v1' } })
      action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: ['i2'], expiresAt: '2026-09-15T10:30:00Z' })
    }],
    ['ambiguous loan', (game: GameView) => {
      const visitor = game.visitors[0]
      const action = visitor?.actions.find(candidate => candidate.action === 'accept_contract' && candidate.enabled)
      if (!visitor || visitor.state !== 'available' || !action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected contract action')
      visitor.contractOptions.push({ ...structuredClone(visitor.contractOptions[0]!), optionId: 'o2' })
      game.items.push(structuredClone(game.items[0]!))
      action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: ['i1'], expiresAt: '2026-09-15T10:30:00Z' })
    }]
  ])('rejects contract corruption in an unselected %s', (_name, mutate) => {
    const game = fixture('integrated-contract')
    const selection: VisitorV2Selection = { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }
    mutate(game)
    expectRejectedAndInvalidated(game, selection, () => acceptContractPayload(game, selection), 'contract_selection_unavailable')
  })

  it.each([
    ['missing option', (game: GameView, binding: { optionId: string, visitorId: string, eligibleLoanItemIds: string[], expiresAt: string }) => { binding.optionId = 'missing-option' }],
    ['ambiguous option', (game: GameView) => {
      const recovery = game.recoveries[0]
      if (recovery?.state !== 'open') throw new Error('Expected open recovery')
      recovery.options.push(structuredClone(recovery.options[1]!))
    }],
    ['missing visitor', (_game: GameView, binding: { optionId: string, visitorId: string, eligibleLoanItemIds: string[], expiresAt: string }) => { binding.visitorId = 'missing-visitor' }],
    ['ambiguous visitor', (game: GameView) => { game.visitors.push(structuredClone(game.visitors[1]!)) }],
    ['ineligible visitor', (game: GameView) => { Object.assign(game.visitors[1]!, { state: 'contracted', contractId: 'c2' }) }],
    ['missing loan', (_game: GameView, binding: { optionId: string, visitorId: string, eligibleLoanItemIds: string[], expiresAt: string }) => { binding.eligibleLoanItemIds = ['missing-item'] }],
    ['foreign loan', (game: GameView, binding: { optionId: string, visitorId: string, eligibleLoanItemIds: string[], expiresAt: string }) => {
      binding.eligibleLoanItemIds = ['i5']
      Object.assign(game.items[1]!, { owner: { kind: 'visitor', visitorId: 'v2' }, custody: { kind: 'visitor', visitorId: 'v2' } })
    }],
    ['ambiguous loan', (game: GameView, binding: { optionId: string, visitorId: string, eligibleLoanItemIds: string[], expiresAt: string }) => {
      binding.eligibleLoanItemIds = ['i5']
      game.items.push(structuredClone(game.items[1]!))
    }]
  ])('rejects recovery corruption in an unselected binding: %s', (_name, mutate) => {
    const game = fixture('integrated-recovery')
    const recovery = game.recoveries[0]
    const action = recovery?.actions.find(candidate => candidate.action === 'assign_recovery' && candidate.enabled)
    if (recovery?.state !== 'open' || !action || action.action !== 'assign_recovery' || !action.enabled) throw new Error('Expected recovery action')
    recovery.options.push({ ...structuredClone(recovery.options[0]!), optionId: 'ro2' })
    game.visitors.push({ ...structuredClone(game.visitors[0]!), visitorId: 'v3' })
    game.items.push({ ...structuredClone(game.items[0]!), itemId: 'i5', owner: { kind: 'caravan' }, custody: { kind: 'stash' } })
    const binding = { optionId: 'ro2', visitorId: 'v3', eligibleLoanItemIds: [] as string[], expiresAt: '2026-09-15T10:30:00Z' }
    action.execution.bindings.push(binding)
    mutate(game, binding)

    const selection: VisitorV2Selection = { kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }
    expectRejectedAndInvalidated(game, selection, () => assignRecoveryPayload(game, selection), 'recovery_selection_unavailable')
  })

  it.each([
    ['missing eligible option', (game: GameView) => {
      const settlement = game.settlements[0]
      const action = settlement?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
      if (!action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
      action.execution.groups[1]!.eligibleOptionIds[1] = 'missing-option'
    }],
    ['duplicate eligible option', (game: GameView) => {
      const settlement = game.settlements[0]
      const action = settlement?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
      if (!action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
      action.execution.groups[1]!.eligibleOptionIds.push('unused-option')
    }],
    ['duplicate group key', (game: GameView) => {
      const settlement = game.settlements[0]
      if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
      settlement.choiceGroups[1]!.groupId = 'g1'
    }]
  ])('rejects settlement corruption in an unselected group: %s', (_name, mutate) => {
    const game = fixture('integrated-settlement')
    const settlement = game.settlements[0]
    const action = settlement?.actions.find(candidate => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!settlement || !('choiceGroups' in settlement) || !action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
    const secondGroup = structuredClone(settlement.choiceGroups[0]!)
    secondGroup.groupId = 'g2'
    secondGroup.defaultOptionId = 'other-option'
    secondGroup.options[0]!.optionId = 'other-option'
    secondGroup.options.push({ ...structuredClone(secondGroup.options[0]!), optionId: 'unused-option' })
    settlement.choiceGroups.push(secondGroup)
    action.execution.groups.push({ groupId: 'g2', eligibleOptionIds: ['other-option', 'unused-option'] })
    mutate(game)
    syncSettlementExecution(game)

    const selection: VisitorV2Selection = {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce', g2: 'other-option' }
    }
    expectRejectedAndInvalidated(game, selection, () => confirmSettlementPayload(game, selection), 'settlement_selection_unavailable')
  })

  it('requires eligible recovery visitors, stash-owned caravan loans and unambiguous bindings', () => {
    const ineligibleVisitor = fixture('integrated-recovery')
    const visitor = ineligibleVisitor.visitors[0]
    if (!visitor) throw new Error('Expected visitor')
    Object.assign(visitor, { state: 'contracted', contractId: 'contract-1' })
    expect(() => assignRecoveryPayload(ineligibleVisitor, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: []
    })).toThrow('recovery_selection_unavailable')

    for (const [owner, custody] of [
      [{ kind: 'visitor', visitorId: 'v1' }, { kind: 'visitor', visitorId: 'v1' }],
      [{ kind: 'caravan' }, { kind: 'recovery', recoveryId: 'r1' }]
    ] as const) {
      const game = fixture('integrated-contract')
      Object.assign(game.items[0]!, { owner, custody })
      expect(() => acceptContractPayload(game, {
        kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1']
      })).toThrow('contract_loan_unavailable')
    }

    const validRecoveryLoan = fixture('integrated-recovery')
    const recoveryAction = validRecoveryLoan.recoveries[0]?.actions.find((candidate) => candidate.action === 'assign_recovery' && candidate.enabled)
    if (!recoveryAction || recoveryAction.action !== 'assign_recovery' || !recoveryAction.enabled) throw new Error('Expected recovery action')
    recoveryAction.execution.bindings[0]!.eligibleLoanItemIds = ['i4']
    Object.assign(validRecoveryLoan.items[0]!, { owner: { kind: 'caravan' }, custody: { kind: 'stash' } })
    expect(assignRecoveryPayload(validRecoveryLoan, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: ['i4']
    })).toEqual({ recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: ['i4'] })

    const duplicateContract = fixture('integrated-contract')
    const accept = duplicateContract.visitors[0]?.actions.find((candidate) => candidate.action === 'accept_contract' && candidate.enabled)
    if (!accept || accept.action !== 'accept_contract' || !accept.enabled) throw new Error('Expected contract action')
    accept.execution.bindings.push(structuredClone(accept.execution.bindings[0]!))
    expect(() => acceptContractPayload(duplicateContract, {
      kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: []
    })).toThrow('contract_selection_unavailable')

    recoveryAction.execution.bindings.push(structuredClone(recoveryAction.execution.bindings[0]!))
    expect(() => assignRecoveryPayload(validRecoveryLoan, {
      kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: []
    })).toThrow('recovery_selection_unavailable')
  })

  it.each([
    {
      id: 'contract',
      mutate: (game: GameView) => {
        const action = game.visitors[0]?.actions.find((candidate) => candidate.action === 'accept_contract' && candidate.enabled)
        if (action?.action === 'accept_contract' && action.enabled) action.targetId = 'foreign-visitor'
      },
      build: (game: GameView) => acceptContractPayload(game, { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }),
      error: 'contract_selection_unavailable',
      fixtureId: 'integrated-contract'
    },
    {
      id: 'start expedition',
      mutate: (game: GameView) => {
        const action = game.visitors[0]?.actions.find((candidate) => candidate.action === 'start_expedition' && candidate.enabled)
        if (action?.action === 'start_expedition' && action.enabled) action.targetId = 'foreign-visitor'
      },
      build: (game: GameView) => startExpeditionPayload(game, 'v1'),
      error: 'start_expedition_unavailable',
      fixtureId: 'integrated-expedition'
    },
    {
      id: 'start expedition execution',
      mutate: (game: GameView) => {
        const action = game.visitors[0]?.actions.find((candidate) => candidate.action === 'start_expedition' && candidate.enabled)
        if (action?.action === 'start_expedition' && action.enabled) action.execution.contractId = 'foreign-contract'
      },
      build: (game: GameView) => startExpeditionPayload(game, 'v1'),
      error: 'start_expedition_unavailable',
      fixtureId: 'integrated-expedition'
    },
    {
      id: 'settlement',
      mutate: (game: GameView) => {
        const action = game.settlements[0]?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
        if (action?.action === 'confirm_settlement' && action.enabled) action.targetId = 'foreign-settlement'
      },
      build: (game: GameView) => confirmSettlementPayload(game, { kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' } }),
      error: 'settlement_selection_unavailable',
      fixtureId: 'integrated-settlement'
    },
    {
      id: 'recovery assignment',
      mutate: (game: GameView) => {
        const action = game.recoveries[0]?.actions.find((candidate) => candidate.action === 'assign_recovery' && candidate.enabled)
        if (action?.action === 'assign_recovery' && action.enabled) action.execution.recoveryId = 'foreign-recovery'
      },
      build: (game: GameView) => assignRecoveryPayload(game, { kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }),
      error: 'recovery_selection_unavailable',
      fixtureId: 'integrated-recovery'
    },
    {
      id: 'recovery option entity',
      mutate: (game: GameView) => {
        const recovery = game.recoveries[0]
        if (recovery?.state === 'open') recovery.options = []
      },
      build: (game: GameView) => assignRecoveryPayload(game, { kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }),
      error: 'recovery_selection_unavailable',
      fixtureId: 'integrated-recovery'
    },
    {
      id: 'recovery abandonment',
      mutate: (game: GameView) => {
        const action = game.recoveries[0]?.actions.find((candidate) => candidate.action === 'abandon_recovery' && candidate.enabled)
        if (action?.action === 'abandon_recovery' && action.enabled) action.targetId = 'foreign-recovery'
      },
      build: (game: GameView) => abandonRecoveryPayload(game, { kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1' }),
      error: 'abandon_recovery_unavailable',
      fixtureId: 'integrated-recovery'
    }
  ])('rejects mismatched target/entity/execution for $id', ({ mutate, build, error, fixtureId }) => {
    const game = fixture(fixtureId)
    mutate(game)
    expect(() => build(game)).toThrow(error)
  })

  it('assigns recovery only through a published visitor/option binding', () => {
    const game = fixture('integrated-recovery')

    expect(assignRecoveryPayload(game, {
      kind: 'recovery',
      recoveryId: 'r1',
      visitorId: 'v2',
      optionId: 'ro1',
      loanItemIds: []
    })).toEqual({ recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] })
    expect(() => assignRecoveryPayload(game, {
      kind: 'recovery',
      recoveryId: 'r1',
      visitorId: 'v1',
      optionId: 'ro1',
      loanItemIds: []
    })).toThrow('recovery_selection_unavailable')
  })

  it.each(['assigned', 'recovered', 'failed', 'abandoned'] as const)('rejects abandonment retained on a %s recovery', (state) => {
    const game = fixture('integrated-recovery')
    const recovery = game.recoveries[0]
    if (!recovery || recovery.state !== 'open') throw new Error('Expected open recovery')
    Object.assign(recovery, { state })
    const selection: VisitorV2Selection = {
      kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1'
    }
    expectRejectedAndInvalidated(game, selection, () => abandonRecoveryPayload(game, selection), 'abandon_recovery_unavailable')
  })

  it('invalidates local selections when a newer snapshot no longer publishes them', () => {
    const before = fixture('integrated-contract')
    const after = fixture('integrated-system')
    const selection: VisitorV2Selection = { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] }

    expect(invalidateVisitorV2Selection(before, selection)).toEqual(selection)
    expect(invalidateVisitorV2Selection(after, selection)).toBeNull()
  })

  it('requires reconcile_game to be explicitly published', () => {
    const game = fixture('integrated-system')
    const action = game.actions.find(candidate => candidate.action === 'reconcile_game' && candidate.enabled)
    if (!action || action.action !== 'reconcile_game' || !action.enabled) throw new Error('Expected reconcile action')
    const payload = reconcileGamePayload(game)
    expect(payload).toEqual({})
    expect(payload).not.toBe(action.execution)
    expect(() => reconcileGamePayload(fixture('integrated-contract'))).toThrow('reconcile_unavailable')
  })
})
