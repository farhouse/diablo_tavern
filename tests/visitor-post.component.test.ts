// @vitest-environment happy-dom

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

const safeOption = {
  optionId: 'safe' as const, title: 'Careful patrol', regionId: 'blood-moor', durationMs: 46_000,
  successChance: 0.82, fullRewardGold: 54, partialRewardGold: 18, riskLevel: 'low' as const,
  failureConsequence: 'The slot stays occupied for the full duration and yields no reward.'
}
const riskyOption = {
  optionId: 'risky' as const, title: 'Perilous delve', regionId: 'blood-moor', durationMs: 108_000,
  successChance: 0.52, fullRewardGold: 122, partialRewardGold: 32, riskLevel: 'high' as const,
  failureConsequence: 'The slot stays occupied longer and a failure yields no reward.'
}

function visitor(overrides: Partial<Visitor> = {}): Visitor {
  return {
    id: 'visitor-1', name: 'Mira', class: 'barbarian', level: 3, origin: 'Ashen Foothills',
    equipmentSummary: [{ name: 'Worn battle axe', type: 'weapon', powerBonus: 0 }],
    state: 'open', budget: 140, initialBudget: 140,
    acceptedItemTypes: ['weapon', 'armor'], interestedItemTypes: ['weapon'],
    offers: [{ id: 'offer-1', item: { ...sword, id: 'offer-item' }, price: 40 }],
    buyQuotes: { sword: 31 }, trades: [], power: 69,
    commissionOptions: [safeOption, riskyOption],
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
    expect(wrapper.text()).toContain('From Ashen Foothills')
    expect(wrapper.text()).toContain('Persisted equipment · routes: Blood Moor')
    expect(wrapper.text()).toContain('Worn battle axe')
    expect(wrapper.text()).toContain('Weapon · starting gear')
    expect(wrapper.get('[aria-label="Visitor resources"]').text()).toContain('140g')
    expect(wrapper.get('[aria-label="Visitor resources"]').text()).toContain('budget')
    expect(wrapper.text()).toContain('Looking for weapon')
    expect(wrapper.get('[data-testid="buy-offer-1"]').text()).toContain('Buy for 40g')
    expect(wrapper.get('[data-testid="sell-sword"]').text()).toContain('Sell for 31g')
  })

  it('renders persisted tavern equipment impact after a reload', () => {
    const persisted = visitor({
      state: 'traded',
      power: 77,
      equipmentSummary: [
        { name: 'Worn battle axe', type: 'weapon', powerBonus: 0 },
        { itemId: 'sword', name: 'Short Sword', type: 'weapon', powerBonus: 8 }
      ]
    })
    const wrapper = mount(VisitorPost, {
      props: { visitor: structuredClone(persisted), stash: [], gold: 450, stashLimit: 20, quests: [quest], now: Date.now() }
    })

    expect(wrapper.text()).toContain('Short Sword')
    expect(wrapper.text()).toContain('Weapon · +8 power')
    expect(wrapper.get('[aria-label="Visitor resources"]').text()).toContain('77')
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

    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('Careful patrol')
    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('Low risk')
    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('Success')
    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('82%')
    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('46s')
    expect(wrapper.get('[data-testid="mission-safe"]').text()).toContain('54g')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('Perilous delve')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('High risk')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('Success')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('52%')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('1m 48s')
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('122g')

    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain(riskyOption.failureConsequence)
    expect(wrapper.get('[data-testid="mission-risky"]').text()).toContain('Partial: 32g')
    await wrapper.get('[data-testid="review-risky"]').trigger('click')
    await wrapper.get('[data-testid="confirm-risky"]').trigger('click')
    expect(wrapper.emitted('commission')).toEqual([['visitor-1', 'risky']])
  })

  it('keeps the remaining trade direction available after the first trade', () => {
    const bought = mount(VisitorPost, {
      props: {
        visitor: visitor({ state: 'traded', trades: [{ requestId: 'buy', kind: 'player_bought', itemId: 'offer-item', price: 40, createdAt: '2026-09-10T20:00:01.000Z' }] }),
        stash: [sword], gold: 410, stashLimit: 20, quests: [quest], now: Date.now()
      }
    })
    expect(bought.find('[data-testid="buy-offer-1"]').exists()).toBe(false)
    expect(bought.get('[data-testid="sell-sword"]').text()).toContain('Sell for 31g')
    expect(bought.find('[data-testid="mission-safe"]').exists()).toBe(true)

    const sold = mount(VisitorPost, {
      props: {
        visitor: visitor({ state: 'traded', trades: [{ requestId: 'sell', kind: 'player_sold', itemId: 'sword', price: 31, createdAt: '2026-09-10T20:00:01.000Z' }] }),
        stash: [], gold: 481, stashLimit: 20, quests: [quest], now: Date.now()
      }
    })
    expect(sold.get('[data-testid="buy-offer-1"]').text()).toContain('Buy for 40g')
    expect(sold.find('[data-testid="sell-sword"]').exists()).toBe(false)
  })

  it('shows the away countdown and the returned result as mutually exclusive states', () => {
    const active = visitor({
      state: 'commissioned',
      commission: {
        ...safeOption, id: 'commission-1', status: 'active', durationMs: 62_000, successChance: 0.67,
        fullRewardGold: 68, partialRewardGold: 23, startedAt: '2026-09-10T20:00:00.000Z',
        finishesAt: '2026-09-10T20:01:02.000Z', outcomeRoll: 0.2
      }
    })
    const away = mount(VisitorPost, {
      props: { visitor: active, stash: [], gold: 450, stashLimit: 20, quests: [quest], now: new Date('2026-09-10T20:00:02.000Z').getTime() }
    })
    expect(away.text()).toContain('Away on commission')
    expect(away.text()).toContain('1m remaining')
    expect(away.get('[data-testid="journey-log"]').attributes('aria-live')).toBeUndefined()
    expect(away.get('[data-testid="journey-log"]').text()).toContain('Set out')
    expect(away.get('[data-testid="journey-log"]').text()).not.toContain('A measured advance')

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

  it('shows route and risk milestones as discrete progress is reached', () => {
    const active = visitor({
      state: 'commissioned',
      commission: {
        ...riskyOption, id: 'commission-1', status: 'active', durationMs: 100_000,
        startedAt: '2026-09-10T20:00:00.000Z', finishesAt: '2026-09-10T20:01:40.000Z', outcomeRoll: 0.99
      }
    })
    const wrapper = mount(VisitorPost, {
      props: { visitor: active, stash: [], gold: 450, stashLimit: 20, quests: [quest], now: new Date('2026-09-10T20:01:25.000Z').getTime() }
    })

    const log = wrapper.get('[data-testid="journey-log"]')
    expect(log.text()).toContain('Crossed into the Blood Moor')
    expect(log.text()).toContain('Pressed into danger')
    expect(log.text()).toContain('Turned for the tavern')
    expect(log.text()).not.toContain('failed')
    expect(log.findAll('li')).toHaveLength(4)
    expect(wrapper.get('.journey-progress').attributes('aria-hidden')).toBe('true')
    expect(log.attributes('aria-live')).toBeUndefined()
    expect(log.text()).toContain('The sealed commission result remains unknown until return.')
  })

  it('describes complete and failed returns, including a full-stash reward', () => {
    const commission = {
      ...safeOption, id: 'commission-1', status: 'ready' as const, durationMs: 62_000, successChance: 0.67,
      fullRewardGold: 68, partialRewardGold: 23, startedAt: '2026-09-10T20:00:00.000Z',
      finishesAt: '2026-09-10T20:01:02.000Z', outcomeRoll: 0.2
    }
    const complete = mount(VisitorPost, {
      props: {
        visitor: visitor({ state: 'returned', commission: { ...commission, outcome: 'complete', rewardGold: 68 } }),
        stash: [sword], gold: 450, stashLimit: 1, quests: [quest], now: Date.now()
      }
    })
    expect(complete.text()).toContain('Full reward: 68g; reward item cannot fit in the full stash')

    const failed = mount(VisitorPost, {
      props: {
        visitor: visitor({ state: 'returned', commission: { ...commission, outcome: 'failed', rewardGold: 0 } }),
        stash: [], gold: 450, stashLimit: 1, quests: [quest], now: Date.now()
      }
    })
    expect(failed.text()).toContain('The expedition failed. There is no reward to collect')
    expect(failed.get('[data-testid="claim-visitor-1"]').text()).toContain('Acknowledge return')
  })

  it('labels pending trade and departure controls with their disabled reason', () => {
    const wrapper = mount(VisitorPost, {
      props: { visitor: visitor(), stash: [sword], gold: 450, stashLimit: 20, quests: [quest], now: Date.now(), pending: true }
    })
    const sell = wrapper.get('[data-testid="sell-sword"]')
    expect(sell.attributes('disabled')).toBeDefined()
    expect(sell.attributes('aria-describedby')).toBe('sell-reason-sword')
    expect(wrapper.text()).toContain('Processing…')
    expect(wrapper.text()).toContain('Another action is being processed')
  })

  it('explains that an emptied post rotates independently', () => {
    const wrapper = mount(VisitorPost, {
      props: {
        visitor: visitor({ state: 'departed', departedAt: '2026-09-10T20:01:00.000Z' }),
        stash: [], gold: 450, stashLimit: 20, quests: [quest], now: Date.now()
      }
    })

    expect(wrapper.text()).toContain('This post checks independently for a new visitor after its next arrival check.')
    expect(wrapper.text()).not.toContain('pair')
  })
})
