import type { Filter } from 'mongodb'
import { createHash } from 'node:crypto'
import type { Item, ProcessedRequest, SaveGame, VisitRound } from '~/types/game'
import { createSaveGame, LEGACY_SAVE_FIELDS, normalizeSaveGame, SAVE_SCHEMA_VERSION } from '~/utils/game-logic'
import { validatePersistedGameView } from '~/server/utils/game-view-validator'
import { type DbSaveGame, saveGamesCollection } from '~/server/utils/db'

const REQUEST_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const REQUEST_RECORD_LIMIT = 1_000
const LEDGER_LIMIT = 500
const MAX_MUTATE_ATTEMPTS = 5

interface PersistedItemPlacement {
  ownerKind: 'caravan'
  ownerId?: string
  custodyKind: 'stash'
  custodyId?: string
}

interface PersistedRequestRecord {
  requestId: string
  operationKey: string
  businessKey: string
  commandHash: string
  response: SaveGame
  revision: number
  createdAt: string
  updatedAt: string
}

interface PersistedLedgerEntry {
  at: string
  requestId: string
  operationKey: string
  commandHash: string
  businessKey: string
  revision: number
}

export interface PersistedGameV3 {
  userId: string
  schemaVersion: 3
  gold: number
  caravan: SaveGame['caravan']
  stashLimit: number
  stash: string[]
  unlockedRegionIds: string[]
  visitRound: VisitRound
  visitHistory: VisitRound[]
  processedRequestIds: string[]
  processedRequests: ProcessedRequest[]
  revision: number
  createdAt: string
  updatedAt: string
  itemsById: Record<string, Item>
  itemPlacements: Record<string, PersistedItemPlacement>
  requestRecords: PersistedRequestRecord[]
  businessKeys: Record<string, string>
  ledger: PersistedLedgerEntry[]
}

type PersistedDbSaveGame = DbSaveGame & PersistedGameV3

type PersistedDbDocument = DbSaveGame & Partial<PersistedGameV3>

export async function getSaveGame(userId: string): Promise<SaveGame> {
  const saves = await saveGamesCollection()

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const existing = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null

    if (!existing) {
      const created = buildPersistedFromPublic(createSaveGame(userId))
      const { _id, ...document } = created
      const result = await saves.updateOne({ userId } as Filter<DbSaveGame>, { $setOnInsert: document }, { upsert: true })
      if (result.upsertedCount !== 1 && result.modifiedCount !== 1) {
        const loaded = await saves.findOne({ userId } as Filter<DbSaveGame>)
        if (loaded) return toPublicView(loaded as PersistedDbDocument)
      }
      return toPublicView(created)
    }

    if (existing.schemaVersion === SAVE_SCHEMA_VERSION && !hasLegacyFields(existing) && !isPersistedCanonical(existing)) {
      throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
    }

    const existingIsLegacy = existing.schemaVersion !== SAVE_SCHEMA_VERSION || hasLegacyFields(existing) || !hasPersistedV3Shape(existing)
    const current = toPublicView(existing)
    const visitStateChanged = hasVisitStateChanges(current)

    if (existingIsLegacy || visitStateChanged) {
      const replacement = buildPersistedFromPublic(current)
      replacement.revision = (typeof existing.revision === 'number' ? existing.revision : 0) + 1
      const { _id, ...document } = replacement
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
        return toGameView(replacement)
      }

      continue
    }

    return toGameView(current)
  }

  throw new Error('Save changed concurrently; retry the operation')
}

export async function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  mutate: (save: SaveGame) => SaveGame | void,
  command?: unknown
): Promise<SaveGame> {
  if (!requestId || requestId.length > 128) throw new Error('A valid requestId is required')
  if (!operationKey || operationKey.length > 128) throw new Error('A valid operationKey is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }

  const saves = await saveGamesCollection()
  const businessKey = operationKey
  const requestHash = hashCommand(command)

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const currentDocument = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null

    if (!currentDocument) {
      await getSaveGame(userId)
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
      return sanitizeGameResponse(existingReplay.response)
    }

    const businessOwner = persisted.businessKeys[businessKey]
    if (businessOwner !== undefined && businessOwner !== requestId) {
      throw new BusinessKeyConflictError('business key is already bound to another request')
    }

    if (currentDocument.schemaVersion !== SAVE_SCHEMA_VERSION || hasLegacyFields(currentDocument) || !hasPersistedV3Shape(currentDocument)) {
      await getSaveGame(userId)
      continue
    }

    const currentView = toPublicView(currentDocument)
    if (currentView.revision !== expectedRevision) {
      if (attempt < MAX_MUTATE_ATTEMPTS - 1) continue
      throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
    }

    const nextRevision = currentView.revision + 1
    const draft = normalizeSaveGame(structuredClone(currentView), { refreshVisitors: false })
    const mutated = mutate(draft) ?? draft
    mutated.revision = nextRevision
    mutated.updatedAt = new Date().toISOString()
    const validated = toGameView(mutated)

    const now = mutated.updatedAt
    const next: PersistedGameV3 = buildPersistedFromPublic(validated)
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
    ].slice(-REQUEST_RECORD_LIMIT)

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
        revision: nextRevision
      }].slice(-LEDGER_LIMIT),
      processedRequestIds: [...(persisted.processedRequestIds || []), requestId].slice(-100),
      processedRequests: addProcessedRequest(persisted.processedRequests || [], requestId, operationKey).slice(-100),
      schemaVersion: SAVE_SCHEMA_VERSION
    }

    const replaceResult = await saves.replaceOne(
      {
        userId,
        ...(currentView.revision === 0
          ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
          : { revision: currentView.revision })
      } as Filter<PersistedDbSaveGame>,
      nextPersisted
    )

    if (replaceResult.modifiedCount === 1) {
      return sanitizeGameResponse(validated)
    }
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

export function serializeSave(save: SaveGame | DbSaveGame): SaveGame {
  const normalized = normalizeSaveGame(save as SaveGame)
  if ((save as { _id?: unknown })._id) normalized._id = String((save as { _id?: unknown })._id)
  return sanitizeGameResponse(normalized)
}

function toPersistedGame(document: PersistedDbDocument): PersistedGameV3 {
  return {
    userId: document.userId,
    schemaVersion: SAVE_SCHEMA_VERSION,
    gold: Number(document.gold ?? 0),
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
    visitRound: (document as { visitRound: VisitRound }).visitRound,
    visitHistory: Array.isArray((document as { visitHistory?: unknown }).visitHistory)
      ? [...((document as { visitHistory: VisitRound[] }).visitHistory)]
      : [],
    processedRequestIds: Array.isArray((document as { processedRequestIds?: unknown }).processedRequestIds)
      ? [...((document as { processedRequestIds: string[] }).processedRequestIds)]
      : [],
    processedRequests: Array.isArray((document as { processedRequests?: unknown }).processedRequests)
      ? [...((document as { processedRequests: ProcessedRequest[] }).processedRequests)]
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

function toPublicView(document: PersistedDbDocument): SaveGame {
  const persisted = hasPersistedV3Shape(document) ? toPersistedGame(document) : buildLegacyPublicView(document)
  const publicSave = buildPublicFromPersisted(persisted)
  return toGameView(publicSave)
}

function buildPublicFromPersisted(document: PersistedGameV3): SaveGame {
  if (document.schemaVersion === SAVE_SCHEMA_VERSION && !isPersistedCanonical(document)) {
    throw new PersistedGameCorruptError('Persisted game is corrupt')
  }

  const base = normalizeSaveGame({
    ...document,
    schemaVersion: document.schemaVersion,
    userId: document.userId,
    processedRequestIds: document.processedRequestIds ?? [],
    processedRequests: document.processedRequests ?? [],
    visitRound: document.visitRound,
    visitHistory: document.visitHistory
  } as SaveGame)

  const stash = (document.stash || []).map((itemId) => (document.itemsById || {})[itemId]).filter((item): item is Item => Boolean(item))

  return {
    ...base,
    stash
  }
}

function buildLegacyPublicView(document: PersistedDbDocument): SaveGame {
  const legacy = normalizeSaveGame(document as SaveGame)
  return {
    ...legacy,
    stash: legacy.stash
  }
}

function buildPersistedFromPublic(save: SaveGame): PersistedGameV3 {
  const normalized = normalizeSaveGame(structuredClone(save))
  const itemsById: Record<string, Item> = {}
  const itemPlacements: Record<string, PersistedItemPlacement> = {}
  const stash: string[] = []

  const seenIds = new Set<string>()
  for (const item of normalized.stash || []) {
    if (!item.id) item.id = createItemId()
    if (seenIds.has(item.id)) throw new PersistedGameCorruptError('Item IDs in stash must be unique')
    seenIds.add(item.id)
    itemsById[item.id] = item
    itemPlacements[item.id] = { ownerKind: 'caravan', custodyKind: 'stash' }
    stash.push(item.id)
  }

  for (const existing of Object.values(itemsById)) {
    if (!existing.id) existing.id = createItemId()
  }

  return {
    userId: normalized.userId,
    schemaVersion: SAVE_SCHEMA_VERSION,
    gold: Number(normalized.gold ?? 0),
    caravan: normalized.caravan,
    stashLimit: Number(normalized.stashLimit ?? 0),
    stash,
    unlockedRegionIds: [...normalized.unlockedRegionIds],
    visitRound: normalized.visitRound,
    visitHistory: [...normalized.visitHistory],
    processedRequestIds: Array.isArray(normalized.processedRequestIds) ? [...normalized.processedRequestIds] : [],
    processedRequests: Array.isArray(normalized.processedRequests)
      ? [...normalized.processedRequests]
      : normalized.processedRequestIds?.map((requestId) => ({ requestId, operationKey: '' })) ?? [],
    revision: Number(normalized.revision ?? 0),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    itemsById,
    itemPlacements,
    requestRecords: [] as PersistedRequestRecord[],
    businessKeys: {},
    ledger: [] as PersistedLedgerEntry[]
  }
}

function hasLegacyFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  return LEGACY_SAVE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))
}

function hasPersistedV3Shape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { schemaVersion?: unknown }
  return candidate.schemaVersion === SAVE_SCHEMA_VERSION
}

function isPersistedCanonical(document: PersistedDbDocument): boolean {
  if (!document || typeof document !== 'object') return false

  const stash = (document as { stash?: unknown }).stash
  const itemsById = (document as { itemsById?: Record<string, Item> }).itemsById
  const itemPlacements = (document as { itemPlacements?: Record<string, PersistedItemPlacement> }).itemPlacements

  if (!Array.isArray(stash) || !itemsById || !itemPlacements) return false
  if (typeof document.userId !== 'string' || !document.userId) return false

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
    if (placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') return false
    if (!itemsById[itemId]) return false
    if (itemId !== itemsById[itemId]?.id) return false
  }

  return true
}

function addProcessedRequest(entries: ProcessedRequest[], requestId: string, operationKey: string): ProcessedRequest[] {
  const list = [...entries]
  if (!list.some((entry) => entry.requestId === requestId)) list.push({ requestId, operationKey })
  return list
}

function hasVisitStateChanges(save: SaveGame): boolean {
  return JSON.stringify(save.visitRound) !== JSON.stringify({ ...save.visitRound, slots: [...save.visitRound.slots] })
    || JSON.stringify(save.visitHistory) !== JSON.stringify(save.visitHistory.map((round) => ({ ...round, slots: [...round.slots] })))
}

function hashCommand(command: unknown): string {
  const payload = canonicalize(command)
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function sanitizeGameResponse(save: SaveGame): SaveGame {
  const sanitized = structuredClone(save) as SaveGame & {
    _id?: unknown
    userId?: unknown
    requestRecords?: unknown
    businessKeys?: unknown
    ledger?: unknown
    itemsById?: unknown
    itemPlacements?: unknown
    processedRequestIds?: unknown
    processedRequests?: unknown
  }
  delete sanitized._id
  delete sanitized.userId
  delete sanitized.requestRecords
  delete sanitized.businessKeys
  delete sanitized.ledger
  delete sanitized.itemsById
  delete sanitized.itemPlacements
  delete sanitized.processedRequestIds
  delete sanitized.processedRequests
  return sanitized
}

function toGameView(save: SaveGame): SaveGame {
  const projected = sanitizeGameResponse(save)
  validatePersistedGameView(projected)
  return projected
}

function createItemId(prefix = 'item'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `${prefix}-${globalThis.crypto.randomUUID()}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]))
  }

  return value
}
