export type ChronicleEntry = {
  eventId: string
  occurredAt: string
  type: 'visitor_arrived' | 'expedition_started' | 'expedition_resolved' | 'item_found' | 'item_custody_changed' | 'visitor_died' | 'visitor_departed'
  subject: { kind: 'visitor' | 'expedition' | 'item'; id: string }
  text: { key: string; fallback: string }
  related: { visitorId?: string; expeditionId?: string; itemId?: string }
  itemProvenance?: { zoneId?: string; lootTableId?: string }
}

export type ChronicleResponse = { entries: ChronicleEntry[]; nextCursor: string | null }
