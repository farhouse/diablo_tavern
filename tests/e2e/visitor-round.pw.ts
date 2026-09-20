import { expect, test } from '@playwright/test'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGO_TEST_URI
const mongoDbName = process.env.MONGO_DB_NAME || 'diablo_management'

test.skip(!mongoUri, 'MONGO_TEST_URI is required for the persisted visitor-round E2E.')

test('persists legacy trade and dismissal across reloads', async ({ page }) => {
  test.setTimeout(120_000)

  const email = `visitor-round-${Date.now()}@example.test`
  const client = new MongoClient(mongoUri!)
  await client.connect()
  const database = client.db(mongoDbName)
  const users = database.collection('users')
  const saves = database.collection('savegames')

  try {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Register instead' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill('visitor-round-password')
    await page.getByLabel('Invite Code').fill('e2e')
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL('**/tavern')
    const user = await users.findOne({ email })
    expect(user).not.toBeNull()
    const userId = String(user!._id)
    const initial = await saves.findOne({ userId })
    expect(initial?.schemaVersion).toBe(3)
    expect(initial?.visitRound?.number).toBe(1)

    const firstPost = page.locator('.visitor-post').first()
    await expect(firstPost).toBeVisible()
    const firstVisitorId = (await firstPost.getAttribute('aria-labelledby'))!.replace('visitor-', '')

    await firstPost.locator('[data-testid^="sell-"]').first().click()
    await expect(firstPost.getByText('Sale used for this visit.')).toBeVisible()
    await firstPost.locator('[data-testid^="buy-"]').first().click()
    await expect(firstPost.getByText('Purchase used for this visit.')).toBeVisible()

    const traded = await saves.findOne({ userId })
    const tradedVisitor = traded!.visitRound.slots.find((slot: any) => slot.visitor?.id === firstVisitorId)!.visitor
    expect(tradedVisitor.trades).toHaveLength(2)
    await page.reload({ waitUntil: 'networkidle' })
    await expect(firstPost.getByText('Sale used for this visit.')).toBeVisible()
    await expect(firstPost.getByText('Purchase used for this visit.')).toBeVisible()

    await firstPost.getByTestId(`dismiss-${firstVisitorId}`).click()
    await expect(page.getByTestId(`dismiss-${firstVisitorId}`)).toHaveCount(0)

    const remainingPost = page.locator('.visitor-post').first()
    await remainingPost.locator('[data-testid^="dismiss-"]').click()
    await expect(page.locator('.visitor-post')).toHaveCount(0)

    const dismissed = await saves.findOne({ userId })
    expect(dismissed!.visitRound.slots.every((slot: any) => !slot.visitor)).toBe(true)
    expect(dismissed).not.toHaveProperty('heroes')
    expect(dismissed).not.toHaveProperty('activeExpeditions')

    const persistedRevision = dismissed!.revision
    const persistedRoundId = dismissed!.visitRound.id
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.locator('.visitor-slot--empty')).toHaveCount(2)
    const reloaded = await saves.findOne({ userId })
    expect(reloaded?.revision).toBe(persistedRevision)
    expect(reloaded?.visitRound?.id).toBe(persistedRoundId)
    expect(reloaded?.visitRound?.slots.every((slot: any) => !slot.visitor)).toBe(true)
  } finally {
    const user = await users.findOne({ email })
    if (user) await saves.deleteMany({ userId: String(user._id) })
    await users.deleteMany({ email })
    await client.close()
  }
})
