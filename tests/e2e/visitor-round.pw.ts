import { expect, test } from '@playwright/test'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGO_TEST_URI
const mongoDbName = process.env.MONGO_DB_NAME || 'diablo_management'

test.skip(!mongoUri, 'MONGO_TEST_URI is required for the persisted visitor-round E2E.')

test('persists arrival, trade, commission, return, claim and the next round across reloads', async ({ page }) => {
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
    const refreshFromServer = async () => {
      const response = page.waitForResponse((candidate) => candidate.request().method() === 'GET'
        && new URL(candidate.url()).pathname === '/api/savegame')
      await page.getByRole('button', { name: 'Refresh from server' }).click()
      await response
    }

    const user = await users.findOne({ email })
    expect(user).not.toBeNull()
    const userId = String(user!._id)
    const initial = await saves.findOne({ userId })
    expect(initial?.schemaVersion).toBe(2)
    expect(initial?.visitRound?.number).toBe(1)

    const firstPost = page.locator('.visitor-post').first()
    await expect(firstPost).toBeVisible()
    const firstVisitorId = (await firstPost.getAttribute('aria-labelledby'))!.replace('visitor-', '')

    await firstPost.locator('[data-testid^="sell-"]').first().click()
    await expect(firstPost.getByText('Sale used for this visit.')).toBeVisible()
    await firstPost.locator('[data-testid^="buy-"]').first().click()
    await expect(firstPost.getByText('Purchase used for this visit.')).toBeVisible()
    await firstPost.getByTestId('review-safe').click()
    await firstPost.getByTestId('confirm-safe').click()
    await expect(firstPost.getByRole('heading', { name: 'Away on commission' })).toBeVisible()

    const commissioned = await saves.findOne({ userId })
    const slotIndex = commissioned!.visitRound.slots.findIndex((slot: any) => slot.visitor?.id === firstVisitorId)
    expect(slotIndex).toBeGreaterThanOrEqual(0)
    await saves.updateOne({ userId }, {
      $set: {
        [`visitRound.slots.${slotIndex}.visitor.commission.finishesAt`]: new Date(Date.now() - 1_000).toISOString(),
        [`visitRound.slots.${slotIndex}.visitor.commission.outcomeRoll`]: 0
      }
    })

    await refreshFromServer()
    await expect(page.getByTestId(`claim-${firstVisitorId}`)).toBeVisible()
    await page.getByTestId(`claim-${firstVisitorId}`).click()
    await expect(page.getByTestId(`claim-${firstVisitorId}`)).toHaveCount(0)

    const remainingPost = page.locator('.visitor-post').first()
    await remainingPost.locator('[data-testid^="dismiss-"]').click()
    await expect(page.locator('.visitor-post')).toHaveCount(0)

    let nextRound: any
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const dueAt = new Date(Date.now() - 1_000).toISOString()
      await saves.updateOne({ userId }, {
        $set: {
          'visitRound.slots.0.nextArrivalCheckAt': dueAt,
          'visitRound.slots.1.nextArrivalCheckAt': dueAt
        }
      })
      await refreshFromServer()
      nextRound = await saves.findOne({ userId })
      if (nextRound?.visitRound?.slots.some((slot: any) => slot.visitor)) break
    }

    expect(nextRound.visitRound.number).toBeGreaterThan(1)
    const persistedVisitors = nextRound.visitRound.slots.flatMap((slot: any) => slot.visitor ? [slot.visitor] : [])
    expect(persistedVisitors.length).toBeGreaterThan(0)
    expect(nextRound.visitHistory.some((round: any) => round.slots.some((slot: any) => slot.visitor?.id === firstVisitorId))).toBe(true)
    expect(nextRound).not.toHaveProperty('heroes')
    expect(nextRound).not.toHaveProperty('activeExpeditions')

    const persistedRevision = nextRound.revision
    const persistedRoundId = nextRound.visitRound.id
    const persistedVisitorIds = persistedVisitors.map((visitor: any) => visitor.id)
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByText(`Visitor round ${nextRound.visitRound.number}`, { exact: true })).toBeVisible()
    const reloaded = await saves.findOne({ userId })
    expect(reloaded?.revision).toBe(persistedRevision)
    expect(reloaded?.visitRound?.id).toBe(persistedRoundId)
    expect(reloaded?.visitRound?.slots.flatMap((slot: any) => slot.visitor ? [slot.visitor.id] : [])).toEqual(persistedVisitorIds)
  } finally {
    const user = await users.findOne({ email })
    if (user) await saves.deleteMany({ userId: String(user._id) })
    await users.deleteMany({ email })
    await client.close()
  }
})
