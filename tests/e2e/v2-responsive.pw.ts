import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { campTradeFixture } from '../fixtures/camp-trade'
import type { GameView } from '../../shared/types/v2-game-view'

const expectedSha = process.env.PLAYWRIGHT_EXPECTED_SHA
if (!expectedSha) throw new Error('PLAYWRIGHT_EXPECTED_SHA must be supplied by playwright.config.ts.')

type ResponsiveGame = {
  revision: number
  actions: Array<{ action: string; execution: { options: Array<{ optionId: string }> } }>
  caravan: { upgrades: unknown[] }
}
const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts/v2-etapa0-4/fixtures.json'), 'utf8')) as { integratedPositiveCases: Array<{ id: string; value: ResponsiveGame }> }
const game = fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-system')!.value
const campGame = structuredClone(fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-contract')!.value) as unknown as GameView
campGame.items = ['integrated-services', 'integrated-destructive'].flatMap((id) => (fixtures.integratedPositiveCases.find((candidate) => candidate.id === id)!.value as unknown as GameView).items)
campGame.capacity.used = campGame.items.length
const chronicleEntry = { eventId: 'responsive-event', eventKey: 'visitor.arrived', type: 'visitor_arrived', occurredAt: '2026-09-26T12:00:00Z', subject: { kind: 'visitor', id: 'visitor-1' }, text: { key: 'visitor.arrived', fallback: 'Visitante llegado' }, related: { visitorId: 'visitor-1' }, itemProvenance: { zoneId: 'Ashen Vale', lootTableId: 'visitors' } }
const auth = { user: { id: 'v2-responsive', email: 'v2-responsive@example.test' }, accessToken: 'v2-token', refreshToken: 'v2-refresh' }

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(`V2 responsive ${viewport.name}`, () => {
    test.use({ viewport })

    test('renders the camp as the game hub and opens its services in place', async ({ page }) => {
      let activeCampGame: GameView = campGame
      await page.route('**/api/v2/game', (route) => route.fulfill({ json: activeCampGame }))
      await page.route('**/api/v2/chronicle?limit=30', (route) => route.fulfill({ json: { entries: [chronicleEntry], nextCursor: null } }))
      await page.context().addCookies([
        { name: 'accessToken', value: auth.accessToken, domain: '127.0.0.1', path: '/' },
        { name: 'refreshToken', value: auth.refreshToken, domain: '127.0.0.1', path: '/' },
        { name: 'user', value: encodeURIComponent(JSON.stringify(auth.user)), domain: '127.0.0.1', path: '/' }
      ])
      await page.addInitScript((session) => { localStorage.setItem('accessToken', session.accessToken); localStorage.setItem('refreshToken', session.refreshToken); localStorage.setItem('user', JSON.stringify(session.user)) }, auth)

      await page.goto('/juego')
      await expect(page.locator('img[src="/images/game/camp-modular/camp-base.png"]')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Héroes en el campamento' })).toBeVisible()
      await expect(page.locator('.hero-portrait').first()).toBeVisible()
      await expect(page.locator('.topbar nav')).toHaveCount(0)

      const hero = page.locator('.hero-portrait').first()
      await hero.click()
      await expect(page.locator('dialog[open]')).toContainText('Ada')
      await expect(page.locator('dialog[open]')).toContainText('Aceptar contrato')
      await expect(page.locator('dialog[open]')).toHaveCSS('transform', 'none')
      await expect(page.locator('.trade-footer')).toBeInViewport({ ratio: 1 })
      for (const control of [page.getByRole('combobox', { name: 'Contrato', exact: true }), page.getByRole('button', { name: 'Aceptar contrato' })]) {
        const box = await control.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(44)
        expect(box?.height).toBeLessThan(64)
      }
      await page.screenshot({ path: test.info().outputPath(`visitor-dialog-${viewport.name}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Volver al campamento' }).click()
      await expect(page).toHaveURL(/\/juego$/)
      await expect(hero).toBeFocused()

      const caravan = page.locator('.camp-place--wagon')
      await caravan.click()
      await expect(page.locator('dialog[open]')).toContainText('Mejoras de caravana')
      await expect(page.locator('dialog[open]')).toHaveCSS('transform', 'none')
      await expect(page).toHaveURL(/\/juego$/)
      await page.screenshot({ path: test.info().outputPath(`caravan-dialog-${viewport.name}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Cerrar' }).click()
      await expect(caravan).toBeFocused()

      const tavern = page.locator('.camp-place--tavern')
      await tavern.click()
      await expect(page.locator('dialog[open]')).toContainText('Ciclo de visitantes')
      await expect(page.locator('dialog[open]')).toHaveCSS('transform', 'none')
      await expect(page).toHaveURL(/\/juego$/)
      await page.screenshot({ path: test.info().outputPath(`tavern-dialog-${viewport.name}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(tavern).toBeFocused()

      const chronicle = page.locator('.camp-place--chronicle')
      await chronicle.click()
      await expect(page.locator('dialog[open]')).toContainText('Visitante llegado')
      await expect(page.locator('dialog[open]')).toHaveCSS('transform', 'none')
      await expect(page).toHaveURL(/\/juego$/)
      await page.screenshot({ path: test.info().outputPath(`chronicle-dialog-${viewport.name}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Cerrar' }).click()
      await expect(chronicle).toBeFocused()

      await page.getByRole('button', { name: 'Ver visitantes' }).click()
      await expect(page.locator('dialog[open]')).toContainText('Ciclo de visitantes')
      await page.getByRole('button', { name: 'Cerrar' }).click()

      const blacksmith = page.getByRole('button', { name: /Herrería/ })
      await blacksmith.click()
      await expect(page.locator('dialog[open]')).toContainText('Herrería')
      await expect(page.getByRole('button', { name: 'Mejorar', exact: true })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`blacksmith-dialog-${viewport.name}.png`), fullPage: true })
      await page.getByRole('button', { name: 'dismantle item', exact: true }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.locator('dialog[open]')).toBeVisible()
      await page.mouse.click(3, 3)
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      await expect(blacksmith).toBeFocused()

      await page.getByRole('button', { name: /Tasador/ }).click()
      await expect(page.locator('dialog[open]')).toContainText('Tasador')
      await page.screenshot({ path: test.info().outputPath(`appraiser-dialog-${viewport.name}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(page.locator('dialog[open]')).toHaveCount(0)

      activeCampGame = { ...campGame, visitors: [] }
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Ver equipo' })).toBeVisible()
      await page.getByRole('button', { name: 'Ver equipo' }).click()
      await expect(page.locator('dialog[open]')).toContainText('Inventario de la caravana')
      await expect(page).toHaveURL(/\/juego$/)
      await page.getByRole('button', { name: 'Cerrar' }).click()

      activeCampGame = game as unknown as GameView
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Ver caravana' })).toBeVisible()
      await page.getByRole('button', { name: 'Ver caravana' }).click()
      await page.getByRole('button', { name: 'Revisar mejora' }).first().click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.locator('dialog[open]')).toBeVisible()
      await page.getByRole('button', { name: 'Cerrar' }).click()

      await page.screenshot({ path: test.info().outputPath(`camp-${viewport.name}.png`), fullPage: true })
    })

    test('keeps a large trade usable and sends only the individually selected eligible loans', async ({ page }) => {
      const tradeGame = campTradeFixture()
      await page.route('**/api/v2/game', (route) => route.fulfill({ json: tradeGame }))
      await page.route('**/api/v2/contracts/accept', (route) => route.fulfill({ json: { game: { ...tradeGame, revision: tradeGame.revision + 1 } } }))
      await page.context().addCookies([
        { name: 'accessToken', value: auth.accessToken, domain: '127.0.0.1', path: '/' },
        { name: 'refreshToken', value: auth.refreshToken, domain: '127.0.0.1', path: '/' },
        { name: 'user', value: encodeURIComponent(JSON.stringify(auth.user)), domain: '127.0.0.1', path: '/' }
      ])
      await page.addInitScript((session) => { localStorage.setItem('accessToken', session.accessToken); localStorage.setItem('refreshToken', session.refreshToken); localStorage.setItem('user', JSON.stringify(session.user)) }, auth)
      await page.goto('/juego')
      const hero = page.locator('.hero-portrait').first()
      await hero.click()

      const dialog = page.locator('dialog[open]')
      const desk = dialog.locator('.trade-desk')
      const footer = desk.locator('.trade-footer')
      const contract = desk.getByRole('combobox', { name: 'Contrato', exact: true })
      const accept = footer.getByRole('button', { name: 'Aceptar contrato' })
      await expect(footer).toBeInViewport({ ratio: 1 })
      await expect(desk.locator('input[type="checkbox"]')).toHaveCount(19)
      await expect(desk).not.toContainText('Reliquia no disponible')
      const group = desk.locator('details.loan-group')
      await expect(group).toHaveCount(1)
      await expect(group).not.toHaveAttribute('open', '')
      await expect(group.locator('input[type="checkbox"]')).toHaveCount(4)
      await expect(desk.locator('details.loan-group input[value="loan-5"], details.loan-group input[value="loan-6"]')).toHaveCount(0)
      if (viewport.name === 'desktop') {
        const contractBox = (await contract.boundingBox())!
        const equipmentBox = (await group.boundingBox())!
        expect(contractBox.x + contractBox.width).toBeLessThanOrEqual(equipmentBox.x)
      }
      await group.locator('summary').click()
      await expect(footer).toBeInViewport({ ratio: 1 })
      await desk.locator('input[value="loan-1"]').check()
      await desk.locator('input[value="loan-2"]').check()
      await expect(desk.locator('input[value="loan-3"]')).not.toBeChecked()
      await desk.locator('input[value="loan-19"]').scrollIntoViewIfNeeded()
      if (viewport.name === 'desktop') await expect(contract).toBeInViewport({ ratio: 1 })
      await expect(footer).toBeInViewport({ ratio: 1 })
      await expect(accept).toBeInViewport({ ratio: 1 })
      expect(await dialog.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>('.trade-desk, .trade-footer, .loan-row, .loan-group')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({ className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })))).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`visitor-many-loans-${viewport.name}.png`), fullPage: true })

      await contract.selectOption('o2')
      await expect(desk.locator('input[type="checkbox"]')).toHaveCount(2)
      await expect(desk.locator('input[value="loan-2"]')).toBeChecked()
      await expect(desk.locator('input[value="loan-3"]')).not.toBeChecked()
      await expect(footer).toContainText(/1\s+(?:objeto|préstamo)/i)
      const responsePromise = page.waitForResponse('**/api/v2/contracts/accept')
      await accept.click()
      const response = await responsePromise
      expect(response.request().postDataJSON().payload).toEqual({ visitorId: 'v1', optionId: 'o2', loanItemIds: ['loan-2'] })
      await dialog.getByRole('button', { name: 'Volver al campamento' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(hero).toBeFocused()
    })

    test('covers caravan and chronicle states, reduced motion and 400% reflow', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      let releaseUpgrade!: () => void
      const upgradeReleased = new Promise<void>((resolve) => { releaseUpgrade = resolve })
      await page.route('**/api/v2/game', (route) => route.fulfill({ json: game }))
      await page.route('**/api/v2/chronicle?limit=30', (route) => route.fulfill({ json: { entries: [chronicleEntry], nextCursor: 'opaque+/=' } }))
      await page.route('**/api/v2/chronicle?limit=30&cursor=*', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }))
      await page.route('**/api/v2/caravan/upgrade', async (route) => {
        const body = route.request().postDataJSON() as { payload: Record<string, unknown> }
        expect(Object.keys(body.payload)).toEqual(['optionId'])
        expect(body.payload.optionId).toBe(game.actions.find((action) => action.action === 'upgrade_caravan')?.execution.options[0]?.optionId)
        const upgraded = structuredClone(game)
        upgraded.revision += 1
        await upgradeReleased
        await route.fulfill({ json: { game: upgraded } })
      })
      await page.context().addCookies([
        { name: 'accessToken', value: auth.accessToken, domain: '127.0.0.1', path: '/' },
        { name: 'refreshToken', value: auth.refreshToken, domain: '127.0.0.1', path: '/' },
        { name: 'user', value: encodeURIComponent(JSON.stringify(auth.user)), domain: '127.0.0.1', path: '/' }
      ])
      await page.addInitScript((session) => { localStorage.setItem('accessToken', session.accessToken); localStorage.setItem('refreshToken', session.refreshToken); localStorage.setItem('user', JSON.stringify(session.user)) }, auth)

      await page.goto('/caravan-v2')
      await expect(page.getByRole('heading', { name: 'Caravana', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Mejoras de caravana' })).toBeVisible()
      await expect(page.locator('img[src^="/images/game/caravan/"]')).toHaveCount(game.caravan.upgrades.length)
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
      const response = page.waitForResponse('**/api/v2/caravan/upgrade')
      await page.getByRole('button', { name: 'Confirmar mejora' }).click()
      await request
      await expect(page.getByText('Aplicando la mejora…')).toBeVisible()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.locator('.caravan-content')).toBeFocused()
      releaseUpgrade()
      await response
      await expect(page.getByText(`Revisión ${game.revision + 1}`)).toBeVisible()
      await page.evaluate(() => { document.documentElement.style.fontSize = '400%' })
      const caravanOverflow = await page.evaluate(() => { const main = document.querySelector('main'); return { main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : null, offenders: main ? [...main.querySelectorAll<HTMLElement>('*')].filter((element) => element.scrollWidth > element.clientWidth + 1).slice(0, 5).map((element) => ({ className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })) : [] } })
      expect(caravanOverflow, JSON.stringify(caravanOverflow)).toEqual(expect.objectContaining({ main: expect.objectContaining({ scrollWidth: expect.any(Number), clientWidth: expect.any(Number) }) }))
      expect(caravanOverflow.main!.scrollWidth, JSON.stringify(caravanOverflow)).toBeLessThanOrEqual(caravanOverflow.main!.clientWidth)
      await page.evaluate(() => { document.documentElement.style.fontSize = '' })
      await expect(page.locator('.topbar')).not.toHaveAttribute('inert', '')
      await page.screenshot({ path: test.info().outputPath(`caravan-v2-${viewport.name}.png`), fullPage: true })

      await page.goto('/chronicle-v2')
      await expect(page.getByRole('heading', { name: 'Historial' })).toBeVisible()
      await expect(page.getByText('Visitante llegado')).toBeVisible()
      await expect(page.getByText('Procedencia: Ashen Vale · visitors')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Actualizar' })).toHaveCSS('min-height', '44px')
      await expect(page.getByRole('button', { name: 'Cargar entradas anteriores' })).toHaveCSS('min-height', '44px')
      await page.screenshot({ path: test.info().outputPath(`chronicle-v2-${viewport.name}.png`), fullPage: true })

      await page.evaluate(() => { document.documentElement.style.fontSize = '400%' })
      const chronicleOverflow = await page.evaluate(() => { const main = document.querySelector('main'); return { main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : null, offenders: main ? [...main.querySelectorAll<HTMLElement>('*')].filter((element) => element.scrollWidth > element.clientWidth + 1).slice(0, 5).map((element) => ({ className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })) : [] } })
      expect(chronicleOverflow.main!.scrollWidth, JSON.stringify(chronicleOverflow)).toBeLessThanOrEqual(chronicleOverflow.main!.clientWidth)
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
