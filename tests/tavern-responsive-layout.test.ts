import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tavernSource = readFileSync(new URL('../pages/tavern.vue', import.meta.url), 'utf8')
const visitorPostSource = readFileSync(new URL('../components/VisitorPost.vue', import.meta.url), 'utf8')
const stashSource = readFileSync(new URL('../pages/stash.vue', import.meta.url), 'utf8')
const caravanSource = readFileSync(new URL('../pages/caravan.vue', import.meta.url), 'utf8')

describe('Tavern responsive layout contract', () => {
  it('uses the available wide-screen canvas without coupling visitor heights', () => {
    expect(tavernSource).toMatch(/\.tavern-page\s*\{[^}]*max-width:\s*min\(100%,\s*1680px\)/s)
    expect(tavernSource).toMatch(/\.visitor-grid\s*\{[^}]*align-items:\s*start/s)
  })

  it('keeps trade and mission content readable before switching to one visitor per row', () => {
    expect(tavernSource).toMatch(/@media\s*\(max-width:\s*1100px\)\s*\{[^}]*\.visitor-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(visitorPostSource).toMatch(/@container\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.trade-columns\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })

  it('keeps Tavern and Stash cards from creating horizontal overflow with long text or disabled/loading states', () => {
    expect(tavernSource).toMatch(/\.visitor-slot--empty\s*\{[^}]*min-width:\s*0/s)
    expect(stashSource).toMatch(/\.item-heading\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(stashSource).toMatch(/\.item-heading-copy h2\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(stashSource).toMatch(/\.item-actions \.btn\s*\{[^}]*min-width:\s*0/s)
    expect(stashSource).toMatch(/\.item-actions \.btn\s*\{[^}]*white-space:\s*normal/s)
  })

  it('keeps Caravan service rows and CTAs inside panel bounds', () => {
    expect(caravanSource).toMatch(/\.service-row\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(caravanSource).toMatch(/\.service-row > div:nth-child\(2\)\s*\{[^}]*min-width:\s*0/s)
    expect(caravanSource).toMatch(/\.service-action \.btn\s*\{[^}]*white-space:\s*normal/s)
  })

  it('keeps VisitorPost trade and mission blocks from clipping long copy', () => {
    expect(visitorPostSource).toMatch(/\.visitor-identity,\s*\.visitor-identity > div,\s*\.visitor-title-row/s)
    expect(visitorPostSource).toMatch(/\.visitor-identity,\s*\.visitor-identity > div,\s*\.visitor-title-row,\s*\.trade-item > div/s)
    expect(visitorPostSource).toMatch(/overflow-wrap:\s*anywhere/s)
    expect(visitorPostSource).toMatch(/word-break:\s*break-word/s)
  })
})
