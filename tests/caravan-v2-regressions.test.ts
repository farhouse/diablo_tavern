import { describe, expect, it } from 'vitest'
import { createPersistedGameV3 } from '~/server/utils/savegame'
import { appendChronicleEvent, eventIdFor, isChronicleEventDataValid, maintenancePeriodKey, reconcileCaravanMaintenance } from '~/server/domain/caravan-v2'

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

  it('uses natural event keys and rejects payloads outside each event union', () => {
    const game = createPersistedGameV3('chronicle-account', dependencies())
    appendChronicleEvent(game, {
      eventKey: 'expedition:e1:started', type: 'expedition_started', occurredAt: game.updatedAt,
      subject: { kind: 'expedition', id: 'e1' }, data: {}
    })
    appendChronicleEvent(game, {
      eventKey: 'expedition:e1:started', type: 'expedition_started', occurredAt: game.updatedAt,
      subject: { kind: 'expedition', id: 'e1' }, data: {}
    })
    expect(game.chronicleOutbox).toHaveLength(1)
    expect(game.chronicleOutbox[0]?.eventId).toBe(eventIdFor(game.userId, 'expedition:e1:started'))
    expect(isChronicleEventDataValid({
      ...game.chronicleOutbox[0]!, type: 'expedition_started', data: { outcome: 'returned' }
    })).toBe(false)
  })
})
