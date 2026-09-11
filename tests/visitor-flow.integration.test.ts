// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { quests } from '../utils/game-data'
import { visitorOperationKey } from '../server/utils/visitor-api'
import { useGameStore } from '../stores/game'
import type { SaveGame } from '../types/game'

const visitors = (save: SaveGame) => save.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])

let persistedSave: SaveGame
const collection = {
  findOne: vi.fn(async () => structuredClone(persistedSave)),
  updateOne: vi.fn(async () => ({ upsertedCount: 0 })),
  replaceOne: vi.fn(async (rawFilter: unknown, replacement: SaveGame) => {
    const filter = rawFilter as {
      revision?: number
      $or?: Array<{ revision: number | { $exists: boolean } }>
      processedRequestIds?: { $ne: string }
    }
    const revisionMatches = typeof filter.revision === 'number'
      ? persistedSave.revision === filter.revision
      : !filter.$or || filter.$or.some((entry) => typeof entry.revision === 'number'
        ? persistedSave.revision === entry.revision
        : entry.revision.$exists === ('revision' in persistedSave))
    const requestMatches = !filter.processedRequestIds
      || !persistedSave.processedRequestIds.includes(filter.processedRequestIds.$ne)
    if (!revisionMatches || !requestMatches) return { modifiedCount: 0 }
    persistedSave = structuredClone(replacement)
    return { modifiedCount: 1 }
  })
}

const hydrate = vi.fn()
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh: vi.fn().mockResolvedValue(false) })
}))
vi.mock('../server/utils/auth', () => ({
  requireUser: async () => ({ id: 'journey' })
}))
vi.mock('../server/utils/db', () => ({
  saveGamesCollection: async () => collection
}))

import TavernPage from '../pages/tavern.vue'

describe('visitor HTTP/store/UI journey', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T20:00:00.000Z'))
    setActivePinia(createPinia())
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (event: TestEvent, key: string) => event.context.params[key])
    vi.stubGlobal('readBody', (event: TestEvent) => event.body)
    vi.stubGlobal('createError', (details: { statusCode: number; statusMessage: string }) => Object.assign(new Error(details.statusMessage), details))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries idempotently, handles both trade directions and two returns, then frees both slots', async () => {
    persistedSave = createSaveGame('journey')
    const originalRoundId = persistedSave.visitRound.id
    const visitorIds = visitors(persistedSave).map((visitor) => visitor.id)
    const soldItem = persistedSave.stash[0]!
    const filler = soldItem
    while (persistedSave.stash.length < persistedSave.stashLimit) {
      persistedSave.stash.push({ ...structuredClone(filler), id: `full-stash-${persistedSave.stash.length}` })
    }
    for (const visitor of visitors(persistedSave)) {
      visitor.commissionOptions = [{
        optionId: 'safe', title: 'Careful patrol', regionId: 'blood-moor', durationMs: 2_000, successChance: 1,
        fullRewardGold: 68, partialRewardGold: 23, riskLevel: 'low',
        failureConsequence: 'The slot stays occupied for the full duration and yields no reward.'
      }, {
        optionId: 'risky', title: 'Perilous delve', regionId: 'blood-moor', durationMs: 4_000, successChance: 0.5,
        fullRewardGold: 120, partialRewardGold: 40, riskLevel: 'high',
        failureConsequence: 'The slot stays occupied longer and a failure yields no reward.'
      }]
    }
    const firstVisitor = visitors(persistedSave)[0]!
    firstVisitor.acceptedItemTypes = [soldItem.type]
    firstVisitor.interestedItemTypes = [soldItem.type]
    firstVisitor.buyQuotes = { [soldItem.id]: soldItem.value }
    firstVisitor.budget = soldItem.value
    firstVisitor.offers = [{
      id: 'integration-offer',
      item: { ...structuredClone(filler), id: 'integration-purchase' },
      price: 1
    }]
    const secondVisitor = visitors(persistedSave)[1]!
    const secondSoldItem = persistedSave.stash[1]!
    secondVisitor.acceptedItemTypes = [secondSoldItem.type]
    secondVisitor.interestedItemTypes = [secondSoldItem.type]
    secondVisitor.buyQuotes = { [secondSoldItem.id]: secondSoldItem.value }
    secondVisitor.budget = secondSoldItem.value
    secondVisitor.offers = [{
      id: 'second-integration-offer',
      item: { ...structuredClone(filler), id: 'second-integration-purchase' },
      price: 1
    }]

    const claimRequestIds: string[] = []
    let loseSecondClaimResponse = true

    const [{ default: saveHandler }, { default: buyHandler }, { default: sellHandler }, { default: commissionHandler }, { default: claimHandler }] = await Promise.all([
      import('../server/api/savegame/index.get'),
      import('../server/api/visitors/[visitorId]/buy.post'),
      import('../server/api/visitors/[visitorId]/sell.post'),
      import('../server/api/visitors/[visitorId]/commission.post'),
      import('../server/api/visitors/[visitorId]/claim.post')
    ])

    const fetchMock = vi.fn(async (url: string, options?: Record<string, any>) => {
      if (url === '/api/quests') return quests
      if (url === '/api/savegame') return saveHandler({} as never)

      const match = url.match(/^\/api\/visitors\/([^/]+)\/(buy|sell|commission|claim)$/)
      if (!match) throw new Error(`Unexpected request: ${url}`)
      const [, visitorId, operation] = match
      const requestId = options?.body?.requestId as string
      if (operation === 'claim') claimRequestIds.push(requestId)
      const event = { context: { params: { visitorId: visitorId! } }, body: options?.body }
      const response = operation === 'commission'
        ? await commissionHandler(event as never)
        : operation === 'sell'
          ? await sellHandler(event as never)
          : operation === 'buy'
            ? await buyHandler(event as never)
            : await claimHandler(event as never)

      if (operation === 'claim' && visitorId === visitorIds[1] && loseSecondClaimResponse) {
        loseSecondClaimResponse = false
        throw new Error('Network disconnected after commit')
      }
      return response
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(TavernPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    expect(visitors(persistedSave).every((visitor) => visitor.state === 'open')).toBe(true)
    expect(wrapper.findAll('.visitor-post')).toHaveLength(2)
    expect(wrapper.findAll('.state-chip').map((chip) => chip.text())).toEqual(['Ready to trade', 'Ready to trade'])

    await wrapper.get(`[data-testid="sell-${soldItem.id}"]`).trigger('click')
    await flushPromises()
    expect(visitors(persistedSave)[0]!.equipmentSummary).toContainEqual(expect.objectContaining({
      itemId: soldItem.id,
      name: soldItem.displayName
    }))
    expect(wrapper.text()).toContain(soldItem.displayName)

    const goldBeforePurchase = persistedSave.gold
    await wrapper.get('[data-testid="buy-integration-offer"]').trigger('click')
    await flushPromises()
    expect(persistedSave.stash).toHaveLength(persistedSave.stashLimit)
    expect(persistedSave.stash.some((item) => item.id === 'integration-purchase')).toBe(true)
    expect(persistedSave.gold).toBe(goldBeforePurchase - 1)
    expect(visitors(persistedSave)[0]!.trades.map((trade) => trade.kind)).toEqual(['player_sold', 'player_bought'])
    expect(visitors(persistedSave)[0]!.offers[0]!.purchasedAt).toBeTruthy()

    await wrapper.get(`[data-testid="sell-${secondSoldItem.id}"]`).trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="buy-second-integration-offer"]').trigger('click')
    await flushPromises()
    expect(visitors(persistedSave)[1]!.trades.map((trade) => trade.kind)).toEqual(['player_sold', 'player_bought'])
    expect(persistedSave.stash).toHaveLength(persistedSave.stashLimit)

    const commissionRandom = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.01)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.02)
      .mockReturnValueOnce(0)
    await wrapper.get('[data-testid="review-safe"]').trigger('click')
    await wrapper.get('[data-testid="confirm-safe"]').trigger('click')
    await flushPromises()

    const secondReview = wrapper.findAll('[data-testid="review-safe"]')[0]
    expect(secondReview).toBeDefined()
    await secondReview!.trigger('click')
    await wrapper.get('[data-testid="confirm-safe"]').trigger('click')
    await flushPromises()
    commissionRandom.mockRestore()
    expect(visitors(persistedSave).filter((visitor) => visitor.state === 'commissioned')).toHaveLength(2)
    expect(persistedSave.visitRound.slots.every((slot) => Boolean(slot.visitor))).toBe(true)
    expect(wrapper.findAll('h3').filter((heading) => heading.text() === 'Away on commission')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="claim-"]')).toHaveLength(2)

    const goldBeforeClaim = persistedSave.gold
    await wrapper.get(`[data-testid="claim-${visitorIds[0]}"]`).trigger('click')
    await flushPromises()
    expect(persistedSave.gold).toBe(goldBeforeClaim + 68)
    expect(persistedSave.visitRound.slots[0]!.visitor).toBeUndefined()
    expect(persistedSave.visitRound.slots[0]!.nextArrivalCheckAt).toBeTruthy()
    expect(persistedSave.visitHistory).toHaveLength(1)
    expect(wrapper.find(`[data-testid="claim-${visitorIds[0]}"]`).exists()).toBe(false)

    const stashBeforeRoundRenewingClaim = persistedSave.stash.map((item) => item.id)
    await wrapper.get(`[data-testid="claim-${visitorIds[1]}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Network disconnected after commit')
    expect(wrapper.text()).toContain('Visitor round 1')
    expect(persistedSave.gold).toBe(goldBeforeClaim + 136)
    expect(persistedSave.stash.map((item) => item.id)).toEqual(stashBeforeRoundRenewingClaim)
    expect(persistedSave.visitHistory).toHaveLength(2)
    expect(persistedSave.visitRound.slots.every((slot) => !slot.visitor && Boolean(slot.nextArrivalCheckAt))).toBe(true)
    const archivedSecondVisitor = persistedSave.visitHistory
      .flatMap((round) => round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : []))
      .find((visitor) => visitor.id === visitorIds[1])!
    expect(archivedSecondVisitor.commission?.rewardGold).toBe(68)
    expect(archivedSecondVisitor.commission?.status).toBe('claimed')
    expect(archivedSecondVisitor.commission?.claimedAt).toBeTruthy()
    const committedRevision = persistedSave.revision
    const committedClaimedAt = archivedSecondVisitor.commission!.claimedAt
    expect(persistedSave.visitRound.id).toBe(originalRoundId)
    expect(persistedSave.visitRound.number).toBe(1)
    expect(wrapper.find(`[data-testid="claim-${visitorIds[1]}"]`).exists()).toBe(true)

    await wrapper.get(`[data-testid="claim-${visitorIds[1]}"]`).trigger('click')
    await flushPromises()
    expect(claimRequestIds).toHaveLength(3)
    expect(claimRequestIds[2]).toBe(claimRequestIds[1])
    expect(persistedSave.processedRequestIds.filter((id) => id === claimRequestIds[1])).toHaveLength(1)
    expect(persistedSave.processedRequests.filter((entry) => entry.requestId === claimRequestIds[1])).toEqual([{
      requestId: claimRequestIds[1],
      operationKey: visitorOperationKey('claim', visitorIds[1]!)
    }])
    expect(persistedSave.gold).toBe(goldBeforeClaim + 136)
    expect(persistedSave.stash.map((item) => item.id)).toEqual(stashBeforeRoundRenewingClaim)
    expect(persistedSave.visitHistory).toHaveLength(2)
    const retriedSecondVisitor = persistedSave.visitHistory
      .flatMap((round) => round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : []))
      .find((visitor) => visitor.id === visitorIds[1])!
    expect(retriedSecondVisitor.commission?.claimedAt).toBe(committedClaimedAt)
    expect(persistedSave.revision).toBe(committedRevision)
    expect(wrapper.text()).not.toContain('Network disconnected after commit')
    expect(persistedSave.visitRound.id).toBe(originalRoundId)
    expect(persistedSave.visitRound.number).toBe(1)
    expect(wrapper.findAll('.visitor-post')).toHaveLength(0)
    expect(wrapper.findAll('.visitor-slot--empty')).toHaveLength(2)
    expect(wrapper.text()).toContain('Next arrival check')
  })

  it('removes a dismissed visitor immediately and keeps the other occupied post intact', async () => {
    persistedSave = createSaveGame('dismiss-journey')
    const [dismissed, remaining] = visitors(persistedSave)
    const [{ default: saveHandler }, { default: dismissHandler }] = await Promise.all([
      import('../server/api/savegame/index.get'),
      import('../server/api/visitors/[visitorId]/dismiss.post')
    ])
    vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: Record<string, any>) => {
      if (url === '/api/quests') return quests
      if (url === '/api/savegame') return saveHandler({} as never)
      if (url === `/api/visitors/${dismissed!.id}/dismiss`) {
        return dismissHandler({ context: { params: { visitorId: dismissed!.id } }, body: options?.body } as never)
      }
      throw new Error(`Unexpected request: ${url}`)
    }))

    const wrapper = mount(TavernPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    await wrapper.get(`[data-testid="dismiss-${dismissed!.id}"]`).trigger('click')
    await flushPromises()

    expect(wrapper.find(`[aria-labelledby="visitor-${dismissed!.id}"]`).exists()).toBe(false)
    expect(wrapper.find(`[aria-labelledby="visitor-${remaining!.id}"]`).exists()).toBe(true)
    expect(wrapper.findAll('.visitor-slot--empty')).toHaveLength(1)
    expect(wrapper.text()).toContain('Next arrival check')
  })

  it('supports buy then sell for one visitor, rejects a duplicate kind, and retries a lost dismiss response', async () => {
    persistedSave = createSaveGame('reverse-trade-journey')
    const currentVisitor = visitors(persistedSave)[0]!
    const sellable = persistedSave.stash[0]!
    currentVisitor.acceptedItemTypes = [sellable.type]
    currentVisitor.interestedItemTypes = [sellable.type]
    currentVisitor.buyQuotes = { [sellable.id]: 30 }
    currentVisitor.budget = 200
    currentVisitor.offers = [
      { id: 'buy-first', item: { ...structuredClone(sellable), id: 'buy-first-item' }, price: 1 },
      { id: 'duplicate-buy', item: { ...structuredClone(sellable), id: 'duplicate-buy-item' }, price: 1 }
    ]
    let loseDismissResponse = true
    const dismissRequestIds: string[] = []
    const [{ default: saveHandler }, { default: buyHandler }, { default: sellHandler }, { default: dismissHandler }] = await Promise.all([
      import('../server/api/savegame/index.get'),
      import('../server/api/visitors/[visitorId]/buy.post'),
      import('../server/api/visitors/[visitorId]/sell.post'),
      import('../server/api/visitors/[visitorId]/dismiss.post')
    ])
    vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: Record<string, any>) => {
      if (url === '/api/quests') return quests
      if (url === '/api/savegame') return saveHandler({} as never)
      const match = url.match(/^\/api\/visitors\/([^/]+)\/(buy|sell|dismiss)$/)
      if (!match) throw new Error(`Unexpected request: ${url}`)
      const [, visitorId, operation] = match
      const event = { context: { params: { visitorId: visitorId! } }, body: options?.body }
      const response = operation === 'buy'
        ? await buyHandler(event as never)
        : operation === 'sell' ? await sellHandler(event as never) : await dismissHandler(event as never)
      if (operation === 'dismiss') {
        dismissRequestIds.push(options?.body?.requestId)
        if (loseDismissResponse) {
          loseDismissResponse = false
          throw new Error('Network disconnected after dismiss commit')
        }
      }
      return response
    }))

    const wrapper = mount(TavernPage, { global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
    await flushPromises()
    await wrapper.get('[data-testid="buy-buy-first"]').trigger('click')
    await flushPromises()
    expect(wrapper.find(`[data-testid="sell-${sellable.id}"]`).exists()).toBe(true)
    await wrapper.get(`[data-testid="sell-${sellable.id}"]`).trigger('click')
    await flushPromises()
    expect(visitors(persistedSave)[0]!.trades.map((trade) => trade.kind)).toEqual(['player_bought', 'player_sold'])

    await expect(useGameStore().buyFromVisitor(currentVisitor.id, 'duplicate-buy')).rejects.toThrow('already completed a sale')
    await wrapper.get(`[data-testid="dismiss-${currentVisitor.id}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Network disconnected after dismiss commit')
    expect(wrapper.find(`[aria-labelledby="visitor-${currentVisitor.id}"]`).exists()).toBe(true)
    await wrapper.get(`[data-testid="dismiss-${currentVisitor.id}"]`).trigger('click')
    await flushPromises()
    expect(dismissRequestIds).toHaveLength(2)
    expect(dismissRequestIds[1]).toBe(dismissRequestIds[0])
    expect(wrapper.find(`[aria-labelledby="visitor-${currentVisitor.id}"]`).exists()).toBe(false)
    expect(wrapper.findAll('.visitor-slot--empty')).toHaveLength(1)
  })

  it('rejects malformed optionId instead of treating it as a legacy region', async () => {
    persistedSave = createSaveGame('invalid-option')
    visitors(persistedSave)[0]!.state = 'traded'
    const { default: commissionHandler } = await import('../server/api/visitors/[visitorId]/commission.post')

    await expect(commissionHandler({
      context: { params: { visitorId: visitors(persistedSave)[0]!.id } },
      body: { requestId: 'invalid-option-request', optionId: 'blood-moor' }
    } as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})

interface TestEvent {
  context: { params: Record<string, string> }
  body?: Record<string, unknown>
}
