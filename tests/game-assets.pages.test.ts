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

  it('renders the stash item image without replacing rarity or actions', async () => {
    const save = createSaveGame('asset-stash')
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => url === '/api/savegame' ? structuredClone(save) : quests))

    const wrapper = mount(StashPage, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    const item = save.stash[0]!
    const image = wrapper.get(`img[src="/images/game/items/${item.type}.png"]`)
    expect(image.attributes('alt')).toBe('')
    expect(wrapper.text()).toContain(item.rarity)
    expect(wrapper.find('summary').exists()).toBe(true)
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
