import { expect, test } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL
const email = process.env.PLAYWRIGHT_DEMO_EMAIL
const password = process.env.PLAYWRIGHT_DEMO_PASSWORD

const viewports = [
  { name: '2k', width: 2560, height: 1440 },
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
]

test.skip(!baseURL || !email || !password, 'Set the Playwright demo URL and credentials to run responsive QA.')

for (const viewport of viewports) {
  test(`${viewport.name} keeps the Tavern readable without overflow or stretched posts`, async ({ browser }) => {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(`${baseURL}/login`)
    await page.getByLabel('Email').fill(email!)
    await page.getByLabel('Password').fill(password!)
    await page.getByRole('button', { name: 'Login' }).click()
    await page.waitForURL('**/tavern')
    await page.getByRole('region', { name: 'Visitor posts' }).waitFor()

    const geometry = await page.evaluate(() => {
      const tavern = document.querySelector<HTMLElement>('.tavern-page')
      const grid = document.querySelector<HTMLElement>('.visitor-grid')
      const posts = [...document.querySelectorAll<HTMLElement>('.visitor-grid > .visitor-post, .visitor-grid > .visitor-slot')]
      const tradeColumns = document.querySelector<HTMLElement>('.trade-columns')
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tavernWidth: tavern?.getBoundingClientRect().width ?? 0,
        gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        gridAlignment: grid ? getComputedStyle(grid).alignItems : '',
        tradeColumns: tradeColumns ? getComputedStyle(tradeColumns).gridTemplateColumns.split(' ').length : null,
        posts: posts.map((post) => {
          const rect = post.getBoundingClientRect()
          return { width: rect.width, height: rect.height, scrollHeight: post.scrollHeight, top: rect.top }
        })
      }
    })

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth)
    expect(geometry.posts).toHaveLength(2)
    expect(geometry.gridAlignment).toBe('start')
    for (const post of geometry.posts) expect(Math.abs(post.height - post.scrollHeight)).toBeLessThanOrEqual(4)

    if (viewport.width === 2560) {
      expect(geometry.tavernWidth).toBeGreaterThanOrEqual(1600)
      expect(geometry.gridColumns).toBe(2)
      expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(740)
      if (geometry.tradeColumns) expect(geometry.tradeColumns).toBe(2)
    } else if (viewport.width === 1440) {
      expect(geometry.gridColumns).toBe(2)
      expect(Math.min(...geometry.posts.map(post => post.width))).toBeGreaterThan(620)
      if (geometry.tradeColumns) expect(geometry.tradeColumns).toBe(1)
    } else {
      expect(geometry.gridColumns).toBe(1)
      expect(geometry.posts[0]!.width).toBeLessThanOrEqual(358)
      expect(geometry.posts[1]!.top).toBeGreaterThan(geometry.posts[0]!.top)
      if (geometry.tradeColumns) expect(geometry.tradeColumns).toBe(1)
    }

    await context.close()
  })
}
