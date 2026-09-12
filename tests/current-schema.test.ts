import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame, normalizeSaveGame, SAVE_SCHEMA_VERSION } from '../utils/game-logic'

const legacySaveFields = [
  'materials',
  'heroes',
  'pendingLoot',
  'questsProgress',
  'activeQuestRun',
  'lastQuestRun',
  'activeExpeditions',
  'expeditionHistory'
] as const

describe('current save schema', () => {
  it('creates only the visitor-commerce aggregate', () => {
    const save = createSaveGame('new-player')

    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    expect(save.gold).toBe(450)
    expect(save.stash).toHaveLength(2)
    expect(save.visitRound.slots).toHaveLength(2)
    for (const field of legacySaveFields) expect(save).not.toHaveProperty(field)
    expect(save.caravan.upgrades).toEqual({ stashWagon: 0, appraiser: 0 })
  })

  it('recreates an incompatible legacy save instead of migrating its economy or roster', () => {
    const legacy = {
      userId: 'legacy-player',
      gold: 999_999,
      materials: 999,
      heroes: [{ id: 'legacy-hero' }],
      stash: [{ id: 'legacy-item' }],
      activeExpeditions: [{ id: 'legacy-expedition' }],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }

    const recreated = normalizeSaveGame(legacy as never, { refreshVisitors: false })

    expect(recreated.userId).toBe('legacy-player')
    expect(recreated.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    expect(recreated.gold).toBe(450)
    expect(recreated.stash).toHaveLength(2)
    expect(recreated.stash.some((item) => item.id === 'legacy-item')).toBe(false)
    for (const field of legacySaveFields) expect(recreated).not.toHaveProperty(field)
  })

  it('strips legacy fields accidentally attached to a current document', () => {
    const current = createSaveGame('current-with-debris') as SaveGame & Record<string, unknown>
    current.heroes = [{ id: 'should-not-survive' }]
    current.activeExpeditions = [{ id: 'should-not-survive' }]

    const normalized = normalizeSaveGame(current, { refreshVisitors: false })

    expect(normalized).not.toHaveProperty('heroes')
    expect(normalized).not.toHaveProperty('activeExpeditions')
  })
})

describe('legacy surface removal', () => {
  it('does not ship obsolete legacy plans or credential reset helpers', () => {
    const retiredArtifacts = [
      'IMPLEMENTATION-SUMMARY.md',
      'UI-UX-Improvements-Documentation.md',
      'scripts/reset-password.ts'
    ]

    for (const artifact of retiredArtifacts) expect(existsSync(artifact), artifact).toBe(false)
  })

  it('has no server routes that bypass the visitor cycle', () => {
    const removedRoutes = [
      'server/api/heroes/hire.post.ts',
      'server/api/heroes/[heroId]/equip.post.ts',
      'server/api/heroes/[heroId]/unequip.post.ts',
      'server/api/heroes/[heroId]/recover.post.ts',
      'server/api/expeditions/start.post.ts',
      'server/api/expeditions/advance.post.ts',
      'server/api/expeditions/recall.post.ts',
      'server/api/quests/complete.post.ts',
      'server/api/quests/[questId]/start.post.ts',
      'server/api/quests/index.get.ts',
      'server/api/items/[itemId]/sell.post.ts'
    ]

    for (const route of removedRoutes) expect(existsSync(route), route).toBe(false)
  })

  it('has no client actions that call removed endpoints', () => {
    const store = readFileSync('stores/game.ts', 'utf8')
    for (const prefix of ['/api/heroes', '/api/expeditions', '/api/quests/complete', '/sell']) {
      expect(store, prefix).not.toContain(prefix)
    }
  })
})
