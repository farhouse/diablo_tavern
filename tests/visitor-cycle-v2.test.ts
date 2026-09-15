import { describe, expect, it } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { buildPersistedFromPublic, isPersistedCanonical, type PersistenceDependencies, type PersistedGameV3 } from '../server/utils/savegame'
import { applyVisitorCycleCommand, VisitorCycleError } from '../server/domain/visitor-cycle'
import { mapPersistedGameToGameView } from '../server/domain/game-view'

describe('V2 visitor contract, expedition, settlement and recovery', () => {
  it.each([
    [9, 'retreated'],
    [18, 'death']
  ] as const)('resolves damage before inclusive retreat: 18 - %i becomes %s', (damage, outcome) => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, damage)]

    const reconciled = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)

    expect(reconciled.visitorCycle.expeditions[scenario.expeditionId]).toMatchObject({
      state: 'awaiting_settlement', outcome, currentHp: 18 - damage
    })
    expect(reconciled.visitorCycle.visitors[scenario.visitorId]?.state).toBe('awaiting_settlement')
  })

  it('retires at exactly 10 HP without processing the following event', () => {
    const scenario = activeScenario()
    const firstAt = new Date(scenario.now.getTime() + 1_000)
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [
      event(firstAt, 8), event(new Date(firstAt.getTime() + 1_000), 10)
    ]
    scenario.dependencies.now = () => firstAt

    const reconciled = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    expect(reconciled.visitorCycle.expeditions[scenario.expeditionId]).toMatchObject({
      state: 'awaiting_settlement', outcome: 'retreated', currentHp: 10, nextEventIndex: 1
    })
  })

  it('keeps preview effect-free and applies return, gold and stay exactly on confirmation', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 1, 100)]
    const beforeGold = scenario.game.gold
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!

    expect(preview.gold).toBe(beforeGold)
    expect(preview.itemPlacements[scenario.loanItemId]).toMatchObject({ custodyKind: 'expedition' })
    const confirmed = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)

    expect(confirmed.gold).toBe(beforeGold + settlement.caravanGold)
    expect(confirmed.itemPlacements[scenario.loanItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(confirmed.visitorCycle.visitors[scenario.visitorId]?.state).toBe('available')
    expect(() => apply(confirmed, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)).toThrow(VisitorCycleError)
  })

  it('applies expiration defaults only through reconcile', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 1)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    scenario.dependencies.now = () => new Date(settlement.expiresAt)

    const readOnly = mapPersistedGameToGameView(preview, scenario.dependencies.now())
    expect(readOnly.settlements[0]?.state).toBe('preview_expired')
    expect(preview.visitorCycle.settlements[settlement.settlementId]?.state).toBe('preview_ready')
    const defaulted = apply(preview, { action: 'reconcile_game' }, scenario.dependencies)
    expect(defaulted.visitorCycle.settlements[settlement.settlementId]).toMatchObject({
      state: 'settled', appliedBy: 'expiry_default'
    })
  })

  it('creates one recovery containing only caravan loans after death settlement', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 18)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    expect(Object.keys(preview.visitorCycle.recoveries)).toHaveLength(0)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const dead = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const recoveries = Object.values(dead.visitorCycle.recoveries)

    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]?.itemIds).toEqual([scenario.loanItemId])
    expect(dead.itemPlacements[scenario.loanItemId]).toMatchObject({ ownerKind: 'caravan', custodyKind: 'recovery' })
    expect(dead.visitorCycle.visitors[scenario.visitorId]).toMatchObject({ state: 'dead', recoveryId: recoveries[0]?.recoveryId })
    expect(isPersistedCanonical(dead)).toBe(true)
  })

  it('assigns and resolves recovery without capturing visitor-owned belongings', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 18)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const dead = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const recovery = Object.values(dead.visitorCycle.recoveries)[0]!
    const rescuer = Object.values(dead.visitorCycle.visitors).find((visitor) => visitor.state === 'available')!
    const supportLoan = dead.stash[0]!
    const assigned = apply(dead, {
      action: 'assign_recovery', recoveryId: recovery.recoveryId, visitorId: rescuer.visitorId,
      optionId: recovery.options[0]!.optionId, loanItemIds: [supportLoan]
    }, scenario.dependencies)
    scenario.dependencies.now = () => new Date(assigned.visitorCycle.recoveries[recovery.recoveryId]!.completesAt!)
    const resolved = apply(assigned, { action: 'reconcile_game' }, scenario.dependencies)

    expect(resolved.visitorCycle.recoveries[recovery.recoveryId]).toMatchObject({
      state: 'recovered', recoveredItemIds: [scenario.loanItemId]
    })
    expect(resolved.itemPlacements[scenario.loanItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(resolved.itemPlacements[supportLoan]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    const visitorOwned = Object.entries(resolved.itemPlacements).filter(([, placement]) => placement.ownerKind === 'visitor')
    expect(visitorOwned.every(([, placement]) => placement.custodyKind === 'visitor')).toBe(true)
  })

  it('projects complete executable bindings without exposing sealed events or rolls', () => {
    const created = baseGame()
    const view = mapPersistedGameToGameView(created.game, created.now)
    const visitor = view.visitors.find((entry) => entry.visitorId === created.visitorId)
    const action = visitor?.actions.find((entry) => entry.action === 'accept_contract')
    expect(action).toMatchObject({ enabled: true, execution: { visitorId: created.visitorId } })
    expect(JSON.stringify(view)).not.toMatch(/"events"|"damage"|"succeeds"|"departureResolution":"(stays|departs)"/)
  })
})

function activeScenario(): ReturnType<typeof baseGame> & { game: PersistedGameV3; expeditionId: string; loanItemId: string } {
  const created = baseGame()
  const loanItemId = created.game.stash[0]!
  const optionId = created.game.visitorCycle.visitors[created.visitorId]!.contractOptions[0]!.optionId
  const contracted = apply(created.game, {
    action: 'accept_contract', visitorId: created.visitorId, optionId, loanItemIds: [loanItemId]
  }, created.dependencies)
  const contract = Object.values(contracted.visitorCycle.contracts)[0]!
  const game = apply(contracted, { action: 'start_expedition', contractId: contract.contractId }, created.dependencies)
  return { ...created, game, expeditionId: contract.expeditionId, loanItemId }
}

function baseGame(): { game: PersistedGameV3; visitorId: string; now: Date; dependencies: PersistenceDependencies } {
  const now = new Date('2026-09-15T00:00:00.000Z')
  let id = 0
  let roll = 0
  const dependencies: PersistenceDependencies = {
    now: () => now,
    uuid: () => String(++id).padStart(4, '0'),
    random: () => 0.9
  }
  const game = buildPersistedFromPublic(createSaveGame('v2-cycle', now, () => (++roll % 997) / 997), undefined, dependencies)
  const visitorId = Object.keys(game.visitorCycle.visitors)[0]!
  return { game, visitorId, now, dependencies }
}

function apply(game: PersistedGameV3, command: Parameters<typeof applyVisitorCycleCommand>[1], dependencies: PersistenceDependencies): PersistedGameV3 {
  return applyVisitorCycleCommand(game, command, dependencies)
}

function event(at: Date, damage: number, gold = 20) {
  return { eventId: `event-${damage}`, occursAt: at.toISOString(), damage, gold }
}
