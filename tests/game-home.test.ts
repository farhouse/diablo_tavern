// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../contracts/v2-etapa0-4/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import GameHome from '../pages/juego.vue'

const store = vi.hoisted(() => ({
  game: null as GameView | null,
  loadState: 'ready' as const,
  errorMessage: '',
  load: vi.fn()
}))

vi.mock('../stores/game-v2', () => ({ useGameV2Store: () => store }))

function fixture(id: string): GameView {
  const match = fixtures.integratedPositiveCases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
  return structuredClone(match.value) as GameView
}

describe('game home', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.game = null
  })

  it('guides a new player to the next contract without exposing V2 jargon', () => {
    store.game = fixture('integrated-contract')
    const wrapper = mount(GameHome, { global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, EquipmentV2: true, HeroSprite: true, VisitorCycleV2: true } } })

    expect(wrapper.get('img[src="/images/game/camp-modular/camp-base.png"]')).toBeDefined()
    expect(wrapper.text()).toContain('Diablo Tavern')
    expect(wrapper.text()).toContain('Elegí un contrato')
    expect(wrapper.get('.next-order a[href="/visitors-v2"]').text()).toBe('Ver visitantes')
    expect(wrapper.text()).toContain('Herrería')
    expect(wrapper.text()).toContain('Tasador')
    expect(wrapper.get('.hero-portrait').element.tagName).toBe('BUTTON')
    expect(wrapper.text()).not.toContain('snapshot')
    expect(wrapper.text()).not.toContain('V2')
  })

  it('prioritizes resolving a ready expedition result', () => {
    store.game = fixture('integrated-settlement')
    const wrapper = mount(GameHome, { global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, EquipmentV2: true, HeroSprite: true, VisitorCycleV2: true } } })

    expect(wrapper.text()).toContain('Confirmá el resultado de una expedición')
    expect(wrapper.get('.next-order a[href="/visitors-v2"]').text()).toBe('Ver resultado')
  })
})
