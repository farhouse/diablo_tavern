import { describe, expect, it } from 'vitest'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import {
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

function fixture(id: string): GameView {
  const match = cases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
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
