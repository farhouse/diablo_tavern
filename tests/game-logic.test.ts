import { describe, expect, it, vi } from 'vitest'
import { 
  completeActiveQuest, 
  createHero, 
  createSaveGame, 
  generateItem, 
  identifyCost, 
  startQuest,
  startExpedition,
  advanceExpedition,
  recallExpedition,
  normalizeSaveGame
} from '../utils/game-logic'

describe('game logic', () => {
  it('clamps quest outcomes into a playable save update', () => {
    const save = createSaveGame('user-1')
    save.heroes.push(createHero('barbarian'))
    const hero = save.heroes[0]
    expect(hero).toBeDefined()

    const started = startQuest(save, 'blood-moor', [hero!.id])
    expect(started.activeQuestRun?.questId).toBe('blood-moor')
    expect(started.heroes[0]?.status).toBe('onQuest')

    const finishTime = new Date(started.activeQuestRun!.finishesAt)
    const next = completeActiveQuest(started, finishTime)

    expect(next.lastQuestRun?.questId).toBe('blood-moor')
    expect(next.activeQuestRun).toBeUndefined()
    expect(next.heroes[0]?.xp).toBeGreaterThanOrEqual(0)
    expect(next.stash.length + next.pendingLoot.length).toBeGreaterThanOrEqual(0)
  })

  it('creates identified normal items and priced unidentified magic items', () => {
    const normal = generateItem('act1-low', 0)
    expect(normal.id).toBeTruthy()
    expect(normal.value).toBeGreaterThan(0)

    expect(identifyCost('normal')).toBe(0)
    expect(identifyCost('magic')).toBe(50)
    expect(identifyCost('rare')).toBe(150)
    expect(identifyCost('unique')).toBe(500)
  })

  describe('expedition logic', () => {
    it('starts an expedition and marks heroes as onQuest', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      const sorceress = createHero('sorceress')
      save.heroes.push(barbarian, sorceress)
      
      const started = startExpedition(save, 'blood-moor', [barbarian.id, sorceress.id])
      
      expect(started.activeExpeditions).toHaveLength(1)
      expect(started.activeExpeditions[0]?.questId).toBe('blood-moor')
      expect(started.activeExpeditions[0]?.heroIds).toEqual([barbarian.id, sorceress.id])
      expect(started.activeExpeditions[0]?.status).toBe('exploring')
      expect(started.heroes[0]?.status).toBe('onQuest')
      expect(started.heroes[1]?.status).toBe('onQuest')
    })

    it('allows multiple expeditions with different available heroes', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      const sorceress = createHero('sorceress')
      save.heroes.push(barbarian, sorceress)

      startExpedition(save, 'blood-moor', [barbarian.id])
      startExpedition(save, 'blood-moor', [sorceress.id])

      expect(save.activeExpeditions).toHaveLength(2)
      expect(save.heroes.map((hero) => hero.status)).toEqual(['onQuest', 'onQuest'])
    })

    it('prevents reusing a hero already assigned to another expedition', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)
      
      // Start first expedition
      startExpedition(save, 'blood-moor', [barbarian.id])
      
      // Try to start second expedition
      expect(() => startExpedition(save, 'blood-moor', [barbarian.id]))
        .toThrow('All selected heroes must be available')
    })

    it('limits expedition parties to four heroes', () => {
      const save = createSaveGame('user-1')
      const heroes = Array.from({ length: 5 }, () => createHero('barbarian'))
      save.heroes.push(...heroes)

      expect(() => startExpedition(save, 'blood-moor', heroes.map((hero) => hero.id)))
        .toThrow('Select up to 4 heroes')
    })

    it('advances expedition and generates events', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)
      
      // Start expedition
      startExpedition(save, 'blood-moor', [barbarian.id])
      
      // Advance time by 10 seconds (should generate 2 events with 5s interval)
      const future = new Date(Date.now() + 10000)
      const advanced = advanceExpedition(save, future)
      
      expect(advanced.activeExpeditions[0]?.events.length).toBeGreaterThan(0)
      expect(advanced.activeExpeditions[0]?.events.length).toBeLessThanOrEqual(2)
    })

    it('can advance only the selected expedition by id', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      const sorceress = createHero('sorceress')
      save.heroes.push(barbarian, sorceress)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      startExpedition(save, 'blood-moor', [sorceress.id], now)
      const expeditionId = save.activeExpeditions[0]!.id

      advanceExpedition(save, new Date(now.getTime() + 10000), expeditionId)

      expect(save.activeExpeditions[0]?.events.length).toBeGreaterThan(0)
      expect(save.activeExpeditions[1]?.events).toHaveLength(0)
    })

    it('recalls expedition and transfers rewards', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)
      
      // Start expedition
      startExpedition(save, 'blood-moor', [barbarian.id])
      
      // Advance time to generate some events
      const future = new Date(Date.now() + 15000) // 15 seconds
      const advanced = advanceExpedition(save, future)
      const expeditionId = advanced.activeExpeditions[0]!.id
      advanced.activeExpeditions[0]!.carriedGold = 25
      
      // Recall expedition
      const recalled = recallExpedition(advanced, expeditionId)
      
      // Check that expedition is cleared
      expect(recalled.activeExpeditions).toHaveLength(0)
      
      // Check that rewards were transferred
      expect(recalled.gold).toBeGreaterThan(450) // Starting gold was 450
      expect(recalled.expeditionHistory[0]).toBeDefined()
      expect(recalled.expeditionHistory[0]?.gold).toBeGreaterThan(0)
    })

    it('recalls one expedition without clearing other active expeditions', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      const sorceress = createHero('sorceress')
      save.heroes.push(barbarian, sorceress)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      startExpedition(save, 'blood-moor', [sorceress.id], now)
      const recalledId = save.activeExpeditions[0]!.id
      const keptId = save.activeExpeditions[1]!.id

      recallExpedition(save, recalledId, now)

      expect(save.activeExpeditions).toHaveLength(1)
      expect(save.activeExpeditions[0]?.id).toBe(keptId)
      expect(save.expeditionHistory[0]?.id).toBe(recalledId)
      expect(barbarian.status).toBe('available')
      expect(sorceress.status).toBe('onQuest')
    })

    it('marks total party defeat on recall and applies carried reward penalties', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expect(expedition).toBeDefined()
      expedition!.carriedGold = 100
      expedition!.carriedXp = 100
      expedition!.carriedLoot = [generateItem('act1-low', 0), generateItem('act1-low', 0)]
      expedition!.partyState[0]!.temporaryHp = 0
      expedition!.partyState[0]!.dead = true
      expedition!.partyState[0]!.permanentDeath = true

      const recalled = recallExpedition(save, expedition!.id, now)

      expect(recalled.expeditionHistory[0]?.result).toBe('death')
      expect(recalled.expeditionHistory[0]?.gold).toBe(50)
      expect(recalled.expeditionHistory[0]?.loot).toHaveLength(1)
      expect(recalled.heroes[0]?.status).toBe('dead')
      expect(recalled.heroes[0]?.xp).toBe(0)
    })

    it('can generate a boss encounter when the expedition is boss-ready', () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      barbarian.level = 10
      barbarian.derivedStats.life = 200
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expect(expedition).toBeDefined()
      expedition!.depth = 100
      expedition!.danger = 100
      expedition!.bossReady = true
      expedition!.status = 'bossReady'

      const advanced = advanceExpedition(save, new Date(now.getTime() + 5000))

      expect(advanced.activeExpeditions[0]?.events.some((event) => event.type === 'boss')).toBe(true)
      expect(advanced.activeExpeditions[0]?.bossDefeated).toBe(true)
      random.mockRestore()
    })

    it('normalizes legacy expedition fields into the new arrays', () => {
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)
      startExpedition(save, 'blood-moor', [barbarian.id])
      const legacyExpedition = save.activeExpeditions[0]
      expect(legacyExpedition).toBeDefined()

      const legacySave = {
        ...save,
        activeExpeditions: undefined,
        expeditionHistory: undefined,
        activeExpedition: legacyExpedition,
        lastExpeditionRun: {
          id: 'legacy-summary',
          questId: 'blood-moor',
          heroIds: [barbarian.id],
          result: 'success',
          depth: 1,
          durationMs: 1000,
          loot: [],
          gold: 1,
          xp: 1,
          heroesStatus: [],
          events: []
        }
      }

      const normalized = normalizeSaveGame(legacySave as unknown as ReturnType<typeof createSaveGame>)

      expect(normalized.activeExpeditions).toHaveLength(1)
      expect(normalized.activeExpeditions[0]?.id).toBe(legacyExpedition?.id)
      expect(normalized.expeditionHistory).toHaveLength(1)
      expect(normalized.expeditionHistory[0]?.id).toBe('legacy-summary')
      expect('activeExpedition' in normalized).toBe(false)
      expect('lastExpeditionRun' in normalized).toBe(false)
    })
  })
})
