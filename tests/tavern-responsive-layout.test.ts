import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tavernSource = readFileSync(new URL('../pages/tavern.vue', import.meta.url), 'utf8')
const visitorPostSource = readFileSync(new URL('../components/VisitorPost.vue', import.meta.url), 'utf8')

describe('Tavern responsive layout contract', () => {
  it('uses the available wide-screen canvas without coupling visitor heights', () => {
    expect(tavernSource).toMatch(/\.tavern-page\s*\{[^}]*max-width:\s*min\(100%,\s*1680px\)/s)
    expect(tavernSource).toMatch(/\.visitor-grid\s*\{[^}]*align-items:\s*start/s)
  })

  it('keeps trade and mission content readable before switching to one visitor per row', () => {
    expect(tavernSource).toMatch(/@media\s*\(max-width:\s*1100px\)\s*\{[^}]*\.visitor-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(visitorPostSource).toMatch(/@container\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.trade-columns\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })
})
