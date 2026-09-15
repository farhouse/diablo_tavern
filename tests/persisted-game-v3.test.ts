import { describe, expect, it } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { buildPersistedFromPublic, isPersistedCanonical, sanitizeGameResponse, type PersistedGameV3 } from '../server/utils/savegame'
import { mapPersistedGameToGameView } from '../server/domain/game-view'
import { applyItemTransition, effectiveCapacityUsed } from '../server/domain/item-transitions'
import { assignVisitorCommission, refreshVisitRound } from '../utils/visitor-logic'

describe('PersistedGameV3 invariants', () => {
  it('stores each actionable item once and only references it from containers', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('canonical-user'))
    expect(isPersistedCanonical(persisted)).toBe(true)
    expect(new Set(Object.keys(persisted.itemsById)).size).toBe(Object.keys(persisted.itemsById).length)
    expect(Object.keys(persisted.itemPlacements).sort()).toEqual(Object.keys(persisted.itemsById).sort())
    for (const round of [persisted.visitRound, ...persisted.visitHistory]) {
      for (const visitor of round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])) {
        expect(visitor.offers.every((offer) => !Object.hasOwn(offer, 'item') && Boolean(offer.itemId))).toBe(true)
        if (visitor.commission) expect(visitor.commission).not.toHaveProperty('rewardItem')
      }
    }
  })

  it('never exposes persistence bookkeeping through the contractual GameView', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('projection-user'))
    const view = mapPersistedGameToGameView(persisted, new Date('2026-09-13T12:00:00.000Z'))
    expect(view.contractVersion).toBe('v2-etapa0-3')
    expect(view.capacity.used).toBe(effectiveCapacityUsed(persisted))
    expect(view.visitors).toHaveLength(2)
    expect(view.items).toContainEqual(expect.objectContaining({
      owner: expect.objectContaining({ kind: 'visitor' }),
      custody: expect.objectContaining({ kind: 'visitor' })
    }))
    for (const key of ['userId', 'itemsById', 'itemPlacements', 'requestRecords', 'businessKeys', 'ledger', 'serviceJobsById']) {
      expect(view).not.toHaveProperty(key)
    }
  })

  it('rejects capacity overflow, dangling custody and visitor-reference disagreement', () => {
    const capacity = buildPersistedFromPublic(createSaveGame('invalid-capacity'))
    capacity.stashLimit = 1
    expect(isPersistedCanonical(capacity)).toBe(false)

    const dangling = buildPersistedFromPublic(createSaveGame('invalid-custody'))
    const itemId = dangling.stash[0]!
    dangling.stash = dangling.stash.filter((id) => id !== itemId)
    dangling.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'service', custodyId: 'missing-job' }
    expect(isPersistedCanonical(dangling)).toBe(false)

    const visitorMismatch = buildPersistedFromPublic(createSaveGame('invalid-visitor'))
    const offer = visitorMismatch.visitRound.slots[0]!.visitor!.offers[0]!
    visitorMismatch.itemPlacements[offer.itemId] = { ownerKind: 'visitor', ownerId: 'foreign', custodyKind: 'visitor', custodyId: 'foreign' }
    expect(isPersistedCanonical(visitorMismatch)).toBe(false)
  })

  it('rejects incomplete nested items and unknown fields in a declared V3 document', () => {
    const incomplete = buildPersistedFromPublic(createSaveGame('invalid-item'))
    const itemId = incomplete.stash[0]!
    incomplete.itemsById[itemId] = { id: itemId } as never
    expect(isPersistedCanonical(incomplete)).toBe(false)

    const badReplay = buildPersistedFromPublic(createSaveGame('invalid-replay'))
    badReplay.requestRecords.push({
      requestId: 'bad', operationKey: 'bad', businessKey: 'bad', commandHash: 'a'.repeat(64),
      response: {} as never, revision: 0, createdAt: badReplay.createdAt, updatedAt: badReplay.updatedAt
    })
    expect(isPersistedCanonical(badReplay)).toBe(false)

    const unknown = buildPersistedFromPublic(createSaveGame('unknown-field')) as typeof incomplete & { legacyGold?: number }
    unknown.legacyGold = 123
    expect(isPersistedCanonical(unknown)).toBe(false)
  })

  it.each(['loan', 'service', 'recover'] as const)('projects %s custody with its public target and item', (operation) => {
    const persisted = buildPersistedFromPublic(createSaveGame(`projection-${operation}`))
    const itemId = persisted.stash[0]!
    const targetId = `${operation}-target`
    addTarget(persisted, operation, targetId, itemId)
    const transitioned = applyItemTransition(persisted, { operation, itemId, targetId }).game
    const view = mapPersistedGameToGameView(transitioned, new Date('2026-09-13T12:00:00.000Z'))
    expect(view.items).toContainEqual(expect.objectContaining({ itemId }))
    const collection = operation === 'loan' ? view.expeditions : operation === 'service' ? view.serviceJobs : view.recoveries
    expect(collection).toContainEqual(expect.objectContaining(
      operation === 'loan' ? { expeditionId: targetId }
        : operation === 'service' ? { jobId: targetId }
          : { recoveryId: targetId }
    ))
    if (operation === 'loan') {
      const visitorId = persisted.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id
      expect(view.items).toContainEqual(expect.objectContaining({
        itemId,
        custody: expect.objectContaining({ expeditionId: targetId, visitorId })
      }))
      expect(view.expeditions).toContainEqual(expect.objectContaining({ expeditionId: targetId, visitorId }))
    }
  })

  it('preserves normative service custody through compatibility round trips', async () => {
    const persisted = buildPersistedFromPublic(createSaveGame('service-round-trip'))
    const itemId = persisted.stash[0]!
    addTarget(persisted, 'service', 'blacksmith-job', itemId)
    const serviced = applyItemTransition(persisted, { operation: 'service', itemId, targetId: 'blacksmith-job' }).game
    const { hydratePersistedGame } = await import('../server/utils/savegame')
    const rebuilt = buildPersistedFromPublic(hydratePersistedGame(serviced), serviced)

    expect(rebuilt.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: 'blacksmith-job' })
    expect(rebuilt.serviceJobsById['blacksmith-job']?.itemIds).toEqual([itemId])
    expect(isPersistedCanonical(rebuilt)).toBe(true)
  })

  it('rejects sharing one normative service job between multiple items', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('service-cardinality'))
    addTarget(persisted, 'service', 'single-job', persisted.stash[0]!)
    const first = applyItemTransition(persisted, { operation: 'service', itemId: persisted.stash[0]!, targetId: 'single-job' }).game
    expect(() => applyItemTransition(first, { operation: 'service', itemId: first.stash[0]!, targetId: 'single-job' }))
      .toThrow('already has an item')
  })

  it('preserves authoritative expedition history after its item returns', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('expedition-history'))
    addTarget(persisted, 'loan', 'expedition-a')
    const itemId = persisted.stash[0]!
    const loaned = applyItemTransition(persisted, { operation: 'loan', itemId, targetId: 'expedition-a' }).game
    const returned = applyItemTransition(loaned, { operation: 'return', itemId, targetId: 'expedition-a' }).game
    expect(returned.expeditionsById['expedition-a']).toBeDefined()
    expect(returned.expeditionsById['expedition-a']?.itemIds).toEqual([])
    expect(isPersistedCanonical(returned)).toBe(true)
  })

  it('rejects duplicate visitors and expedition contract mismatches', () => {
    const duplicate = buildPersistedFromPublic(createSaveGame('duplicate-visitor'))
    duplicate.visitHistory.push(structuredClone(duplicate.visitRound))
    expect(isPersistedCanonical(duplicate)).toBe(false)

    const mismatch = buildPersistedFromPublic(createSaveGame('contract-mismatch'))
    addTarget(mismatch, 'loan', 'expedition-mismatch')
    const expedition = mismatch.expeditionsById['expedition-mismatch']!
    if (expedition.projection?.kind === 'expedition') expedition.projection.contractId = 'foreign-contract'
    expect(isPersistedCanonical(mismatch)).toBe(false)
  })

  it('requires a bijective commission lifecycle and rejects premature settlements', () => {
    const duplicateExpedition = buildPersistedFromPublic(createSaveGame('duplicate-expedition'))
    addTarget(duplicateExpedition, 'loan', 'first-expedition')
    const first = duplicateExpedition.expeditionsById['first-expedition']!
    duplicateExpedition.expeditionsById['second-expedition'] = {
      ...structuredClone(first), id: 'second-expedition'
    }
    expect(isPersistedCanonical(duplicateExpedition)).toBe(false)

    const prematureSettlement = buildPersistedFromPublic(createSaveGame('premature-settlement'))
    addTarget(prematureSettlement, 'loan', 'active-expedition')
    const visitor = prematureSettlement.visitRound.slots.find((slot) => slot.visitor?.commission)?.visitor!
    prematureSettlement.settlementsById[visitor.commission!.id] = {
      id: visitor.commission!.id,
      itemIds: [],
      projection: {
        kind: 'settlement', expeditionId: 'active-expedition', outcome: 'returned', appliedAt: visitor.commission!.finishesAt
      }
    }
    expect(isPersistedCanonical(prematureSettlement)).toBe(false)
  })

  it('requires settlement custody to equal the pending commission reward exactly', () => {
    const noRewardSave = createSaveGame('settlement-without-reward')
    const noRewardVisitor = noRewardSave.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    noRewardVisitor.state = 'returned'
    noRewardVisitor.commission = {
      ...noRewardVisitor.commissionOptions[0]!, id: 'no-reward', status: 'ready',
      startedAt: noRewardSave.createdAt, finishesAt: noRewardSave.updatedAt, outcomeRoll: 0.5,
      outcome: 'partial', rewardGold: noRewardVisitor.commissionOptions[0]!.partialRewardGold
    }
    const noReward = buildPersistedFromPublic(noRewardSave)
    moveStashItemToSettlement(noReward, noReward.stash[0]!, 'no-reward')
    expect(isPersistedCanonical(noReward)).toBe(false)

    const pendingSave = createSaveGame('settlement-extra-reward')
    const pendingVisitor = pendingSave.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    pendingVisitor.state = 'returned'
    pendingVisitor.commission = {
      ...pendingVisitor.commissionOptions[0]!, id: 'pending-reward', status: 'ready',
      startedAt: pendingSave.createdAt, finishesAt: pendingSave.updatedAt, outcomeRoll: 0.5,
      outcome: 'complete', rewardGold: pendingVisitor.commissionOptions[0]!.fullRewardGold,
      rewardItem: { ...structuredClone(pendingSave.stash[0]!), id: 'reward-item' }
    }
    const pending = buildPersistedFromPublic(pendingSave)
    moveStashItemToSettlement(pending, pending.stash[0]!, 'pending-reward')
    expect(isPersistedCanonical(pending)).toBe(false)
  })

  it('rejects commission state, reward, and timestamp contradictions', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('commission-state'))
    addTarget(persisted, 'loan', 'active-expedition')
    const visitor = persisted.visitRound.slots.find((slot) => slot.visitor?.commission)?.visitor!
    visitor.state = 'returned'
    expect(isPersistedCanonical(persisted)).toBe(false)

    visitor.state = 'commissioned'
    visitor.commission!.outcome = 'complete'
    visitor.commission!.rewardGold = visitor.commission!.fullRewardGold
    expect(isPersistedCanonical(persisted)).toBe(false)
  })

  it('requires ledger and business keys in both directions and bounds replay revisions', () => {
    const orphanLedger = buildPersistedFromPublic(createSaveGame('orphan-ledger'))
    orphanLedger.revision = 1
    orphanLedger.ledger.push({
      at: orphanLedger.updatedAt, requestId: 'orphan-request', operationKey: 'orphan', businessKey: 'orphan',
      commandHash: 'a'.repeat(64), revision: 1, goldDelta: 0, materialDeltas: {}, itemChanges: []
    })
    expect(isPersistedCanonical(orphanLedger)).toBe(false)

    const orphanBusinessKey = buildPersistedFromPublic(createSaveGame('orphan-business-key'))
    orphanBusinessKey.businessKeys.orphan = 'orphan-request'
    expect(isPersistedCanonical(orphanBusinessKey)).toBe(false)

    const futureReplay = buildPersistedFromPublic(createSaveGame('future-replay'))
    futureReplay.requestRecords.push({
      requestId: 'future', operationKey: 'future', businessKey: 'future', commandHash: 'b'.repeat(64),
      response: sanitizeGameResponse(createSaveGame('future-replay')) as never,
      revision: futureReplay.revision + 1, createdAt: futureReplay.createdAt, updatedAt: futureReplay.updatedAt
    })
    expect(isPersistedCanonical(futureReplay)).toBe(false)
  })

  it('requires every retained replay record to match its permanent ledger effect', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('orphan-replay'))
    persisted.revision = 1
    const response = sanitizeGameResponse(createSaveGame('orphan-replay'))
    response.revision = 1
    persisted.requestRecords.push({
      requestId: 'request-1', operationKey: 'credit', businessKey: 'credit:one', commandHash: 'a'.repeat(64),
      response: response as never, revision: 1, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt
    })
    expect(isPersistedCanonical(persisted)).toBe(false)

    persisted.businessKeys['credit:one'] = 'request-1'
    persisted.ledger.push({
      at: persisted.updatedAt, requestId: 'request-1', operationKey: 'debit', commandHash: 'b'.repeat(64),
      businessKey: 'credit:one', revision: 1, goldDelta: 0, materialDeltas: {}, itemChanges: []
    })
    expect(isPersistedCanonical(persisted)).toBe(false)
  })

  it('counts an unclaimed commission reward as caravan property', () => {
    const save = createSaveGame('pending-reward')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: 'commission-reward', status: 'ready',
      startedAt: save.createdAt, finishesAt: save.updatedAt, outcomeRoll: 0.5,
      outcome: 'complete', rewardGold: 10, rewardItem: structuredClone(save.stash[0]!)
    }
    visitor.state = 'returned'
    visitor.commission.rewardGold = visitor.commission.fullRewardGold
    visitor.commission.rewardItem!.id = 'pending-reward-item'
    const persisted = buildPersistedFromPublic(save)
    expect(persisted.itemPlacements['pending-reward-item']).toMatchObject({ ownerKind: 'caravan' })
    expect(effectiveCapacityUsed(persisted)).toBe(save.stash.length + 1)
    const view = mapPersistedGameToGameView(persisted, new Date('2026-09-13T12:00:00.000Z'))
    expect(view.settlements).toContainEqual(expect.objectContaining({ settlementId: 'commission-reward' }))
  })

  it.each(['partial', 'failed'] as const)('projects %s commission lifecycle without fabricating an item', (outcome) => {
    const save = createSaveGame(`commission-${outcome}`)
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.state = 'returned'
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: `commission-${outcome}`, status: 'ready',
      startedAt: save.createdAt, finishesAt: save.updatedAt, outcomeRoll: 0.5,
      outcome, rewardGold: outcome === 'partial' ? visitor.commissionOptions[0]!.partialRewardGold : 0
    }
    const persisted = buildPersistedFromPublic(save)
    const view = mapPersistedGameToGameView(persisted, new Date('2026-09-13T12:00:00.000Z'))
    expect(persisted.expeditionsById[visitor.commission.id]).toBeDefined()
    expect(persisted.settlementsById[visitor.commission.id]?.itemIds).toEqual([])
    expect(view.settlements).toContainEqual(expect.objectContaining({ settlementId: visitor.commission.id }))

    const corrupt = structuredClone(persisted)
    const projection = corrupt.settlementsById[visitor.commission.id]!.projection
    if (projection?.kind === 'settlement') projection.outcome = outcome === 'failed' ? 'returned' : 'death'
    expect(isPersistedCanonical(corrupt)).toBe(false)
  })

  it('projects a completed commission settlement when effective capacity leaves no reward slot', () => {
    const save = createSaveGame('commission-full-capacity')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.state = 'traded'
    const startedAt = new Date('2026-01-01T00:00:00.000Z')
    assignVisitorCommission(save, visitor.id, 'safe', () => 0, startedAt)
    save.stashLimit = save.stash.length
    save._effectiveCapacityUsed = save.stashLimit
    refreshVisitRound(save, new Date(visitor.commission!.finishesAt), () => 0)
    expect(visitor.commission!.rewardItem).toBeUndefined()

    const persisted = buildPersistedFromPublic(save)
    const view = mapPersistedGameToGameView(persisted, new Date(visitor.commission!.finishesAt))
    expect(persisted.settlementsById[visitor.commission!.id]?.itemIds).toEqual([])
    expect(view.settlements).toContainEqual(expect.objectContaining({ settlementId: visitor.commission!.id }))
  })

  it('prunes empty lifecycle after its visitor ages out of bounded history', async () => {
    const persisted = buildPersistedFromPublic(createSaveGame('history-pruning'))
    const visitor = persisted.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.commission = commissionFor(visitor, 'old-contract', persisted.updatedAt)
    visitor.state = 'commissioned'
    persisted.expeditionsById['old-contract'] = {
      id: 'old-contract', itemIds: [],
      projection: { kind: 'expedition', visitorId: visitor.id, contractId: 'old-contract', startsAt: persisted.updatedAt }
    }
    persisted.visitHistory = [structuredClone(persisted.visitRound)]
    persisted.visitRound = {
      id: 'empty-current', number: 99,
      slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: persisted.updatedAt
    }
    for (let index = 0; index < 20; index += 1) {
      persisted.visitHistory.unshift({
        id: `empty-history-${index}`, number: 98 - index,
        slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: persisted.updatedAt
      })
    }
    expect(isPersistedCanonical(persisted)).toBe(true)
    const { hydratePersistedGame } = await import('../server/utils/savegame')
    const rebuilt = buildPersistedFromPublic(hydratePersistedGame(persisted), persisted)
    expect(rebuilt.expeditionsById['old-contract']).toBeUndefined()
    expect(isPersistedCanonical(rebuilt)).toBe(true)
  })

  it('retains a borrowed item lifecycle after its visitor ages out of bounded history', async () => {
    const persisted = buildPersistedFromPublic(createSaveGame('retained-history'))
    const visitor = persisted.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.state = 'commissioned'
    visitor.commission = commissionFor(visitor, 'retained-contract', persisted.updatedAt)
    persisted.expeditionsById['retained-contract'] = {
      id: 'retained-contract', itemIds: [],
      projection: { kind: 'expedition', visitorId: visitor.id, contractId: 'retained-contract', startsAt: persisted.updatedAt }
    }
    const itemId = persisted.stash[0]!
    const loaned = applyItemTransition(persisted, { operation: 'loan', itemId, targetId: 'retained-contract' }).game
    const departedAt = new Date(Date.parse(visitor.commission!.finishesAt) + 60_000).toISOString()
    const historicalName = visitor.name
    const departedVisitor = loaned.visitRound.slots.find((slot) => slot.visitor?.id === visitor.id)?.visitor!
    departedVisitor.state = 'departed'
    departedVisitor.departedAt = departedAt
    departedVisitor.commission!.status = 'claimed'
    departedVisitor.commission!.outcome = 'partial'
    departedVisitor.commission!.rewardGold = departedVisitor.commission!.partialRewardGold
    departedVisitor.commission!.claimedAt = departedAt
    loaned.settlementsById['retained-contract'] = {
      id: 'retained-contract', itemIds: [],
      projection: {
        kind: 'settlement', expeditionId: 'retained-contract', outcome: 'retreated',
        appliedAt: departedVisitor.commission!.finishesAt
      }
    }
    const { hydratePersistedGame } = await import('../server/utils/savegame')
    const departed = buildPersistedFromPublic(hydratePersistedGame(loaned), loaned)
    const aged = hydratePersistedGame(departed)
    aged.visitHistory = [structuredClone(aged.visitRound)]
    aged.visitRound = {
      id: 'empty-current', number: 99,
      slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: aged.updatedAt
    }
    for (let index = 0; index < 20; index += 1) {
      aged.visitHistory.unshift({
        id: `empty-history-${index}`, number: 98 - index,
        slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: aged.updatedAt
      })
    }

    const rebuilt = buildPersistedFromPublic(aged, departed)
    expect(rebuilt.visitHistory.flatMap((round) => round.slots).some((slot) => slot.visitor?.id === visitor.id)).toBe(false)
    expect(rebuilt.expeditionsById['retained-contract']?.itemIds).toEqual([itemId])
    expect(rebuilt.expeditionsById['retained-contract']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))
    expect(isPersistedCanonical(rebuilt)).toBe(true)

    rebuilt.updatedAt = '2026-06-07T08:09:10.000Z'
    const retainedView = mapPersistedGameToGameView(rebuilt, new Date(rebuilt.updatedAt))
    expect(retainedView.visitors).toContainEqual(expect.objectContaining({
      visitorId: visitor.id,
      name: { key: `visitor.${visitor.id}`, fallback: historicalName },
      state: 'departed',
      departedAt,
      lastExpeditionId: 'retained-contract'
    }))
    expect(retainedView.items).toContainEqual(expect.objectContaining({
      itemId,
      custody: expect.objectContaining({
        kind: 'expedition', expeditionId: 'retained-contract', visitorId: visitor.id
      })
    }))
  })

  it('deeply strips private rolls from compatibility responses', () => {
    const save = createSaveGame('private-roll')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: 'private-commission', status: 'active',
      startedAt: save.createdAt, finishesAt: save.updatedAt, outcomeRoll: 0.42
    }
    expect(JSON.stringify(sanitizeGameResponse(save))).not.toContain('outcomeRoll')
  })

  it('uses injected clock, RNG and UUID sources deterministically', () => {
    let seed = 7
    const dependencies = {
      now: () => new Date('2030-01-02T03:04:05.000Z'),
      random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32),
      uuid: () => 'fixed-uuid'
    }
    const save = createSaveGame('injected-user', dependencies.now(), dependencies.random)
    save.stash[0]!.id = ''
    const persisted = buildPersistedFromPublic(save, undefined, dependencies)
    expect(persisted.createdAt).toBe('2030-01-02T03:04:05.000Z')
    expect(persisted.itemsById['item-fixed-uuid']).toBeDefined()
  })

  it('preserves identity, ownership and resource deltas over deterministic generated sequences', () => {
    let seed = 0x43a33
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const operations = ['loan', 'service', 'recover', 'return', 'sell', 'dismantle'] as const

    for (let run = 0; run < 200; run += 1) {
      let state = buildPersistedFromPublic(createSaveGame(`property-${run}`))
      const originalIds = Object.keys(state.itemsById).sort()
      for (let step = 0; step < 20; step += 1) {
        const itemId = originalIds[Math.floor(random() * originalIds.length)]!
        const operation = operations[Math.floor(random() * operations.length)]!
        const beforeGold = state.gold
        const beforeMaterials = state.materials.scrap ?? 0
        try {
          const candidate = structuredClone(state)
          const targetId = operation === 'loan'
            ? Object.keys(candidate.expeditionsById)[0] ?? `target-${step}`
            : `target-${step}`
          if (operation === 'loan' || operation === 'service' || operation === 'recover') addTarget(candidate, operation, targetId, itemId)
          const result = applyItemTransition(candidate, { operation, itemId, targetId })
          state = result.game
          expect(state.gold - beforeGold).toBe(result.effect.goldDelta)
          expect((state.materials.scrap ?? 0) - beforeMaterials).toBe(result.effect.materialDeltas.scrap ?? 0)
        } catch (error) {
          expect((error as Error).name).toBe('ItemTransitionError')
        }
        expect(Object.keys(state.itemsById).sort()).toEqual(originalIds)
        expect(isPersistedCanonical(state)).toBe(true)
        expect(effectiveCapacityUsed(state)).toBeLessThanOrEqual(state.stashLimit)
      }
    }
  }, 15_000)

  it.each([
    ['sell', 'loan'],
    ['sell', 'dismantle'],
    ['service', 'loan']
  ] as const)('allows exactly one winner for %s versus %s on the same snapshot', (first, second) => {
    const initial = buildPersistedFromPublic(createSaveGame(`race-${first}-${second}`))
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing'
    const target = (operation: typeof first | typeof second, fallback: string) => operation === 'sell' ? visitorId : fallback
    if (first === 'service') addTarget(initial, 'service', 'winner', itemId)
    const winner = applyItemTransition(initial, { operation: first, itemId, targetId: target(first, 'winner') }).game
    expect(() => applyItemTransition(winner, { operation: second, itemId, targetId: target(second, 'loser') }))
      .toThrow(expect.objectContaining({ name: 'ItemTransitionError' }))
  })
})

function addTarget(game: PersistedGameV3, operation: 'loan' | 'service' | 'recover', targetId: string, itemId?: string): void {
  const at = game.updatedAt
  if (operation === 'loan') {
    const visitor = game.visitRound.slots.find((slot) => slot.visitor)?.visitor
    const visitorId = visitor?.id ?? 'missing'
    if (visitor?.commission && Object.values(game.expeditionsById).some((container) =>
      container.projection?.kind === 'expedition' && container.projection.visitorId === visitor.id)) return
    if (visitor && !visitor.commission) visitor.commission = commissionFor(visitor, `contract-${targetId}`, at)
    if (visitor?.commission) visitor.state = 'commissioned'
    const contractId = visitor?.commission?.id ?? `contract-${targetId}`
    game.expeditionsById[targetId] = {
      id: targetId, itemIds: [], projection: { kind: 'expedition', visitorId, contractId, startsAt: at }
    }
  } else if (operation === 'service') {
    game.serviceJobsById[targetId] = {
      id: targetId, itemIds: [], projection: { kind: 'service', service: 'blacksmith', queuedAt: at, startsAt: at }
    }
    if (itemId) {
      game.serviceJobStateById[targetId] = {
        status: 'active',
        service: 'blacksmith',
        itemId,
        queuedAt: at,
        startedAt: at,
        completesAt: at,
        result: { blacksmithLevel: 1 }
      }
    }
  } else {
    const sourceExpeditionId = Object.keys(game.expeditionsById)[0] ?? `source-${targetId}`
    const visitor = game.visitRound.slots.find((slot) => slot.visitor)?.visitor
    const visitorId = visitor?.id ?? 'missing'
    if (visitor && !visitor.commission) visitor.commission = commissionFor(visitor, `contract-${targetId}`, at)
    if (visitor?.commission) visitor.state = 'commissioned'
    const contractId = visitor?.commission?.id ?? `contract-${targetId}`
    if (!game.expeditionsById[sourceExpeditionId]) game.expeditionsById[sourceExpeditionId] = {
      id: sourceExpeditionId, itemIds: [], projection: { kind: 'expedition', visitorId, contractId, startsAt: at }
    }
    game.recoveriesById[targetId] = {
      id: targetId, itemIds: [], projection: { kind: 'recovery', sourceExpeditionId, resolvedAt: at }
    }
  }
}

function moveStashItemToSettlement(game: PersistedGameV3, itemId: string, settlementId: string): void {
  game.stash = game.stash.filter((candidate) => candidate !== itemId)
  game.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'settlement', custodyId: settlementId }
  game.settlementsById[settlementId]!.itemIds.push(itemId)
}

function commissionFor(visitor: PersistedGameV3['visitRound']['slots'][number]['visitor'], id: string, at: string) {
  return {
    ...visitor!.commissionOptions[0]!, id, status: 'active' as const,
    startedAt: at, finishesAt: at, outcomeRoll: 0.5
  }
}
