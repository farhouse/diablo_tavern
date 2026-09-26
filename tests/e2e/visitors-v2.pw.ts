import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGO_URI
const mongoDbName = process.env.MONGO_DB_NAME

test.skip(!mongoUri || !mongoDbName || mongoDbName === 'diablo_management', 'An isolated MONGO_URI and MONGO_DB_NAME are required.')

type GameSnapshot = {
  revision: number
  visitors: Array<{ visitorId: string; state: string }>
  expeditions: Array<{ expeditionId: string; visitorId: string; state: string }>
  settlements: Array<{ settlementId: string; state: string }>
  recoveries: Array<{ recoveryId: string; state: string }>
}

async function register(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Register instead' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('visitors-v2-password')
  await page.getByLabel('Invite Code').fill('e2e')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/tavern')
  await page.waitForLoadState('networkidle')
}

async function cleanup(database: ReturnType<MongoClient['db']>, email: string): Promise<void> {
  const users = database.collection('users')
  const saves = database.collection('savegames')
  const user = await users.findOne({ email })
  if (user) await saves.deleteMany({ userId: String(user._id) })
  await users.deleteMany({ email })
}

async function openV2(page: Page): Promise<{ response: Awaited<ReturnType<typeof page.waitForResponse>>; game: GameSnapshot }> {
  const gameResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v2/game')
  await page.goto('/visitors-v2')
  await page.waitForURL('**/visitors-v2')
  const response = await gameResponsePromise
  return { response, game: await response.json() as GameSnapshot }
}

test('completes the authenticated V2 visitor cycle and persists settlement state', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const email = `visitors-v2-cycle-${Date.now()}@example.test`
  const client = new MongoClient(mongoUri!)
  await client.connect()
  const database = client.db(mongoDbName!)
  const users = database.collection('users')
  const saves = database.collection('savegames')

  try {
    await register(page, email)
    const legacyRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/savegame') legacyRequests.push(request.url())
    })

    const { response: gameResponse, game } = await openV2(page)
    expect(gameResponse.ok()).toBe(true)
    expect(gameResponse.request().headers().authorization).toMatch(/^Bearer /)
    expect(legacyRequests).toHaveLength(0)

    const acceptResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v2/contracts/accept')
    await page.getByRole('button', { name: 'Aceptar contrato' }).first().click()
    const acceptResponse = await acceptResponsePromise
    expect(acceptResponse.ok()).toBe(true)
    const accepted = await acceptResponse.json() as { requestId: string; revision: number; game: GameSnapshot }
    expect(accepted.requestId).toEqual(expect.any(String))
    expect(accepted.revision).toBeGreaterThan(game.revision)
    const acceptEnvelope = acceptResponse.request().postDataJSON()
    expect(Object.keys(acceptEnvelope).sort()).toEqual(['expectedRevision', 'payload', 'requestId'])
    expect(acceptEnvelope.requestId).toEqual(expect.any(String))
    expect(acceptEnvelope.expectedRevision).toBe(game.revision)
    expect(Object.keys(acceptEnvelope.payload).sort()).toEqual(['loanItemIds', 'optionId', 'visitorId'])
    const contractedVisitor = accepted.game.visitors.find((visitor) => visitor.state === 'contracted')
    expect(contractedVisitor).toBeDefined()
    await expect(page.getByTestId('visitor-contracted')).toBeVisible()

    const startResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v2/expeditions/start')
    await page.getByRole('button', { name: 'Iniciar expedición' }).click()
    const startResponse = await startResponsePromise
    expect(startResponse.ok()).toBe(true)
    const started = await startResponse.json() as { revision: number; game: GameSnapshot }
    const expedition = started.game.expeditions.find((candidate) => candidate.visitorId === contractedVisitor!.visitorId)
    expect(expedition?.state).toBe('active')

    const user = await users.findOne({ email })
    expect(user).not.toBeNull()
    const userId = String(user!._id)
    const persisted = await saves.findOne({ userId }) as unknown as {
      revision: number
      visitorCycle: { expeditions: Record<string, { events: Array<{ occursAt: string }> }> }
    }
    const persistedExpedition = persisted.visitorCycle.expeditions[expedition!.expeditionId]
    if (!persistedExpedition || persistedExpedition.events.length === 0) throw new Error('The persisted expedition did not publish events.')
    const acceleratedAt = Date.now() - 1_000
    const events = persistedExpedition.events.map((event, index) => ({
      ...event,
      occursAt: new Date(acceleratedAt - (persistedExpedition.events.length - index) * 1_000).toISOString()
    }))
    const acceleratedUpdate = await saves.updateOne(
      { userId, revision: persisted.revision },
      { $set: { [`visitorCycle.expeditions.${expedition!.expeditionId}.events`]: events } }
    )
    expect(acceleratedUpdate.modifiedCount).toBe(1)

    const reconcileResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v2/reconcile')
    await page.getByRole('button', { name: 'Reconciliar' }).click()
    const reconcileResponse = await reconcileResponsePromise
    expect(reconcileResponse.ok()).toBe(true)
    const reconciled = await reconcileResponse.json() as { revision: number; game: GameSnapshot }
    const preview = reconciled.game.settlements.find((settlement) => settlement.state === 'preview_ready')
    expect(preview).toBeDefined()
    await expect(page.getByTestId('settlement-preview_ready')).toBeVisible()

    const confirmResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v2/settlements/confirm')
    await page.getByRole('button', { name: 'Confirmar preview' }).click()
    const confirmResponse = await confirmResponsePromise
    expect(confirmResponse.ok()).toBe(true)
    const confirmed = await confirmResponse.json() as { revision: number; game: GameSnapshot }
    expect(confirmed.game.settlements.find((settlement) => settlement.settlementId === preview!.settlementId)?.state).toBe('settled')
    await expect(page.getByTestId('settlement-settled')).toBeVisible()

    const recoveries = confirmed.game.recoveries.filter((recovery) => recovery.state === 'open')
    if (recoveries.length) await expect(page.getByTestId('recovery-open')).toHaveCount(recoveries.length)
    testInfo.annotations.push({
      type: 'recovery',
      description: recoveries.length ? 'Recovery published and visible after death outcome.' : 'No recovery published by this outcome; snapshot had no open recovery.'
    })

    await page.screenshot({ path: testInfo.outputPath('visitors-v2-mobile-settled.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.screenshot({ path: testInfo.outputPath('visitors-v2-desktop-settled.png'), fullPage: true })

    const reloadGameResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v2/game')
    await page.reload({ waitUntil: 'networkidle' })
    const reloaded = await (await reloadGameResponsePromise).json() as GameSnapshot
    expect(reloaded.revision).toBe(confirmed.revision)
    expect(reloaded.settlements.find((settlement) => settlement.settlementId === preview!.settlementId)?.state).toBe('settled')
    await expect(page.getByTestId('settlement-settled')).toBeVisible()
    expect(legacyRequests).toHaveLength(0)
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true)

    await page.goto('/equipment-v2')
    await expect(page.getByRole('heading', { name: 'Equipo y servicios' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Inventario de la caravana' })).toBeVisible()
    await page.goto('/caravan-v2')
    await expect(page.getByRole('heading', { name: 'Caravana V2' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Mejoras de caravana' })).toBeVisible()
    await page.goto('/chronicle-v2')
    await expect(page.getByRole('heading', { name: 'Crónica V2' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Crónica histórica' })).toBeVisible()
    expect(legacyRequests).toHaveLength(0)
  } finally {
    await cleanup(database, email)
    await client.close()
  }
})

test('shows the published next step for a historical stale contract and reconciles it', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const email = `visitors-v2-history-${Date.now()}@example.test`
  const client = new MongoClient(mongoUri!)
  await client.connect()
  const database = client.db(mongoDbName!)
  const users = database.collection('users')
  const saves = database.collection('savegames')

  try {
    await register(page, email)
    const { game } = await openV2(page)
    const visitor = game.visitors.find((candidate) => candidate.state === 'available')
    expect(visitor).toBeDefined()
    const user = await users.findOne({ email })
    expect(user).not.toBeNull()
    const userId = String(user!._id)
    const persisted = await saves.findOne({ userId }) as unknown as { revision: number; visitorCycle: { visitors: Record<string, { contractOptions: Array<Record<string, unknown>> }> } }
    const staleOptions = persisted.visitorCycle.visitors[visitor!.visitorId]!.contractOptions.map((option) => ({
      ...option,
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }))
    const staleUpdate = await saves.updateOne(
      { userId, revision: persisted.revision },
      { $set: { [`visitorCycle.visitors.${visitor!.visitorId}.contractOptions`]: staleOptions } }
    )
    expect(staleUpdate.modifiedCount).toBe(1)

    const staleGameResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v2/game')
    await page.reload({ waitUntil: 'networkidle' })
    const staleGame = await (await staleGameResponsePromise).json() as GameSnapshot
    expect(staleGame.revision).toBe(game.revision)
    const availableIndex = game.visitors.slice(0, game.visitors.indexOf(visitor!)).filter((candidate) => candidate.state === 'available').length
    const staleRow = page.getByTestId('visitor-available').nth(availableIndex)
    await expect(staleRow.getByRole('button', { name: 'Aceptar contrato' })).toBeDisabled()
    await expect(staleRow).toContainText('Reconciliá')
    await expect(page.getByText('Acción no publicada en el snapshot.')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('visitors-v2-mobile-stale-history.png'), fullPage: true })

    const reconcileResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v2/reconcile')
    await page.getByRole('button', { name: 'Reconciliar' }).click()
    const reconcileResponse = await reconcileResponsePromise
    expect(reconcileResponse.ok()).toBe(true)
    const reconciled = await reconcileResponse.json() as { game: GameSnapshot }
    expect(reconciled.game.visitors.find((candidate) => candidate.visitorId === visitor!.visitorId)?.state).toBe('available')
    await expect(staleRow.getByRole('button', { name: 'Aceptar contrato' })).toBeEnabled()
    await expect(staleRow).not.toContainText('Reconciliá')
    await page.screenshot({ path: testInfo.outputPath('visitors-v2-mobile-reconciled-history.png'), fullPage: true })
  } finally {
    await cleanup(database, email)
    await client.close()
  }
})
