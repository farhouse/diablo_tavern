// @vitest-environment happy-dom

import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { quests } from '../utils/game-data'
import type { ActiveExpedition, SaveGame } from '../types/game'

const hydrate = vi.fn()
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh: vi.fn().mockResolvedValue(false) })
}))

import QuestsPage from '../pages/quests.vue'

function returningExpedition(returnsAt: string): ActiveExpedition {
  return {
    id: 'legacy-return', questId: 'blood-moor', heroIds: ['historic-hero'], status: 'returning',
    startedAt: '2026-09-10T20:00:00.000Z', lastEventAt: '2026-09-10T20:00:00.000Z',
    nextEventAt: '2026-09-10T20:01:00.000Z', returnStartedAt: '2026-09-10T20:00:05.000Z',
    returnsAt, depth: 2, danger: 12, partyState: [], events: [], carriedLoot: [], carriedGold: 25, carriedXp: 10,
    carriedMaterials: 0, bossReady: false, bossDefeated: false
  }
}

describe('legacy expedition recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T20:00:10.000Z'))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows the ETA, waits for returnsAt, and never reports a server no-op as success', async () => {
    const save = createSaveGame('legacy-ui')
    save.activeExpeditions = [returningExpedition('2026-09-10T20:00:15.000Z')]
    let advanceCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/savegame') return structuredClone(save)
      if (url === '/api/quests') return quests
      if (url === '/api/expeditions/advance') {
        advanceCalls += 1
        if (advanceCalls === 2) save.activeExpeditions = []
        save.revision += 1
        return structuredClone(save)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(QuestsPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    const button = wrapper.get('button')
    expect(wrapper.get('[data-testid="return-eta"]').text()).toBe('Returns in 5s.')
    expect(button.attributes('disabled')).toBeDefined()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(wrapper.get('[data-testid="return-eta"]').text()).toBe('Ready to process.')
    expect(button.attributes('disabled')).toBeUndefined()

    await button.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('The server has not completed this return yet. Retry is safe.')
    expect(wrapper.find('.page-alert--success').exists()).toBe(false)

    await button.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Legacy expedition returned and its recovered resources are persisted.')
    expect(wrapper.text()).toContain('No legacy expeditions remain')
  })

  it.each([
    { label: 'timed return', status: 'returning' as const, endpoint: '/api/expeditions/advance' },
    { label: 'active portal', status: 'exploring' as const, endpoint: '/api/expeditions/recall' }
  ])('reconciles an authoritative $label after its response is lost', async ({ status, endpoint }) => {
    const save = createSaveGame(`lost-${status}`)
    const expedition = returningExpedition('2026-09-10T20:00:09.000Z')
    expedition.status = status
    if (status === 'exploring') {
      delete expedition.returnStartedAt
      delete expedition.returnsAt
      expedition.portalAvailableUntil = '2026-09-10T20:01:00.000Z'
    }
    save.activeExpeditions = [expedition]
    let responseWasLost = false
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/savegame') return structuredClone(save)
      if (url === '/api/quests') return quests
      if (url === endpoint) {
        save.activeExpeditions = []
        save.revision += 1
        responseWasLost = true
        throw new Error('Connection closed after commit')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(QuestsPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(responseWasLost).toBe(true)
    expect(wrapper.text()).toContain('Legacy expedition returned and its recovered resources are persisted.')
    expect(wrapper.text()).toContain('No legacy expeditions remain')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})
