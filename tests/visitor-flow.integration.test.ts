// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { quests } from '../utils/game-data'
import type { SaveGame } from '../types/game'

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

  it('retries idempotently, handles a full stash and two returns, then starts a new round', async () => {
    persistedSave = createSaveGame('journey')
    const originalRoundId = persistedSave.visitRound.id
    const visitorIds = persistedSave.visitRound.visitors.map((visitor) => visitor.id)
    const soldItem = persistedSave.stash[0]!
    const filler = soldItem
    while (persistedSave.stash.length < persistedSave.stashLimit) {
      persistedSave.stash.push({ ...structuredClone(filler), id: `full-stash-${persistedSave.stash.length}` })
    }
    for (const visitor of persistedSave.visitRound.visitors) {
      visitor.commissionOptions = [{
        regionId: 'blood-moor', durationMs: 2_000, successChance: 1,
        fullRewardGold: 68, partialRewardGold: 23
      }]
    }
    const firstVisitor = persistedSave.visitRound.visitors[0]!
    firstVisitor.acceptedItemTypes = [soldItem.type]
    firstVisitor.interestedItemTypes = [soldItem.type]
    firstVisitor.buyQuotes = { [soldItem.id]: soldItem.value }
    firstVisitor.budget = soldItem.value
    const secondVisitor = persistedSave.visitRound.visitors[1]!
    secondVisitor.offers = [{
      id: 'integration-offer',
      item: { ...structuredClone(filler), id: 'integration-purchase' },
      price: 1
    }]

    const commissionRequestIds: string[] = []
    let loseFirstCommissionResponse = true

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
      if (operation === 'commission') commissionRequestIds.push(requestId)
      const event = { context: { params: { visitorId: visitorId! } }, body: options?.body }
      const response = operation === 'commission'
        ? await commissionHandler(event as never)
        : operation === 'sell'
          ? await sellHandler(event as never)
          : operation === 'buy'
            ? await buyHandler(event as never)
            : await claimHandler(event as never)

      if (operation === 'commission' && loseFirstCommissionResponse) {
        loseFirstCommissionResponse = false
        throw new Error('Network disconnected after commit')
      }
      return response
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(TavernPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    await wrapper.get(`[data-testid="sell-${soldItem.id}"]`).trigger('click')
    await flushPromises()
    expect(persistedSave.visitRound.visitors[0]!.equipmentSummary).toContainEqual(expect.objectContaining({
      itemId: soldItem.id,
      name: soldItem.displayName
    }))
    expect(wrapper.text()).toContain(soldItem.displayName)

    await wrapper.get('[data-testid="buy-integration-offer"]').trigger('click')
    await flushPromises()
    expect(persistedSave.stash).toHaveLength(persistedSave.stashLimit)

    await wrapper.get('[data-testid="review-blood-moor"]').trigger('click')
    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Network disconnected after commit')

    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(commissionRequestIds[1]).toBe(commissionRequestIds[0])
    expect(persistedSave.processedRequestIds.filter((id) => id === commissionRequestIds[0])).toHaveLength(1)

    const secondReview = wrapper.findAll('[data-testid="review-blood-moor"]')[0]
    expect(secondReview).toBeDefined()
    await secondReview!.trigger('click')
    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(persistedSave.visitRound.visitors.filter((visitor) => visitor.state === 'commissioned')).toHaveLength(2)
    expect(wrapper.findAll('h3').filter((heading) => heading.text() === 'Away on commission')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="claim-"]')).toHaveLength(2)

    await wrapper.get(`[data-testid="claim-${visitorIds[0]}"]`).trigger('click')
    await flushPromises()
    expect(persistedSave.stash).toHaveLength(persistedSave.stashLimit)

    await wrapper.get(`[data-testid="claim-${visitorIds[1]}"]`).trigger('click')
    await flushPromises()
    expect(persistedSave.visitRound.id).not.toBe(originalRoundId)
    expect(persistedSave.visitRound.number).toBe(2)
    expect(wrapper.text()).toContain('Visitor round 2')
    expect(wrapper.findAll('.visitor-post')).toHaveLength(2)
  })
})

interface TestEvent {
  context: { params: Record<string, string> }
  body?: Record<string, unknown>
}
