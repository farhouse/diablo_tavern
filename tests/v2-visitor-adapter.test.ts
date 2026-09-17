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
    expect(() => confirmSettlementPayload(mixedGroup, {
      kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'other-group-option' }
    })).toThrow('settlement_option_unavailable')
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

  it('invalidates local selections when a newer snapshot no longer publishes them', () => {
    const before = fixture('integrated-contract')
    const after = fixture('integrated-system')
    const selection: VisitorV2Selection = { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] }

    expect(invalidateVisitorV2Selection(before, selection)).toEqual(selection)
    expect(invalidateVisitorV2Selection(after, selection)).toBeNull()
  })

  it('requires reconcile_game to be explicitly published', () => {
    expect(reconcileGamePayload(fixture('integrated-system'))).toEqual({})
    expect(() => reconcileGamePayload(fixture('integrated-contract'))).toThrow('reconcile_unavailable')
  })
})
