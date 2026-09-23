import { expect, test } from '@playwright/test'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGO_URI
const mongoDbName = process.env.MONGO_DB_NAME

test.skip(!mongoUri || !mongoDbName || mongoDbName === 'diablo_management', 'An isolated MONGO_URI and MONGO_DB_NAME are required.')

test('loads and mutates the authenticated V2 route with the exact command envelope', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const email = `visitors-v2-${Date.now()}@example.test`
  const client = new MongoClient(mongoUri!)
  await client.connect()
  const database = client.db(mongoDbName!)
  const users = database.collection('users')
  const saves = database.collection('savegames')

  try {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Register instead' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill('visitors-v2-password')
    await page.getByLabel('Invite Code').fill('e2e')
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/tavern')
    await page.waitForLoadState('networkidle')

    const legacyRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/savegame') legacyRequests.push(request.url())
    })
    const gameResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v2/game')
    await page.goto('/visitors-v2')
    await page.waitForURL('**/visitors-v2')
    const gameResponse = await gameResponsePromise
    expect(gameResponse.ok()).toBe(true)
    expect(gameResponse.request().headers().authorization).toMatch(/^Bearer /)
    const game = await gameResponse.json()
    expect(legacyRequests).toHaveLength(0)

    const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.request().url()).pathname === '/api/v2/contracts/accept')
    await page.locator('button:not([disabled])', { hasText: 'Aceptar contrato' }).first().click()
    const response = await responsePromise
    expect(response.ok()).toBe(true)
    const result = await response.json()
    expect(result.requestId).toEqual(expect.any(String))
    expect(result.revision).toBeGreaterThan(game.revision)
    expect(result.game.revision).toBe(result.revision)
    const contracted = result.game.visitors.find((visitor: { state: string }) => visitor.state === 'contracted')
    expect(contracted).toBeDefined()
    const user = await users.findOne({ email })
    expect(user).not.toBeNull()
    const userId = String(user!._id)
    const persisted = await saves.findOne({ userId })
    expect(persisted?.revision).toBe(result.revision)
    expect(persisted?.visitorCycle?.visitors?.[contracted.visitorId]?.state).toBe('contracted')
    await expect(page.getByTestId('visitor-contracted')).toBeVisible()
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true)

    const reloadGameResponse = page.waitForResponse((reloadResponse) => reloadResponse.request().method() === 'GET'
      && new URL(reloadResponse.url()).pathname === '/api/v2/game')
    await page.reload({ waitUntil: 'networkidle' })
    const reloadedGame = await (await reloadGameResponse).json()
    expect(reloadedGame.revision).toBe(result.revision)
    expect(reloadedGame.visitors.find((visitor: { visitorId: string }) => visitor.visitorId === contracted.visitorId)?.state).toBe('contracted')
    await expect(page.getByTestId('visitor-contracted')).toBeVisible()
    expect(legacyRequests).toHaveLength(0)

    const request = response.request()
    expect(request.headers().authorization).toMatch(/^Bearer /)
    const envelope = request.postDataJSON()
    expect(Object.keys(envelope).sort()).toEqual(['expectedRevision', 'payload', 'requestId'])
    expect(envelope.requestId).toEqual(expect.any(String))
    expect(envelope.expectedRevision).toBe(game.revision)
    expect(Object.keys(envelope.payload).sort()).toEqual(['loanItemIds', 'optionId', 'visitorId'])
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true)
  } finally {
    const user = await users.findOne({ email })
    if (user) await saves.deleteMany({ userId: String(user._id) })
    await users.deleteMany({ email })
    await client.close()
  }
})
