import type { Filter } from 'mongodb'
import { createHash, randomUUID } from 'node:crypto'
import type { Item, SaveGame, VisitRound, Visitor, VisitorCommission, VisitorOffer, VisitorSlot } from '~/types/game'
import { createSaveGame, LEGACY_SAVE_FIELDS, normalizeSaveGame, SAVE_SCHEMA_VERSION } from '~/utils/game-logic'
import { refreshVisitRound } from '~/utils/visitor-logic'
import { type DbSaveGame, saveGamesCollection } from '~/server/utils/db'

const REQUEST_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_MUTATE_ATTEMPTS = 5
const PERSISTENCE_LEGACY_FIELDS = LEGACY_SAVE_FIELDS.filter((field) => field !== 'materials')

export interface PersistenceDependencies {
  now: () => Date
  uuid: () => string
  random: () => number
}

const defaultDependencies: PersistenceDependencies = {
  now: () => new Date(),
  uuid: randomUUID,
  random: Math.random
}

export interface PersistedItemPlacement {
  ownerKind: 'caravan' | 'visitor' | 'tombstone'
  ownerId?: string
  custodyKind: 'stash' | 'visitor' | 'service' | 'expedition' | 'recovery' | 'settlement' | 'tombstone'
  custodyId?: string
}

export interface PersistedRequestRecord {
  requestId: string
  operationKey: string
  businessKey: string
  commandHash: string
  response: PublicSaveGame
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PersistedLedgerEntry {
  at: string
  requestId: string
  operationKey: string
  commandHash: string
  businessKey: string
  revision: number
  goldDelta: number
  itemChanges: Array<{ itemId: string; from?: PersistedItemPlacement; to: PersistedItemPlacement }>
}

type PersistedVisitorOffer = Omit<VisitorOffer, 'item'> & { itemId: string }
type PersistedVisitorCommission = Omit<VisitorCommission, 'rewardItem'> & { rewardItemId?: string }
type PersistedVisitor = Omit<Visitor, 'offers' | 'commission'> & {
  offers: PersistedVisitorOffer[]
  commission?: PersistedVisitorCommission
}
type PersistedVisitorSlot = Omit<VisitorSlot, 'visitor'> & { visitor?: PersistedVisitor }
type PersistedVisitRound = Omit<VisitRound, 'slots'> & { slots: PersistedVisitorSlot[] }

export interface PersistedGameV3 {
  userId: string
  schemaVersion: 3
  gold: number
  materials: Record<string, number>
  caravan: SaveGame['caravan']
  stashLimit: number
  stash: string[]
  unlockedRegionIds: string[]
  visitRound: PersistedVisitRound
  visitHistory: PersistedVisitRound[]
  revision: number
  createdAt: string
  updatedAt: string
  itemsById: Record<string, Item>
  itemPlacements: Record<string, PersistedItemPlacement>
  requestRecords: PersistedRequestRecord[]
  businessKeys: Record<string, string>
  ledger: PersistedLedgerEntry[]
}

export function createPersistedGameV3(userId: string, dependencies = defaultDependencies): PersistedGameV3 {
  return buildPersistedFromPublic(createSaveGame(userId, dependencies.now(), dependencies.random), undefined, dependencies)
}

type PersistedDbDocument = DbSaveGame & Partial<Omit<PersistedGameV3, 'userId'>>

export async function getPersistedGameV3(userId: string, dependencies = defaultDependencies): Promise<PersistedGameV3> {
  const saves = await saveGamesCollection()

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const existing = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null

    if (!existing) {
      const created = createPersistedGameV3(userId, dependencies)
      const document = created as unknown as DbSaveGame
      const result = await saves.updateOne({ userId } as Filter<DbSaveGame>, { $setOnInsert: document }, { upsert: true })
      if (result.upsertedCount !== 1 && result.modifiedCount !== 1) {
        const loaded = await saves.findOne({ userId } as Filter<DbSaveGame>)
        if (loaded) {
          if (!isPersistedCanonical(loaded)) throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
          return toPersistedGame(loaded as PersistedDbDocument)
        }
      }
      return created
    }

    if (existing.schemaVersion === SAVE_SCHEMA_VERSION && !hasLegacyFields(existing) && !isPersistedCanonical(existing)) {
      throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
    }

    const existingIsLegacy = existing.schemaVersion !== SAVE_SCHEMA_VERSION || hasLegacyFields(existing) || !hasPersistedV3Shape(existing)
    if (existingIsLegacy) {
      const replacement = createPersistedGameV3(userId, dependencies)
      replacement.revision = (typeof existing.revision === 'number' ? existing.revision : 0) + 1
      const document = replacement as unknown as DbSaveGame
      const result = await saves.replaceOne(
        {
          userId,
          ...(typeof existing.revision === 'number'
            ? { revision: existing.revision }
            : { $or: [{ revision: { $exists: false } }, { revision: 0 }] })
        },
        document
      )
      if (result.modifiedCount === 1) {
        return replacement
      }

      continue
    }

    return toPersistedGame(existing)
  }

  throw new Error('Save changed concurrently; retry the operation')
}

export async function getSaveGame(userId: string, dependencies = defaultDependencies): Promise<SaveGame> {
  const compatibility = hydratePersistedGame(await getPersistedGameV3(userId, dependencies))
  refreshVisitRound(compatibility, dependencies.now(), dependencies.random)
  return toGameView(compatibility)
}

export function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  mutate: (save: SaveGame) => SaveGame | void
): Promise<SaveGame>
export function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  command: unknown,
  mutate: (save: SaveGame) => SaveGame | void,
  dependencies?: PersistenceDependencies
): Promise<SaveGame>
export async function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  commandOrMutate: unknown | ((save: SaveGame) => SaveGame | void),
  maybeMutate?: (save: SaveGame) => SaveGame | void,
  dependencies = defaultDependencies
): Promise<SaveGame> {
  if (!requestId || requestId.length > 128) throw new Error('A valid requestId is required')
  if (!operationKey || operationKey.length > 128) throw new Error('A valid operationKey is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }

  const saves = await saveGamesCollection()
  const businessKey = operationKey
  const mutate = maybeMutate ?? (commandOrMutate as (save: SaveGame) => SaveGame | void)
  const command = maybeMutate ? commandOrMutate : { operationKey }
  const requestHash = hashCommand(operationKey, command)

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const currentDocument = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null

    if (!currentDocument) {
      await getSaveGame(userId, dependencies)
      continue
    }

    if (currentDocument.schemaVersion === SAVE_SCHEMA_VERSION && !hasLegacyFields(currentDocument) && !isPersistedCanonical(currentDocument)) {
      throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
    }

    const persisted = toPersistedGame(currentDocument)
    const existingReplay = persisted.requestRecords.find((record) => record.requestId === requestId)

    if (existingReplay) {
      if (existingReplay.commandHash !== requestHash) {
        throw new IdempotencyConflictError('requestId was already used for a different command')
      }
      return existingReplay.response as unknown as SaveGame
    }

    const businessOwner = persisted.businessKeys[businessKey]
    if (businessOwner !== undefined) {
      throw new BusinessKeyConflictError('business key was already committed and its replay record is unavailable')
    }

    if (currentDocument.schemaVersion !== SAVE_SCHEMA_VERSION || hasLegacyFields(currentDocument) || !hasPersistedV3Shape(currentDocument)) {
      await getSaveGame(userId, dependencies)
      continue
    }

    const currentView = hydratePersistedGame(persisted)
    if (currentView.revision !== expectedRevision) {
      throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
    }

    const nextRevision = currentView.revision + 1
    const draft = normalizeSaveGame(structuredClone(currentView), { refreshVisitors: false })
    const mutated = mutate(draft) ?? draft
    mutated.revision = nextRevision
    mutated.updatedAt = dependencies.now().toISOString()
    const validated = normalizeSaveGame(mutated, { refreshVisitors: false })
    validated.userId = userId

    const now = mutated.updatedAt
    const next: PersistedGameV3 = buildPersistedFromPublic(validated, persisted, dependencies)
    next.userId = userId
    next.revision = nextRevision

    const requestRecords = [
      ...persisted.requestRecords.filter((entry) => Date.parse(entry.createdAt) + REQUEST_RECORD_RETENTION_MS >= Date.parse(now)),
      {
        requestId,
        operationKey,
        businessKey,
        commandHash: requestHash,
        response: sanitizeGameResponse(validated),
        revision: nextRevision,
        createdAt: now,
        updatedAt: now
      }
    ]

    const nextPersisted: PersistedGameV3 = {
      ...next,
      requestRecords,
      businessKeys: {
        ...(persisted.businessKeys || {}),
        [businessKey]: requestId
      },
      ledger: [...persisted.ledger, {
        at: now,
        requestId,
        operationKey,
        commandHash: requestHash,
        businessKey,
        revision: nextRevision,
        goldDelta: next.gold - persisted.gold,
        itemChanges: itemPlacementChanges(persisted, next)
      }],
      schemaVersion: SAVE_SCHEMA_VERSION
    }

    const replaceResult = await saves.replaceOne(
      {
        userId,
        ...(currentView.revision === 0
          ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
          : { revision: currentView.revision })
      } as Filter<DbSaveGame>,
      nextPersisted as unknown as DbSaveGame
    )
    if (replaceResult.modifiedCount === 1) {
      return sanitizeGameResponse(validated)
    }

    // Reload after a lost CAS. The next iteration can only return an exact
    // replay; any other winner makes expectedRevision stale.
  }

  throw new Error('Save changed concurrently; retry with the same requestId')
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError'
}

export class RevisionConflictError extends Error {
  override name = 'RevisionConflictError'
}

export class BusinessKeyConflictError extends Error {
  override name = 'BusinessKeyConflictError'
}

export class PersistedGameCorruptError extends Error {
  override name = 'PersistedGameCorruptError'
}

function toPersistedGame(document: PersistedDbDocument): PersistedGameV3 {
  return {
    userId: document.userId,
    schemaVersion: SAVE_SCHEMA_VERSION,
    gold: Number(document.gold ?? 0),
    materials: isResourceMap(document.materials) ? document.materials : {},
    caravan: (document as { caravan: SaveGame['caravan'] }).caravan || {
      level: 0,
      upgrades: { stashWagon: 0, appraiser: 0 },
      services: { appraiserQueue: [] }
    },
    stashLimit: Number(document.stashLimit ?? 20),
    stash: Array.isArray(document.stash) ? document.stash : [],
    unlockedRegionIds: Array.isArray((document as { unlockedRegionIds?: unknown }).unlockedRegionIds)
      ? [...((document as { unlockedRegionIds: string[] }).unlockedRegionIds)]
      : [],
    visitRound: (document as { visitRound: PersistedVisitRound }).visitRound,
    visitHistory: Array.isArray((document as { visitHistory?: unknown }).visitHistory)
      ? [...((document as { visitHistory: PersistedVisitRound[] }).visitHistory)]
      : [],
    revision: Number(document.revision ?? 0),
    createdAt: (document as { createdAt?: string }).createdAt ?? new Date().toISOString(),
    updatedAt: (document as { updatedAt?: string }).updatedAt ?? new Date().toISOString(),
    itemsById: (document as { itemsById?: Record<string, Item> }).itemsById || {},
    itemPlacements: (document as { itemPlacements?: Record<string, PersistedItemPlacement> }).itemPlacements || {},
    requestRecords: Array.isArray((document as { requestRecords?: unknown }).requestRecords)
      ? [...((document as { requestRecords: PersistedRequestRecord[] }).requestRecords)]
      : [],
    businessKeys: (document as { businessKeys?: Record<string, string> }).businessKeys || {},
    ledger: Array.isArray((document as { ledger?: unknown }).ledger)
      ? [...((document as { ledger: PersistedLedgerEntry[] }).ledger)]
      : []
  }
}

export function hydratePersistedGame(document: PersistedGameV3): SaveGame {
  if (document.schemaVersion === SAVE_SCHEMA_VERSION && !isPersistedCanonical(document)) {
    throw new PersistedGameCorruptError('Persisted game is corrupt')
  }

  const base = normalizeSaveGame({
    schemaVersion: document.schemaVersion,
    userId: document.userId,
    gold: document.gold,
    caravan: structuredClone(document.caravan),
    stashLimit: document.stashLimit,
    stash: [],
    unlockedRegionIds: [...document.unlockedRegionIds],
    processedRequestIds: [],
    processedRequests: [],
    visitRound: hydrateRound(document.visitRound, document.itemsById),
    visitHistory: document.visitHistory.map((round) => hydrateRound(round, document.itemsById)),
    revision: document.revision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  } as unknown as SaveGame, { refreshVisitors: false })

  const stash = Object.entries(document.itemPlacements)
    .filter(([, placement]) => placement.ownerKind === 'caravan' && placement.custodyKind !== 'tombstone')
    .map(([itemId]) => document.itemsById[itemId])
    .filter((item): item is Item => Boolean(item))

  return {
    ...base,
    stash
  }
}

export function buildPersistedFromPublic(
  save: SaveGame,
  previous?: PersistedGameV3,
  dependencies = defaultDependencies
): PersistedGameV3 {
  const normalized = normalizeSaveGame(structuredClone(save))
  const itemsById: Record<string, Item> = {}
  const itemPlacements: Record<string, PersistedItemPlacement> = {}
  const stash: string[] = []

  const seenIds = new Set<string>()
  for (const item of normalized.stash || []) {
    if (!item.id) item.id = createItemId('item', dependencies)
    if (seenIds.has(item.id)) throw new PersistedGameCorruptError('Item IDs in stash must be unique')
    seenIds.add(item.id)
    const serviceJob = normalized.caravan.services.appraiserQueue.find((job) => job.itemId === item.id)
    registerItem(itemsById, itemPlacements, item, serviceJob
      ? { ownerKind: 'caravan', custodyKind: 'service', custodyId: serviceJob.id }
      : { ownerKind: 'caravan', custodyKind: 'stash' })
    if (!serviceJob) stash.push(item.id)
  }

  const visitRound = persistRound(normalized.visitRound, itemsById, itemPlacements)
  const visitHistory = normalized.visitHistory.map((round) => persistRound(round, itemsById, itemPlacements))
  for (const round of [visitRound, ...visitHistory]) {
    for (const visitor of round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])) {
      for (const trade of visitor.trades.filter((entry) => entry.kind === 'player_sold')) {
        const soldItem = itemsById[trade.itemId] ?? previous?.itemsById[trade.itemId]
        if (!soldItem) throw new PersistedGameCorruptError(`Missing sold item ${trade.itemId}`)
        if (itemPlacements[trade.itemId]?.ownerKind !== 'caravan') {
          itemsById[trade.itemId] = structuredClone(soldItem)
          itemPlacements[trade.itemId] = {
            ownerKind: 'visitor', ownerId: visitor.id, custodyKind: 'visitor', custodyId: visitor.id
          }
        }
      }
    }
  }
  for (const [itemId, item] of Object.entries(previous?.itemsById ?? {})) {
    if (!itemsById[itemId]) itemsById[itemId] = structuredClone(item)
  }
  for (const itemId of Object.keys(itemsById)) {
    if (seenIds.has(itemId) || isReferencedByVisitors(itemId, visitRound, visitHistory)) continue
    itemPlacements[itemId] = { ownerKind: 'tombstone', custodyKind: 'tombstone' }
  }

  return {
    userId: normalized.userId,
    schemaVersion: SAVE_SCHEMA_VERSION,
    gold: Number(normalized.gold ?? 0),
    materials: structuredClone(previous?.materials ?? {}),
    caravan: normalized.caravan,
    stashLimit: Number(normalized.stashLimit ?? 0),
    stash,
    unlockedRegionIds: [...normalized.unlockedRegionIds],
    visitRound,
    visitHistory,
    revision: Number(normalized.revision ?? 0),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    itemsById,
    itemPlacements,
    requestRecords: structuredClone(previous?.requestRecords ?? []),
    businessKeys: structuredClone(previous?.businessKeys ?? {}),
    ledger: structuredClone(previous?.ledger ?? [])
  }
}

function hasLegacyFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  return PERSISTENCE_LEGACY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))
}

function hasPersistedV3Shape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { schemaVersion?: unknown }
  return candidate.schemaVersion === SAVE_SCHEMA_VERSION
}

export function isPersistedCanonical(document: unknown): document is PersistedGameV3 {
  if (!document || typeof document !== 'object') return false

  const candidate = document as Record<string, unknown>

  const stash = (document as { stash?: unknown }).stash
  const itemsById = (document as { itemsById?: Record<string, Item> }).itemsById
  const itemPlacements = (document as { itemPlacements?: Record<string, PersistedItemPlacement> }).itemPlacements

  if (candidate.schemaVersion !== SAVE_SCHEMA_VERSION) return false
  if (!Array.isArray(stash) || !itemsById || !itemPlacements) return false
  if (typeof candidate.userId !== 'string' || !candidate.userId) return false
  if (!Number.isInteger(candidate.gold) || Number(candidate.gold) < 0 || !isResourceMap(candidate.materials)) return false
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 0) return false
  if (!Number.isFinite(Date.parse(String(candidate.createdAt))) || !Number.isFinite(Date.parse(String(candidate.updatedAt)))) return false
  if (!Array.isArray(candidate.requestRecords) || !Array.isArray(candidate.ledger)) return false
  if (!candidate.businessKeys || typeof candidate.businessKeys !== 'object' || Array.isArray(candidate.businessKeys)) return false
  if (!candidate.visitRound || typeof candidate.visitRound !== 'object' || !Array.isArray((candidate.visitRound as { slots?: unknown }).slots)) return false
  if (!Array.isArray(candidate.visitHistory)) return false
  if (Object.keys(itemsById).length !== Object.keys(itemPlacements).length) return false

  const seen = new Set<string>()
  for (const itemId of stash) {
    if (typeof itemId !== 'string' || !itemId) return false
    if (seen.has(itemId)) return false
    seen.add(itemId)

    const item = itemsById[itemId]
    const placement = itemPlacements[itemId]
    if (!item || !placement || placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') return false
  }

  for (const [itemId, placement] of Object.entries(itemPlacements)) {
    if (!itemsById[itemId]) return false
    if (itemId !== itemsById[itemId]?.id) return false
    const compatible =
      (placement.ownerKind === 'caravan' && ['stash', 'service', 'expedition', 'recovery', 'settlement'].includes(placement.custodyKind))
      || (placement.ownerKind === 'visitor' && placement.custodyKind === 'visitor' && Boolean(placement.ownerId) && placement.ownerId === placement.custodyId)
      || (placement.ownerKind === 'tombstone' && placement.custodyKind === 'tombstone')
    if (!compatible) return false
    if (placement.custodyKind === 'stash' && !seen.has(itemId)) return false
  }

  const rounds = [candidate.visitRound, ...candidate.visitHistory] as PersistedVisitRound[]
  for (const round of rounds) {
    if (!round || !Array.isArray(round.slots)) return false
    for (const slot of round.slots) {
      const visitor = slot.visitor
      if (!visitor) continue
      if (!Array.isArray(visitor.offers) || !Array.isArray(visitor.trades)) return false
      if (visitor.offers.some((offer) => !offer.itemId || !itemsById[offer.itemId] || Object.prototype.hasOwnProperty.call(offer, 'item'))) return false
      if (visitor.commission && Object.prototype.hasOwnProperty.call(visitor.commission, 'rewardItem')) return false
      if (visitor.commission?.rewardItemId && !itemsById[visitor.commission.rewardItemId]) return false
    }
  }

  const requestIds = new Set<string>()
  for (const record of candidate.requestRecords as PersistedRequestRecord[]) {
    if (!record || typeof record.requestId !== 'string' || requestIds.has(record.requestId)) return false
    if (!/^[a-f0-9]{64}$/.test(record.commandHash) || !Number.isInteger(record.revision)) return false
    if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) return false
    if (containsInternalFields(record.response)) return false
    requestIds.add(record.requestId)
  }

  const ledgerKeys = new Set<string>()
  for (const entry of candidate.ledger as PersistedLedgerEntry[]) {
    if (!entry || typeof entry.businessKey !== 'string' || ledgerKeys.has(entry.businessKey)) return false
    if (!Number.isInteger(entry.goldDelta) || !Array.isArray(entry.itemChanges)) return false
    ledgerKeys.add(entry.businessKey)
  }
  for (const [businessKey, requestId] of Object.entries(candidate.businessKeys as Record<string, string>)) {
    if (!businessKey || !requestId || !ledgerKeys.has(businessKey)) return false
  }

  return true
}

function isResourceMap(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => Number.isInteger(entry) && Number(entry) >= 0)
}

function containsInternalFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const keys = new Set(Object.keys(value as object))
  return ['_id', 'userId', 'requestRecords', 'businessKeys', 'ledger', 'itemsById', 'itemPlacements', 'processedRequestIds', 'processedRequests']
    .some((key) => keys.has(key))
}

function registerItem(
  items: Record<string, Item>,
  placements: Record<string, PersistedItemPlacement>,
  item: Item,
  placement: PersistedItemPlacement
): void {
  const existing = items[item.id]
  const existingPlacement = placements[item.id]
  if (existing && JSON.stringify(existing) !== JSON.stringify(item) && existingPlacement?.ownerKind !== 'caravan') {
    throw new PersistedGameCorruptError(`Conflicting copies for item ${item.id}`)
  }
  if (!existing || placement.ownerKind === 'caravan') items[item.id] = structuredClone(item)
  if (placements[item.id]?.ownerKind !== 'caravan' || placement.ownerKind === 'caravan') {
    placements[item.id] = placement
  }
}

function persistRound(
  round: VisitRound,
  items: Record<string, Item>,
  placements: Record<string, PersistedItemPlacement>
): PersistedVisitRound {
  return {
    ...structuredClone(round),
    slots: round.slots.map((slot) => {
      if (!slot.visitor) return { id: slot.id, ...(slot.nextArrivalCheckAt ? { nextArrivalCheckAt: slot.nextArrivalCheckAt } : {}) }
      const visitor = slot.visitor
      const offers = visitor.offers.map(({ item, ...offer }) => {
        registerItem(items, placements, item, {
          ownerKind: 'visitor', ownerId: visitor.id, custodyKind: 'visitor', custodyId: visitor.id
        })
        return { ...structuredClone(offer), itemId: item.id }
      })
      let commission: PersistedVisitorCommission | undefined
      if (visitor.commission) {
        const { rewardItem, ...rest } = visitor.commission
        if (rewardItem) {
          registerItem(items, placements, rewardItem, {
            ownerKind: 'visitor', ownerId: visitor.id, custodyKind: 'visitor', custodyId: visitor.id
          })
        }
        commission = { ...structuredClone(rest), ...(rewardItem ? { rewardItemId: rewardItem.id } : {}) }
      }
      return { ...structuredClone(slot), visitor: { ...structuredClone(visitor), offers, commission } }
    })
  }
}

function hydrateRound(round: PersistedVisitRound, items: Record<string, Item>): VisitRound {
  return {
    ...structuredClone(round),
    slots: round.slots.map((slot) => {
      if (!slot.visitor) return { id: slot.id, ...(slot.nextArrivalCheckAt ? { nextArrivalCheckAt: slot.nextArrivalCheckAt } : {}) }
      const visitor = slot.visitor
      const offers = visitor.offers.map(({ itemId, ...offer }) => ({
        ...structuredClone(offer),
        item: requirePersistedItem(items, itemId)
      }))
      const commission = visitor.commission
        ? (() => {
            const { rewardItemId, ...rest } = visitor.commission
            return { ...structuredClone(rest), ...(rewardItemId ? { rewardItem: requirePersistedItem(items, rewardItemId) } : {}) }
          })()
        : undefined
      return { ...structuredClone(slot), visitor: { ...structuredClone(visitor), offers, commission } as Visitor }
    })
  }
}

function requirePersistedItem(items: Record<string, Item>, itemId: string): Item {
  const item = items[itemId]
  if (!item) throw new PersistedGameCorruptError(`Missing item reference ${itemId}`)
  return structuredClone(item)
}

function isReferencedByVisitors(itemId: string, current: PersistedVisitRound, history: PersistedVisitRound[]): boolean {
  return [current, ...history].some((round) => round.slots.some((slot) =>
    slot.visitor?.offers.some((offer) => offer.itemId === itemId)
    || slot.visitor?.commission?.rewardItemId === itemId
    || slot.visitor?.trades.some((trade) => trade.itemId === itemId)
  ))
}

function itemPlacementChanges(before: PersistedGameV3, after: PersistedGameV3): PersistedLedgerEntry['itemChanges'] {
  const changes: PersistedLedgerEntry['itemChanges'] = []
  for (const itemId of new Set([...Object.keys(before.itemPlacements), ...Object.keys(after.itemPlacements)])) {
    const from = before.itemPlacements[itemId]
    const to = after.itemPlacements[itemId]
    if (!to) throw new PersistedGameCorruptError(`Mutation removed item placement ${itemId}`)
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ itemId, ...(from ? { from } : {}), to })
  }
  return changes
}

function hashCommand(operationKey: string, command: unknown): string {
  const payload = canonicalize({ operationKey, command: commandPayload(command) })
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')
}

function commandPayload(command: unknown): unknown {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return command
  const { requestId: _requestId, expectedRevision: _expectedRevision, ...payload } = command as Record<string, unknown>
  return payload
}

export type PublicSaveGame = Omit<SaveGame, '_id' | 'userId' | 'processedRequestIds' | 'processedRequests'>

function sanitizeGameResponse(save: SaveGame): SaveGame {
  const sanitized = structuredClone(save) as unknown as Partial<SaveGame> & Record<string, unknown>
  delete sanitized._id
  delete sanitized.userId
  delete sanitized.requestRecords
  delete sanitized.businessKeys
  delete sanitized.ledger
  delete sanitized.itemsById
  delete sanitized.itemPlacements
  delete sanitized.processedRequestIds
  delete sanitized.processedRequests
  return stripUndefined(sanitized) as SaveGame
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]))
  }
  return value
}

function toGameView(save: SaveGame): SaveGame {
  return sanitizeGameResponse(save)
}

function createItemId(prefix = 'item', dependencies = defaultDependencies): string {
  return `${prefix}-${dependencies.uuid()}`
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]))
  }

  return value
}
