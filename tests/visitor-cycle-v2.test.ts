import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createSaveGame } from '../utils/game-logic'
import { buildPersistedFromPublic, hydratePersistedGame, isPersistedCanonical, type PersistenceDependencies, type PersistedGameV3 } from '../server/utils/savegame'
import { applyVisitorCycleCommand, isVisitorCycle, VisitorCycleError } from '../server/domain/visitor-cycle'
import { mapPersistedGameToGameView } from '../server/domain/game-view'
import { validateGameView } from '../server/utils/game-view-validator'
import { applyItemTransition } from '../server/domain/item-transitions'
import { dismissVisitor } from '../utils/visitor-logic'
import { confirmSettlementPayload } from '../utils/v2-visitor-adapter'

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET
const ORIGINAL_NUXT_JWT_SECRET = process.env.NUXT_JWT_SECRET

beforeAll(() => {
  process.env.JWT_SECRET = 'visitor-cycle-v2-test-secret'
  process.env.NUXT_JWT_SECRET = 'visitor-cycle-v2-test-secret'
})

afterAll(() => {
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET
  if (ORIGINAL_NUXT_JWT_SECRET === undefined) delete process.env.NUXT_JWT_SECRET
  else process.env.NUXT_JWT_SECRET = ORIGINAL_NUXT_JWT_SECRET
})

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

    const nextVisitorId = confirmed.visitRound.slots.find((slot) => slot.visitor?.id !== scenario.visitorId)?.visitor?.id!
    const resold = applyItemTransition(confirmed, {
      operation: 'sell', itemId: scenario.loanItemId, targetId: nextVisitorId
    }).game
    expect(resold.itemPlacements[scenario.loanItemId]).toMatchObject({ ownerKind: 'visitor', ownerId: nextVisitorId })
    expect(isPersistedCanonical(resold)).toBe(true)
  })

  it('rotates sealed options so a staying visitor can accept a later contract', () => {
    const scenario = activeScenario()
    const firstOptionId = scenario.game.visitorCycle.contracts[
      scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.contractId
    ]!.option.optionId
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 0)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const settled = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const nextOptionId = settled.visitorCycle.visitors[scenario.visitorId]!.contractOptions[0]!.optionId

    expect(nextOptionId).not.toBe(firstOptionId)
    const contractedAgain = apply(settled, {
      action: 'accept_contract', visitorId: scenario.visitorId, optionId: nextOptionId, loanItemIds: []
    }, scenario.dependencies)
    expect(Object.values(contractedAgain.visitorCycle.contracts)).toHaveLength(2)
  })

  it('synchronizes a voluntary legacy dismissal after all V2 loans returned', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 0)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const settled = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const compatibility = hydratePersistedGame(settled)
    dismissVisitor(compatibility, scenario.visitorId, scenario.now, () => 0)
    const rebuilt = buildPersistedFromPublic(compatibility, settled, scenario.dependencies)

    expect(rebuilt.visitorCycle.visitors[scenario.visitorId]).toMatchObject({
      state: 'departed', lastExpeditionId: scenario.expeditionId
    })
    expect(isPersistedCanonical(rebuilt)).toBe(true)
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

  it('materializes an observable effect-free preview on the first late reconcile', () => {
    const scenario = activeScenario()
    const eventAt = new Date(scenario.now.getTime() + 1_000)
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(eventAt, 1, 100)]
    const beforeGold = scenario.game.gold
    const materializedAt = new Date(eventAt.getTime() + 60 * 60 * 1000)
    scenario.dependencies.now = () => materializedAt

    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!

    expect(settlement).toMatchObject({
      state: 'preview_ready',
      createdAt: materializedAt.toISOString(),
      expiresAt: new Date(materializedAt.getTime() + 5 * 60 * 1000).toISOString()
    })
    expect(preview.gold).toBe(beforeGold)
    expect(preview.itemPlacements[scenario.loanItemId]).toMatchObject({ custodyKind: 'expedition' })
    expect(mapPersistedGameToGameView(preview, materializedAt).settlements[0]).toMatchObject({
      state: 'preview_ready', actions: [{ action: 'confirm_settlement', enabled: true }]
    })
  })

  it('projects one shared settlement authorization across visitor and settlement containers', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 1)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const view = mapPersistedGameToGameView(preview, scenario.now)
    const settlement = view.settlements[0]
    const visitor = view.visitors.find((candidate) => candidate.visitorId === scenario.visitorId)
    const settlementAction = settlement?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    const visitorAction = visitor?.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)

    if (!settlement || settlement.state !== 'preview_ready'
      || !visitor || visitor.state !== 'awaiting_settlement'
      || !settlementAction || settlementAction.action !== 'confirm_settlement' || !settlementAction.enabled
      || !visitorAction || visitorAction.action !== 'confirm_settlement' || !visitorAction.enabled) {
      throw new Error('Expected projected settlement actions')
    }

    expect(visitorAction.authorizationId).toBe(settlementAction.authorizationId)
    expect(visitorAction.targetId).toBe(visitor.visitorId)
    expect(settlementAction.targetId).toBe(settlement.settlementId)
    expect(visitorAction.execution).toEqual(settlementAction.execution)

    const selectedOptionIds = Object.fromEntries(settlement.choiceGroups.map((group) => [group.groupId, group.options[0]!.optionId]))
    expect(confirmSettlementPayload(view, {
      kind: 'settlement', settlementId: settlement.settlementId, selectedOptionIds
    })).toEqual({
      settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion,
      selectedOptionIds: settlement.choiceGroups.map((group) => selectedOptionIds[group.groupId]!)
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
    const deadView = mapPersistedGameToGameView(dead, scenario.now)
    validateGameView(deadView)
    expect(deadView.recoveries[0]).toMatchObject({
      itemIds: [scenario.loanItemId],
      actions: expect.arrayContaining([
        expect.objectContaining({
          action: 'abandon_recovery',
          consequences: [expect.objectContaining({ destroyedItemIds: [scenario.loanItemId] })]
        })
      ])
    })
    expect(isPersistedCanonical(dead)).toBe(true)

    const abandoned = apply(dead, {
      action: 'abandon_recovery', recoveryId: recoveries[0]!.recoveryId,
      acknowledgementId: `${recoveries[0]!.recoveryId}:abandon`
    }, scenario.dependencies)
    expect(abandoned.itemPlacements[scenario.loanItemId]).toMatchObject({ ownerKind: 'tombstone', custodyKind: 'tombstone' })
    expect(isPersistedCanonical(abandoned)).toBe(true)
  })

  it('keeps a loan-free death terminal after settlement without recovery actions', () => {
    const scenario = baseGame()
    const optionId = scenario.game.visitorCycle.visitors[scenario.visitorId]!.contractOptions[0]!.optionId
    const contracted = apply(scenario.game, {
      action: 'accept_contract', visitorId: scenario.visitorId, optionId, loanItemIds: []
    }, scenario.dependencies)
    const contract = Object.values(contracted.visitorCycle.contracts)[0]!
    const expedition = apply(contracted, { action: 'start_expedition', contractId: contract.contractId }, scenario.dependencies)
    expedition.visitorCycle.expeditions[contract.expeditionId]!.events = [event(scenario.now, 18, 100)]

    const preview = apply(expedition, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const dead = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)

    expect(dead.gold).toBe(expedition.gold + settlement.caravanGold)
    expect(dead.visitorCycle.settlements[settlement.settlementId]).toMatchObject({ state: 'settled', outcome: 'death' })
    expect(dead.visitorCycle.visitors[scenario.visitorId]).toMatchObject({ state: 'dead' })
    expect(Object.values(dead.visitorCycle.recoveries)).toEqual([expect.objectContaining({
      state: 'recovered', itemIds: [], recoveredItemIds: []
    })])

    const deadView = mapPersistedGameToGameView(dead, scenario.now)
    validateGameView(deadView)
    expect(deadView.recoveries).toEqual([expect.objectContaining({
      state: 'recovered', itemIds: [], recoveredItemIds: [], actions: []
    })])
    const gameActionNames = deadView.actions.map((action) => action.action)
    expect(gameActionNames).not.toContain('assign_recovery')
    expect(gameActionNames).not.toContain('abandon_recovery')
    const deadVisitor = deadView.visitors.find((visitor) => visitor.visitorId === scenario.visitorId)
    expect(deadVisitor).toBeDefined()
    const visitorActionNames = deadVisitor!.actions.map((action) => action.action)
    expect(visitorActionNames).not.toContain('assign_recovery')
    expect(visitorActionNames).not.toContain('abandon_recovery')
    expect(isPersistedCanonical(dead)).toBe(true)
  })

  it('keeps historical empty recoveries with assignment metadata canonical', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 18)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    settlement.loanItemIds = []
    const dead = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const recovery = Object.values(dead.visitorCycle.recoveries)[0]!
    Object.assign(recovery, {
      assignedVisitorId: scenario.visitorId,
      assignedAt: scenario.now.toISOString(),
      completesAt: scenario.now.toISOString(),
      succeeds: true
    })

    expect(isVisitorCycle(dead.visitorCycle)).toBe(true)
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
    const compatibility = hydratePersistedGame(assigned)
    expect(compatibility._v2VisitorStates?.[rescuer.visitorId]).toBe('away')
    expect(() => dismissVisitor(compatibility, rescuer.visitorId, scenario.now, () => 0))
      .toThrow('Visitor cannot be dismissed while contracted or away')
    scenario.dependencies.now = () => new Date(assigned.visitorCycle.recoveries[recovery.recoveryId]!.completesAt!)
    const resolved = apply(assigned, { action: 'reconcile_game' }, scenario.dependencies)

    expect(resolved.visitorCycle.recoveries[recovery.recoveryId]).toMatchObject({
      state: 'recovered', recoveredItemIds: [scenario.loanItemId]
    })
    expect(resolved.itemPlacements[scenario.loanItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(resolved.itemPlacements[supportLoan]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    const visitorOwned = Object.entries(resolved.itemPlacements).filter(([, placement]) => placement.ownerKind === 'visitor')
    expect(visitorOwned.every(([, placement]) => placement.custodyKind === 'visitor')).toBe(true)
    const dismantled = applyItemTransition(resolved, {
      operation: 'dismantle', itemId: scenario.loanItemId, targetId: 'scrap'
    }).game
    expect(dismantled.itemPlacements[scenario.loanItemId]).toMatchObject({ ownerKind: 'tombstone', custodyKind: 'tombstone' })
    expect(isPersistedCanonical(dismantled)).toBe(true)
  })

  it('archives terminal legacy slots and replenishes the V2 roster only through reconcile', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 18)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const dead = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)

    expect(dead.visitRound.slots.some((slot) => slot.visitor?.id === scenario.visitorId)).toBe(false)
    expect(dead.visitHistory.some((round) => round.slots.some((slot) => slot.visitor?.id === scenario.visitorId))).toBe(true)
    const replenished = apply(dead, { action: 'reconcile_game' }, scenario.dependencies)
    const activeVisitors = Object.values(replenished.visitorCycle.visitors)
      .filter((visitor) => visitor.state !== 'dead' && visitor.state !== 'departed')
    expect(activeVisitors).toHaveLength(2)
    expect(isPersistedCanonical(replenished)).toBe(true)
  })

  it.each([
    ['departure', 0, 'departs'],
    ['death', 18, 'dead']
  ] as const)('tombstones visitor-owned items evicted from full history on %s settlement', (_case, damage, resolution) => {
    const scenario = activeScenario()
    const evictedItemIds = populateFullVisitorHistory(scenario.game, scenario.now)
    expect(isPersistedCanonical(scenario.game)).toBe(true)
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, damage)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    settlement.departureResolution = resolution

    const settled = apply(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)

    expect(settled.visitHistory).toHaveLength(20)
    expect(evictedItemIds.length).toBeGreaterThan(0)
    expect(evictedItemIds.every((itemId) => settled.itemPlacements[itemId]?.ownerKind === 'tombstone')).toBe(true)
    expect(isPersistedCanonical(settled)).toBe(true)
  })

  it('projects the complete resource state/action matrix', () => {
    const scenario = activeScenario()
    const activeView = mapPersistedGameToGameView(scenario.game, scenario.now)
    const available = baseGame()
    const availableView = mapPersistedGameToGameView(available.game, scenario.now)
    const visitorMatrix = new Map<string, string[]>([
      ['available', ['accept_contract']], ['negotiating', []], ['contracted', ['start_expedition']],
      ['away', []], ['awaiting_settlement', ['confirm_settlement']], ['departed', []], ['dead', []]
    ])
    const projectedActions = (game: PersistedGameV3, visitorId: string) => mapPersistedGameToGameView(game, scenario.now)
      .visitors.find((visitor) => visitor.visitorId === visitorId)!.actions.map((action) => action.action)

    expect(availableView.visitors.find((visitor) => visitor.state === 'available')?.actions.map((action) => action.action))
      .toEqual(visitorMatrix.get('available'))
    expect(activeView.visitors.find((visitor) => visitor.visitorId === scenario.visitorId)?.actions.map((action) => action.action))
      .toEqual(visitorMatrix.get('away'))
    expect(activeView.expeditions).toContainEqual(expect.objectContaining({ state: 'active', actions: [] }))

    const contractOptionId = available.game.visitorCycle.visitors[available.visitorId]!.contractOptions[0]!.optionId
    const contracted = apply(available.game, {
      action: 'accept_contract', visitorId: available.visitorId, optionId: contractOptionId, loanItemIds: []
    }, available.dependencies)
    expect(isPersistedCanonical(contracted)).toBe(true)
    expect(projectedActions(contracted, available.visitorId)).toEqual(visitorMatrix.get('contracted'))
    expect(mapPersistedGameToGameView(contracted, scenario.now).expeditions)
      .toContainEqual(expect.objectContaining({ state: 'scheduled', actions: [] }))

    const negotiating = structuredClone(available.game)
    const negotiatingVisitor = negotiating.visitorCycle.visitors[available.visitorId]!
    negotiatingVisitor.state = 'negotiating'
    negotiatingVisitor.negotiationId = 'negotiation-matrix'
    negotiatingVisitor.expiresAt = new Date(scenario.now.getTime() + 1000).toISOString()
    expect(isPersistedCanonical(negotiating)).toBe(true)
    expect(projectedActions(negotiating, available.visitorId)).toEqual(visitorMatrix.get('negotiating'))

    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 0)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const previewView = mapPersistedGameToGameView(preview, scenario.now)
    expect(isPersistedCanonical(preview)).toBe(true)
    expect(projectedActions(preview, scenario.visitorId)).toEqual(visitorMatrix.get('awaiting_settlement'))
    expect(previewView.expeditions).toContainEqual(expect.objectContaining({ state: 'awaiting_settlement', actions: [] }))
    expect(previewView.settlements[0]?.actions.map((action) => action.action))
      .toEqual(['confirm_settlement'])
    const expiredAt = new Date(settlement.expiresAt)
    expect(mapPersistedGameToGameView(preview, expiredAt).settlements[0]).toMatchObject({ state: 'preview_expired', actions: [] })
    const departed = structuredClone(preview)
    departed.visitorCycle.settlements[settlement.settlementId]!.departureResolution = 'departs'
    const departedResult = apply(departed, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, scenario.dependencies)
    const departedView = mapPersistedGameToGameView(departedResult, scenario.now)
    expect(isPersistedCanonical(departedResult)).toBe(true)
    expect(projectedActions(departedResult, scenario.visitorId)).toEqual(visitorMatrix.get('departed'))
    expect(departedView.expeditions).toContainEqual(expect.objectContaining({ state: 'settled', actions: [] }))
    expect(departedView.settlements[0]).toMatchObject({ state: 'settled', actions: [] })

    const deathScenario = activeScenario()
    deathScenario.game.visitorCycle.expeditions[deathScenario.expeditionId]!.events = [event(deathScenario.now, 18)]
    const deathPreview = apply(deathScenario.game, { action: 'reconcile_game' }, deathScenario.dependencies)
    const deathSettlement = Object.values(deathPreview.visitorCycle.settlements)[0]!
    const dead = apply(deathPreview, {
      action: 'confirm_settlement', settlementId: deathSettlement.settlementId,
      previewVersion: deathSettlement.previewVersion, selectedOptionIds: []
    }, deathScenario.dependencies)
    expect(projectedActions(dead, deathScenario.visitorId)).toEqual(visitorMatrix.get('dead'))
    const recovery = Object.values(dead.visitorCycle.recoveries)[0]!
    expect(mapPersistedGameToGameView(dead, deathScenario.now).recoveries[0]?.actions.map((action) => action.action).sort())
      .toEqual(['abandon_recovery', 'assign_recovery'])
    expect(mapPersistedGameToGameView(dead, new Date(recovery.expiresAt)).recoveries[0])
      .toMatchObject({ state: 'open', actions: [] })
    const rescuer = Object.values(dead.visitorCycle.visitors).find((visitor) => visitor.state === 'available')!
    const assigned = apply(dead, {
      action: 'assign_recovery', recoveryId: recovery.recoveryId, visitorId: rescuer.visitorId,
      optionId: recovery.options[0]!.optionId, loanItemIds: []
    }, deathScenario.dependencies)
    expect(mapPersistedGameToGameView(assigned, deathScenario.now).recoveries[0]).toMatchObject({ state: 'assigned', actions: [] })
    deathScenario.dependencies.now = () => new Date(assigned.visitorCycle.recoveries[recovery.recoveryId]!.completesAt!)
    expect(mapPersistedGameToGameView(apply(assigned, { action: 'reconcile_game' }, deathScenario.dependencies), deathScenario.dependencies.now())
      .recoveries[0]).toMatchObject({ state: 'recovered', actions: [] })
    const abandoned = apply(dead, {
      action: 'abandon_recovery', recoveryId: recovery.recoveryId,
      acknowledgementId: `${recovery.recoveryId}:abandon`
    }, deathScenario.dependencies)
    expect(mapPersistedGameToGameView(abandoned, deathScenario.now).recoveries[0]).toMatchObject({ state: 'abandoned', actions: [] })
    const failed = structuredClone(assigned)
    failed.visitorCycle.recoveries[recovery.recoveryId]!.succeeds = false
    expect(mapPersistedGameToGameView(apply(failed, { action: 'reconcile_game' }, deathScenario.dependencies), deathScenario.dependencies.now())
      .recoveries[0]).toMatchObject({ state: 'failed', actions: [] })
    expect(mapPersistedGameToGameView(dead, deathScenario.now).actions.map((action) => action.action)).toEqual(['reconcile_game', 'upgrade_caravan'])
  })

  it('accepts only the canonical pre-departure return window', () => {
    const scenario = activeScenario()
    scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = [event(scenario.now, 0)]
    const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const returned = applyItemTransition(preview, {
      operation: 'return', itemId: scenario.loanItemId, targetId: scenario.expeditionId
    }).game
    expect(isPersistedCanonical(returned)).toBe(true)

    const alreadySettled = structuredClone(returned)
    const settledPreview = alreadySettled.visitorCycle.settlements[settlement.settlementId]!
    settledPreview.state = 'settled'
    settledPreview.appliedAt = scenario.now.toISOString()
    settledPreview.appliedBy = 'confirmation'
    settledPreview.appliedChoices = []
    expect(isPersistedCanonical(alreadySettled)).toBe(false)

    const mismatched = structuredClone(returned)
    mismatched.visitorCycle.settlements[settlement.settlementId]!.outcome = 'retreated'
    expect(isPersistedCanonical(mismatched)).toBe(false)

    const deathScenario = activeScenario()
    deathScenario.game.visitorCycle.expeditions[deathScenario.expeditionId]!.events = [event(deathScenario.now, 18)]
    const deathPreview = apply(deathScenario.game, { action: 'reconcile_game' }, deathScenario.dependencies)
    const returnedFromDeath = applyItemTransition(deathPreview, {
      operation: 'return', itemId: deathScenario.loanItemId, targetId: deathScenario.expeditionId
    }).game
    expect(isPersistedCanonical(returnedFromDeath)).toBe(false)
  })

  it('preserves canonical ownership and effect-free previews across generated visitor cycles', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ damage: fc.integer({ min: 0, max: 18 }), gold: fc.integer({ min: 0, max: 50 }) }), { minLength: 1, maxLength: 3 }),
      fc.boolean(),
      (events, useDefault) => {
        const scenario = activeScenario()
        scenario.game.visitorCycle.expeditions[scenario.expeditionId]!.events = events.map((entry, index) =>
          event(new Date(scenario.now.getTime() + index + 1), entry.damage, entry.gold))
        scenario.dependencies.now = () => new Date(scenario.now.getTime() + events.length + 1)
        const beforeGold = scenario.game.gold
        const preview = apply(scenario.game, { action: 'reconcile_game' }, scenario.dependencies)
        const settlement = Object.values(preview.visitorCycle.settlements)[0]!
        expect(settlement).toBeDefined()
        expect(preview.gold).toBe(beforeGold)
        expect(preview.itemPlacements[scenario.loanItemId]).toMatchObject({ custodyKind: 'expedition' })
        expect(isPersistedCanonical(preview)).toBe(true)
        if (useDefault) scenario.dependencies.now = () => new Date(settlement.expiresAt)
        const settled = useDefault
          ? apply(preview, { action: 'reconcile_game' }, scenario.dependencies)
          : apply(preview, {
              action: 'confirm_settlement', settlementId: settlement.settlementId,
              previewVersion: settlement.previewVersion, selectedOptionIds: []
            }, scenario.dependencies)
        expect(settled.gold).toBe(beforeGold + settlement.caravanGold)
        expect(Object.values(settled.visitorCycle.settlements).filter((entry) => entry.state === 'settled')).toHaveLength(1)
        expect(isPersistedCanonical(settled)).toBe(true)
      }
    ), { numRuns: 100 })
  })

  it('projects complete executable bindings without exposing sealed events or rolls', () => {
    const created = baseGame()
    const view = mapPersistedGameToGameView(created.game, created.now)
    const visitor = view.visitors.find((entry) => entry.visitorId === created.visitorId)
    const action = visitor?.actions.find((entry) => entry.action === 'accept_contract')
    expect(action).toMatchObject({ enabled: true, execution: { visitorId: created.visitorId } })
    expect(JSON.stringify(view)).not.toMatch(/"events"|"damage"|"succeeds"|"departureResolution":"(stays|departs)"/)
  })

  it('publishes an actionable reconcile reason when historical contract options expired', () => {
    const created = baseGame()
    const expiresAt = created.game.visitorCycle.visitors[created.visitorId]!.contractOptions[0]!.expiresAt
    const afterExpiry = new Date(Date.parse(expiresAt) + 1)

    const staleView = mapPersistedGameToGameView(created.game, afterExpiry)
    const staleVisitor = staleView.visitors.find((visitor) => visitor.visitorId === created.visitorId)
    expect(staleVisitor?.actions).toContainEqual(expect.objectContaining({
      action: 'accept_contract',
      enabled: false,
      reason: 'OPTION_STALE',
      reasonText: expect.objectContaining({ fallback: expect.stringContaining('Reconciliá') })
    }))

    created.dependencies.now = () => afterExpiry
    const reconciled = apply(created.game, { action: 'reconcile_game' }, created.dependencies)
    const refreshedView = mapPersistedGameToGameView(reconciled, afterExpiry)
    const refreshedVisitor = refreshedView.visitors.find((visitor) => visitor.visitorId === created.visitorId)
    expect(refreshedVisitor?.actions).toContainEqual(expect.objectContaining({
      action: 'accept_contract',
      enabled: true
    }))
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

function populateFullVisitorHistory(game: PersistedGameV3, now: Date): string[] {
  let evictedItemIds: string[] = []
  game.visitHistory = []
  for (let index = 0; index < 20; index += 1) {
    let roll = (index + 1) / 100
    const donor = buildPersistedFromPublic(createSaveGame(`history-${index}`, now, () => {
      roll = (roll * 9301 + 49297) % 233280
      return roll / 233280
    }))
    const round = structuredClone(donor.visitRound)
    round.id = `history-round-${index}`
    round.number = index
    const imported: string[] = []
    for (const [slotIndex, slot] of round.slots.entries()) {
      if (!slot.visitor) continue
      const oldId = slot.visitor.id
      const visitorId = `history-visitor-${index}-${slotIndex}`
      slot.visitor.id = visitorId
      for (const [offerIndex, offer] of slot.visitor.offers.entries()) {
        const source = donor.itemsById[offer.itemId]!
        const itemId = `history-item-${index}-${slotIndex}-${offerIndex}`
        offer.itemId = itemId
        game.itemsById[itemId] = { ...structuredClone(source), id: itemId }
        game.itemPlacements[itemId] = { ownerKind: 'visitor', ownerId: visitorId, custodyKind: 'visitor', custodyId: visitorId }
        imported.push(itemId)
      }
      slot.visitor.buyQuotes = Object.fromEntries(Object.entries(slot.visitor.buyQuotes).map(([itemId, quote]) => [`${oldId}:${itemId}`, quote]))
    }
    game.visitHistory.push(round)
    if (index === 19) evictedItemIds = imported
  }
  return evictedItemIds
}
