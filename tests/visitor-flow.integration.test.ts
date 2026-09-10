// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { quests } from '../utils/game-data'
import {
  assignVisitorCommission,
  claimVisitorCommission,
  refreshVisitRound
} from '../utils/visitor-logic'
import type { SaveGame } from '../types/game'

const hydrate = vi.fn()
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh: vi.fn().mockResolvedValue(false) })
}))

import TavernPage from '../pages/tavern.vue'

describe('visitor HTTP/store/UI journey', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T20:00:00.000Z'))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries idempotently, handles a full stash and two returns, then starts a new round', async () => {
    let serverSave = createSaveGame('journey')
    const originalRoundId = serverSave.visitRound.id
    const visitorIds = serverSave.visitRound.visitors.map((visitor) => visitor.id)
    serverSave.stashLimit = serverSave.stash.length
    for (const visitor of serverSave.visitRound.visitors) {
      visitor.state = 'traded'
      visitor.commissionOptions = [{
        regionId: 'blood-moor', durationMs: 2_000, successChance: 1,
        fullRewardGold: 68, partialRewardGold: 23
      }]
    }

    const processed = new Map<string, SaveGame>()
    const commissionRequestIds: string[] = []
    let appliedCommissions = 0
    let loseFirstCommissionResponse = true
    let randomStep = 0
    const deterministicRandom = () => (randomStep++ % 100) / 100

    const fetchMock = vi.fn(async (url: string, options?: Record<string, any>) => {
      if (url === '/api/quests') return quests
      if (url === '/api/savegame') {
        const before = JSON.stringify(serverSave.visitRound)
        refreshVisitRound(serverSave, new Date())
        if (before !== JSON.stringify(serverSave.visitRound)) serverSave.revision += 1
        return structuredClone(serverSave)
      }

      const match = url.match(/^\/api\/visitors\/([^/]+)\/(commission|claim)$/)
      if (!match) throw new Error(`Unexpected request: ${url}`)
      const [, visitorId, operation] = match
      const requestId = options?.body?.requestId as string
      if (operation === 'commission') commissionRequestIds.push(requestId)
      const replay = processed.get(requestId)
      if (replay) return structuredClone(replay)

      if (operation === 'commission') {
        assignVisitorCommission(serverSave, visitorId!, options?.body?.regionId, deterministicRandom, new Date())
        appliedCommissions += 1
      } else {
        claimVisitorCommission(serverSave, visitorId!, new Date(), deterministicRandom)
      }
      serverSave.revision += 1
      processed.set(requestId, structuredClone(serverSave))

      if (operation === 'commission' && loseFirstCommissionResponse) {
        loseFirstCommissionResponse = false
        throw new Error('Network disconnected after commit')
      }
      return structuredClone(serverSave)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(TavernPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    await wrapper.get('[data-testid="review-blood-moor"]').trigger('click')
    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Network disconnected after commit')

    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(commissionRequestIds[1]).toBe(commissionRequestIds[0])
    expect(appliedCommissions).toBe(1)

    const secondReview = wrapper.findAll('[data-testid="review-blood-moor"]')[0]
    expect(secondReview).toBeDefined()
    await secondReview!.trigger('click')
    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    await flushPromises()
    expect(serverSave.visitRound.visitors.filter((visitor) => visitor.state === 'commissioned')).toHaveLength(2)
    expect(wrapper.findAll('h3').filter((heading) => heading.text() === 'Away on commission')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="claim-"]')).toHaveLength(2)

    await wrapper.get(`[data-testid="claim-${visitorIds[0]}"]`).trigger('click')
    await flushPromises()
    expect(serverSave.stash).toHaveLength(serverSave.stashLimit)

    await wrapper.get(`[data-testid="claim-${visitorIds[1]}"]`).trigger('click')
    await flushPromises()
    expect(serverSave.visitRound.id).not.toBe(originalRoundId)
    expect(serverSave.visitRound.number).toBe(2)
    expect(wrapper.text()).toContain('Visitor round 2')
    expect(wrapper.findAll('.visitor-post')).toHaveLength(2)
  })
})
