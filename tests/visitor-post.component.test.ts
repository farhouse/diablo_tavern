import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VisitorPost from '../components/VisitorPost.vue'
import type { Item, Quest, Visitor } from '../types/game'

const sword: Item = {
  id: 'sword', baseName: 'Short Sword', displayName: 'Short Sword', type: 'weapon', rarity: 'normal',
  identified: true, width: 1, height: 3, requiredLevel: 1, affixes: [{ stat: 'attackPower', value: 8 }], value: 35
}

const quest: Quest = {
  id: 'blood-moor', name: 'Blood Moor', act: 1, difficulty: 34, minLevel: 1,
  rewards: { xp: 70, gold: 90 }, lootTableId: 'act1-low'
}

function visitor(overrides: Partial<Visitor> = {}): Visitor {
  return {
    id: 'visitor-1', name: 'Mira', class: 'barbarian', level: 3, state: 'open', budget: 140, initialBudget: 140,
    acceptedItemTypes: ['weapon', 'armor'], interestedItemTypes: ['weapon'],
    offers: [{ id: 'offer-1', item: { ...sword, id: 'offer-item' }, price: 40 }],
    buyQuotes: { sword: 31 }, trades: [], power: 69,
    commissionOptions: [{ regionId: 'blood-moor', durationMs: 62_000, successChance: 0.67, fullRewardGold: 68, partialRewardGold: 23 }],
    arrivedAt: '2026-09-10T20:00:00.000Z', ...overrides
  }
}

describe('VisitorPost', () => {
  it('renders identity, route, budget, interests, offers and stash quotes', () => {
    const wrapper = mount(VisitorPost, {
      props: { visitor: visitor(), stash: [sword], gold: 450, stashLimit: 20, quests: [quest], now: Date.now() }
    })

    expect(wrapper.text()).toContain('Mira')
    expect(wrapper.text()).toContain('Barbarian · level 3')
    expect(wrapper.text()).toContain('Arrived from Blood Moor')
    expect(wrapper.get('[aria-label="Visitor resources"]').text()).toContain('140g')
    expect(wrapper.get('[aria-label="Visitor resources"]').text()).toContain('budget')
    expect(wrapper.text()).toContain('Looking for weapon')
    expect(wrapper.get('[data-testid="buy-offer-1"]').text()).toContain('Buy for 40g')
    expect(wrapper.get('[data-testid="sell-sword"]').text()).toContain('Sell for 31g')
  })

  it('explains why commercial actions are unavailable', () => {
    const wrapper = mount(VisitorPost, {
      props: { visitor: visitor(), stash: [sword], gold: 10, stashLimit: 1, quests: [quest], now: Date.now() }
    })

    expect(wrapper.get('[data-testid="buy-offer-1"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Stash is full')
  })

  it('requires an inline mission review and shows every consequence before confirmation', async () => {
    const wrapper = mount(VisitorPost, {
      props: { visitor: visitor({ state: 'traded' }), stash: [], gold: 450, stashLimit: 20, quests: [quest], now: Date.now() }
    })

    await wrapper.get('[data-testid="review-blood-moor"]').trigger('click')
    expect(wrapper.text()).toContain('1m 2s')
    expect(wrapper.text()).toContain('67% success')
    expect(wrapper.text()).toContain('Complete: 68g and one item if stash has room')
    expect(wrapper.text()).toContain('Partial: 23g')
    expect(wrapper.text()).toContain('Failed: no reward')
    await wrapper.get('[data-testid="confirm-blood-moor"]').trigger('click')
    expect(wrapper.emitted('commission')).toEqual([['visitor-1', 'blood-moor']])
  })

  it('shows the away countdown and the returned result as mutually exclusive states', () => {
    const active = visitor({
      state: 'commissioned',
      commission: {
        id: 'commission-1', status: 'active', regionId: 'blood-moor', durationMs: 62_000, successChance: 0.67,
        fullRewardGold: 68, partialRewardGold: 23, startedAt: '2026-09-10T20:00:00.000Z',
        finishesAt: '2026-09-10T20:01:02.000Z', outcomeRoll: 0.2
      }
    })
    const away = mount(VisitorPost, {
      props: { visitor: active, stash: [], gold: 450, stashLimit: 20, quests: [quest], now: new Date('2026-09-10T20:00:02.000Z').getTime() }
    })
    expect(away.text()).toContain('Away on commission')
    expect(away.text()).toContain('1m remaining')

    const returned = mount(VisitorPost, {
      props: {
        visitor: visitor({
          state: 'returned',
          commission: { ...active.commission!, status: 'ready', outcome: 'partial', rewardGold: 23 }
        }),
        stash: [], gold: 450, stashLimit: 20, quests: [quest], now: Date.now()
      }
    })
    expect(returned.text()).toContain('Returned: partial result')
    expect(returned.get('[data-testid="claim-visitor-1"]').text()).toContain('Claim 23g')
  })
})
