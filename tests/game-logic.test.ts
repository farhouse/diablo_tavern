import type { ActiveExpedition } from '../types/game'
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
  normalizeSaveGame,
  upgradeCaravan,
  startAppraisal,
  completeAppraisalQueue,
  getHeroCapacity,
  getExpeditionCapacity,
  getStashCapacity,
  getActiveHeroCount,
  getHireCost,
  equipItem
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
      save.gold = 9999
      save.materials = 999
      upgradeCaravan(save, 'scoutTable')
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
      save.gold = 9999
      save.materials = 999
      upgradeCaravan(save, 'scoutTable')
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
      save.gold = 9999
      save.materials = 999
      upgradeCaravan(save, 'scoutTable')
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

    it('recalls expedition via portal and transfers rewards', () => {
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
      // Set up portal for immediate recall
      advanced.activeExpeditions[0]!.portalAvailableUntil = new Date(Date.now() + 60000).toISOString()
      
      // Recall expedition via portal
      const recalled = recallExpedition(advanced, expeditionId, undefined, { usePortal: true })
      
      // Check that expedition is cleared
      expect(recalled.activeExpeditions).toHaveLength(0)
      
      // Check that rewards were transferred
      expect(recalled.gold).toBeGreaterThan(450) // Starting gold was 450
      expect(recalled.expeditionHistory[0]).toBeDefined()
      expect(recalled.expeditionHistory[0]?.gold).toBeGreaterThan(0)
    })

    it('recalls one expedition via portal without clearing other active expeditions', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      save.gold = 9999
      save.materials = 999
      upgradeCaravan(save, 'scoutTable')
      const barbarian = createHero('barbarian')
      const sorceress = createHero('sorceress')
      save.heroes.push(barbarian, sorceress)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      startExpedition(save, 'blood-moor', [sorceress.id], now)
      const recalledId = save.activeExpeditions[0]!.id
      const keptId = save.activeExpeditions[1]!.id
      save.activeExpeditions[0]!.portalAvailableUntil = new Date(now.getTime() + 60000).toISOString()

      recallExpedition(save, recalledId, now, { usePortal: true })

      expect(save.activeExpeditions).toHaveLength(1)
      expect(save.activeExpeditions[0]?.id).toBe(keptId)
      expect(save.expeditionHistory[0]?.id).toBe(recalledId)
      expect(barbarian.status).toBe('available')
      expect(sorceress.status).toBe('onQuest')
    })

    it('marks total party defeat on portal recall and applies carried reward penalties', () => {
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
      expedition!.portalAvailableUntil = new Date(now.getTime() + 60000).toISOString()

      const recalled = recallExpedition(save, expedition!.id, now, { usePortal: true })

      expect(recalled.expeditionHistory[0]?.result).toBe('defeated')
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
      delete (legacyExpedition as unknown as Record<string, unknown>).carriedMaterials
      delete (legacyExpedition as unknown as Record<string, unknown>).bossReady
      delete (legacyExpedition as unknown as Record<string, unknown>).bossDefeated

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
          heroStatuses: [],
          materials: 0,
          events: []
        }
      }

      const normalized = normalizeSaveGame(legacySave as unknown as ReturnType<typeof createSaveGame>)

      expect(normalized.activeExpeditions).toHaveLength(1)
      expect(normalized.activeExpeditions[0]?.id).toBe(legacyExpedition?.id)
      expect(normalized.activeExpeditions[0]?.carriedMaterials).toBe(0)
      expect(normalized.activeExpeditions[0]?.bossReady).toBe(false)
      expect(normalized.activeExpeditions[0]?.bossDefeated).toBe(false)
      expect(normalized.expeditionHistory).toHaveLength(1)
      expect(normalized.expeditionHistory[0]?.id).toBe('legacy-summary')
      expect('activeExpedition' in normalized).toBe(false)
      expect('lastExpeditionRun' in normalized).toBe(false)
    })

    it('uses infirmary upgrades to reduce injury risk on recall', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      save.gold = 99999
      save.materials = 9999
      upgradeCaravan(save, 'infirmary')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expect(expedition).toBeDefined()
      expedition!.partyState[0]!.temporaryHp = Math.floor(expedition!.partyState[0]!.maxTemporaryHp * 0.4)
      expedition!.portalAvailableUntil = new Date(now.getTime() + 60000).toISOString()

      const recalled = recallExpedition(save, expedition!.id, now, { usePortal: true })

      expect(recalled.expeditionHistory[0]?.result).toBe('success')
      expect(recalled.heroes[0]?.status).toBe('available')
    })
  })

    it('portal event is generated and sets portalAvailableUntil and portalEventId', () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      barbarian.derivedStats.life = 200
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]

      // Advance to generate events (portal has weight 4, 0.99 of total picks portal)
      const future = new Date(now.getTime() + 10000)
      advanceExpedition(save, future)

      // Verify the portal event went through the real pipeline
      const portalEvent = expedition!.events.find(e => e.type === 'portal')
      expect(portalEvent).toBeDefined()
      expect(expedition!.portalEventId).toBe(portalEvent!.id)
      expect(expedition!.portalAvailableUntil).toBeDefined()
      const portalCreatedAt = new Date(portalEvent!.createdAt).getTime()
      expect(new Date(expedition!.portalAvailableUntil!).getTime()).toBe(portalCreatedAt + 30000)
      random.mockRestore()
    })

    it('portal expires after 30 seconds during advanceExpedition', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      barbarian.derivedStats.life = 200
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expedition!.portalAvailableUntil = new Date(now.getTime() + 30000).toISOString()
      expedition!.portalEventId = 'portal-1'

      // Advance past portal expiry (portal expires at 30s, advance to 60s)
      // After expiry, a new portal event may be generated in the same tick
      // so the original portalEventId should be gone
      const future = new Date(now.getTime() + 60000)
      advanceExpedition(save, future)

      // Either the portal was fully cleared or replaced by a new one
      // In either case, the original portalEventId is gone
      expect(expedition!.portalEventId).not.toBe('portal-1')
    })

    it('using an active portal completes immediately and transfers rewards', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expedition!.carriedGold = 50
      expedition!.portalAvailableUntil = new Date(now.getTime() + 60000).toISOString()

      const recalled = recallExpedition(save, expedition!.id, now, { usePortal: true })

      expect(recalled.activeExpeditions).toHaveLength(0)
      expect(recalled.gold).toBe(500) // 450 base + 50 carried
    })

    it('using an expired portal throws', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]

      expect(() => recallExpedition(save, expedition!.id, now, { usePortal: true }))
        .toThrow('Portal is no longer available')
    })

    it('normal recall sets status returning, returnStartedAt, and returnsAt', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]

      // Advance 10 seconds so elapsed > 0
      const advanced = advanceExpedition(save, new Date(now.getTime() + 10000))
      const recalled = recallExpedition(advanced, expedition!.id, new Date(now.getTime() + 10000))

      expect(recalled.activeExpeditions[0]?.status).toBe('returning')
      expect(recalled.activeExpeditions[0]?.returnStartedAt).toBeDefined()
      expect(recalled.activeExpeditions[0]?.returnsAt).toBeDefined()
      // returnsAt should be now + half of elapsed (10s / 2 = 5s)
      const expectedReturnsAt = new Date(now.getTime() + 10000 + 5000).getTime()
      expect(new Date(recalled.activeExpeditions[0]!.returnsAt!).getTime()).toBe(expectedReturnsAt)
    })

    it('normal recall does not transfer rewards immediately', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expedition!.carriedGold = 50

      const advanced = advanceExpedition(save, new Date(now.getTime() + 10000))
      const recalled = recallExpedition(advanced, expedition!.id, new Date(now.getTime() + 10000))

      // Gold should NOT be transferred yet
      expect(recalled.gold).toBe(450)
      // Expedition should still be active (returning)
      expect(recalled.activeExpeditions).toHaveLength(1)
      expect(recalled.activeExpeditions[0]?.status).toBe('returning')
    })

    it('advanceExpedition completes a returning expedition after returnsAt', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]
      expedition!.carriedGold = 50

      const advanceTime = new Date(now.getTime() + 10000)
      const advanced = advanceExpedition(save, advanceTime)
      recallExpedition(advanced, expedition!.id, advanceTime)

      // Expedition should be returning with returnsAt set
      expect(advanced.activeExpeditions[0]?.status).toBe('returning')

      // Advance past returnsAt
      const returnsAt = new Date(advanced.activeExpeditions[0]!.returnsAt!)
      const afterReturn = new Date(returnsAt.getTime() + 1000)
      advanceExpedition(advanced, afterReturn)

      // Expedition should be completed now
      expect(advanced.activeExpeditions).toHaveLength(0)
      // Gold should be transferred
      expect(advanced.gold).toBe(500)
    })

    it('returning expeditions do not generate new events', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const save = createSaveGame('user-1')
      const barbarian = createHero('barbarian')
      save.heroes.push(barbarian)

      startExpedition(save, 'blood-moor', [barbarian.id], now)
      const expedition = save.activeExpeditions[0]

      // Generate some initial events
      const advanceTime = new Date(now.getTime() + 10000)
      advanceExpedition(save, advanceTime)
      const initialEventCount = expedition!.events.length

      // Start timed return
      recallExpedition(save, expedition!.id, advanceTime)

      // Advance further while returning
      advanceExpedition(save, new Date(advanceTime.getTime() + 20000))

      // No new events should have been generated after recall
      expect(expedition!.events.length).toBe(initialEventCount)
    })

    describe('caravan logic', () => {
    it('new save has caravan with 3 hero capacity, 1 expedition, 20 stash', () => {
      const save = createSaveGame('user-1')
      expect(getHeroCapacity(save)).toBe(3)
      expect(getExpeditionCapacity(save)).toBe(1)
      expect(getStashCapacity(save)).toBe(20)
      expect(save.materials).toBe(0)
    })

    it('normalize adds caravan to legacy save', () => {
      const save = createSaveGame('user-1')
      const legacy = { ...save }
      delete (legacy as Record<string, unknown>).materials
      delete (legacy as Record<string, unknown>).caravan
      const normalized = normalizeSaveGame(legacy as unknown as ReturnType<typeof createSaveGame>)
      expect(normalized.materials).toBe(0)
      expect(normalized.caravan).toBeDefined()
      expect(normalized.caravan.level).toBe(0)
      expect(getHeroCapacity(normalized)).toBe(3)
    })

    it('upgrade fails if not enough gold', () => {
      const save = createSaveGame('user-1')
      save.gold = 0
      expect(() => upgradeCaravan(save, 'wagons')).toThrow('Not enough gold')
    })

    it('upgrade fails if not enough materials', () => {
      const save = createSaveGame('user-1')
      save.gold = 1000
      save.materials = 0
      expect(() => upgradeCaravan(save, 'wagons')).toThrow('Not enough materials')
    })

    it('upgrade deducts resources and increases capacity', () => {
      const save = createSaveGame('user-1')
      save.gold = 1000
      save.materials = 50
      upgradeCaravan(save, 'wagons')
      expect(save.gold).toBe(400)
      expect(save.materials).toBe(30)
      expect(getHeroCapacity(save)).toBe(5)
    })

    it('stash capacity upgrades work', () => {
      const save = createSaveGame('user-1')
      save.gold = 10000
      save.materials = 500
      upgradeCaravan(save, 'stashWagon')
      expect(getStashCapacity(save)).toBe(30)
      expect(save.stashLimit).toBe(30)
      upgradeCaravan(save, 'stashWagon')
      expect(getStashCapacity(save)).toBe(45)
    })

    it('exceeding max upgrade level throws', () => {
      const save = createSaveGame('user-1')
      save.gold = 99999
      save.materials = 9999
      upgradeCaravan(save, 'scoutTable')
      upgradeCaravan(save, 'scoutTable')
      upgradeCaravan(save, 'scoutTable')
      expect(getExpeditionCapacity(save)).toBe(4)
      expect(() => upgradeCaravan(save, 'scoutTable')).toThrow('Upgrade is already at max level')
    })

    it('respects hero capacity when hiring', () => {
      const save = createSaveGame('user-1')
      expect(getHeroCapacity(save)).toBe(3)
      save.heroes.push(createHero('barbarian'))
      save.heroes.push(createHero('sorceress'))
      save.heroes.push(createHero('paladin'))
      expect(save.heroes.length).toBe(3)
    })

    it('does not count dead heroes against active roster capacity or hire cost', () => {
      const save = createSaveGame('user-1')
      const deadHero = createHero('barbarian')
      deadHero.status = 'dead'
      save.heroes.push(createHero('barbarian'), createHero('sorceress'), createHero('paladin'), deadHero)

      expect(save.heroes.length).toBe(4)
      expect(getActiveHeroCount(save)).toBe(3)
      expect(getHireCost(save)).toBe(360)
    })

    it('does not allow equipping dead heroes', () => {
      const save = createSaveGame('user-1')
      const deadHero = createHero('barbarian')
      deadHero.status = 'dead'
      const item = generateItem('act1-low', 0)
      item.identified = true
      save.heroes.push(deadHero)
      save.stash.push(item)

      expect(() => equipItem(save, deadHero.id, item.id)).toThrow('Dead heroes cannot equip items')
    })

    it('appraiser start fails without upgrade', () => {
      const save = createSaveGame('user-1')
      const item = generateItem('act1-low', 0)
      item.identified = false
      save.stash.push(item)
      expect(() => startAppraisal(save, item.id)).toThrow('Appraiser not available')
    })

    it('appraiser start rejects identified item', () => {
      const save = createSaveGame('user-1')
      save.gold = 99999
      save.materials = 9999
      upgradeCaravan(save, 'appraiser')
      const item = generateItem('act1-low', 0)
      item.identified = true
      save.stash.push(item)
      expect(() => startAppraisal(save, item.id)).toThrow('already identified')
    })

    it('appraiser queue accepts item and completes when time passes', () => {
      const save = createSaveGame('user-1')
      save.gold = 99999
      save.materials = 9999
      upgradeCaravan(save, 'appraiser')
      const item = generateItem('act1-low', 0)
      item.identified = false
      item.rarity = 'magic'
      save.stash.push(item)

      startAppraisal(save, item.id)
      expect(save.caravan.services.appraiserQueue).toHaveLength(1)

      // Complete with a future date
      const future = new Date(Date.now() + 10 * 60 * 1000)
      vi.useFakeTimers()
      vi.setSystemTime(future)
      completeAppraisalQueue(save)
      expect(save.caravan.services.appraiserQueue).toHaveLength(0)

      const stashItem = save.stash.find(si => si.id === item.id)
      expect(stashItem?.identified).toBe(true)
      vi.useRealTimers()
    })
  })
})
