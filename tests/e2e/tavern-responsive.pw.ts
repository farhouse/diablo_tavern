import { expect, type Locator, type Page, test } from '@playwright/test'

const expectedSha = process.env.PLAYWRIGHT_EXPECTED_SHA

if (!expectedSha) {
  throw new Error('PLAYWRIGHT_EXPECTED_SHA must be supplied by playwright.config.ts.')
}

type LayoutSnapshot = {
  innerWidth: number
  scrollWidth: number
  maxElementWidth: number
  selectorCounts: Record<string, number>
  violations: string[]
}

type Scenario = {
  name: string
  slug: string
  path: string
  save: Record<string, unknown>
  geometrySelectors: string[]
  readySelector: string
  disabledCheck: (page: Page) => Promise<void>
  loadingSetup: (page: Page) => Promise<Locator>
  mutateRouteUrl: string
  mutateSaveResponse: Record<string, unknown>
}

const unbroken = 'x'.repeat(320)

const tavernLongName = `LongName${unbroken}`
const tavernLongOrigin = `LongOrigin${unbroken}`
const tavernLongEquipment = `LongEquipment${unbroken}`
const tavernLongMission = `LongMissionDescription${unbroken}`
const stashLongItem = `Unidentified${unbroken}`
const stashLongIdentify = `LongIdentify${unbroken}`
const caravanQueueItem = `QueueItem${unbroken}`

function visitorPayload(id: string, name: string, state: 'open' | 'traded') {
  return {
    id,
    name,
    class: 'barbarian',
    level: 3,
    origin: `${tavernLongOrigin}-${id}`,
    equipmentSummary: [
      {
        name: `${tavernLongEquipment}-${id}`,
        itemId: `${id}-gear`,
        type: 'weapon',
        powerBonus: 0
      }
    ],
    state,
    budget: 80,
    initialBudget: 80,
    acceptedItemTypes: ['weapon', 'armor'],
    interestedItemTypes: ['weapon'],
    offers: [
      {
        id: `offer-${id}`,
        item: {
          id: `offer-item-${id}`,
          baseName: `Offer ${id}`,
          displayName: `Offer ${id}`,
          type: 'weapon',
          rarity: 'normal',
          identified: true,
          width: 1,
          height: 2,
          requiredLevel: 1,
          affixes: [{ stat: 'attackPower', value: 11 }],
          value: 34
        },
        price: 450
      }
    ],
    buyQuotes: { [`offer-item-${id}`]: 420 },
    trades: [],
    power: 69,
    commissionOptions: [
      {
        id: `commission-${id}`,
        optionId: 'safe',
        title: `Cautious ${id}`,
        regionId: 'blood-moor',
        durationMs: 46_000,
        successChance: 0.82,
        fullRewardGold: 60,
        partialRewardGold: 18,
        riskLevel: 'low',
        failureConsequence: `${tavernLongMission}-${id}`
      }
    ],
    arrivedAt: '2026-09-10T20:00:00.000Z'
  }
}

const tavernSave = {
  schemaVersion: 3,
  userId: 'responsive-e2e',
  gold: 6,
  caravan: { level: 0, upgrades: { stashWagon: 0, appraiser: 0 }, services: { appraiserQueue: [] } },
  stashLimit: 20,
  stash: [],
  unlockedRegionIds: ['blood-moor', 'dark-crypt'],
  visitRound: {
    id: 'responsive-round',
    number: 1,
    createdAt: '2026-09-10T20:00:00.000Z',
    slots: [
      { id: 'visitor-slot-1', visitor: visitorPayload('traveler-one', tavernLongName, 'traded') },
      { id: 'visitor-slot-2', visitor: { ...visitorPayload('traveler-two', `${tavernLongName}B`, 'open') } }
    ]
  },
  visitHistory: [],
  processedRequestIds: [],
  processedRequests: [],
  revision: 1,
  createdAt: '2026-09-10T20:00:00.000Z',
  updatedAt: '2026-09-10T20:00:00.000Z'
}

const stashSave = {
  schemaVersion: 3,
  userId: 'responsive-e2e',
  gold: 900,
  caravan: { level: 0, upgrades: { stashWagon: 0, appraiser: 1 }, services: { appraiserQueue: [{ id: 'job-queue', itemId: 'queued-long-item', finishesAt: '2026-09-10T20:01:00.000Z' }] } },
  stashLimit: 24,
  stash: [
    {
      id: 'queued-long-item',
      baseName: stashLongItem,
      displayName: stashLongItem,
      type: 'armor',
      rarity: 'normal',
      identified: false,
      width: 1,
      height: 2,
      requiredLevel: 1,
      affixes: [{ stat: 'health', value: 8 }],
      value: 20
    },
    {
      id: 'identify-target',
      baseName: stashLongIdentify,
      displayName: stashLongIdentify,
      type: 'armor',
      rarity: 'magic',
      identified: false,
      width: 1,
      height: 3,
      requiredLevel: 2,
      affixes: [{ stat: 'attackPower', value: 11 }],
      value: 20
    }
  ],
  unlockedRegionIds: ['blood-moor'],
  visitRound: { id: 'responsive-round', number: 1, createdAt: '2026-09-10T20:00:00.000Z', slots: [] },
  visitHistory: [],
  processedRequestIds: [],
  processedRequests: [],
  revision: 1,
  createdAt: '2026-09-10T20:00:00.000Z',
  updatedAt: '2026-09-10T20:00:00.000Z'
}

const caravanSave = {
  schemaVersion: 3,
  userId: 'responsive-e2e',
  gold: 5,
  caravan: { level: 0, upgrades: { stashWagon: 0, appraiser: 1 }, services: { appraiserQueue: [{ id: 'job-queue', itemId: 'queued-long-item', finishesAt: '2026-09-10T20:01:00.000Z' }] } },
  stashLimit: 28,
  stash: [
    {
      id: 'queued-long-item',
      baseName: caravanQueueItem,
      displayName: caravanQueueItem,
      type: 'weapon',
      rarity: 'normal',
      identified: false,
      width: 1,
      height: 2,
      requiredLevel: 2,
      affixes: [{ stat: 'attackPower', value: 10 }],
      value: 16
    }
  ],
  unlockedRegionIds: ['blood-moor'],
  visitRound: { id: 'responsive-round', number: 1, createdAt: '2026-09-10T20:00:00.000Z', slots: [] },
  visitHistory: [],
  processedRequestIds: [],
  processedRequests: [],
  revision: 1,
  createdAt: '2026-09-10T20:00:00.000Z',
  updatedAt: '2026-09-10T20:00:00.000Z'
}

const scenarios: Scenario[] = [
  {
    name: 'Tavern',
    slug: 'tavern',
    path: '/tavern',
    save: tavernSave,
    geometrySelectors: [
      '.tavern-page',
      '.visitor-grid',
      '.visitor-slot--empty',
      '.visitor-post',
      '.visitor-identity',
      '.visitor-title-row',
      '.visitor-title-row h2',
      '.visitor-origin',
      '.equipment-copy',
      '.equipment-copy strong',
      '.equipment-copy span',
      '.trade-item',
      '.trade-item strong',
      '.trade-item p',
      '.mission-option'
    ],
    readySelector: '.visitor-grid',
    disabledCheck: async (page) => {
      const disabledBuy = page.locator('[data-testid="buy-offer-traveler-two"]').first()
      await expect(disabledBuy).toBeVisible()
      await expect(disabledBuy).toBeDisabled()
    },
    loadingSetup: async (page) => {
      const revealReview = page.getByTestId('review-safe')
      const confirm = page.getByTestId('confirm-safe')
      await revealReview.click()
      await expect(confirm).toBeVisible()
      await confirm.click()
      return confirm
    },
    mutateRouteUrl: '**/api/visitors/*/commission',
    mutateSaveResponse: tavernSave
  },
  {
    name: 'Stash',
    slug: 'stash',
    path: '/stash',
    save: stashSave,
    geometrySelectors: [
      '.stash-page',
      '.grid.three',
      '.item',
      '.item-heading',
      '.item-heading-copy',
      '.item-heading-copy .row',
      '.item-heading-copy h2',
      '.item-heading-copy p',
      '.item-actions',
      '.item-actions .btn',
      '.salvage-details',
      '.salvage-details p'
    ],
    readySelector: '.grid.three',
    disabledCheck: async (page) => {
      const queued = page.locator('.item').filter({ hasText: stashLongItem })
      await expect(queued.getByRole('button', { name: /^Identify/ })).toBeDisabled()
    },
    loadingSetup: async (page) => {
      const longIdentifyDisplay = page.getByText(new RegExp(stashLongIdentify, 'i'))
      const actionCard = page.locator('.item').filter({ has: longIdentifyDisplay })
      const identifyButton = actionCard.getByRole('button', { name: /^Identify/ })
      await expect(identifyButton).toBeVisible()
      await identifyButton.click()
      return identifyButton
    },
    mutateRouteUrl: '**/api/items/identify-target/identify',
    mutateSaveResponse: stashSave
  },
  {
    name: 'Caravan',
    slug: 'caravan',
    path: '/caravan',
    save: caravanSave,
    geometrySelectors: [
      '.caravan-page',
      '.caravan-status',
      '.service-list',
      '.service-row',
      '.service-row > div:nth-child(2)',
      '.service-action',
      '.queue-row',
      '.appraiser-panel'
    ],
    readySelector: '.caravan-status',
    disabledCheck: async (page) => {
      const appraiserRow = page.locator('.service-row').filter({ hasText: 'Appraiser' })
      const upgradeButton = appraiserRow.getByRole('button', { name: 'Upgrade' })
      await expect(upgradeButton).toBeDisabled()
    },
    loadingSetup: async (page) => {
      const processButton = page.getByRole('button', { name: 'Process ready items' })
      await expect(processButton).toBeVisible()
      await processButton.click()
      return processButton
    },
    mutateRouteUrl: '**/api/appraiser/complete',
    mutateSaveResponse: caravanSave
  }
]

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
]

async function collectLayoutGeometry(page: Page, selectors: string[]): Promise<LayoutSnapshot> {
  return page.evaluate((selectorList) => {
    const tolerance = 1
    const off: string[] = []
    let maxWidth = 0
    const selectorCounts: Record<string, number> = {}

    for (const selector of selectorList) {
      const nodes = [...document.querySelectorAll<HTMLElement>(selector)]
      selectorCounts[selector] = nodes.length

      nodes.forEach((node, index) => {
        const bounds = node.getBoundingClientRect()
        const parentBounds = node.parentElement?.getBoundingClientRect()
        maxWidth = Math.max(maxWidth, Math.ceil(bounds.width))

        if (bounds.width > window.innerWidth + tolerance) {
          off.push(`${selector}[${index}] exceeds viewport width (${Math.ceil(bounds.width)} > ${Math.ceil(window.innerWidth)})`)
        }
        if (parentBounds && bounds.width > parentBounds.width + tolerance) {
          off.push(`${selector}[${index}] exceeds parent width (${Math.ceil(bounds.width)} > ${Math.ceil(parentBounds.width)})`)
        }
      })
    }

    return {
      innerWidth: Math.ceil(window.innerWidth),
      scrollWidth: Math.ceil(document.documentElement.scrollWidth),
      maxElementWidth: Math.ceil(maxWidth),
      selectorCounts,
      violations: off
    }
  }, selectors)
}

const responsiveAuth = {
  user: { id: 'responsive-e2e', email: 'responsive@example.test' },
  accessToken: 'responsive-access-token',
  refreshToken: 'responsive-refresh-token'
}

for (const viewport of viewports) {
  for (const scenario of scenarios) {
    test.describe(`${scenario.name} responsive layout at ${viewport.name}`, () => {
      test.use({ viewport })

      test('keeps geometry bounded and validates disabled/loading actions', async ({ page }) => {
        const buildInfo = await page.request.get('/api/build-info')
        await expect(buildInfo).toBeOK()
        await expect(buildInfo.json()).resolves.toEqual({ sha: expectedSha })

        await page.route('**/api/auth/login', (route) => {
          void route.fulfill({ json: responsiveAuth })
        })
        await page.route('**/api/savegame', (route) => {
          void route.fulfill({ json: scenario.save })
        })
        await page.route(scenario.mutateRouteUrl, (route) => {
          void route.fulfill({ json: scenario.mutateSaveResponse })
        })

        await page.goto('/login')
        await page.getByLabel('Email').fill('responsive@example.test')
        await page.getByLabel('Password').fill('responsive-test-password')
        await page.getByRole('button', { name: 'Login' }).click()
        await page.waitForURL('**/tavern')

        if (scenario.path !== '/tavern') {
          await page.goto(scenario.path)
        }
        await page.waitForURL(`**${scenario.path}`)

        await expect(page.locator(scenario.readySelector)).toBeVisible()

        const initialGeometry = await collectLayoutGeometry(page, scenario.geometrySelectors)
        expect(initialGeometry.scrollWidth).toBeLessThanOrEqual(initialGeometry.innerWidth)
        expect(initialGeometry.violations).toHaveLength(0)

        const initialPath = test.info().outputPath(`${scenario.slug}-${viewport.name}-initial.png`)
        await page.screenshot({ path: initialPath, fullPage: true })

        await scenario.disabledCheck(page)

        const loadingButton = await scenario.loadingSetup(page)

        await expect(loadingButton).toBeVisible()
        await page.waitForTimeout(150)

        const beforePath = test.info().outputPath(`${scenario.slug}-${viewport.name}-loading.png`)
        await page.screenshot({ path: beforePath, fullPage: true })

        await page.waitForLoadState('networkidle')

        const stableGeometry = await collectLayoutGeometry(page, scenario.geometrySelectors)
        expect(stableGeometry.scrollWidth).toBeLessThanOrEqual(stableGeometry.innerWidth)
        expect(stableGeometry.violations).toHaveLength(0)

        const finalPath = test.info().outputPath(`${scenario.slug}-${viewport.name}-final.png`)
        await page.screenshot({ path: finalPath, fullPage: true })
      })
    })
  }
}
