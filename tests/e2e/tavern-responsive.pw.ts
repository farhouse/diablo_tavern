import { expect, test } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL
const email = process.env.PLAYWRIGHT_DEMO_EMAIL
const password = process.env.PLAYWRIGHT_DEMO_PASSWORD

if (!baseURL || !email || !password) {
  throw new Error('PLAYWRIGHT_BASE_URL, PLAYWRIGHT_DEMO_EMAIL and PLAYWRIGHT_DEMO_PASSWORD are required.')
}

const viewports = [
  { name: '2k', width: 2560, height: 1440 },
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
]

for (const viewport of viewports) {
  test(`${viewport.name} keeps the Tavern readable without overflow or stretched posts`, async ({ browser }) => {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.route('**/api/savegame', route => route.fulfill({ json: responsiveSave }))
    await page.route('**/api/quests', route => route.fulfill({ json: responsiveQuests }))
    await page.goto(`${baseURL}/login`)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Login' }).click()
    await page.waitForURL('**/tavern')
    await page.getByRole('region', { name: 'Visitor posts' }).waitFor()

    const geometry = await page.evaluate(() => {
      const tavern = document.querySelector<HTMLElement>('.tavern-page')
      const grid = document.querySelector<HTMLElement>('.visitor-grid')
      const posts = [...document.querySelectorAll<HTMLElement>('.visitor-grid > .visitor-post, .visitor-grid > .visitor-slot')]
      const tradeColumns = document.querySelector<HTMLElement>('.trade-columns')
      const missionOption = document.querySelector<HTMLElement>('.mission-option')
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tavernWidth: tavern?.getBoundingClientRect().width ?? 0,
        gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        gridAlignment: grid ? getComputedStyle(grid).alignItems : '',
        tradeColumns: tradeColumns ? getComputedStyle(tradeColumns).gridTemplateColumns.split(' ').length : 0,
        missionColumns: missionOption ? getComputedStyle(missionOption).gridTemplateColumns.split(' ').length : 0,
        posts: posts.map((post) => {
          const rect = post.getBoundingClientRect()
          const style = getComputedStyle(post)
          const contentBottom = Math.max(...[...post.children].map(child => child.getBoundingClientRect().bottom))
          const expectedBottomGap = Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth)
          return { width: rect.width, top: rect.top, bottomGap: rect.bottom - contentBottom, expectedBottomGap }
        })
      }
    })

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth)
    expect(geometry.posts).toHaveLength(2)
    expect(geometry.gridAlignment).toBe('start')
    expect(geometry.tradeColumns).toBeGreaterThan(0)
    expect(geometry.missionColumns).toBeGreaterThan(0)
    for (const post of geometry.posts) expect(post.bottomGap).toBeLessThanOrEqual(post.expectedBottomGap + 2)

    if (viewport.width === 2560) {
      expect(geometry.tavernWidth).toBeGreaterThanOrEqual(1600)
      expect(geometry.gridColumns).toBe(2)
      expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(740)
      expect(geometry.tradeColumns).toBe(2)
      expect(geometry.missionColumns).toBe(2)
    } else if (viewport.width === 1440) {
      expect(geometry.gridColumns).toBe(2)
      expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(620)
      expect(geometry.tradeColumns).toBe(1)
      expect(geometry.missionColumns).toBe(1)
    } else {
      expect(geometry.gridColumns).toBe(1)
      expect(geometry.posts[0]!.width).toBeLessThanOrEqual(358)
      expect(geometry.posts[1]!.top).toBeGreaterThan(geometry.posts[0]!.top)
      expect(geometry.tradeColumns).toBe(1)
      expect(geometry.missionColumns).toBe(1)
    }

    await context.close()
  })
}

const item = {
  id: 'stash-sword', baseName: 'Short Sword', displayName: 'Short Sword', type: 'weapon', rarity: 'normal',
  identified: true, width: 1, height: 3, requiredLevel: 1, affixes: [{ stat: 'attackPower', value: 8 }], value: 35
}
const options = [
  { optionId: 'safe', title: 'Careful patrol', regionId: 'blood-moor', durationMs: 46_000, successChance: 0.82, fullRewardGold: 54, partialRewardGold: 18, riskLevel: 'low', failureConsequence: 'The slot stays occupied for the full duration and yields no reward.' },
  { optionId: 'risky', title: 'Perilous delve', regionId: 'blood-moor', durationMs: 108_000, successChance: 0.52, fullRewardGold: 122, partialRewardGold: 32, riskLevel: 'high', failureConsequence: 'The slot stays occupied longer and a failure yields no reward.' }
]
const visitor = (id: string, name: string) => ({
  id, name, class: 'barbarian', level: 3, origin: 'Ashen Foothills',
  equipmentSummary: [{ name: 'Worn battle axe', type: 'weapon', powerBonus: 0 }], state: 'traded',
  budget: 140, initialBudget: 140, acceptedItemTypes: ['weapon', 'armor'], interestedItemTypes: ['weapon'],
  offers: [{ id: `${id}-offer`, item: { ...item, id: `${id}-item` }, price: 40 }],
  buyQuotes: { [item.id]: 31 }, trades: [], power: 69, commissionOptions: options,
  arrivedAt: '2026-09-10T20:00:00.000Z'
})
const responsiveSave = {
  userId: 'responsive-e2e', gold: 450, materials: 0,
  caravan: { level: 0, upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 }, services: { appraiserQueue: [] } },
  stashLimit: 20, heroes: [], stash: [item], pendingLoot: [],
  questsProgress: [{ questId: 'blood-moor', completed: false, unlocked: true }],
  activeExpeditions: [], expeditionHistory: [],
  visitRound: {
    id: 'responsive-round', number: 1, createdAt: '2026-09-10T20:00:00.000Z',
    slots: [
      { id: 'visitor-slot-1', visitor: visitor('visitor-1', 'Mira') },
      { id: 'visitor-slot-2', visitor: { ...visitor('visitor-2', 'Kael'), state: 'returned', commission: { ...options[0], id: 'commission-1', status: 'ready', startedAt: '2026-09-10T20:00:00.000Z', finishesAt: '2026-09-10T20:01:00.000Z', outcomeRoll: 0.2, outcome: 'partial', rewardGold: 18 } } }
    ]
  },
  visitHistory: [], processedRequestIds: [], processedRequests: [], revision: 1,
  createdAt: '2026-09-10T20:00:00.000Z', updatedAt: '2026-09-10T20:00:00.000Z'
}
const responsiveQuests = [{
  id: 'blood-moor', name: 'Blood Moor', act: 1, difficulty: 34, minLevel: 1,
  rewards: { xp: 70, gold: 90 }, lootTableId: 'act1-low'
}]
