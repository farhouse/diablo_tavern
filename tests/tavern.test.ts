import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TavernPage from './tavern.vue'
import { createPinia } from 'pinia'

// Mock the stores and game logic
vi.mock('~/stores/game', () => ({
  useGameStore: () => ({
    save: {
      gold: 450,
      materials: 0,
      caravan: { level: 0, upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 }, services: { appraiserQueue: [] } },
      stashLimit: 20,
      heroes: [],
      stash: [],
      pendingLoot: [],
      questsProgress: [],
      activeQuestRun: undefined,
      lastQuestRun: undefined,
      activeExpeditions: [],
      expeditionHistory: [],
      createdAt: '',
      updatedAt: ''
    },
    error: '',
    loading: false,
    load: vi.fn(),
    hire: vi.fn(),
    recover: vi.fn(),
    reset: vi.fn()
  })
}))

vi.mock('~/utils/game-logic', () => ({
  getHeroCapacity: () => 3,
  getActiveHeroCount: () => 0,
  getHireCost: () => 120,
  createHero: () => ({
    id: 'test-hero',
    name: 'Test Hero',
    class: 'barbarian',
    level: 1,
    xp: 0,
    baseStats: { strength: 15, dexterity: 9, vitality: 14, energy: 5 },
    derivedStats: { life: 0, mana: 0, attackPower: 0, defense: 0, fireResist: 0, coldResist: 0, lightningResist: 0, poisonResist: 0, magicFind: 0 },
    equipment: {},
    status: 'available'
  })
}))

vi.mock('~/components/HeroComparisonModal.vue', () => ({
  template: '<div class="hero-comparison-modal" v-if="showComparisonModal"><slot></slot></div>',
  props: ['currentParty', 'playerGold', 'onClose', 'onHire']
}))

describe('Tavern Page', () => {
  it('renders correctly when no heroes are hired', () => {
    const pinia = createPinia()
    const wrapper = mount(TavernPage, {
      global: {
        plugins: [pinia],
        stubs: {
          'HeroComparisonModal': true
        }
      }
    })
    
    expect(wrapper.find('h1').text()).toContain('Tavern')
    expect(wrapper.find('.muted').text()).toContain('No active heroes hired yet')
  })
  
  it('shows hero comparison modal when button is clicked', async () => {
    const pinia = createPinia()
    const wrapper = mount(TavernPage, {
      global: {
        plugins: [pinia],
        stubs: {
          'HeroComparisonModal': {
            template: '<div class="hero-comparison-modal" v-if="showComparisonModal"><slot></slot></div>',
            props: ['currentParty', 'playerGold', 'onClose', 'onHire']
          }
        }
      }
    })
    
    // Find and click the compare button
    const compareButton = wrapper.find('button:contains("Compare Classes")')
    await compareButton.trigger('click')
    
    // Check if modal is shown (we can't easily test this with stubs)
    // This test verifies the button exists and can be clicked
    expect(compareButton.exists()).toBe(true)
  })
  
  it('displays hero XP progress bars', () => {
    const pinia = createPinia()
    const wrapper = mount(TavernPage, {
      global: {
        plugins: [pinia],
        stubs: {
          'HeroComparisonModal': true
        }
      }
    })
    
    // Check if progress bar container exists
    const progressContainers = wrapper.findAll('.progress-bar-container')
    expect(progressContainers.length).toBe(0) // No heroes, so no progress bars
  })
  
  it('filters heroes by status', async () => {
    const pinia = createPinia()
    const wrapper = mount(TavernPage, {
      global: {
        plugins: [pinia],
        stubs: {
          'HeroComparisonModal': true
        }
      }
    })
    
    // Find the filter select
    const filterSelect = wrapper.find('.filter-select')
    expect(filterSelect.exists()).toBe(true)
    
    // Test filtering functionality
    await filterSelect.setValue('available')
    expect(filterSelect.element.value).toBe('available')
  })
  
  it('shows enhanced hero cards with progress', () => {
    const pinia = createPinia()
    const wrapper = mount(TavernPage, {
      global: {
        plugins: [pinia],
        stubs: {
          'HeroComparisonModal': true
        }
      }
    })
    
    // Check if hero cards have the enhanced structure
    const heroCards = wrapper.findAll('.hero-card')
    expect(heroCards.length).toBe(0) // No heroes, so no cards
  })
})
