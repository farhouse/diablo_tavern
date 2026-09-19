// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CaravanPage from '../pages/caravan.vue'
import StashPage from '../pages/stash.vue'
import { createSaveGame } from '../utils/game-logic'
import { quests } from '../utils/game-data'

const hydrate = vi.fn()
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh: vi.fn().mockResolvedValue(false) })
}))

describe('game assets in active pages', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders the stash item image and active actions without legacy salvage', async () => {
    const save = createSaveGame('asset-stash')
    save.stash[0]!.identified = false
    save.stash[0]!.affixes = []
    save.caravan.upgrades.appraiser = 1
    save.gold = 1_000
    const fetcher = vi.fn(async (url: string, _options?: { body?: Record<string, unknown> }) => {
      if (url === '/api/savegame' || url.endsWith('/identify') || url === '/api/appraiser/start') return structuredClone(save)
      return quests
    })
    vi.stubGlobal('$fetch', fetcher)

    const wrapper = mount(StashPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    const item = save.stash[0]!
    const image = wrapper.get(`img[src="/images/game/items/${item.type}.png"]`)
    expect(image.attributes('alt')).toBe('')
    expect(wrapper.text()).toContain(item.rarity)
    expect(wrapper.text()).toContain('Identify')
    expect(wrapper.text()).toContain('Send to Appraiser')
    expect(wrapper.text()).not.toContain('Emergency salvage')
    expect(wrapper.text()).not.toContain('Salvage for')
    expect(wrapper.find('.salvage-details').exists()).toBe(false)

    const identifyButton = wrapper.findAll('button').find((button) => button.text().startsWith('Identify'))
    expect(identifyButton).toBeDefined()
    await identifyButton!.trigger('click')
    await flushPromises()

    const appraiserButton = wrapper.findAll('button').find((button) => button.text() === 'Send to Appraiser')
    expect(appraiserButton).toBeDefined()
    await appraiserButton!.trigger('click')
    await flushPromises()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/savegame',
      `/api/items/${item.id}/identify`,
      '/api/appraiser/start'
    ])
    expect(fetcher.mock.calls[2]?.[1]?.body).toMatchObject({ itemId: item.id })
  })

  it('renders only the buildings that belong to the active visitor MVP', async () => {
    const save = createSaveGame('asset-caravan')
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => url === '/api/savegame' ? structuredClone(save) : quests))

    const wrapper = mount(CaravanPage)
    await flushPromises()

    expect(wrapper.find('img[src="/images/game/caravan/wagons.png"]').exists()).toBe(true)
    expect(wrapper.find('img[src="/images/game/caravan/stash-wagon.png"]').exists()).toBe(true)
    expect(wrapper.find('img[src="/images/game/caravan/appraiser.png"]').exists()).toBe(true)
    expect(wrapper.find('img[src*="scout-table"]').exists()).toBe(false)
    expect(wrapper.find('img[src*="infirmary"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Outside this MVP')

    wrapper.unmount()
  })
})
