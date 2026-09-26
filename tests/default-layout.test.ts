// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DefaultLayout from '../layouts/default.vue'

const stores = vi.hoisted(() => ({
  auth: { loggedIn: true, logout: vi.fn(), hydrate: vi.fn() },
  legacy: { save: null, load: vi.fn(), $reset: vi.fn() },
  v2: { game: null, loadState: 'empty', load: vi.fn(), $reset: vi.fn() },
  chronicle: { $reset: vi.fn() }
}))
vi.mock('../stores/auth', () => ({ useAuthStore: () => stores.auth }))
vi.mock('../stores/game', () => ({ useGameStore: () => stores.legacy }))
vi.mock('../stores/game-v2', () => ({ useGameV2Store: () => stores.v2 }))
vi.mock('../stores/chronicle-v2', () => ({ useChronicleV2Store: () => stores.chronicle }))

describe('default layout session isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigateTo', vi.fn())
  })

  it('clears both legacy and V2 snapshots on logout', async () => {
    const wrapper = mount(DefaultLayout, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })

    await wrapper.get('button').trigger('click')

    expect(stores.auth.logout).toHaveBeenCalledOnce()
    expect(stores.legacy.$reset).toHaveBeenCalledOnce()
    expect(stores.v2.$reset).toHaveBeenCalledOnce()
    expect(stores.chronicle.$reset).toHaveBeenCalledOnce()
    expect(navigateTo).toHaveBeenCalledWith('/login')
  })

  it('loads only the current game and exposes one Spanish navigation', async () => {
    const wrapper = mount(DefaultLayout, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })

    await wrapper.vm.$nextTick()

    expect(stores.legacy.load).not.toHaveBeenCalled()
    expect(stores.v2.load).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('Round')
    expect(wrapper.text()).not.toContain('V2')
    expect(wrapper.text()).not.toContain('Stash')
    expect(wrapper.text()).toContain('Inicio')
    expect(wrapper.text()).toContain('Visitantes')
    expect(wrapper.text()).toContain('Caravana')
  })
})
