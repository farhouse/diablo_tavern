// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DefaultLayout from '../layouts/default.vue'

const stores = vi.hoisted(() => ({
  auth: { loggedIn: true, logout: vi.fn(), hydrate: vi.fn() },
  legacy: { save: null, load: vi.fn(), $reset: vi.fn() },
  v2: { $reset: vi.fn() }
}))
let routePath = '/tavern'

vi.mock('../stores/auth', () => ({ useAuthStore: () => stores.auth }))
vi.mock('../stores/game', () => ({ useGameStore: () => stores.legacy }))
vi.mock('../stores/game-v2', () => ({ useGameV2Store: () => stores.v2 }))

describe('default layout session isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routePath = '/tavern'
    vi.stubGlobal('useRoute', () => ({ path: routePath }))
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
    expect(navigateTo).toHaveBeenCalledWith('/login')
  })

  it('does not load or display legacy state on the V2 route', async () => {
    routePath = '/visitors-v2'
    const wrapper = mount(DefaultLayout, {
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } }
    })

    await wrapper.vm.$nextTick()

    expect(stores.legacy.load).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Round')
    expect(wrapper.text()).not.toContain('stash')
    expect(wrapper.text()).toContain('Tavern')
    expect(wrapper.text()).toContain('Stash')
    expect(wrapper.text()).toContain('Caravan')
  })
})
