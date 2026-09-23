import { chronicleEventsCollection } from '~/server/utils/db'
import { getPersistedGameV3 } from '~/server/utils/savegame'
import type { PersistedChronicleOutboxEvent } from '~/server/domain/caravan-v2'

export interface ChronicleEntry {
  eventId: string
  occurredAt: string
  type: PersistedChronicleOutboxEvent['type']
  subject: PersistedChronicleOutboxEvent['subject']
  text: { key: string; fallback: string }
  related: { visitorId?: string; expeditionId?: string; itemId?: string }
  itemProvenance?: { zoneId?: string; lootTableId?: string }
}

export async function projectChronicleOutbox(userId: string): Promise<void> {
  const game = await getPersistedGameV3(userId)
  if (!game.chronicleOutbox.length) return
  const collection = await chronicleEventsCollection()
  for (const event of game.chronicleOutbox) {
    await collection.updateOne({ userId, eventId: event.eventId }, { $setOnInsert: { userId, ...event } }, { upsert: true })
  }
  const ids = game.chronicleOutbox.map((event) => event.eventId)
  const saves = (await import('~/server/utils/db')).saveGamesCollection
  const saveCollection = await saves()
  await saveCollection.updateOne({ userId }, { $pull: { chronicleOutbox: { eventId: { $in: ids } } } } as never)
}

export async function listChronicle(userId: string, cursor: string | undefined, limit: number): Promise<{ entries: ChronicleEntry[]; nextCursor: string | null }> {
  await projectChronicleOutbox(userId)
  const collection = await chronicleEventsCollection()
  const filter: Record<string, unknown> = { userId }
  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { occurredAt: string; eventId: string }
    filter.$or = [{ occurredAt: { $lt: decoded.occurredAt } }, { occurredAt: decoded.occurredAt, eventId: { $lt: decoded.eventId } }]
  }
  const rows = await collection.find(filter).sort({ occurredAt: -1, eventId: -1 }).limit(limit + 1).toArray()
  const page = rows.slice(0, limit)
  const entries = page.map((event) => publicEntry(event as unknown as PersistedChronicleOutboxEvent))
  const last = page.at(-1)
  return { entries, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, eventId: last.eventId })).toString('base64url') : null }
}

function publicEntry(event: PersistedChronicleOutboxEvent): ChronicleEntry {
  const related = event.subject.kind === 'visitor' ? { visitorId: event.subject.id } : event.subject.kind === 'expedition' ? { expeditionId: event.subject.id } : { itemId: event.subject.id }
  return { eventId: event.eventId, occurredAt: event.occurredAt, type: event.type, subject: event.subject, text: { key: `chronicle.${event.type}`, fallback: event.type.replaceAll('_', ' ') }, related, ...(event.data.zoneId ? { itemProvenance: { zoneId: event.data.zoneId, ...(event.data.lootTableId ? { lootTableId: event.data.lootTableId } : {}) } } : {}) }
}
