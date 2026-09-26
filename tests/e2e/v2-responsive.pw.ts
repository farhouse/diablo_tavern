import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const expectedSha = process.env.PLAYWRIGHT_EXPECTED_SHA
if (!expectedSha) throw new Error('PLAYWRIGHT_EXPECTED_SHA must be supplied by playwright.config.ts.')

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts/v2-etapa0-4/fixtures.json'), 'utf8')) as { integratedPositiveCases: Array<{ id: string; value: Record<string, unknown> }> }
const game = fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-system')!.value
const chronicleEntry = { eventId: 'responsive-event', eventKey: 'visitor.arrived', type: 'visitor_arrived', occurredAt: '2026-09-26T12:00:00Z', subject: { kind: 'visitor', id: 'visitor-1' }, text: { key: 'visitor.arrived', fallback: 'Visitante llegado' }, related: { visitorId: 'visitor-1' }, itemProvenance: { zoneId: 'Ashen Vale', lootTableId: 'visitors' } }
const auth = { user: { id: 'v2-responsive', email: 'v2-responsive@example.test' }, accessToken: 'v2-token', refreshToken: 'v2-refresh' }

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(`V2 responsive ${viewport.name}`, () => {
    test.use({ viewport })

    test('covers caravan and chronicle states, reduced motion and 400% reflow', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.route('**/api/v2/game', (route) => route.fulfill({ json: game }))
      await page.route('**/api/v2/chronicle?limit=30', (route) => route.fulfill({ json: { entries: [chronicleEntry], nextCursor: 'opaque+/=' } }))
      await page.route('**/api/v2/chronicle?limit=30&cursor=*', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }))
      await page.route('**/api/v2/caravan/upgrade', async (route) => {
        const body = route.request().postDataJSON() as { payload: Record<string, unknown> }
        expect(Object.keys(body.payload)).toEqual(['optionId'])
        const upgraded = structuredClone(game)
        upgraded.revision += 1
        await route.fulfill({ json: { game: upgraded } })
      })
      await page.context().addCookies([
        { name: 'accessToken', value: auth.accessToken, domain: '127.0.0.1', path: '/' },
        { name: 'refreshToken', value: auth.refreshToken, domain: '127.0.0.1', path: '/' },
        { name: 'user', value: encodeURIComponent(JSON.stringify(auth.user)), domain: '127.0.0.1', path: '/' }
      ])
      await page.addInitScript((session) => { localStorage.setItem('accessToken', session.accessToken); localStorage.setItem('refreshToken', session.refreshToken); localStorage.setItem('user', JSON.stringify(session.user)) }, auth)

      await page.goto('/caravan-v2')
      await expect(page.getByRole('heading', { name: 'Caravana V2' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Mejoras de caravana' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Actualizar' })).toHaveCSS('min-height', '44px')
      await expect(page.getByRole('button', { name: 'Revisar mejora' }).first()).toHaveCSS('min-height', '44px')
      const review = page.getByRole('button', { name: 'Revisar mejora' }).first()
      await review.click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expect(page.locator('.caravan-content')).toHaveAttribute('inert', '')
      await expect(page.locator('.topbar')).toHaveAttribute('inert', '')
      await expect(page.getByRole('button', { name: 'Cancelar' })).toBeFocused()
      await expect(page.getByRole('alertdialog')).toContainText('La mejora se aplicará')
      const request = page.waitForRequest('**/api/v2/caravan/upgrade')
      await page.getByRole('button', { name: 'Confirmar mejora' }).click()
      await request
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.locator('.caravan-content')).toBeFocused()
      await expect(page.locator('.topbar')).not.toHaveAttribute('inert', '')
      await page.screenshot({ path: test.info().outputPath(`caravan-v2-${viewport.name}.png`), fullPage: true })

      await page.goto('/chronicle-v2')
      await expect(page.getByRole('heading', { name: 'Crónica histórica' })).toBeVisible()
      await expect(page.getByText('Visitante llegado')).toBeVisible()
      await expect(page.getByText('Procedencia: Ashen Vale · visitors')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Actualizar' })).toHaveCSS('min-height', '44px')
      await expect(page.getByRole('button', { name: 'Cargar entradas anteriores' })).toHaveCSS('min-height', '44px')
      await page.screenshot({ path: test.info().outputPath(`chronicle-v2-${viewport.name}.png`), fullPage: true })

      await page.evaluate(() => { document.documentElement.style.fontSize = '400%' })
      if (viewport.name === 'desktop') expect(await page.evaluate(() => { const main = document.querySelector('main'); return Boolean(main && main.scrollWidth <= main.clientWidth) })).toBe(true)
      expect(await page.evaluate(() => [...document.querySelectorAll('button, .nav a')].every((element) => { const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 }))).toBe(true)
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    })

    test('renders the initial empty chronicle state', async ({ page }) => {
      await page.route('**/api/v2/game', (route) => route.fulfill({ json: game }))
      await page.route('**/api/v2/chronicle?limit=30', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }))
      await page.context().addCookies([
        { name: 'accessToken', value: auth.accessToken, domain: '127.0.0.1', path: '/' },
        { name: 'refreshToken', value: auth.refreshToken, domain: '127.0.0.1', path: '/' },
        { name: 'user', value: encodeURIComponent(JSON.stringify(auth.user)), domain: '127.0.0.1', path: '/' }
      ])
      await page.addInitScript((session) => { localStorage.setItem('accessToken', session.accessToken); localStorage.setItem('refreshToken', session.refreshToken); localStorage.setItem('user', JSON.stringify(session.user)) }, auth)
      await page.goto('/chronicle-v2')
      await expect(page.getByText(/crónica.*vacía/i)).toBeVisible()
    })
  })
}
