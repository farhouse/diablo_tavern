import { expect, test } from '@playwright/test'

const expectedSha = process.env.PLAYWRIGHT_EXPECTED_SHA

if (!expectedSha) {
  throw new Error('PLAYWRIGHT_EXPECTED_SHA must be supplied by playwright.config.ts.')
}

const viewports = [
  { name: '2k', width: 2560, height: 1440 },
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
]

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport })

    test('keeps the Tavern readable without overflow or stretched posts', async ({ page, request }) => {
      const buildInfo = await request.get('/api/build-info')
      await expect(buildInfo).toBeOK()
      await expect(buildInfo.json()).resolves.toEqual({ sha: expectedSha })

      await page.route('**/api/auth/login', route => route.fulfill({ json: responsiveAuth }))
      await page.route('**/api/savegame', route => route.fulfill({ json: responsiveSave }))
      await page.goto('/login')
      await page.getByLabel('Email').fill('responsive@example.test')
      await page.getByLabel('Password').fill('responsive-test-password')
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
            return { width: rect.width, height: rect.height, top: rect.top }
          })
        }
      })

      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth)
      expect(geometry.posts).toHaveLength(2)
      expect(geometry.gridAlignment).toBe('start')
      expect(geometry.tradeColumns).toBeGreaterThan(0)
      expect(geometry.missionColumns).toBeGreaterThan(0)

      if (viewport.width === 2560) {
        expect(geometry.tavernWidth).toBeGreaterThanOrEqual(1600)
        expect(geometry.gridColumns).toBe(2)
        expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(740)
        expect(geometry.tradeColumns).toBe(2)
        expect(geometry.missionColumns).toBe(2)
        expect(geometry.posts[0]!.height - geometry.posts[1]!.height).toBeGreaterThan(300)
      } else if (viewport.width === 1440) {
        expect(geometry.gridColumns).toBe(2)
        expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(620)
        expect(geometry.tradeColumns).toBe(1)
        expect(geometry.missionColumns).toBe(1)
        expect(geometry.posts[0]!.height - geometry.posts[1]!.height).toBeGreaterThan(300)
      } else {
        expect(geometry.gridColumns).toBe(1)
        expect(geometry.posts[0]!.width).toBeLessThanOrEqual(358)
        expect(geometry.posts[1]!.top).toBeGreaterThan(geometry.posts[0]!.top)
        expect(geometry.tradeColumns).toBe(1)
        expect(geometry.missionColumns).toBe(1)
        const mobileControls = page.locator([
          '[data-testid^="buy-"]',
          '[data-testid^="sell-"]',
          '[data-testid^="review-"]',
          '[data-testid^="claim-"]',
          '[data-testid^="dismiss-"]'
        ].join(', '))
        const mobileControlCount = await mobileControls.count()
        expect(mobileControlCount).toBeGreaterThan(0)

        for (let index = 0; index < mobileControlCount; index += 1) {
          const control = mobileControls.nth(index)
          const container = control.locator('..')
          await expect(control).toBeVisible()
          await expect(container).toBeVisible()

          const controlBox = await control.boundingBox()
          const containerBox = await container.boundingBox()
          expect(controlBox).not.toBeNull()
          expect(containerBox).not.toBeNull()
          expect(controlBox!.width).toBeGreaterThan(0)
          expect(controlBox!.height).toBeGreaterThan(0)
          expect(containerBox!.width).toBeGreaterThan(0)
          expect(containerBox!.height).toBeGreaterThan(0)

          const containerInsets = await container.evaluate((element) => {
            const style = getComputedStyle(element)
            return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
              + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth)
          })
          const containerContentWidth = containerBox!.width - containerInsets
          expect(containerContentWidth).toBeGreaterThan(0)
          expect(Math.abs(controlBox!.width - containerContentWidth)).toBeLessThanOrEqual(1)
        }
      }
    })
  })
}

const responsiveAuth = {
  user: { id: 'responsive-e2e', email: 'responsive@example.test' },
  accessToken: 'responsive-access-token',
  refreshToken: 'responsive-refresh-token'
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
  schemaVersion: 2, userId: 'responsive-e2e', gold: 450,
  caravan: { level: 0, upgrades: { stashWagon: 0, appraiser: 0 }, services: { appraiserQueue: [] } },
  stashLimit: 20, stash: [item], unlockedRegionIds: ['blood-moor'],
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
