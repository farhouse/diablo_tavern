import { describe, expect, it } from 'vitest'
import { createPersistedGameV3 } from '~/server/utils/savegame'
import { maintenancePeriodKey, reconcileCaravanMaintenance } from '~/server/domain/caravan-v2'

describe('caravan V2 regression coverage', () => {
  const dependencies = () => {
    let sequence = 0
    return { now: () => new Date('2026-09-23T12:00:00Z'), uuid: () => `id-${sequence++}`, random: () => (sequence++ % 997) / 997 }
  }

  it('starts new games with locked V2 services', () => {
    const game = createPersistedGameV3('new-account', dependencies())
    expect(game.caravanV2.upgrades).toEqual({ visitor_quarters: 0, blacksmith: 0, enchanter: 0 })
    expect(game.caravanV2.serviceUnlockedAt).toEqual({})
  })

  it('pays existing maintenance debt when reconcile has no new period', () => {
    const game = createPersistedGameV3('debt-account', dependencies())
    game.gold = 1000
    game.caravanV2.upgrades.blacksmith = 1
    game.caravanV2.maintenance.debts = [{ periodKey: '2026-W38', gold: 100 }]
    const before = maintenancePeriodKey(new Date('2026-09-23T12:00:00Z'))
    reconcileCaravanMaintenance(game, new Date('2026-09-23T12:00:00Z'))
    expect(before).toBe(game.caravanV2.maintenance.accountedThroughPeriodKey)
    expect(game.gold).toBe(900)
    expect(game.caravanV2.maintenance.debts).toEqual([])
  })
})
