import { expect, test } from '@playwright/test'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGO_TEST_URI
const mongoDbName = process.env.MONGO_DB_NAME

test.skip(!mongoUri || !mongoDbName, 'MONGO_TEST_URI and an isolated MONGO_DB_NAME are required.')

test('loads and mutates the authenticated V2 route with the exact command envelope', async ({ page }) => {
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

    const gameResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v2/game')
    await page.getByRole('link', { name: 'Visitantes V2' }).click()
    await page.waitForURL('**/visitors-v2')
    const gameResponse = await gameResponsePromise
    expect(gameResponse.ok()).toBe(true)
    expect(gameResponse.request().headers().authorization).toMatch(/^Bearer /)
    const game = await gameResponse.json()

    const requestPromise = page.waitForRequest((request) => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v2/contracts/accept')
    await page.locator('button:not([disabled])', { hasText: 'Aceptar contrato' }).first().click()
    const request = await requestPromise
    expect(request.headers().authorization).toMatch(/^Bearer /)
    const envelope = request.postDataJSON()
    expect(Object.keys(envelope).sort()).toEqual(['expectedRevision', 'payload', 'requestId'])
    expect(envelope.requestId).toEqual(expect.any(String))
    expect(envelope.expectedRevision).toBe(game.revision)
    expect(Object.keys(envelope.payload).sort()).toEqual(['loanItemIds', 'optionId', 'visitorId'])
    await expect(page.getByTestId('v2-ready')).toBeVisible()
  } finally {
    const user = await users.findOne({ email })
    if (user) await saves.deleteMany({ userId: String(user._id) })
    await users.deleteMany({ email })
    await client.close()
  }
})
