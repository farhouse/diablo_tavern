import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient, type Collection } from 'mongodb'
import type { SaveGame } from '../types/game'
import type { PersistedGameV3 } from '../server/utils/savegame'

const mongoUri = process.env.MONGO_TEST_URI
const suite = mongoUri ? describe : describe.skip
let client: MongoClient
let collection: Collection
let repositoryCollection: Collection
const prefix = `alta43-${process.pid}`
const userIds = [`${prefix}-replay`, `${prefix}-reset`, `${prefix}-business`, `${prefix}-sell-loan`, `${prefix}-sell-dismantle`, `${prefix}-service-loan`, `${prefix}-transition-replay`, `${prefix}-custody`, `${prefix}-materials`, `${prefix}-uncertain`, `${prefix}-corrupt`, `${prefix}-commission-flow`, `${prefix}-service-roundtrip`, `${prefix}-retained-return`, `${prefix}-retained-missing-source`, `${prefix}-retained-malformed-source`, `${prefix}-retained-backfill-race`, `${prefix}-v2-cycle`, `${prefix}-settlement-race`, `${prefix}-double-advance`, `${prefix}-return-departure`, `${prefix}-recovery-abandon`]

vi.mock('../server/utils/db', () => ({ saveGamesCollection: async () => repositoryCollection }))

suite('PersistedGameV3 against isolated real MongoDB', () => {
  beforeAll(async () => {
    client = new MongoClient(mongoUri!)
    await client.connect()
    collection = client.db('diablo_tavern_alta43_integration').collection('savegames')
    repositoryCollection = collection
    await collection.createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' })
    await collection.deleteMany({ userId: { $in: userIds } })
  })

  afterAll(async () => {
    if (!client) return
    await collection.deleteMany({ userId: { $in: userIds } })
    await client.close()
  })

  it('commits concurrent retries once and reloads the exact public response', async () => {
    const { getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await getSaveGame(userIds[0]!)
    const command = { amount: 37 }
    const mutate = (save: SaveGame) => { save.gold += 37 }
    const [first, retry] = await Promise.all([
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', 'mongo-credit:one', 0, command, mutate),
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', 'mongo-credit:one', 0, command, mutate)
    ])
    const reloaded = await getSaveGame(userIds[0]!)
    const persisted = await collection.findOne({ userId: userIds[0] })
    expect(first).toEqual(retry)
    expect(reloaded).toEqual(first)
    expect(first.gold).toBe(487)
    expect(persisted?.requestRecords).toHaveLength(1)
    expect(persisted?.ledger).toHaveLength(1)
  })

  it('commits one V2 contract under concurrent identical retries and reloads its exact GameView', async () => {
    const { getPersistedGameV3, mutateVisitorCycleAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[17]!)
    const visitorId = Object.keys(initial.visitorCycle.visitors)[0]!
    const optionId = initial.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    const command = { action: 'accept_contract' as const, visitorId, optionId, loanItemIds: [initial.stash[0]!] }
    let id = 0
    const dependencies = {
      now: () => new Date(initial.createdAt), random: () => 0.9,
      uuid: () => `mongo-v2-${++id}`
    }
    const execute = () => mutateVisitorCycleAtomic(
      userIds[17]!, 'mongo-v2-request', 0, command, `v2:contract:${visitorId}`,
      mapPersistedGameToGameView, dependencies
    )

    const [first, retry] = await Promise.all([execute(), execute()])
    const stored = await getPersistedGameV3(userIds[17]!)
    expect(retry).toEqual(first)
    expect(first.game.visitors.find((visitor) => visitor.visitorId === visitorId)?.state).toBe('contracted')
    expect(stored.ledger).toHaveLength(1)
    expect(stored.requestRecords).toHaveLength(1)
    expect(stored.itemPlacements[command.loanItemIds[0]!]).toMatchObject({ custodyKind: 'expedition' })
  })

  it('allows one Mongo winner for settlement confirmation versus expiry default', async () => {
    const { getPersistedGameV3, mutateVisitorCycleAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    const { applyVisitorCycleCommand } = await import('../server/domain/visitor-cycle')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[18]!)
    const visitorId = Object.keys(initial.visitorCycle.visitors)[0]!
    const optionId = initial.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    const startedAt = new Date(initial.createdAt)
    let id = 0
    const prepareDependencies = { now: () => startedAt, random: () => 0.9, uuid: () => `settlement-race-${++id}` }
    const contracted = applyVisitorCycleCommand(initial, {
      action: 'accept_contract', visitorId, optionId, loanItemIds: [initial.stash[0]!]
    }, prepareDependencies)
    const contract = Object.values(contracted.visitorCycle.contracts)[0]!
    const active = applyVisitorCycleCommand(contracted, { action: 'start_expedition', contractId: contract.contractId }, prepareDependencies)
    active.visitorCycle.expeditions[contract.expeditionId]!.events = [{
      eventId: 'settlement-race-event', occursAt: startedAt.toISOString(), damage: 0, gold: 100
    }]
    const preview = applyVisitorCycleCommand(active, { action: 'reconcile_game' }, prepareDependencies)
    await collection.replaceOne({ userId: userIds[18] }, preview)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const beforeGold = preview.gold
    const confirmDependencies = { ...prepareDependencies, now: () => new Date(Date.parse(settlement.expiresAt) - 1) }
    const defaultDependencies = { ...prepareDependencies, now: () => new Date(settlement.expiresAt) }

    const results = await Promise.allSettled([
      mutateVisitorCycleAtomic(userIds[18]!, 'settlement-confirm', 0, {
        action: 'confirm_settlement', settlementId: settlement.settlementId,
        previewVersion: settlement.previewVersion, selectedOptionIds: []
      }, `settlement:${settlement.settlementId}`, mapPersistedGameToGameView, confirmDependencies),
      mutateVisitorCycleAtomic(userIds[18]!, 'settlement-default', 0, {
        action: 'reconcile_game'
      }, 'reconcile:0', mapPersistedGameToGameView, defaultDependencies)
    ])
    const stored = await getPersistedGameV3(userIds[18]!)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: expect.any(RevisionConflictError)
    })
    expect(stored.revision).toBe(1)
    expect(stored.ledger).toHaveLength(1)
    expect(stored.gold).toBe(beforeGold + settlement.caravanGold)
    expect(stored.visitorCycle.settlements[settlement.settlementId]?.state).toBe('settled')
  })

  it('allows one Mongo CAS winner for a double expedition advance', async () => {
    const { getPersistedGameV3, isPersistedCanonical, mutateVisitorCycleAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    const { applyVisitorCycleCommand } = await import('../server/domain/visitor-cycle')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[19]!)
    const visitorId = Object.keys(initial.visitorCycle.visitors)[0]!
    const optionId = initial.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    const now = new Date(initial.createdAt)
    const dependencies = { now: () => now, random: () => 0.9, uuid: () => 'double-advance' }
    const contracted = applyVisitorCycleCommand(initial, {
      action: 'accept_contract', visitorId, optionId, loanItemIds: [initial.stash[0]!]
    }, dependencies)
    const contract = Object.values(contracted.visitorCycle.contracts)[0]!
    const active = applyVisitorCycleCommand(contracted, { action: 'start_expedition', contractId: contract.contractId }, dependencies)
    active.visitorCycle.expeditions[contract.expeditionId]!.events = [{
      eventId: 'double-advance-event', occursAt: now.toISOString(), damage: 0, gold: 75
    }]
    await collection.replaceOne({ userId: userIds[19] }, active)
    const execute = (requestId: string) => mutateVisitorCycleAtomic(
      userIds[19]!, requestId, 0, { action: 'reconcile_game' }, `reconcile:${requestId}`,
      mapPersistedGameToGameView, dependencies
    )

    const results = await Promise.allSettled([execute('advance-a'), execute('advance-b')])
    const stored = await getPersistedGameV3(userIds[19]!)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect(stored.revision).toBe(1)
    expect(stored.ledger).toHaveLength(1)
    expect(Object.values(stored.visitorCycle.settlements)).toHaveLength(1)
    expect(Object.values(stored.visitorCycle.settlements)[0]).toMatchObject({ state: 'preview_ready', grossGold: 75 })
    expect(isPersistedCanonical(stored)).toBe(true)
  })

  it('allows one Mongo CAS winner for loan return versus visitor departure', async () => {
    const { getPersistedGameV3, isPersistedCanonical, mutateVisitorCycleAtomic, RevisionConflictError, transitionItemAtomic } = await import('../server/utils/savegame')
    const { applyVisitorCycleCommand } = await import('../server/domain/visitor-cycle')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[20]!)
    const visitorId = Object.keys(initial.visitorCycle.visitors)[0]!
    const optionId = initial.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    const loanItemId = initial.stash[0]!
    const now = new Date(initial.createdAt)
    let id = 0
    const dependencies = { now: () => now, random: () => 0.9, uuid: () => `return-departure-${++id}` }
    const contracted = applyVisitorCycleCommand(initial, {
      action: 'accept_contract', visitorId, optionId, loanItemIds: [loanItemId]
    }, dependencies)
    const contract = Object.values(contracted.visitorCycle.contracts)[0]!
    const active = applyVisitorCycleCommand(contracted, { action: 'start_expedition', contractId: contract.contractId }, dependencies)
    active.visitorCycle.expeditions[contract.expeditionId]!.events = [{
      eventId: 'return-departure-event', occursAt: now.toISOString(), damage: 0, gold: 50
    }]
    const preview = applyVisitorCycleCommand(active, { action: 'reconcile_game' }, dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    settlement.departureResolution = 'departs'
    await collection.replaceOne({ userId: userIds[20] }, preview)

    const results = await Promise.allSettled([
      transitionItemAtomic(userIds[20]!, 'concurrent-return', 0, {
        operation: 'return', itemId: loanItemId, targetId: contract.expeditionId
      }),
      mutateVisitorCycleAtomic(userIds[20]!, 'concurrent-departure', 0, {
        action: 'confirm_settlement', settlementId: settlement.settlementId,
        previewVersion: settlement.previewVersion, selectedOptionIds: []
      }, `settlement:${settlement.settlementId}`, mapPersistedGameToGameView, dependencies)
    ])
    const stored = await getPersistedGameV3(userIds[20]!)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect(stored.revision).toBe(1)
    expect(stored.ledger).toHaveLength(1)
    expect(stored.itemPlacements[loanItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(['awaiting_settlement', 'departed']).toContain(stored.visitorCycle.visitors[visitorId]?.state)
    expect(isPersistedCanonical(stored)).toBe(true)
  })

  it('allows one Mongo CAS winner for recovery assignment versus abandonment', async () => {
    const { getPersistedGameV3, isPersistedCanonical, mutateVisitorCycleAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    const { applyVisitorCycleCommand } = await import('../server/domain/visitor-cycle')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[21]!)
    const visitorId = Object.keys(initial.visitorCycle.visitors)[0]!
    const optionId = initial.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    const loanItemId = initial.stash[0]!
    const now = new Date(initial.createdAt)
    let id = 0
    const dependencies = { now: () => now, random: () => 0.9, uuid: () => `recovery-abandon-${++id}` }
    const contracted = applyVisitorCycleCommand(initial, {
      action: 'accept_contract', visitorId, optionId, loanItemIds: [loanItemId]
    }, dependencies)
    const contract = Object.values(contracted.visitorCycle.contracts)[0]!
    const active = applyVisitorCycleCommand(contracted, { action: 'start_expedition', contractId: contract.contractId }, dependencies)
    active.visitorCycle.expeditions[contract.expeditionId]!.events = [{
      eventId: 'recovery-abandon-event', occursAt: now.toISOString(), damage: 18, gold: 0
    }]
    const preview = applyVisitorCycleCommand(active, { action: 'reconcile_game' }, dependencies)
    const settlement = Object.values(preview.visitorCycle.settlements)[0]!
    const dead = applyVisitorCycleCommand(preview, {
      action: 'confirm_settlement', settlementId: settlement.settlementId,
      previewVersion: settlement.previewVersion, selectedOptionIds: []
    }, dependencies)
    const recovery = Object.values(dead.visitorCycle.recoveries)[0]!
    const rescuer = Object.values(dead.visitorCycle.visitors).find((visitor) => visitor.state === 'available')!
    const supportLoanId = dead.stash[0]!
    await collection.replaceOne({ userId: userIds[21] }, dead)

    const results = await Promise.allSettled([
      mutateVisitorCycleAtomic(userIds[21]!, 'concurrent-recovery', 0, {
        action: 'assign_recovery', recoveryId: recovery.recoveryId, visitorId: rescuer.visitorId,
        optionId: recovery.options[0]!.optionId, loanItemIds: [supportLoanId]
      }, `recovery:${recovery.recoveryId}:assign`, mapPersistedGameToGameView, dependencies),
      mutateVisitorCycleAtomic(userIds[21]!, 'concurrent-abandon', 0, {
        action: 'abandon_recovery', recoveryId: recovery.recoveryId,
        acknowledgementId: `${recovery.recoveryId}:abandon`
      }, `recovery:${recovery.recoveryId}:abandon`, mapPersistedGameToGameView, dependencies)
    ])
    const stored = await getPersistedGameV3(userIds[21]!)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect(stored.revision).toBe(1)
    expect(stored.ledger).toHaveLength(1)
    expect(['assigned', 'abandoned']).toContain(stored.visitorCycle.recoveries[recovery.recoveryId]?.state)
    expect(isPersistedCanonical(stored)).toBe(true)
  })

  it('rejects stale CAS and a second requestId for one permanent business key', async () => {
    const { BusinessKeyConflictError, mutateSaveGameAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic(userIds[2]!, 'business-a', 'business:one', 0, {}, () => {})
    await expect(mutateSaveGameAtomic(userIds[2]!, 'stale', 'business:other', 0, {}, () => {}))
      .rejects.toBeInstanceOf(RevisionConflictError)
    await expect(mutateSaveGameAtomic(userIds[2]!, 'business-b', 'business:one', 1, {}, () => {}))
      .rejects.toBeInstanceOf(BusinessKeyConflictError)
  })

  it('replays the exact item-transition response after later commits', async () => {
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[6]!)
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing'
    const command = { operation: 'sell' as const, itemId, targetId: visitorId }
    const first = await transitionItemAtomic(userIds[6]!, 'transition-replay', 0, command)
    await mutateSaveGameAtomic(userIds[6]!, 'later-command', 'later:credit', 1, { amount: 1 }, (save) => { save.gold += 1 })
    const replay = await transitionItemAtomic(userIds[6]!, 'transition-replay', 0, command)
    expect(replay).toEqual(first)
    expect(replay.revision).toBe(1)
  })

  it('reloads and projects custody, records material conservation and permits a new loan instance', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const custody = await getPersistedGameV3(userIds[7]!)
    const itemId = custody.stash[0]!
    addExpedition(custody, 'expedition-a')
    addExpedition(custody, 'expedition-b', 1)
    await collection.replaceOne({ userId: userIds[7] }, custody)
    await transitionItemAtomic(userIds[7]!, 'mongo-loan-a', 0, { operation: 'loan', itemId, targetId: 'expedition-a' })
    const projected = mapPersistedGameToGameView(await getPersistedGameV3(userIds[7]!), new Date('2026-09-13T12:00:00.000Z'))
    expect(projected.expeditions).toEqual([])
    expect(projected.items).not.toContainEqual(expect.objectContaining({ itemId }))
    expect(projected.capacity.used).toBe(custody.stash.length)
    await transitionItemAtomic(userIds[7]!, 'mongo-return-a', 1, { operation: 'return', itemId, targetId: 'expedition-a' })
    expect((await getPersistedGameV3(userIds[7]!)).expeditionsById['expedition-a']).toBeDefined()
    await transitionItemAtomic(userIds[7]!, 'mongo-loan-b', 2, { operation: 'loan', itemId, targetId: 'expedition-b' })

    const materials = await getPersistedGameV3(userIds[8]!)
    const dismantledId = materials.stash[0]!
    await transitionItemAtomic(userIds[8]!, 'mongo-dismantle', 0, { operation: 'dismantle', itemId: dismantledId, targetId: 'scrap' })
    const persisted = await collection.findOne({ userId: userIds[8] })
    expect(persisted?.ledger[0].materialDeltas.scrap).toBe(persisted?.materials.scrap)
  })

  it('does not let a real-Mongo compatibility read advance a legacy commission', async () => {
    const { getPersistedGameV3, getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { assignVisitorCommission } = await import('../utils/visitor-logic')
    const initial = await getPersistedGameV3(userIds[11]!)
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    const start = new Date('2026-09-13T00:00:00.000Z')
    const dependencies = { now: () => start, random: () => 0, uuid: () => 'mongo-pending-flow' }
    await mutateSaveGameAtomic(userIds[11]!, 'mongo-assign-flow', 'commission:assign:mongo-flow', 0, {}, (save) => {
      const visitor = save.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
      visitor.state = 'traded'
      assignVisitorCommission(save, visitorId, 'safe', () => 0, start)
    }, dependencies)
    const assigned = await getPersistedGameV3(userIds[11]!)
    const finish = assigned.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!.finishesAt
    const reconcileDependencies = { ...dependencies, now: () => new Date(finish) }
    await getSaveGame(userIds[11]!, reconcileDependencies)
    const unchanged = await getPersistedGameV3(userIds[11]!)
    const unchangedVisitor = unchanged.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
    expect(unchanged.revision).toBe(assigned.revision)
    expect(unchangedVisitor.state).toBe('commissioned')
    expect(unchangedVisitor.commission).toMatchObject({ status: 'active', finishesAt: finish })
    expect(unchangedVisitor.commission?.rewardItemId).toBeUndefined()
  })

  it('preserves normative service custody through a generic Mongo mutation', async () => {
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[12]!)
    const itemId = initial.stash[0]!
    initial.serviceJobsById['mongo-service'] = {
      id: 'mongo-service', itemIds: [],
      projection: { kind: 'service', service: 'blacksmith', queuedAt: initial.updatedAt, startsAt: initial.updatedAt }
    }
    await collection.replaceOne({ userId: userIds[12] }, initial)
    await transitionItemAtomic(userIds[12]!, 'mongo-service-item', 0, { operation: 'service', itemId, targetId: 'mongo-service' })
    await mutateSaveGameAtomic(userIds[12]!, 'mongo-generic', 'generic:gold', 1, {}, (save) => { save.gold += 1 })
    const reloaded = await getPersistedGameV3(userIds[12]!)
    expect(reloaded.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: 'mongo-service' })
    expect(reloaded.serviceJobsById['mongo-service']?.itemIds).toEqual([itemId])
  })

  it('returns the final retained loan after its visitor ages out and prunes the lifecycle', async () => {
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const { retainedLifecycle, itemId, visitorId, historicalName, departedAt } = await createLegacyRetainedLifecycle(userIds[13]!)
    await collection.replaceOne({ userId: userIds[13] }, retainedLifecycle)
    const backfilled = await getPersistedGameV3(userIds[13]!)
    expect(backfilled.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))
    await mutateSaveGameAtomic(userIds[13]!, 'unrelated-gold', 'generic:retained-stability', 1, {}, (save) => { save.gold += 1 })
    const retained = await getPersistedGameV3(userIds[13]!)
    expect(retained.visitHistory.flatMap((round) => round.slots).some((slot) => slot.visitor?.id === visitorId)).toBe(false)
    expect(retained.expeditionsById['retained-expedition']?.itemIds).toEqual([itemId])
    expect(retained.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))

    vi.doMock('../server/utils/auth', () => ({
      requireUser: async () => ({ id: userIds[13]!, email: 'retained@example.test' })
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { default: getGameHandler } = await import('../server/api/v2/game.get')
    const retainedView = await getGameHandler({} as never)
    expect(retainedView.visitors).toContainEqual(expect.objectContaining({
      visitorId,
      name: { key: `visitor.${visitorId}`, fallback: historicalName },
      state: 'departed',
      departedAt,
      lastExpeditionId: 'retained-expedition'
    }))
    expect(retainedView.expeditions).toEqual([])
    expect(retainedView.items).not.toContainEqual(expect.objectContaining({ itemId }))

    const revisionBeforeReturn = (await getPersistedGameV3(userIds[13]!)).revision
    await transitionItemAtomic(userIds[13]!, 'return-retained', revisionBeforeReturn, { operation: 'return', itemId, targetId: 'retained-expedition' })
    const returned = await getPersistedGameV3(userIds[13]!)
    expect(returned.stash).toContain(itemId)
    expect(returned.expeditionsById['retained-expedition']).toBeUndefined()
    const returnedView = await getGameHandler({} as never)
    expect(returnedView.expeditions).not.toContainEqual(expect.objectContaining({ expeditionId: 'retained-expedition' }))
    expect(returnedView.visitors).toContainEqual(expect.objectContaining({ visitorId, state: 'departed' }))
  })

  it.each([
    ['absent', userIds[14]!],
    ['malformed', userIds[15]!]
  ])('rejects an %s replay source with the typed corruption error', async (sourceKind, userId) => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const { retainedLifecycle } = await createLegacyRetainedLifecycle(userId)
    const corrupt = structuredClone(retainedLifecycle) as unknown as Record<string, unknown>
    if (sourceKind === 'absent') delete corrupt.requestRecords
    else corrupt.requestRecords = [undefined]
    await collection.replaceOne({ userId }, corrupt)

    await expect(getPersistedGameV3(userId)).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it('converges concurrent backfill readers without changing aggregate identity or economics', async () => {
    const { getPersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    const userId = userIds[16]!
    const { retainedLifecycle, historicalName, departedAt } = await createLegacyRetainedLifecycle(userId)
    await collection.replaceOne({ userId }, retainedLifecycle)
    const before = await collection.findOne({ userId })
    if (!before) throw new Error('Expected recoverable document')

    let initialReads = 0
    let releaseReaders!: () => void
    const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve })
    repositoryCollection = {
      findOne: async (...args: Parameters<Collection['findOne']>) => {
        const found = await collection.findOne(...args)
        initialReads += 1
        if (initialReads === 2) releaseReaders()
        else if (initialReads < 2) await bothRead
        return found
      },
      replaceOne: (...args: Parameters<Collection['replaceOne']>) => collection.replaceOne(...args)
    } as unknown as Collection

    let readers: PersistedGameV3[]
    try {
      readers = await Promise.all([getPersistedGameV3(userId), getPersistedGameV3(userId)])
    } finally {
      repositoryCollection = collection
    }

    const after = await collection.findOne({ userId })
    expect(after).not.toBeNull()
    expect(isPersistedCanonical(after)).toBe(true)
    expect(await collection.countDocuments({ userId })).toBe(1)
    expect(readers[0]).toEqual(readers[1])
    expect(readers[0]?.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))
    expect(after?._id).toEqual(before._id)
    expect(after?.revision).toBe(before.revision)
    expect(after?.gold).toBe(before.gold)
    expect(after?.materials).toEqual(before.materials)
    expect(after?.ledger).toEqual(before.ledger)
    expect(after?.businessKeys).toEqual(before.businessKeys)
    expect(after?.expeditionsById['retained-expedition'].projection.retainedVisitor)
      .toEqual({ name: historicalName, departedAt })
  })

  it('recovers the committed response after the repository driver throws', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[9]!)
    const itemId = initial.stash[0]!
    addExpedition(initial, 'uncertain-expedition')
    await collection.replaceOne({ userId: userIds[9] }, initial)
    repositoryCollection = {
      findOne: (...args: Parameters<Collection['findOne']>) => collection.findOne(...args),
      replaceOne: async (...args: Parameters<Collection['replaceOne']>) => {
        await collection.replaceOne(...args)
        throw new Error('simulated Mongo network loss after acknowledged server commit')
      }
    } as unknown as Collection
    try {
      const response = await transitionItemAtomic(userIds[9]!, 'mongo-uncertain', 0, { operation: 'loan', itemId, targetId: 'uncertain-expedition' })
      expect(response.revision).toBe(1)
      expect((await collection.findOne({ userId: userIds[9] }))?.ledger).toHaveLength(1)
    } finally {
      repositoryCollection = collection
    }
  })

  it('rejects a declared V3 document with legacy or incomplete nested fields', async () => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const corrupt = await getPersistedGameV3(userIds[10]!)
    const itemId = corrupt.stash[0]!
    corrupt.itemsById[itemId] = { id: itemId } as never
    await collection.replaceOne({ userId: userIds[10] }, { ...corrupt, processedRequests: [] })
    await expect(getPersistedGameV3(userIds[10]!)).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it.each([
    ['sell', 'loan', userIds[3]!],
    ['sell', 'dismantle', userIds[4]!],
    ['service', 'loan', userIds[5]!]
  ])('allows one Mongo CAS winner for %s versus %s', async (firstName, secondName, userId) => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing-visitor'
    const targetFor = (operation: string) => operation === 'sell' ? visitorId : `${operation}-target`
    for (const operation of [firstName, secondName]) {
      const targetId = targetFor(operation)
      if (operation === 'loan') addExpedition(initial, targetId)
      if (operation === 'service') initial.serviceJobsById[targetId] = {
        id: targetId, itemIds: [], projection: { kind: 'service', service: 'blacksmith', queuedAt: initial.updatedAt, startsAt: initial.updatedAt }
      }
    }
    await collection.replaceOne({ userId }, initial)
    const results = await Promise.allSettled([
      transitionItemAtomic(userId, `${firstName}-request`, 0, { operation: firstName as never, itemId, targetId: targetFor(firstName) }),
      transitionItemAtomic(userId, `${secondName}-request`, 0, { operation: secondName as never, itemId, targetId: targetFor(secondName) })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const persisted = await collection.findOne({ userId })
    expect(persisted?.ledger).toHaveLength(1)
    expect(persisted?.revision).toBe(1)
    expect(persisted?.ledger[0].itemChanges).toHaveLength(1)
    expect(persisted?.itemPlacements[itemId]).not.toMatchObject({ custodyKind: 'stash' })
  })

  it('resets schema 2 without importing its economy and keeps the unique index', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    await collection.insertOne({ userId: userIds[1], schemaVersion: 2, revision: 4, gold: 999_999, heroes: [{ id: 'old' }] })
    const recreated = await getSaveGame(userIds[1]!)
    const persisted = await collection.findOne({ userId: userIds[1] })
    const indexes = await collection.indexes()
    expect(recreated.gold).toBe(450)
    expect(recreated.revision).toBe(5)
    expect(persisted).not.toHaveProperty('heroes')
    expect(persisted?.itemsById).toBeDefined()
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'userId_unique', unique: true }))
  })
})

function addExpedition(game: PersistedGameV3, id: string, visitorIndex = 0): void {
  const visitor = game.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])[visitorIndex]
  const visitorId = visitor?.id ?? 'missing'
  if (visitor && !visitor.commission) visitor.commission = {
    ...visitor.commissionOptions[0]!, id: `contract-${id}`, status: 'active',
    startedAt: game.updatedAt, finishesAt: game.updatedAt, outcomeRoll: 0.5
  }
  if (visitor?.commission) visitor.state = 'commissioned'
  const contractId = visitor?.commission?.id ?? `contract-${id}`
  game.expeditionsById[id] = {
    id, itemIds: [], projection: { kind: 'expedition', visitorId, contractId, startsAt: game.updatedAt }
  }
}

async function createLegacyRetainedLifecycle(userId: string): Promise<{
  retainedLifecycle: PersistedGameV3
  itemId: string
  visitorId: string
  historicalName: string
  departedAt: string
}> {
  const { buildPersistedFromPublic, getPersistedGameV3, hydratePersistedGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
  const { applyItemTransition } = await import('../server/domain/item-transitions')
  const initial = await getPersistedGameV3(userId)
  addExpedition(initial, 'retained-expedition')
  const visitor = initial.visitRound.slots.find((slot) => slot.visitor?.commission)?.visitor!
  visitor.commission!.id = 'retained-expedition'
  const initialProjection = initial.expeditionsById['retained-expedition']!.projection
  if (initialProjection?.kind !== 'expedition') throw new Error('Expected retained expedition projection')
  initialProjection.contractId = 'retained-expedition'
  const itemId = initial.stash[0]!
  const loaned = applyItemTransition(initial, { operation: 'loan', itemId, targetId: 'retained-expedition' }).game
  const historicalName = visitor.name
  const departedAt = new Date(Date.parse(visitor.commission!.finishesAt) + 60_000).toISOString()
  const departedVisitor = loaned.visitRound.slots.find((slot) => slot.visitor?.id === visitor.id)?.visitor!
  departedVisitor.state = 'departed'
  departedVisitor.departedAt = departedAt
  departedVisitor.commission!.status = 'claimed'
  departedVisitor.commission!.outcome = 'partial'
  departedVisitor.commission!.rewardGold = departedVisitor.commission!.partialRewardGold
  departedVisitor.commission!.claimedAt = departedAt
  loaned.settlementsById['retained-expedition'] = {
    id: 'retained-expedition', itemIds: [],
    projection: {
      kind: 'settlement', expeditionId: 'retained-expedition', outcome: 'retreated',
      appliedAt: departedVisitor.commission!.finishesAt
    }
  }
  const departed = buildPersistedFromPublic(hydratePersistedGame(loaned), loaned)
  await collection.replaceOne({ userId }, departed)
  await mutateSaveGameAtomic(userId, 'capture-departed', 'generic:capture-departed', 0, {}, () => {})
  const withReplay = await getPersistedGameV3(userId)
  const aged = hydratePersistedGame(withReplay)
  aged.visitHistory = []
  aged.visitRound = {
    id: 'empty-current', number: 99,
    slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: aged.updatedAt
  }
  const retainedLifecycle = buildPersistedFromPublic(aged, withReplay)
  const legacyProjection = retainedLifecycle.expeditionsById['retained-expedition']!.projection
  if (legacyProjection?.kind !== 'expedition') throw new Error('Expected retained expedition projection')
  delete legacyProjection.retainedVisitor
  return { retainedLifecycle, itemId, visitorId: visitor.id, historicalName, departedAt }
}
