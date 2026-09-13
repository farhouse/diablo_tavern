import type { Filter } from 'mongodb'
import { createHash, randomUUID } from 'node:crypto'
import type { Item, SaveGame, VisitRound, Visitor, VisitorCommission, VisitorOffer, VisitorSlot } from '~/types/game'
import { createSaveGame, LEGACY_SAVE_FIELDS, normalizeSaveGame, SAVE_SCHEMA_VERSION } from '~/utils/game-logic'
import { refreshVisitRound } from '~/utils/visitor-logic'
import { applyItemTransition, type ItemTransitionCommand } from '~/server/domain/item-transitions'
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
  random: () => Math.random()
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
  materialDeltas: Record<string, number>
  itemChanges: Array<{ itemId: string; from?: PersistedItemPlacement; to: PersistedItemPlacement }>
}

export interface PersistedCustodyContainer {
  id: string
  itemIds: string[]
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
  expeditionsById: Record<string, PersistedCustodyContainer>
  recoveriesById: Record<string, PersistedCustodyContainer>
  settlementsById: Record<string, PersistedCustodyContainer>
  serviceJobsById: Record<string, PersistedCustodyContainer>
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

    if (existing.schemaVersion === SAVE_SCHEMA_VERSION && (hasLegacyFields(existing) || !isPersistedCanonical(existing))) {
      throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
    }

    const existingIsLegacy = existing.schemaVersion !== SAVE_SCHEMA_VERSION
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
  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const compatibility = hydratePersistedGame(await getPersistedGameV3(userId, dependencies))
    const now = dependencies.now()
    const reconciled = structuredClone(compatibility)
    refreshVisitRound(reconciled, now, dependencies.random)
    if (JSON.stringify(reconciled) === JSON.stringify(compatibility)) return toGameView(compatibility)

    try {
      return await mutateSaveGameAtomic(
        userId,
        `reconcile:${compatibility.revision}:${now.toISOString()}`,
        JSON.stringify(['reconcile', compatibility.revision]),
        compatibility.revision,
        { asOf: now.toISOString() },
        (save, deps) => refreshVisitRound(save, now, deps.random),
        dependencies
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
    }
  }
  throw new RevisionConflictError('Save changed concurrently while reconciling time transitions')
}

export function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  mutate: (save: SaveGame, dependencies: PersistenceDependencies) => SaveGame | void
): Promise<SaveGame>
export function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  command: unknown,
  mutate: (save: SaveGame, dependencies: PersistenceDependencies) => SaveGame | void,
  dependencies?: PersistenceDependencies
): Promise<SaveGame>
export async function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  expectedRevision: number,
  commandOrMutate: unknown | ((save: SaveGame, dependencies: PersistenceDependencies) => SaveGame | void),
  maybeMutate?: (save: SaveGame, dependencies: PersistenceDependencies) => SaveGame | void,
  dependencies = defaultDependencies
): Promise<SaveGame> {
  if (!requestId || requestId.length > 128) throw new Error('A valid requestId is required')
  if (!operationKey || operationKey.length > 128) throw new Error('A valid operationKey is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }

  const saves = await saveGamesCollection()
  const businessKey = isRepeatableOperation(operationKey)
    ? `${operationKey}:revision:${expectedRevision}`
    : operationKey
  const mutate = maybeMutate ?? (commandOrMutate as (save: SaveGame, dependencies: PersistenceDependencies) => SaveGame | void)
  const command = maybeMutate ? commandOrMutate : { operationKey }
  const requestHash = hashCommand(operationKey, command)

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const currentDocument = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null

    if (!currentDocument) {
      await getSaveGame(userId, dependencies)
      continue
    }

    if (currentDocument.schemaVersion === SAVE_SCHEMA_VERSION && (hasLegacyFields(currentDocument) || !isPersistedCanonical(currentDocument))) {
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

    if (currentDocument.schemaVersion !== SAVE_SCHEMA_VERSION) {
      await getSaveGame(userId, dependencies)
      continue
    }

    const currentView = hydratePersistedGame(persisted)
    if (currentView.revision !== expectedRevision) {
      throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
    }

    const nextRevision = currentView.revision + 1
    const draft = normalizeSaveGame(structuredClone(currentView), { refreshVisitors: false })
    const mutated = mutate(draft, dependencies) ?? draft
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
        materialDeltas: resourceDeltas(persisted.materials, next.materials),
        itemChanges: itemPlacementChanges(persisted, next)
      }],
      schemaVersion: SAVE_SCHEMA_VERSION
    }
    if (!isPersistedCanonical(nextPersisted)) {
      throw new PersistedGameCorruptError('Mutation produced an invalid PersistedGameV3 document')
    }

    let replaceResult
    try {
      replaceResult = await saves.replaceOne(
        {
          userId,
          ...(currentView.revision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision: currentView.revision })
        } as Filter<DbSaveGame>,
        nextPersisted as unknown as DbSaveGame
      )
    } catch (error) {
      const afterError = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null
      if (afterError && isPersistedCanonical(afterError)) {
        const replay = afterError.requestRecords.find((record) => record.requestId === requestId)
        if (replay?.commandHash === requestHash) return replay.response as unknown as SaveGame
      }
      throw error
    }
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

export async function transitionItemAtomic(
  userId: string,
  requestId: string,
  expectedRevision: number,
  command: ItemTransitionCommand,
  dependencies = defaultDependencies
): Promise<PublicSaveGame> {
  const saves = await saveGamesCollection()
  const current = await getPersistedGameV3(userId, dependencies)
  const operationKey = JSON.stringify(['item-transition', command.operation, command.itemId, command.targetId])
  const businessKey = operationKey
  const commandHash = hashCommand(operationKey, command)
  const replay = current.requestRecords.find((record) => record.requestId === requestId)
  if (replay) {
    if (replay.commandHash !== commandHash) throw new IdempotencyConflictError('requestId was already used for a different command')
    return replay.response
  }
  if (current.businessKeys[businessKey]) throw new BusinessKeyConflictError('item transition was already committed')
  if (current.revision !== expectedRevision) throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')

  const { game: transitioned } = applyItemTransition(current, command)
  const now = dependencies.now().toISOString()
  transitioned.revision = expectedRevision + 1
  transitioned.updatedAt = now
  const response = sanitizeGameResponse(hydratePersistedGame(transitioned))
  transitioned.requestRecords = [...current.requestRecords, {
    requestId, operationKey, businessKey, commandHash, response,
    revision: transitioned.revision, createdAt: now, updatedAt: now
  }]
  transitioned.businessKeys = { ...current.businessKeys, [businessKey]: requestId }
  transitioned.ledger = [...current.ledger, {
    at: now, requestId, operationKey, commandHash, businessKey,
    revision: transitioned.revision,
    goldDelta: transitioned.gold - current.gold,
    materialDeltas: resourceDeltas(current.materials, transitioned.materials),
    itemChanges: itemPlacementChanges(current, transitioned)
  }]
  if (!isPersistedCanonical(transitioned)) throw new PersistedGameCorruptError('Item transition produced an invalid aggregate')

  let result
  try {
    result = await saves.replaceOne(
      { userId, revision: expectedRevision } as Filter<DbSaveGame>,
      transitioned as unknown as DbSaveGame
    )
  } catch (error) {
    const afterError = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null
    if (afterError && isPersistedCanonical(afterError)) {
      const exactReplay = afterError.requestRecords.find((record) => record.requestId === requestId)
      if (exactReplay?.commandHash === commandHash) return exactReplay.response
    }
    throw error
  }
  if (result.modifiedCount === 1) return response
  const winner = await getPersistedGameV3(userId, dependencies)
  const winnerReplay = winner.requestRecords.find((record) => record.requestId === requestId)
  if (winnerReplay?.commandHash === commandHash) return winnerReplay.response
  throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
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
    expeditionsById: readContainerMap(document.expeditionsById),
    recoveriesById: readContainerMap(document.recoveriesById),
    settlementsById: readContainerMap(document.settlementsById),
    serviceJobsById: readContainerMap(document.serviceJobsById),
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
    .filter(([, placement]) => placement.ownerKind === 'caravan' && ['stash', 'service'].includes(placement.custodyKind))
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
  const normalized = normalizeSaveGame(structuredClone(save), { refreshVisitors: false })
  const itemsById: Record<string, Item> = {}
  const itemPlacements: Record<string, PersistedItemPlacement> = {}
  const expeditionsById = structuredClone(previous?.expeditionsById ?? {})
  const recoveriesById = structuredClone(previous?.recoveriesById ?? {})
  const settlementsById = structuredClone(previous?.settlementsById ?? {})
  const serviceJobsById = structuredClone(previous?.serviceJobsById ?? {})
  for (const job of previous?.caravan.services.appraiserQueue ?? []) delete serviceJobsById[job.id]
  const stash: string[] = []

  const seenIds = new Set<string>()
  for (const item of normalized.stash || []) {
    if (!item.id) item.id = createItemId('item', dependencies)
    if (seenIds.has(item.id)) throw new PersistedGameCorruptError('Item IDs in stash must be unique')
    seenIds.add(item.id)
    const serviceJob = normalized.caravan.services.appraiserQueue.find((job) => job.itemId === item.id)
    if (serviceJob) serviceJobsById[serviceJob.id] = { id: serviceJob.id, itemIds: [item.id] }
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
      if (visitor.commission?.rewardItemId && visitor.commission.status !== 'claimed') {
        const rewardItemId = visitor.commission.rewardItemId
        const settlementId = visitor.commission.id
        itemPlacements[rewardItemId] = { ownerKind: 'caravan', custodyKind: 'settlement', custodyId: settlementId }
        settlementsById[settlementId] = { id: settlementId, itemIds: [rewardItemId] }
      }
    }
  }
  for (const [itemId, item] of Object.entries(previous?.itemsById ?? {})) {
    if (!itemsById[itemId]) itemsById[itemId] = structuredClone(item)
  }
  for (const itemId of Object.keys(itemsById)) {
    if (seenIds.has(itemId) || isReferencedByVisitors(itemId, visitRound, visitHistory)) continue
    const previousPlacement = previous?.itemPlacements[itemId]
    itemPlacements[itemId] = previousPlacement && ['expedition', 'recovery', 'settlement'].includes(previousPlacement.custodyKind)
      ? structuredClone(previousPlacement)
      : { ownerKind: 'tombstone', custodyKind: 'tombstone' }
  }

  const persisted: PersistedGameV3 = {
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
    expeditionsById,
    recoveriesById,
    settlementsById,
    serviceJobsById,
    requestRecords: structuredClone(previous?.requestRecords ?? []),
    businessKeys: structuredClone(previous?.businessKeys ?? {}),
    ledger: structuredClone(previous?.ledger ?? [])
  }
  const canonical = stripUndefinedDeep(persisted) as PersistedGameV3
  if (!isPersistedCanonical(canonical)) {
    throw new PersistedGameCorruptError('Public aggregate cannot be represented as canonical PersistedGameV3')
  }
  return canonical
}

function hasLegacyFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  return PERSISTENCE_LEGACY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))
}

export function isPersistedCanonical(document: unknown): document is PersistedGameV3 {
  if (!document || typeof document !== 'object') return false

  const candidate = document as Record<string, unknown>
  if (!hasOnlyKeys(candidate, [
    '_id', 'userId', 'schemaVersion', 'gold', 'materials', 'caravan', 'stashLimit', 'stash',
    'unlockedRegionIds', 'visitRound', 'visitHistory', 'revision', 'createdAt', 'updatedAt',
    'itemsById', 'itemPlacements', 'expeditionsById', 'recoveriesById', 'settlementsById',
    'serviceJobsById', 'requestRecords', 'businessKeys', 'ledger'
  ])) return false

  const stash = (document as { stash?: unknown }).stash
  const itemsById = (document as { itemsById?: Record<string, Item> }).itemsById
  const itemPlacements = (document as { itemPlacements?: Record<string, PersistedItemPlacement> }).itemPlacements
  const containerMaps = {
    expedition: candidate.expeditionsById,
    recovery: candidate.recoveriesById,
    settlement: candidate.settlementsById,
    service: candidate.serviceJobsById
  }

  if (candidate.schemaVersion !== SAVE_SCHEMA_VERSION) return false
  if (!Array.isArray(stash) || !isPlainRecord(itemsById) || !isPlainRecord(itemPlacements)) return false
  if (typeof candidate.userId !== 'string' || !candidate.userId) return false
  if (!Number.isInteger(candidate.gold) || Number(candidate.gold) < 0 || !isResourceMap(candidate.materials)) return false
  if (!Number.isInteger(candidate.stashLimit) || Number(candidate.stashLimit) < 0) return false
  if (!Array.isArray(candidate.unlockedRegionIds) || !candidate.unlockedRegionIds.every((id) => typeof id === 'string' && Boolean(id))) return false
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 0) return false
  if (!Number.isFinite(Date.parse(String(candidate.createdAt))) || !Number.isFinite(Date.parse(String(candidate.updatedAt)))) return false
  if (!Array.isArray(candidate.requestRecords) || !Array.isArray(candidate.ledger)) return false
  if (!candidate.businessKeys || typeof candidate.businessKeys !== 'object' || Array.isArray(candidate.businessKeys)) return false
  if (!Object.values(candidate.businessKeys as Record<string, unknown>).every((requestId) => typeof requestId === 'string' && Boolean(requestId))) return false
  if (!candidate.visitRound || typeof candidate.visitRound !== 'object' || !Array.isArray((candidate.visitRound as { slots?: unknown }).slots)) return false
  if (!Array.isArray(candidate.visitHistory)) return false
  if (!isCaravan(candidate.caravan)) return false
  const caravan = candidate.caravan as Partial<SaveGame['caravan']>
  if (!caravan.services || !Array.isArray(caravan.services.appraiserQueue)) return false
  const allRounds = [candidate.visitRound, ...candidate.visitHistory]
  if (!allRounds.every(isPersistedRound)) return false
  const visitorIds = new Set(allRounds.flatMap((round) => round.slots.flatMap((slot) => slot.visitor?.id ? [slot.visitor.id] : [])))
  if (Object.values(containerMaps).some((value) => !isContainerMap(value))) return false
  if (Object.keys(itemsById).length !== Object.keys(itemPlacements).length) return false

  const seen = new Set<string>()
  const activeReferences = new Set<string>()
  for (const itemId of stash) {
    if (typeof itemId !== 'string' || !itemId) return false
    if (seen.has(itemId)) return false
    seen.add(itemId)

    const item = itemsById[itemId]
    const placement = itemPlacements[itemId]
    if (!item || !placement || placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') return false
  }

  for (const [itemId, placement] of Object.entries(itemPlacements)) {
    if (!isItem(itemsById[itemId]) || !isPlacement(placement)) return false
    if (itemId !== itemsById[itemId]?.id) return false
    const compatible =
      (placement.ownerKind === 'caravan' && ['stash', 'service', 'expedition', 'recovery', 'settlement'].includes(placement.custodyKind))
      || (placement.ownerKind === 'visitor' && placement.custodyKind === 'visitor' && Boolean(placement.ownerId) && placement.ownerId === placement.custodyId && visitorIds.has(placement.ownerId!))
      || (placement.ownerKind === 'tombstone' && placement.custodyKind === 'tombstone')
    if (!compatible) return false
    if (placement.custodyKind === 'stash' && !seen.has(itemId)) return false
    if (placement.custodyKind !== 'stash' && placement.custodyKind !== 'visitor' && placement.custodyKind !== 'tombstone') {
      const container = (containerMaps[placement.custodyKind] as Record<string, PersistedCustodyContainer>)[placement.custodyId ?? '']
      if (!container?.itemIds.includes(itemId)) return false
    }
  }
  for (const [kind, containers] of Object.entries(containerMaps)) {
    for (const container of Object.values(containers as Record<string, PersistedCustodyContainer>)) {
      for (const itemId of container.itemIds) {
        if (activeReferences.has(itemId)) return false
        activeReferences.add(itemId)
        const placement = itemPlacements[itemId]
        if (!placement || placement.custodyKind !== kind || placement.custodyId !== container.id) return false
      }
    }
  }
  if (Object.values(itemPlacements).filter((placement) => placement.ownerKind === 'caravan').length > Number(candidate.stashLimit)) return false

  const rounds = allRounds
  for (const round of rounds) {
    if (!round || !Array.isArray(round.slots)) return false
    for (const slot of round.slots) {
      const visitor = slot.visitor
      if (!visitor) continue
      if (!Array.isArray(visitor.offers) || !Array.isArray(visitor.trades)) return false
      if (visitor.offers.some((offer) => !offer.itemId || !itemsById[offer.itemId] || Object.prototype.hasOwnProperty.call(offer, 'item'))) return false
      for (const offer of visitor.offers.filter((candidate) => !candidate.purchasedAt)) {
        if (activeReferences.has(offer.itemId)) return false
        activeReferences.add(offer.itemId)
        const placement = itemPlacements[offer.itemId]
        if (placement?.ownerKind !== 'visitor' || placement.ownerId !== visitor.id || placement.custodyId !== visitor.id) return false
      }
      if (visitor.commission && Object.prototype.hasOwnProperty.call(visitor.commission, 'rewardItem')) return false
      if (visitor.commission?.rewardItemId) {
        const placement = itemPlacements[visitor.commission.rewardItemId]
        if (!itemsById[visitor.commission.rewardItemId] || placement?.ownerKind !== 'caravan') return false
        if (visitor.commission.status === 'claimed') {
          if (placement.custodyKind !== 'stash') return false
        } else if (placement.custodyKind !== 'settlement' || placement.custodyId !== visitor.commission.id) return false
      }
    }
  }

  const appraiserJobs = new Map(caravan.services.appraiserQueue.map((job) => [job.id, job.itemId]))
  for (const [jobId, itemId] of appraiserJobs) {
    const container = (candidate.serviceJobsById as Record<string, PersistedCustodyContainer>)[jobId]
    const placement = itemPlacements[itemId]
    if (!container || container.itemIds.length !== 1 || container.itemIds[0] !== itemId) return false
    if (placement?.custodyKind !== 'service' || placement.custodyId !== jobId) return false
  }

  const requestIds = new Set<string>()
  for (const record of candidate.requestRecords as PersistedRequestRecord[]) {
    if (!isPlainRecord(record) || !hasOnlyKeys(record, ['requestId', 'operationKey', 'businessKey', 'commandHash', 'response', 'revision', 'createdAt', 'updatedAt'])) return false
    if (typeof record.requestId !== 'string' || requestIds.has(record.requestId)) return false
    if (!record.operationKey || !record.businessKey || typeof record.response !== 'object' || !record.response) return false
    if (!/^[a-f0-9]{64}$/.test(record.commandHash) || !Number.isInteger(record.revision)) return false
    if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) return false
    if (containsInternalFields(record.response)) return false
    requestIds.add(record.requestId)
  }

  const ledgerKeys = new Set<string>()
  let previousLedgerRevision = 0
  for (const entry of candidate.ledger as PersistedLedgerEntry[]) {
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, ['at', 'requestId', 'operationKey', 'commandHash', 'businessKey', 'revision', 'goldDelta', 'materialDeltas', 'itemChanges'])) return false
    if (typeof entry.businessKey !== 'string' || ledgerKeys.has(entry.businessKey)) return false
    if (!entry.requestId || !entry.operationKey || !/^[a-f0-9]{64}$/.test(entry.commandHash)) return false
    if (!Number.isFinite(Date.parse(entry.at)) || !Number.isInteger(entry.revision) || entry.revision < 1) return false
    if (entry.revision <= previousLedgerRevision || entry.revision > Number(candidate.revision)) return false
    if (!Number.isInteger(entry.goldDelta) || !isSignedResourceMap(entry.materialDeltas) || !Array.isArray(entry.itemChanges)
      || !entry.itemChanges.every(isItemChange)) return false
    ledgerKeys.add(entry.businessKey)
    previousLedgerRevision = entry.revision
  }
  for (const [businessKey, requestId] of Object.entries(candidate.businessKeys as Record<string, string>)) {
    const ledgerEntry = (candidate.ledger as PersistedLedgerEntry[]).find((entry) => entry.businessKey === businessKey)
    if (!businessKey || !requestId || !ledgerEntry || ledgerEntry.requestId !== requestId) return false
  }
  return true
}

function isResourceMap(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => Number.isInteger(entry) && Number(entry) >= 0)
}

function isSignedResourceMap(value: unknown): value is Record<string, number> {
  return isPlainRecord(value) && Object.values(value).every((entry) => Number.isInteger(entry))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function isItem(value: unknown): value is Item {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'id', 'baseName', 'displayName', 'type', 'rarity', 'identified', 'width', 'height',
    'requiredLevel', 'affixes', 'value', 'acquisitionCost', 'position'
  ])) return false
  if (!['id', 'baseName', 'displayName'].every((key) => typeof value[key] === 'string' && Boolean(value[key]))) return false
  if (!['weapon', 'armor', 'helmet', 'gloves', 'boots', 'ring', 'amulet', 'charm'].includes(String(value.type))) return false
  if (!['normal', 'magic', 'rare', 'unique'].includes(String(value.rarity)) || typeof value.identified !== 'boolean') return false
  if (!['width', 'height', 'requiredLevel', 'value'].every((key) => Number.isInteger(value[key]) && Number(value[key]) >= 0)) return false
  if (value.acquisitionCost !== undefined && (!Number.isInteger(value.acquisitionCost) || Number(value.acquisitionCost) < 0)) return false
  if (!Array.isArray(value.affixes) || !value.affixes.every((affix) => isPlainRecord(affix)
    && hasOnlyKeys(affix, ['stat', 'value']) && typeof affix.stat === 'string' && Number.isFinite(affix.value))) return false
  return value.position === undefined || (isPlainRecord(value.position) && hasOnlyKeys(value.position, ['x', 'y'])
    && Number.isFinite(value.position.x) && Number.isFinite(value.position.y))
}

function isPlacement(value: unknown): value is PersistedItemPlacement {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['ownerKind', 'ownerId', 'custodyKind', 'custodyId'])) return false
  if (!['caravan', 'visitor', 'tombstone'].includes(String(value.ownerKind))) return false
  if (!['stash', 'visitor', 'service', 'expedition', 'recovery', 'settlement', 'tombstone'].includes(String(value.custodyKind))) return false
  if (value.ownerId !== undefined && (typeof value.ownerId !== 'string' || !value.ownerId)) return false
  if (value.custodyId !== undefined && (typeof value.custodyId !== 'string' || !value.custodyId)) return false
  if (value.ownerKind === 'visitor') return Boolean(value.ownerId) && value.custodyKind === 'visitor' && value.ownerId === value.custodyId
  if (value.ownerKind === 'caravan') return value.ownerId === undefined
    && (value.custodyKind === 'stash' ? value.custodyId === undefined : value.custodyKind !== 'visitor' && value.custodyKind !== 'tombstone' && Boolean(value.custodyId))
  return value.ownerId === undefined && value.custodyKind === 'tombstone'
}

function isCaravan(value: unknown): value is SaveGame['caravan'] {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['level', 'upgrades', 'services'])) return false
  if (!Number.isInteger(value.level) || !isPlainRecord(value.upgrades) || !hasOnlyKeys(value.upgrades, ['stashWagon', 'appraiser'])) return false
  if (!Number.isInteger(value.upgrades.stashWagon) || !Number.isInteger(value.upgrades.appraiser)) return false
  if (!isPlainRecord(value.services) || !hasOnlyKeys(value.services, ['appraiserQueue']) || !Array.isArray(value.services.appraiserQueue)) return false
  return value.services.appraiserQueue.every((job) => isPlainRecord(job)
    && hasOnlyKeys(job, ['id', 'itemId', 'startedAt', 'finishesAt'])
    && ['id', 'itemId', 'startedAt', 'finishesAt'].every((key) => typeof job[key] === 'string' && Boolean(job[key])))
}

function isPersistedRound(value: unknown): value is PersistedVisitRound {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'number', 'slots', 'createdAt'])) return false
  if (typeof value.id !== 'string' || !value.id || !Number.isInteger(value.number) || !Number.isFinite(Date.parse(String(value.createdAt)))) return false
  return Array.isArray(value.slots) && value.slots.every(isPersistedSlot)
}

function isPersistedSlot(value: unknown): value is PersistedVisitorSlot {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'visitor', 'nextArrivalCheckAt']) || typeof value.id !== 'string' || !value.id) return false
  if (value.nextArrivalCheckAt !== undefined && !Number.isFinite(Date.parse(String(value.nextArrivalCheckAt)))) return false
  return value.visitor === undefined || isPersistedVisitor(value.visitor)
}

function isPersistedVisitor(value: unknown): value is PersistedVisitor {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'id', 'name', 'class', 'level', 'origin', 'equipmentSummary', 'state', 'budget', 'initialBudget',
    'acceptedItemTypes', 'interestedItemTypes', 'offers', 'buyQuotes', 'trades', 'power',
    'commissionOptions', 'commission', 'arrivedAt', 'departedAt'
  ])) return false
  if (!['id', 'name', 'origin', 'arrivedAt'].every((key) => typeof value[key] === 'string' && Boolean(value[key]))) return false
  if (!['barbarian', 'sorceress', 'paladin', 'necromancer'].includes(String(value.class))) return false
  if (!['open', 'traded', 'commissioned', 'returned', 'departed'].includes(String(value.state))) return false
  if (!['level', 'budget', 'initialBudget', 'power'].every((key) => Number.isInteger(value[key]) && Number(value[key]) >= 0)) return false
  if (!Array.isArray(value.equipmentSummary) || !value.equipmentSummary.every((entry) => isPlainRecord(entry)
    && hasOnlyKeys(entry, ['itemId', 'name', 'type', 'powerBonus']) && typeof entry.name === 'string'
    && typeof entry.type === 'string' && Number.isFinite(entry.powerBonus))) return false
  if (!Array.isArray(value.acceptedItemTypes) || !value.acceptedItemTypes.every((entry) => typeof entry === 'string')) return false
  if (!Array.isArray(value.interestedItemTypes) || !value.interestedItemTypes.every((entry) => typeof entry === 'string')) return false
  if (!Array.isArray(value.offers) || !value.offers.every(isPersistedOffer)) return false
  if (!isPlainRecord(value.buyQuotes) || !Object.values(value.buyQuotes).every((quote) => Number.isInteger(quote) && Number(quote) >= 0)) return false
  if (!Array.isArray(value.trades) || !value.trades.every((trade) => isPlainRecord(trade)
    && hasOnlyKeys(trade, ['requestId', 'kind', 'itemId', 'price', 'createdAt'])
    && ['requestId', 'itemId', 'createdAt'].every((key) => typeof trade[key] === 'string' && Boolean(trade[key]))
    && ['player_bought', 'player_sold'].includes(String(trade.kind)) && Number.isInteger(trade.price))) return false
  if (!Array.isArray(value.commissionOptions) || !value.commissionOptions.every(isCommissionOption)) return false
  if (value.commission !== undefined && !isPersistedCommission(value.commission)) return false
  return value.departedAt === undefined || Number.isFinite(Date.parse(String(value.departedAt)))
}

function isPersistedOffer(value: unknown): value is PersistedVisitorOffer {
  return isPlainRecord(value) && hasOnlyKeys(value, ['id', 'itemId', 'price', 'purchasedAt'])
    && typeof value.id === 'string' && Boolean(value.id) && typeof value.itemId === 'string' && Boolean(value.itemId)
    && Number.isInteger(value.price) && (value.purchasedAt === undefined || Number.isFinite(Date.parse(String(value.purchasedAt))))
}

function isCommissionOption(value: unknown): value is Visitor['commissionOptions'][number] {
  return isPlainRecord(value) && hasOnlyKeys(value, ['optionId', 'title', 'regionId', 'durationMs', 'successChance', 'fullRewardGold', 'partialRewardGold', 'riskLevel', 'failureConsequence'])
    && ['safe', 'risky'].includes(String(value.optionId)) && ['title', 'regionId', 'failureConsequence'].every((key) => typeof value[key] === 'string' && Boolean(value[key]))
    && ['durationMs', 'successChance', 'fullRewardGold', 'partialRewardGold'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && ['low', 'high'].includes(String(value.riskLevel))
}

function isPersistedCommission(value: unknown): value is PersistedVisitorCommission {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'optionId', 'title', 'regionId', 'durationMs', 'successChance', 'fullRewardGold', 'partialRewardGold',
    'riskLevel', 'failureConsequence', 'id', 'status', 'startedAt', 'finishesAt', 'outcomeRoll',
    'outcome', 'rewardGold', 'rewardItemId', 'claimedAt'
  ])) return false
  if (!isCommissionOption(Object.fromEntries(Object.entries(value).filter(([key]) => [
    'optionId', 'title', 'regionId', 'durationMs', 'successChance', 'fullRewardGold', 'partialRewardGold', 'riskLevel', 'failureConsequence'
  ].includes(key))))) return false
  if (typeof value.id !== 'string' || !value.id || !['active', 'ready', 'claimed'].includes(String(value.status))) return false
  if (!Number.isFinite(Date.parse(String(value.startedAt))) || !Number.isFinite(Date.parse(String(value.finishesAt))) || !Number.isFinite(value.outcomeRoll)) return false
  if (value.outcome !== undefined && !['complete', 'partial', 'failed'].includes(String(value.outcome))) return false
  if (value.rewardGold !== undefined && (!Number.isInteger(value.rewardGold) || Number(value.rewardGold) < 0)) return false
  if (value.rewardItemId !== undefined && (typeof value.rewardItemId !== 'string' || !value.rewardItemId)) return false
  return value.claimedAt === undefined || Number.isFinite(Date.parse(String(value.claimedAt)))
}

function isItemChange(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['itemId', 'from', 'to']) || typeof value.itemId !== 'string' || !value.itemId) return false
  return (value.from === undefined || isPlacement(value.from)) && isPlacement(value.to)
}

function readContainerMap(value: unknown): Record<string, PersistedCustodyContainer> {
  return isContainerMap(value) ? structuredClone(value) : {}
}

function isContainerMap(value: unknown): value is Record<string, PersistedCustodyContainer> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(([id, entry]) => {
    if (!entry || typeof entry !== 'object') return false
    if (!hasOnlyKeys(entry as Record<string, unknown>, ['id', 'itemIds'])) return false
    const container = entry as PersistedCustodyContainer
    return container.id === id && Array.isArray(container.itemIds)
      && new Set(container.itemIds).size === container.itemIds.length
      && container.itemIds.every((itemId) => typeof itemId === 'string' && Boolean(itemId))
  })
}

function containsInternalFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const keys = new Set(Object.keys(value as object))
  if (['_id', 'userId', 'requestRecords', 'businessKeys', 'ledger', 'itemsById', 'itemPlacements', 'expeditionsById', 'recoveriesById', 'settlementsById', 'serviceJobsById', 'processedRequestIds', 'processedRequests', 'outcomeRoll']
    .some((key) => keys.has(key))) return true
  return Object.values(value as Record<string, unknown>).some(containsInternalFields)
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

function resourceDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)] as const)
    .filter(([, delta]) => delta !== 0))
}

function hashCommand(operationKey: string, command: unknown): string {
  const payload = canonicalize({ operationKey, command: commandPayload(command) })
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')
}

function isRepeatableOperation(operationKey: string): boolean {
  try {
    const [operation] = JSON.parse(operationKey) as unknown[]
    return operation === 'reset' || operation === 'appraise-complete' || operation === 'upgrade'
  } catch {
    return false
  }
}

function commandPayload(command: unknown): unknown {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return command
  const { requestId: _requestId, expectedRevision: _expectedRevision, ...payload } = command as Record<string, unknown>
  return payload
}

export type PublicSaveGame = Omit<SaveGame, '_id' | 'userId' | 'processedRequestIds' | 'processedRequests'>

export function sanitizeGameResponse(save: SaveGame): SaveGame {
  return stripPrivateFields(save) as SaveGame
}

function stripPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateFields)
  if (value && typeof value === 'object') {
    const privateKeys = new Set(['_id', 'userId', 'requestRecords', 'businessKeys', 'ledger', 'itemsById', 'itemPlacements', 'processedRequestIds', 'processedRequests', 'outcomeRoll'])
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => entry !== undefined && !privateKeys.has(key))
      .map(([key, entry]) => [key, stripPrivateFields(entry)]))
  }
  return value
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)]))
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
