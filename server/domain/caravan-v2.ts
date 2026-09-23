import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PersistedGameV3 } from '~/server/utils/savegame'

export type CaravanV2UpgradeId = 'visitor_quarters' | 'blacksmith' | 'enchanter'
export type ServiceV2Id = 'blacksmith' | 'enchanter'

export interface PersistedCaravanV2 {
  upgrades: Record<CaravanV2UpgradeId, number>
  serviceUnlockedAt: Partial<Record<ServiceV2Id, string>>
  maintenance: {
    policyVersion: 'weekly-v1'
    accountedThroughPeriodKey: string
    debts: Array<{ periodKey: string; gold: number }>
  }
  capacityReservations: Record<string, {
    reservationId: string
    sourceKind: 'settlement'
    sourceId: string
    slots: number
    createdAt: string
  }>
}

export interface PersistedChronicleOutboxEvent {
  eventId: string
  eventKey: string
  type: 'visitor_arrived' | 'expedition_started' | 'expedition_resolved' |
    'item_found' | 'item_custody_changed' | 'visitor_died' | 'visitor_departed'
  occurredAt: string
  subject: { kind: 'visitor' | 'expedition' | 'item'; id: string }
  data: Record<string, string>
}

export const CARAVAN_V2_MAX_OUTBOX = 100
export const CARAVAN_V2_UPGRADES: Record<CaravanV2UpgradeId, { maxLevel: number; costs: Array<{ gold: number; scrap: number }> }> = {
  visitor_quarters: { maxLevel: 2, costs: [{ gold: 600, scrap: 20 }, { gold: 1800, scrap: 70 }] },
  blacksmith: { maxLevel: 1, costs: [{ gold: 800, scrap: 30 }] },
  enchanter: { maxLevel: 1, costs: [{ gold: 900, scrap: 35 }] }
}

export function createCaravanV2(now: Date, legacy = false): PersistedCaravanV2 {
  const periodKey = maintenancePeriodKey(now)
  return {
    upgrades: { visitor_quarters: legacy ? 0 : 0, blacksmith: legacy ? 1 : 0, enchanter: legacy ? 1 : 0 },
    serviceUnlockedAt: legacy ? { blacksmith: now.toISOString(), enchanter: now.toISOString() } : {},
    maintenance: { policyVersion: 'weekly-v1', accountedThroughPeriodKey: periodKey, debts: [] },
    capacityReservations: {}
  }
}

export function visitorCapacityLimit(level: number): number {
  return Math.min(2, Math.max(0, level)) + 2
}

export function maintenancePeriodKey(date: Date): string {
  const utc = new Date(date)
  const day = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - day)
  const year = utc.getUTCFullYear()
  const first = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil((((utc.getTime() - first.getTime()) / 86400000) + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function nextMaintenancePeriodStart(periodKey: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(periodKey)
  if (!match) throw new Error('Invalid maintenance period key')
  const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4))
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000)
  monday.setUTCDate(monday.getUTCDate() + (Number(match[2]) * 7))
  return monday.toISOString()
}

export function caravanUpgradeToken(game: PersistedGameV3, upgradeId: CaravanV2UpgradeId, targetLevel: number, expiresAt: string): string {
  const payload = `${game.userId}|${game.createdAt}|${game.revision}|${upgradeId}|${targetLevel}|${expiresAt}`
  const secret = process.env.CARAVAN_V2_TOKEN_SECRET || 'diablo-tavern-caravan-v2-dev-secret'
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `cv2.${Buffer.from(expiresAt).toString('base64url')}.${signature}`
}

export function verifyCaravanUpgradeToken(game: PersistedGameV3, optionId: string, upgradeId: CaravanV2UpgradeId, targetLevel: number, now: Date): boolean {
  const parts = optionId.split('.')
  if (parts.length !== 3 || parts[0] !== 'cv2') return false
  let expiresAt: string
  try { expiresAt = Buffer.from(parts[1]!, 'base64url').toString('utf8') } catch { return false }
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime()) return false
  const expected = caravanUpgradeToken(game, upgradeId, targetLevel, expiresAt)
  return parts[2]!.length === expected.split('.')[2]!.length && timingSafeEqual(Buffer.from(optionId), Buffer.from(expected))
}

export function resolveCaravanUpgradeOption(game: PersistedGameV3, optionId: string, now: Date): { upgradeId: CaravanV2UpgradeId; targetLevel: number } | undefined {
  for (const upgradeId of Object.keys(CARAVAN_V2_UPGRADES) as CaravanV2UpgradeId[]) {
    const targetLevel = game.caravanV2.upgrades[upgradeId] + 1
    if (verifyCaravanUpgradeToken(game, optionId, upgradeId, targetLevel, now)) return { upgradeId, targetLevel }
  }
  return undefined
}

export function maintenanceServiceCount(caravan: PersistedCaravanV2, periodKey: string): number {
  return Object.values(caravan.serviceUnlockedAt).filter((unlockedAt) => maintenancePeriodKey(new Date(unlockedAt)) < periodKey).length
}

export function reservedCapacity(caravan: PersistedCaravanV2): number {
  return Object.values(caravan.capacityReservations).reduce((sum, reservation) => sum + reservation.slots, 0)
}

export function reconcileCaravanMaintenance(game: Pick<PersistedGameV3, 'gold' | 'caravanV2' | 'businessKeys'>, now: Date): string[] {
  const currentKey = maintenancePeriodKey(now)
  const start = nextMaintenancePeriodStart(game.caravanV2.maintenance.accountedThroughPeriodKey)
  const end = nextMaintenancePeriodStart(currentKey)
  const assessed: string[] = []
  for (let cursor = new Date(start); cursor < new Date(end); cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const periodKey = maintenancePeriodKey(cursor)
    if (periodKey === game.caravanV2.maintenance.accountedThroughPeriodKey) continue
    const key = `maintenance:assessed:${periodKey}`
    if (game.businessKeys[key]) continue
    assessed.push(periodKey)
    const due = maintenanceServiceCount(game.caravanV2, periodKey) * 50
    const debt = game.caravanV2.maintenance.debts[0]
    if (debt && game.gold >= debt.gold) {
      game.gold -= debt.gold
      game.businessKeys[`maintenance:paid:${debt.periodKey}`] = 'reconcile_game'
      game.caravanV2.maintenance.debts.shift()
    }
    if (due > 0 && game.gold >= due) {
      game.gold -= due
      game.businessKeys[`maintenance:paid:${periodKey}`] = 'reconcile_game'
    } else if (due > 0 && game.caravanV2.maintenance.debts.length < 2) {
      game.caravanV2.maintenance.debts.push({ periodKey, gold: due })
    }
    game.caravanV2.maintenance.accountedThroughPeriodKey = periodKey
    game.businessKeys[key] = 'reconcile_game'
  }
  return assessed
}

export function eventIdFor(userId: string, eventKey: string): string {
  return createHash('sha256').update(`${userId}\0${eventKey}`).digest('hex')
}

export function appendChronicleEvent(game: Pick<PersistedGameV3, 'userId' | 'chronicleOutbox'>, event: Omit<PersistedChronicleOutboxEvent, 'eventId'>): void {
  const eventId = eventIdFor(game.userId, event.eventKey)
  if (game.chronicleOutbox.some((pending) => pending.eventId === eventId)) return
  if (game.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX) throw new Error('Chronicle outbox is full')
  game.chronicleOutbox.push({ ...event, eventId })
}
