import { describe, expect, expectTypeOf, it } from 'vitest'
import { ACTION_IDS, actionExecution } from '../shared/types/v2-game-view'
import type {
  ActionAvailability,
  ActionId,
  ConsequenceView,
  EnabledAction,
  GameView,
  ItemView,
  UnavailableReason
} from '../shared/types/v2-game-view'

describe('V2 shared DTO compile-time boundary', () => {
  it('keeps all 13 action discriminants in one exhaustive shared union', () => {
    expect(ACTION_IDS).toHaveLength(13)
    expectTypeOf<(typeof ACTION_IDS)[number]>().toEqualTypeOf<ActionId>()
    expectTypeOf<ActionAvailability['action']>().toEqualTypeOf<ActionId>()
    expectTypeOf<ConsequenceView['kind']>().toEqualTypeOf<
      'lose_items' | 'destroy_items' | 'transfer_items' | 'spend_resource' |
      'renounce_reward' | 'replace_imprint' | 'depart_visitor' | 'fail_recovery'
    >()
    expectTypeOf<UnavailableReason>().toEqualTypeOf<
      'VISITOR_NOT_AVAILABLE' | 'EXPEDITION_NOT_READY' | 'MAINTENANCE_DEBT' |
      'SERVICE_LOCKED' | 'RECOVERY_LIMIT_REACHED' | 'CAPACITY_FULL' |
      'ITEM_IN_USE' | 'ITEM_NOT_OWNED' | 'OPTION_STALE' |
      'SETTLEMENT_PENDING' | 'TERMINAL_ENTITY'
    >()
  })

  it('does not make persistence bookkeeping part of GameView', () => {
    type Forbidden = Extract<
      keyof GameView,
      'userId' | 'requestRecords' | 'ledger' | 'businessKeys' | 'commandHash' | 'seed' | 'rolls'
    >
    expectTypeOf<Forbidden>().toEqualTypeOf<never>()
  })

  it('cannot fabricate economic inputs or invalid ownership through action bindings', () => {
    type ForbiddenKey = 'gold' | 'price' | 'chance' | 'durationSeconds' | 'reward' | 'outcome' | 'serverNow'
    type ForbiddenCommandField<T> = T extends readonly (infer Item)[]
      ? ForbiddenCommandField<Item>
      : T extends object
        ? Extract<keyof T, ForbiddenKey> | { [Key in keyof T]: ForbiddenCommandField<T[Key]> }[keyof T]
        : never
    type InvalidVisitorStash = Extract<
      ItemView,
      { owner: { kind: 'visitor' }; custody: { kind: 'stash' } }
    >
    expectTypeOf<ForbiddenCommandField<EnabledAction['execution']>>().toEqualTypeOf<never>()
    expectTypeOf<InvalidVisitorStash>().toEqualTypeOf<never>()
  })

  it('dispatches both enabled and disabled actions through the typed boundary', () => {
    const action: ActionAvailability = {
      authorizationId: 'auth',
      action: 'reconcile_game',
      enabled: true,
      label: { key: 'action.reconcile', fallback: 'Actualizar' },
      consequences: [],
      execution: {}
    }
    expect(actionExecution(action)).toBe('reconcile_game')

    const disabled: ActionAvailability = {
      authorizationId: 'auth-disabled',
      action: 'identify_item',
      targetId: 'item-1',
      enabled: false,
      label: { key: 'action.identify', fallback: 'Identificar' },
      reason: 'ITEM_IN_USE',
      reasonText: { key: 'reason.item-in-use', fallback: 'El objeto está en uso' },
      consequences: []
    }
    expect(actionExecution(disabled)).toBe('identify_item')
  })
})
