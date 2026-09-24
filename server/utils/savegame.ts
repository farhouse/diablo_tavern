import type { Filter } from 'mongodb'
import { createHash, randomUUID } from 'node:crypto'
import type { Item, SaveGame, VisitRound, Visitor, VisitorCommission, VisitorOffer, VisitorSlot } from '~/types/game'
import { createSaveGame, LEGACY_SAVE_FIELDS, normalizeSaveGame, SAVE_SCHEMA_VERSION } from '~/utils/game-logic'
import { applyItemTransition, type ItemTransitionCommand } from '~/server/domain/item-transitions'
import { applyEquipmentV2Command, authorizeEquipmentV2Command, getEnchanterOption, type EquipmentV2Command } from '~/server/domain/equipment-v2'
import { generateLootForZone, lootTableIdForZone, LOOT_CONFIG_VERSION } from '~/server/domain/loot-v2'
import { UncertainOperationError } from '~/server/domain/v2-errors'
import { type DbSaveGame, saveGamesCollection } from '~/server/utils/db'
import type { CommandSuccess } from '~/shared/types/v2-api-error'
import type { GameView } from '~/shared/types/v2-game-view'
import { validateGameView } from '~/server/utils/game-view-validator'
import {
  applyVisitorCycleCommand,
  createVisitorCycle,
  isVisitorCycle,
  type PersistedVisitorCycle,
  type VisitorCycleCommand
} from '~/server/domain/visitor-cycle'
import { CARAVAN_V2_MAX_OUTBOX, CARAVAN_V2_UPGRADES, appendChronicleEvent, createCaravanV2, eventIdFor, isChronicleEventDataValid, reconcileCaravanMaintenance, resolveCaravanUpgradeOption, settlementReservationKey, type PersistedCaravanV2, type PersistedChronicleOutboxEvent } from '~/server/domain/caravan-v2'
import { V2DomainRuleError } from '~/shared/errors/v2-domain'

const REQUEST_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_REQUEST_RECORDS = 100
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
  response: PublicSaveGame | CommandSuccess
  persistedResponse?: PersistedGameV3
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
  projection?:
    | {
        kind: 'expedition'
        visitorId: string
        contractId: string
        startsAt: string
        retainedVisitor?: { name: string; departedAt: string }
      }
    | { kind: 'settlement'; expeditionId: string; outcome: 'returned' | 'retreated' | 'death'; appliedAt: string }
    | { kind: 'recovery'; sourceExpeditionId: string; resolvedAt: string }
    | { kind: 'service'; service: 'blacksmith' | 'enchanter'; queuedAt: string; startsAt: string }
    | { kind: 'legacy_appraiser' }
}

export interface PersistedItemV2State {
  sealedAffixes?: Item['affixes']
  blacksmithLevel?: number
  enchantCount?: number
  activeImprint?: { imprintId: string; label: string; grantedAt: string }
  pendingImprint?: { imprintId: string; label: string; grantedAt: string }
  imprintHistory?: Array<{ imprintId: string; label: string; grantedAt: string; replacedAt?: string }>
  provenance?: { zoneId: string; lootTableId?: string; configVersion?: string; businessKey?: string; combinationId?: string; imperfectPieceId?: string; droppedAt: string }
}

export interface PersistedServiceJobState {
  status: 'queued' | 'active' | 'completed' | 'failed' | 'cancelled'
  service: 'blacksmith' | 'enchanter'
  itemId: string
  queuedAt: string
  startedAt: string
  completesAt: string
  completedAt?: string
  failedAt?: string
  cancelledAt?: string
  result: {
    blacksmithLevel?: number
    enchantCount?: number
    affix?: Item['affixes'][number]
  }
}

type PersistedVisitorOffer = Omit<VisitorOffer, 'item'> & { itemId: string }
export type PersistedVisitorCommission = Omit<VisitorCommission, 'rewardItem'> & { rewardItemId?: string }
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
  itemV2ById: Record<string, PersistedItemV2State>
  serviceJobStateById: Record<string, PersistedServiceJobState>
  requestRecords: PersistedRequestRecord[]
  businessKeys: Record<string, string>
  ledger: PersistedLedgerEntry[]
  visitorCycle: PersistedVisitorCycle
  caravanV2: PersistedCaravanV2
  chronicleOutbox: PersistedChronicleOutboxEvent[]
}

export function createPersistedGameV3(userId: string, dependencies = defaultDependencies): PersistedGameV3 {
  return buildPersistedFromPublic(createSaveGame(userId, dependencies.now(), dependencies.random), undefined, dependencies, true)
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
      const backfilled = !hasLegacyFields(existing) ? backfillPersistedV3(existing, dependencies.now()) : undefined
      if (!backfilled || !isPersistedCanonical(backfilled)) {
        throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
      }
      const result = await saves.replaceOne(
        { userId, revision: existing.revision } as Filter<DbSaveGame>,
        backfilled as unknown as DbSaveGame
      )
      if (result.modifiedCount === 1) return backfilled
      continue
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
  return toGameView(hydratePersistedGame(await getPersistedGameV3(userId, dependencies)))
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
      const backfilled = !hasLegacyFields(currentDocument) ? backfillPersistedV3(currentDocument, dependencies.now()) : undefined
      if (!backfilled || !isPersistedCanonical(backfilled)) {
        throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
      }
      await saves.replaceOne(
        { userId, revision: currentDocument.revision } as Filter<DbSaveGame>,
        backfilled as unknown as DbSaveGame
      )
      continue
    }

    const persisted = toPersistedGame(currentDocument)
    const existingReplay = persisted.requestRecords.find((record) => record.requestId === requestId)

    if (existingReplay) {
      if (existingReplay.commandHash !== requestHash) {
        throw new IdempotencyConflictError('requestId was already used for a different command')
      }
      return existingReplay.response as unknown as SaveGame
    }
    if (persisted.ledger.some((entry) => entry.requestId === requestId)) {
      throw new IdempotencyConflictError('requestId was already committed and its replay record is unavailable')
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

    const requestRecords = appendRequestRecord(persisted.requestRecords, now, {
      requestId,
      operationKey,
      businessKey,
      commandHash: requestHash,
      response: sanitizeGameResponse(hydratePersistedGame(next)),
      revision: nextRevision,
      createdAt: now,
      updatedAt: now
    })

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
      let afterError: PersistedDbDocument | null = null
      try {
        afterError = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null
      } catch {
        // The write outcome stays uncertain when the verification read also fails.
      }
      if (afterError && isPersistedCanonical(afterError)) {
        const replay = afterError.requestRecords.find((record) => record.requestId === requestId)
        if (replay?.commandHash === requestHash) return replay.response as unknown as SaveGame
      }
      throw new UncertainOperationError(requestId, { cause: error })
    }
    if (replaceResult.modifiedCount === 1) {
      return sanitizeGameResponse(hydratePersistedGame(nextPersisted))
    }

    // Reload after a lost CAS. The next iteration can only return an exact
    // replay; any other winner makes expectedRevision stale.
  }

  throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
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

export class InvalidMutationRequestError extends Error {
  override name = 'InvalidMutationRequestError'
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
    if (isPublicSaveGame(replay.response)) return replay.response
    throw new IdempotencyConflictError('requestId belongs to another API operation')
  }
  if (current.ledger.some((entry) => entry.requestId === requestId)) {
    throw new IdempotencyConflictError('requestId was already committed and its replay record is unavailable')
  }
  if (current.businessKeys[businessKey]) throw new BusinessKeyConflictError('item transition was already committed')
  if (current.revision !== expectedRevision) throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')

  const { game: transitioned } = applyItemTransition(current, command)
  pruneEmptyOrphanedLifecycle(
    transitioned.expeditionsById,
    transitioned.settlementsById,
    transitioned.recoveriesById,
    transitioned.visitRound,
    transitioned.visitHistory
  )
  const now = dependencies.now().toISOString()
  transitioned.revision = expectedRevision + 1
  transitioned.updatedAt = now
  const response = sanitizeGameResponse(hydratePersistedGame(transitioned))
  transitioned.requestRecords = appendRequestRecord(current.requestRecords, now, {
    requestId, operationKey, businessKey, commandHash, response,
    revision: transitioned.revision, createdAt: now, updatedAt: now
  })
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
    let afterError: PersistedDbDocument | null = null
    try {
      afterError = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null
    } catch {
      // The write outcome stays uncertain when the verification read also fails.
    }
    if (afterError && isPersistedCanonical(afterError)) {
      const exactReplay = afterError.requestRecords.find((record) => record.requestId === requestId)
      if (exactReplay?.commandHash === commandHash && isPublicSaveGame(exactReplay.response)) return exactReplay.response
    }
    throw new UncertainOperationError(requestId, { cause: error })
  }
  if (result.modifiedCount === 1) return response
  const winner = await getPersistedGameV3(userId, dependencies)
  const winnerReplay = winner.requestRecords.find((record) => record.requestId === requestId)
  if (winnerReplay?.commandHash === commandHash && isPublicSaveGame(winnerReplay.response)) return winnerReplay.response
  throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
}

export async function mutateVisitorCycleAtomic(
  userId: string,
  requestId: string,
  expectedRevision: number,
  command: VisitorCycleCommand,
  businessKey: string,
  project: (game: PersistedGameV3, now: Date) => GameView,
  dependencies = defaultDependencies
): Promise<CommandSuccess> {
  if (!requestId || requestId.length > 128) throw new Error('A valid requestId is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision must be a non-negative integer')
  if (!businessKey || businessKey.length > 128) throw new Error('A valid businessKey is required')
  const operationKey = JSON.stringify(['v2', command.action])
  const commandHash = hashCommand(operationKey, command)
  const saves = await saveGamesCollection()

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const current = await getPersistedGameV3(userId, dependencies)
    const replay = current.requestRecords.find((record) => record.requestId === requestId)
    if (replay) {
      if (replay.commandHash !== commandHash) throw new IdempotencyConflictError('requestId was already used for a different command')
      if (isReplayResponse(replay.response) && 'game' in replay.response) return structuredClone(replay.response)
      throw new IdempotencyConflictError('requestId belongs to another API operation')
    }
    if (current.ledger.some((entry) => entry.requestId === requestId)) {
      throw new IdempotencyConflictError('requestId was already committed and its replay record is unavailable')
    }
    if (current.businessKeys[businessKey]) throw new BusinessKeyConflictError('business operation was already committed')
    if (current.revision !== expectedRevision) throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')

    const now = dependencies.now()
    const scopedDependencies = { ...dependencies, now: () => now }
    const next = applyVisitorCycleCommand(current, command, scopedDependencies)
    if (command.action === 'reconcile_game') reconcileCaravanMaintenance(next, now)
    next.revision = expectedRevision + 1
    next.updatedAt = now.toISOString()
    const response: CommandSuccess = {
      requestId,
      revision: next.revision,
      game: project(next, now)
    }
    next.requestRecords = appendRequestRecord(current.requestRecords, next.updatedAt, {
      requestId, operationKey, businessKey, commandHash, response, revision: next.revision,
      createdAt: next.updatedAt, updatedAt: next.updatedAt
    })
    next.businessKeys = { ...current.businessKeys, ...(command.action === 'reconcile_game' ? next.businessKeys : {}), [businessKey]: requestId }
    next.ledger = [...current.ledger, {
      at: next.updatedAt, requestId, operationKey, commandHash, businessKey, revision: next.revision,
      goldDelta: next.gold - current.gold,
      materialDeltas: resourceDeltas(current.materials, next.materials),
      itemChanges: itemPlacementChanges(current, next)
    }]
    if (current.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX || current.chronicleOutbox.length + countCycleChronicleEvents(current, next, now, businessKey) > CARAVAN_V2_MAX_OUTBOX) {
      await projectChronicleOutboxBestEffort(userId)
      const drained = await getPersistedGameV3(userId, dependencies)
      if (drained.chronicleOutbox.length + countCycleChronicleEvents(drained, next, now, businessKey) > CARAVAN_V2_MAX_OUTBOX || drained.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX) throw new V2DomainRuleError('Chronicle outbox is full', 'SERVICE_LOCKED')
      continue
    }
    appendCycleChronicleEvents(current, next, now, businessKey)
    if (!isPersistedCanonical(next)) throw new PersistedGameCorruptError('Visitor cycle produced an invalid aggregate')

    try {
      const result = await saves.replaceOne(
        { userId, revision: expectedRevision } as Filter<DbSaveGame>,
        next as unknown as DbSaveGame
      )
      if (result.modifiedCount === 1) {
        await projectChronicleOutboxBestEffort(userId)
        return response
      }
    } catch (error) {
      let winner: PersistedGameV3 | undefined
      try { winner = await getPersistedGameV3(userId, dependencies) } catch { /* uncertain */ }
      const exact = winner?.requestRecords.find((record) => record.requestId === requestId)
      if (exact?.commandHash === commandHash && isReplayResponse(exact.response) && 'game' in exact.response) {
        return structuredClone(exact.response)
      }
      throw new UncertainOperationError(requestId, { cause: error })
    }

    const winner = await getPersistedGameV3(userId, dependencies)
    const exact = winner.requestRecords.find((record) => record.requestId === requestId)
    if (exact?.commandHash === commandHash && isReplayResponse(exact.response) && 'game' in exact.response) {
      return structuredClone(exact.response)
    }
  }
  throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
}

function appendCycleChronicleEvents(previous: PersistedGameV3, next: PersistedGameV3, now: Date, mutationBusinessKey = ''): void {
  for (const [visitorId, visitor] of Object.entries(next.visitorCycle.visitors)) {
    if (!previous.visitorCycle.visitors[visitorId]) appendChronicleEvent(next, { eventKey: `visitor:${visitorId}:arrived`, type: 'visitor_arrived', occurredAt: now.toISOString(), subject: { kind: 'visitor', id: visitorId }, data: {} })
    const old = previous.visitorCycle.visitors[visitorId]
    if (old?.state !== 'dead' && visitor.state === 'dead') appendChronicleEvent(next, { eventKey: `visitor:${visitorId}:died`, type: 'visitor_died', occurredAt: now.toISOString(), subject: { kind: 'visitor', id: visitorId }, data: {} })
    if (old?.state !== 'departed' && visitor.state === 'departed') appendChronicleEvent(next, { eventKey: `visitor:${visitorId}:departed`, type: 'visitor_departed', occurredAt: now.toISOString(), subject: { kind: 'visitor', id: visitorId }, data: {} })
  }
  for (const [expeditionId, expedition] of Object.entries(next.visitorCycle.expeditions)) {
    const old = previous.visitorCycle.expeditions[expeditionId]
    if (old?.state !== 'active' && expedition.state === 'active') appendChronicleEvent(next, { eventKey: `expedition:${expeditionId}:started`, type: 'expedition_started', occurredAt: expedition.startedAt ?? now.toISOString(), subject: { kind: 'expedition', id: expeditionId }, data: {} })
    if (old?.state !== 'awaiting_settlement' && expedition.state === 'awaiting_settlement') appendChronicleEvent(next, { eventKey: `expedition:${expeditionId}:resolved`, type: 'expedition_resolved', occurredAt: expedition.resolvedAt ?? now.toISOString(), subject: { kind: 'expedition', id: expeditionId }, data: { outcome: expedition.outcome ?? 'returned' } })
  }
  for (const [itemId, placement] of Object.entries(next.itemPlacements)) {
    const previousPlacement = previous.itemPlacements[itemId]
    if (!previousPlacement) {
      const provenance = next.itemV2ById[itemId]?.provenance
      appendChronicleEvent(next, { eventKey: `item:${itemId}:found:${provenance?.businessKey ?? 'initial'}`, type: 'item_found', occurredAt: now.toISOString(), subject: { kind: 'item', id: itemId }, data: provenance ? { zoneId: provenance.zoneId, ...(provenance.lootTableId ? { lootTableId: provenance.lootTableId } : {}) } : {} })
    }
    else if (JSON.stringify(previousPlacement) !== JSON.stringify(placement)) appendChronicleEvent(next, { eventKey: `item:${itemId}:custody:${mutationBusinessKey}`, type: 'item_custody_changed', occurredAt: now.toISOString(), subject: { kind: 'item', id: itemId }, data: { custodyKind: placement.custodyKind } })
  }
}

function countCycleChronicleEvents(previous: PersistedGameV3, next: PersistedGameV3, now: Date, mutationBusinessKey: string): number {
  const candidate = structuredClone(next)
  candidate.chronicleOutbox = []
  appendCycleChronicleEvents(previous, candidate, now, mutationBusinessKey)
  const existing = new Set(previous.chronicleOutbox.map((event) => event.eventId))
  return candidate.chronicleOutbox.filter((event) => !existing.has(event.eventId)).length
}

async function projectChronicleOutboxBestEffort(userId: string): Promise<void> {
  try { await (await import('~/server/domain/chronicle')).projectChronicleOutbox(userId) } catch { /* repair is retried by GET/reconcile */ }
}

export async function mutateEquipmentV2Atomic(
  userId: string,
  requestId: string,
  expectedRevision: number,
  command: EquipmentV2Command,
  dependencies = defaultDependencies
): Promise<PersistedGameV3> {
  if (!requestId || requestId.length > 128) throw new InvalidMutationRequestError('A valid requestId is required')
  const saves = await saveGamesCollection()
  const operationKey = JSON.stringify(['equipment-v2', command.action, command.itemId ?? command.jobId ?? '', command.optionId ?? ''])
  const businessKey = operationKey
  const commandHash = hashCommand(operationKey, command)

  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const currentDocument = await saves.findOne({ userId } as Filter<DbSaveGame>) as PersistedDbDocument | null
    if (!currentDocument) {
      await getPersistedGameV3(userId, dependencies)
      continue
    }
    if (currentDocument.schemaVersion === SAVE_SCHEMA_VERSION && (hasLegacyFields(currentDocument) || !isPersistedCanonical(currentDocument))) {
      const backfilled = !hasLegacyFields(currentDocument) ? backfillPersistedV3(currentDocument, dependencies.now()) : undefined
      if (!backfilled || !isPersistedCanonical(backfilled)) throw new PersistedGameCorruptError('Persisted V3 structure is invalid')
      await saves.replaceOne({ userId, revision: currentDocument.revision } as Filter<DbSaveGame>, backfilled as unknown as DbSaveGame)
      continue
    }

    const current = toPersistedGame(currentDocument)
    const replay = current.requestRecords.find((record) => record.requestId === requestId)
    if (replay) {
      if (replay.commandHash !== commandHash) throw new IdempotencyConflictError('requestId was already used for a different command')
      if (replay.persistedResponse) return replay.persistedResponse
      return current
    }
    if (current.ledger.some((entry) => entry.requestId === requestId)) {
      throw new IdempotencyConflictError('requestId was already committed and its replay record is unavailable')
    }
    if (current.businessKeys[businessKey]) {
      if (command.action === 'complete_service_job' && command.jobId && current.serviceJobStateById[command.jobId]?.status === 'completed') return current
      throw new BusinessKeyConflictError('equipment command was already committed')
    }
    if (current.revision !== expectedRevision) throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')

    authorizeEquipmentV2Command(current, command, dependencies)
    const transitioned = applyEquipmentV2Command(current, command, dependencies)
    pruneEmptyOrphanedLifecycle(
      transitioned.expeditionsById,
      transitioned.settlementsById,
      transitioned.recoveriesById,
      transitioned.visitRound,
      transitioned.visitHistory
    )
    const now = dependencies.now().toISOString()
    transitioned.revision = expectedRevision + 1
    transitioned.updatedAt = now
    if (current.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX || current.chronicleOutbox.length + countCycleChronicleEvents(current, transitioned, dependencies.now(), businessKey) > CARAVAN_V2_MAX_OUTBOX) {
      await projectChronicleOutboxBestEffort(userId)
      const drained = await getPersistedGameV3(userId, dependencies)
      if (drained.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX || drained.chronicleOutbox.length + countCycleChronicleEvents(drained, transitioned, dependencies.now(), businessKey) > CARAVAN_V2_MAX_OUTBOX) throw new V2DomainRuleError('Chronicle outbox is full', 'SERVICE_LOCKED')
      continue
    }
    appendCycleChronicleEvents(current, transitioned, dependencies.now(), businessKey)
    const response = sanitizeGameResponse(hydratePersistedGame(transitioned))
    const persistedResponse = createReplaySnapshot(transitioned)
    transitioned.requestRecords = appendRequestRecord(current.requestRecords, now, {
      requestId, operationKey, businessKey, commandHash, response, persistedResponse,
      revision: transitioned.revision, createdAt: now, updatedAt: now
    })
    transitioned.businessKeys = { ...current.businessKeys, [businessKey]: requestId }
    transitioned.ledger = [...current.ledger, {
      at: now, requestId, operationKey, commandHash, businessKey,
      revision: transitioned.revision,
      goldDelta: transitioned.gold - current.gold,
      materialDeltas: resourceDeltas(current.materials, transitioned.materials),
      itemChanges: itemPlacementChanges(current, transitioned)
    }]
    if (!isPersistedCanonical(transitioned)) throw new PersistedGameCorruptError('Equipment mutation produced an invalid aggregate')

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
        if (exactReplay?.commandHash === commandHash) return exactReplay.persistedResponse ?? toPersistedGame(afterError)
      }
      throw error
    }
    if (result.modifiedCount === 1) {
      await projectChronicleOutboxBestEffort(userId)
      return transitioned
    }
    const winner = await getPersistedGameV3(userId, dependencies)
    const winnerReplay = winner.requestRecords.find((record) => record.requestId === requestId)
    if (winnerReplay?.commandHash === commandHash) return winnerReplay.persistedResponse ?? winner
    throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
  }

  throw new Error('Save changed concurrently; retry with the same requestId')
}

export async function reconcilePersistedGameV3(
  userId: string,
  dependencies = defaultDependencies
): Promise<PersistedGameV3> {
  await projectChronicleOutboxBestEffort(userId)
  let conflicts = 0
  while (conflicts < MAX_MUTATE_ATTEMPTS) {
    const current = await getPersistedGameV3(userId, dependencies)
    const due = Object.entries(current.serviceJobStateById)
      .find(([, state]) => state.status === 'active' && Date.parse(state.completesAt) <= dependencies.now().getTime())
    if (!due) {
      await projectChronicleOutboxBestEffort(userId)
      return await getPersistedGameV3(userId, dependencies)
    }
    const [jobId, state] = due
    try {
      await mutateEquipmentV2Atomic(
        userId,
        `complete-service:${jobId}:${state.completesAt}`,
        current.revision,
        { action: 'complete_service_job', jobId },
        dependencies
      )
      conflicts = 0
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      conflicts += 1
    }
  }
  throw new Error('Save changed concurrently; retry reconciliation')
}

export async function mutateCaravanUpgradeAtomic(
  userId: string,
  requestId: string,
  expectedRevision: number,
  optionId: string,
  project: (game: PersistedGameV3, now: Date) => GameView,
  dependencies = defaultDependencies
): Promise<CommandSuccess> {
  const saves = await saveGamesCollection()
  const operationKey = 'upgrade_caravan'
  const command = { operationKey, optionId }
  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const commandHash = hashCommand(operationKey, command)
    const current = await getPersistedGameV3(userId, dependencies)
    const replay = current.requestRecords.find((record) => record.requestId === requestId)
    if (replay) {
      if (replay.commandHash !== commandHash) throw new IdempotencyConflictError('requestId was already used for a different command')
      if (isReplayResponse(replay.response) && 'game' in replay.response) return structuredClone(replay.response)
      throw new IdempotencyConflictError('requestId belongs to another API operation')
    }
    const option = resolveCaravanUpgradeOption(current, optionId, dependencies.now())
    if (!option) throw new V2DomainRuleError('Caravan upgrade option is stale', 'OPTION_STALE')
    const { upgradeId, targetLevel } = option
    const resolvedBusinessKey = `caravan-upgrade:${upgradeId}:${targetLevel}`
    if (current.businessKeys[resolvedBusinessKey]) throw new BusinessKeyConflictError('business operation was already committed')
    if (current.revision !== expectedRevision) throw new RevisionConflictError('Save changed concurrently; reload and retry with current revision')
    if (current.caravanV2.maintenance.debts.length) throw new V2DomainRuleError('Maintenance debt blocks caravan upgrades', 'MAINTENANCE_DEBT')
    if (current.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX) {
      await projectChronicleOutboxBestEffort(userId)
      const drained = await getPersistedGameV3(userId, dependencies)
      if (drained.chronicleOutbox.length >= CARAVAN_V2_MAX_OUTBOX) throw new V2DomainRuleError('Chronicle outbox is full', 'SERVICE_LOCKED')
      continue
    }
    const level = current.caravanV2.upgrades[upgradeId]
    const cost = CARAVAN_V2_UPGRADES[upgradeId].costs[level]
    if (!cost) throw new V2DomainRuleError('Caravan upgrade option is stale', 'OPTION_STALE')
    if (current.gold < cost.gold || (current.materials.scrap ?? 0) < cost.scrap) throw new V2DomainRuleError('Insufficient resources for caravan upgrade')
    const next = structuredClone(current)
    const now = dependencies.now().toISOString()
    next.gold -= cost.gold
    next.materials.scrap = (next.materials.scrap ?? 0) - cost.scrap
    next.caravanV2.upgrades[upgradeId] = targetLevel
    if (upgradeId !== 'visitor_quarters') next.caravanV2.serviceUnlockedAt[upgradeId] ??= now
    next.revision += 1
    next.updatedAt = now
    const response: CommandSuccess = { requestId, revision: next.revision, game: project(next, new Date(now)) }
    next.requestRecords = appendRequestRecord(current.requestRecords, now, { requestId, operationKey, businessKey: resolvedBusinessKey, commandHash, response, revision: next.revision, createdAt: now, updatedAt: now })
    next.businessKeys = { ...current.businessKeys, [resolvedBusinessKey]: requestId }
    next.ledger = [...current.ledger, { at: now, requestId, operationKey, commandHash, businessKey: resolvedBusinessKey, revision: next.revision, goldDelta: next.gold - current.gold, materialDeltas: resourceDeltas(current.materials, next.materials), itemChanges: [] }]
    if (!isPersistedCanonical(next)) throw new PersistedGameCorruptError('Caravan upgrade produced an invalid aggregate')
    try {
      const result = await saves.replaceOne({ userId, revision: expectedRevision } as Filter<DbSaveGame>, next as unknown as DbSaveGame)
      if (result.modifiedCount === 1) {
        await projectChronicleOutboxBestEffort(userId)
        return response
      }
    } catch (error) {
      const winner = await getPersistedGameV3(userId, dependencies).catch(() => undefined)
      const exact = winner?.requestRecords.find((record) => record.requestId === requestId)
      if (exact?.commandHash === commandHash && isReplayResponse(exact.response) && 'game' in exact.response) return structuredClone(exact.response)
      throw new UncertainOperationError(requestId, { cause: error })
    }
  }
  throw new RevisionConflictError('Save changed concurrently; retry with the same requestId')
}


function createReplaySnapshot(game: PersistedGameV3): PersistedGameV3 {
  return {
    ...structuredClone(game),
    requestRecords: [],
    businessKeys: {},
    ledger: []
  }
}

function pruneRequestRecords(records: PersistedRequestRecord[], now: string, maxRecords: number): PersistedRequestRecord[] {
  const cutoff = Date.parse(now) - REQUEST_RECORD_RETENTION_MS
  return records
    .filter((entry) => Date.parse(entry.createdAt) >= cutoff)
    .slice(-maxRecords)
}

function appendRequestRecord(
  records: PersistedRequestRecord[],
  now: string,
  record: PersistedRequestRecord
): PersistedRequestRecord[] {
  return [...pruneRequestRecords(records, now, MAX_REQUEST_RECORDS - 1), record]
}

function toPersistedGame(document: PersistedDbDocument): PersistedGameV3 {
  const persisted = {
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
    itemV2ById: readItemV2Map((document as { itemV2ById?: unknown }).itemV2ById),
    serviceJobStateById: readServiceJobStateMap((document as { serviceJobStateById?: unknown }).serviceJobStateById),
    requestRecords: Array.isArray((document as { requestRecords?: unknown }).requestRecords)
      ? [...((document as { requestRecords: PersistedRequestRecord[] }).requestRecords)]
      : [],
    businessKeys: (document as { businessKeys?: Record<string, string> }).businessKeys || {},
    ledger: Array.isArray((document as { ledger?: unknown }).ledger)
      ? [...((document as { ledger: PersistedLedgerEntry[] }).ledger)]
      : [],
    visitorCycle: (document as { visitorCycle?: PersistedVisitorCycle }).visitorCycle,
    caravanV2: (document as { caravanV2?: PersistedCaravanV2 }).caravanV2,
    chronicleOutbox: (document as { chronicleOutbox?: PersistedChronicleOutboxEvent[] }).chronicleOutbox
  } as Omit<PersistedGameV3, 'visitorCycle' | 'caravanV2' | 'chronicleOutbox'> & { visitorCycle?: PersistedVisitorCycle; caravanV2?: PersistedCaravanV2; chronicleOutbox?: PersistedChronicleOutboxEvent[] }
  return {
    ...persisted,
    visitorCycle: isVisitorCycle(persisted.visitorCycle)
      ? structuredClone(persisted.visitorCycle)
      : persisted.visitRound && Array.isArray(persisted.visitRound.slots)
        ? createVisitorCycle(persisted as PersistedGameV3)
        : { visitors: {}, contracts: {}, expeditions: {}, settlements: {}, recoveries: {} },
    caravanV2: persisted.caravanV2 ?? createCaravanV2(new Date(persisted.createdAt), true),
    chronicleOutbox: Array.isArray(persisted.chronicleOutbox) ? persisted.chronicleOutbox : []
  }
}

function upgradePersistedGame(document: PersistedDbDocument): PersistedGameV3 | undefined {
  const retained = backfillRetainedVisitorIdentity(document)
  const source = retained ?? document
  if (retained || !Object.prototype.hasOwnProperty.call(document, 'visitorCycle')) {
    return toPersistedGame(source as unknown as PersistedDbDocument)
  }
  return undefined
}

function backfillRetainedVisitorIdentity(document: PersistedDbDocument): PersistedGameV3 | undefined {
  if (!isPersistedCanonical(document, { allowMissingRetainedVisitor: true })) return undefined
  const source = toPersistedGame(document)
  const candidate = structuredClone(document) as unknown as PersistedGameV3
  delete (candidate as PersistedGameV3 & { _id?: unknown })._id
  const candidateRounds: unknown[] = [source.visitRound, ...(Array.isArray(source.visitHistory) ? source.visitHistory : [])]
  const currentVisitors = candidateRounds.filter(isPersistedRound)
    .flatMap((round) => round?.slots?.flatMap((slot) => slot.visitor ? [slot.visitor] : []) ?? [])
  const currentVisitorIds = new Set(currentVisitors.map((visitor) => visitor.id))
  const replayRecords = Array.isArray(document.requestRecords) ? [...document.requestRecords].reverse() : []
  const replayVisitors = replayRecords.flatMap((record) => {
    if (!isPlainRecord(record) || !isPublicSaveGame(record.response)) return []
    const response = record.response as PublicSaveGame
    return [response.visitRound, ...(response.visitHistory ?? [])]
      .flatMap((round) => round?.slots?.flatMap((slot) => slot.visitor ? [slot.visitor] : []) ?? [])
  })
  let changed = false

  for (const expedition of Object.values(candidate.expeditionsById)) {
    const projection = expedition.projection
    if (projection?.kind !== 'expedition' || projection.retainedVisitor || currentVisitorIds.has(projection.visitorId)) continue
    const historical = replayVisitors.find((visitor) => visitor.id === projection.visitorId
      && visitor.commission?.id === projection.contractId
      && typeof visitor.departedAt === 'string')
    if (!historical?.departedAt) return undefined
    projection.retainedVisitor = { name: historical.name, departedAt: historical.departedAt }
    changed = true
  }

  return changed && isPersistedCanonical(candidate) ? candidate : undefined
}

function backfillPersistedV3(document: PersistedDbDocument, now = new Date()): PersistedGameV3 | undefined {
  const missingItemV2Map = !Object.prototype.hasOwnProperty.call(document, 'itemV2ById')
  const missingServiceJobStateMap = !Object.prototype.hasOwnProperty.call(document, 'serviceJobStateById')
  const missingVisitorCycle = !Object.prototype.hasOwnProperty.call(document, 'visitorCycle')
  const missingV2Maps = missingItemV2Map || missingServiceJobStateMap
  const itemV2Map = (document as { itemV2ById?: unknown }).itemV2ById
  const serviceJobStateMap = (document as { serviceJobStateById?: unknown }).serviceJobStateById
  if ((!missingItemV2Map && !isItemV2Map(itemV2Map))
    || (!missingServiceJobStateMap && !isServiceJobStateMap(serviceJobStateMap))) return undefined
  if (Object.prototype.hasOwnProperty.call(document, 'visitorCycle') && !isVisitorCycle(document.visitorCycle)) return undefined
  if (Object.prototype.hasOwnProperty.call(document, 'caravanV2') && !isPersistedCaravanV2(document.caravanV2)) return undefined
  if (Object.prototype.hasOwnProperty.call(document, 'chronicleOutbox')
    && (!Array.isArray(document.chronicleOutbox)
      || !document.chronicleOutbox.every((event) => isPersistedChronicleOutboxEvent(event, document.userId)))) return undefined
  if (missingV2Maps) {
    const original = structuredClone(document) as PersistedGameV3
    if (Object.prototype.hasOwnProperty.call(document, '_id')) {
      const originalWithId = original as PersistedGameV3 & { _id?: unknown }
      delete originalWithId._id
    }
    if (missingItemV2Map) original.itemV2ById = {}
    if (missingServiceJobStateMap) original.serviceJobStateById = {}
    if (missingVisitorCycle) {
      if (!isPersistedRound(original.visitRound)
        || !Array.isArray(original.visitHistory)
        || !original.visitHistory.every(isPersistedRound)) return undefined
      original.visitorCycle = createVisitorCycle(original)
    }
    const originalWithV2 = original as PersistedGameV3 & { caravanV2?: PersistedCaravanV2; chronicleOutbox?: PersistedChronicleOutboxEvent[] }
    if (!Object.prototype.hasOwnProperty.call(originalWithV2, 'caravanV2')) originalWithV2.caravanV2 = createCaravanV2(now, true)
    if (!Object.prototype.hasOwnProperty.call(originalWithV2, 'chronicleOutbox')) originalWithV2.chronicleOutbox = []
    if (!isPersistedCanonicalExceptReservations(original, { allowMissingHistoricalRewardV2: missingItemV2Map })) return undefined
    normalizePendingSettlementReservations(original)
    if (!isPersistedCanonical(original, { allowMissingHistoricalRewardV2: missingItemV2Map })) return undefined
    if (missingItemV2Map) backfillCommissionRewardV2State(original)
    return original
  }
  const retained = backfillRetainedVisitorIdentity(document)
  if (!missingV2Maps
    && !missingVisitorCycle
    && Object.prototype.hasOwnProperty.call(document, 'caravanV2')
    && Object.prototype.hasOwnProperty.call(document, 'chronicleOutbox')
    && !retained
    && !isPersistedCanonicalExceptReservations(document)) return undefined
  if (retained || missingVisitorCycle || !Object.prototype.hasOwnProperty.call(document, 'caravanV2') || !Object.prototype.hasOwnProperty.call(document, 'chronicleOutbox')) {
    const migrated = structuredClone((retained ?? document) as PersistedGameV3)
    delete (migrated as PersistedGameV3 & { _id?: unknown })._id
    if (!Object.prototype.hasOwnProperty.call(document, 'caravanV2')) migrated.caravanV2 = createCaravanV2(now, true)
    if (!Object.prototype.hasOwnProperty.call(document, 'chronicleOutbox')) migrated.chronicleOutbox = []
    if (!isPersistedCanonicalExceptReservations(migrated)) return undefined
    normalizePendingSettlementReservations(migrated)
    return migrated
  }
  const migrated = structuredClone(document) as unknown as PersistedGameV3
  delete (migrated as PersistedGameV3 & { _id?: unknown })._id
  if (!isPersistedCanonicalExceptReservations(migrated)) return undefined
  normalizePendingSettlementReservations(migrated)
  return isPersistedCanonical(migrated) ? migrated : undefined
}

function normalizePendingSettlementReservations(game: PersistedGameV3): void {
  const expected = Object.values(game.visitorCycle.settlements)
    .map((settlement) => ({ settlement, slots: settlement.rewardItemIds.filter((itemId) => game.itemPlacements[itemId]?.ownerKind !== 'caravan').length }))
    .filter(({ settlement, slots }) => settlement.state === 'preview_ready' && slots > 0)
  game.caravanV2.capacityReservations = Object.fromEntries(expected.map(({ settlement, slots }) => {
    const key = settlementReservationKey(settlement.settlementId)
    return [key, {
      reservationId: key,
      sourceKind: 'settlement' as const,
      sourceId: settlement.settlementId,
      slots,
      createdAt: settlement.createdAt
    }]
  }))
}

function isPersistedCanonicalExceptReservations(
  document: unknown,
  options: { allowMissingHistoricalRewardV2?: boolean; allowMissingRetainedVisitor?: boolean } = {}
): document is PersistedGameV3 {
  if (!isPlainRecord(document) || !isPlainRecord(document.caravanV2)) return false
  const candidate = structuredClone(document) as Record<string, unknown>
  const caravanV2 = candidate.caravanV2 as Record<string, unknown>
  caravanV2.capacityReservations = {}
  return isPersistedCanonical(candidate, { ...options, skipReservationValidation: true })
}

function backfillCommissionRewardV2State(candidate: PersistedGameV3): void {
  for (const commission of persistedCommissions(candidate)) {
    if (!commission.rewardItemId || commission.outcome !== 'complete') continue
    if (!candidate.itemsById[commission.rewardItemId]) continue
    const current = candidate.itemV2ById[commission.rewardItemId]
    if (current?.provenance) continue
    let lootTableId: string
    try {
      lootTableId = lootTableIdForZone(commission.regionId)
    } catch {
      continue
    }
    candidate.itemV2ById[commission.rewardItemId] = {
      ...structuredClone(current ?? {}),
      sealedAffixes: structuredClone(candidate.itemsById[commission.rewardItemId]!.affixes),
      provenance: {
        zoneId: commission.regionId,
        lootTableId,
        configVersion: LOOT_CONFIG_VERSION,
        businessKey: `loot:${commission.id}:reward`,
        droppedAt: commission.finishesAt
      }
    }
  }
}

function persistedCommissions(game: PersistedGameV3): PersistedVisitorCommission[] {
  if (!isPersistedRound(game.visitRound) || !Array.isArray(game.visitHistory) || !game.visitHistory.every(isPersistedRound)) return []
  return [game.visitRound, ...game.visitHistory].flatMap((round) =>
    round.slots.flatMap((slot) => slot.visitor?.commission ? [slot.visitor.commission] : []))
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
    .filter(([, placement]) => {
      if (placement.ownerKind !== 'caravan') return false
      if (placement.custodyKind === 'stash') return true
      if (placement.custodyKind !== 'service') return false
      return document.serviceJobsById[placement.custodyId ?? '']?.projection?.kind === 'legacy_appraiser'
    })
    .map(([itemId]) => document.itemsById[itemId])
    .filter((item): item is Item => Boolean(item))

  return {
    ...base,
    stash,
    _effectiveCapacityUsed: Object.values(document.itemPlacements).filter((placement) => placement.ownerKind === 'caravan').length,
    _v2VisitorStates: Object.fromEntries(Object.values(document.visitorCycle.visitors)
      .map((visitor) => [visitor.visitorId, visitor.busyRecoveryId ? 'away' : visitor.state]))
  }
}

export function buildPersistedFromPublic(
  save: SaveGame,
  previous?: PersistedGameV3,
  dependencies = defaultDependencies,
  newGame = false
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
    const previousPlacement = previous?.itemPlacements[item.id]
    const normativeServiceJob = previousPlacement?.custodyKind === 'service'
      ? serviceJobsById[previousPlacement.custodyId ?? '']
      : undefined
    const preservesNormativeService = normativeServiceJob?.projection?.kind === 'service'
    if (serviceJob) serviceJobsById[serviceJob.id] = { id: serviceJob.id, itemIds: [item.id], projection: { kind: 'legacy_appraiser' } }
    registerItem(itemsById, itemPlacements, item, serviceJob
      ? { ownerKind: 'caravan', custodyKind: 'service', custodyId: serviceJob.id }
      : preservesNormativeService ? structuredClone(previousPlacement!)
      : { ownerKind: 'caravan', custodyKind: 'stash' })
    if (!serviceJob && !preservesNormativeService) stash.push(item.id)
  }

  const generatedItemStates: Record<string, PersistedItemV2State> = {}
  const visitRound = persistRound(normalized.visitRound, itemsById, itemPlacements, previous, generatedItemStates, dependencies)
  const visitHistory = normalized.visitHistory.map((round) => persistRound(round, itemsById, itemPlacements, previous, generatedItemStates, dependencies))
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
      const commission = visitor.commission
      if (!commission) continue
      const expedition = expeditionsById[commission.id]
      expeditionsById[commission.id] = {
        id: commission.id,
        itemIds: [...(expedition?.itemIds ?? [])],
        projection: {
          kind: 'expedition', visitorId: visitor.id, contractId: commission.id, startsAt: commission.startedAt,
          retainedVisitor: visitor.departedAt
            ? { name: visitor.name, departedAt: visitor.departedAt }
            : expedition?.projection?.kind === 'expedition'
              ? expedition.projection.retainedVisitor
              : undefined
        }
      }
      if (commission.status !== 'active' && commission.outcome) {
        const pendingRewardIds = commission.rewardItemId && commission.status !== 'claimed'
          ? [commission.rewardItemId]
          : []
        if (pendingRewardIds[0]) {
          itemPlacements[pendingRewardIds[0]] = {
            ownerKind: 'caravan', custodyKind: 'settlement', custodyId: commission.id
          }
        }
        settlementsById[commission.id] = {
          id: commission.id,
          itemIds: pendingRewardIds,
          projection: {
            kind: 'settlement', expeditionId: commission.id,
            outcome: commission.outcome === 'failed' ? 'death' : commission.outcome === 'partial' ? 'retreated' : 'returned',
            appliedAt: commission.finishesAt
          }
        }
      }
    }
  }
  pruneEmptyOrphanedLifecycle(expeditionsById, settlementsById, recoveriesById, visitRound, visitHistory)
  for (const [itemId, item] of Object.entries(previous?.itemsById ?? {})) {
    if (!itemsById[itemId]) itemsById[itemId] = structuredClone(item)
  }
  for (const itemId of Object.keys(itemsById)) {
    if (seenIds.has(itemId) || isReferencedByVisitors(itemId, visitRound, visitHistory)) continue
    const previousPlacement = previous?.itemPlacements[itemId]
    itemPlacements[itemId] = previousPlacement && ['service', 'expedition', 'recovery', 'settlement'].includes(previousPlacement.custodyKind)
      ? structuredClone(previousPlacement)
      : { ownerKind: 'tombstone', custodyKind: 'tombstone' }
  }

  const visitorCycle = structuredClone(previous?.visitorCycle
    ?? createVisitorCycle({ visitRound, visitHistory, createdAt: normalized.createdAt } as PersistedGameV3))
  const discoveredVisitors = createVisitorCycle({
    visitRound, visitHistory, createdAt: normalized.updatedAt
  } as PersistedGameV3).visitors
  for (const [visitorId, visitor] of Object.entries(discoveredVisitors)) {
    visitorCycle.visitors[visitorId] ??= visitor
  }
  for (const round of [visitRound, ...visitHistory]) {
    for (const visitor of round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])) {
      const cycleVisitor = visitorCycle.visitors[visitor.id]
      const migratedSettlement = visitor.commission?.status === 'claimed'
        ? visitorCycle.settlements[visitor.commission.id]
        : undefined
      const migratedExpedition = migratedSettlement
        ? visitorCycle.expeditions[migratedSettlement.expeditionId]
        : undefined
      if (cycleVisitor && migratedSettlement?.state === 'preview_ready' && migratedExpedition) {
        migratedSettlement.state = 'settled'
        migratedSettlement.appliedAt = visitor.commission!.claimedAt ?? visitor.departedAt ?? normalized.updatedAt
        migratedSettlement.appliedBy = 'confirmation'
        migratedSettlement.appliedChoices = migratedSettlement.choiceGroups.map((group) => {
          const option = group.options.find((entry) => entry.optionId === group.defaultOptionId)!
          return { groupId: group.groupId, optionId: option.optionId, label: structuredClone(option.label) }
        })
        migratedExpedition.state = 'settled'
        migratedExpedition.settledAt = migratedSettlement.appliedAt
        migratedExpedition.visitorResolution = 'departs'
        cycleVisitor.state = 'departed'
        cycleVisitor.departedAt = visitor.departedAt ?? migratedSettlement.appliedAt
        cycleVisitor.lastExpeditionId = migratedExpedition.expeditionId
        cycleVisitor.contractOptions = []
        delete cycleVisitor.contractId
        delete cycleVisitor.expeditionId
        delete cycleVisitor.settlementId
        delete cycleVisitor.outcome
      }
      if (visitor.state === 'departed' && visitor.departedAt && cycleVisitor?.state === 'available') {
        const lastExpedition = Object.values(visitorCycle.expeditions)
          .filter((expedition) => expedition.visitorId === visitor.id)
          .at(-1)
        cycleVisitor.state = 'departed'
        cycleVisitor.departedAt = visitor.departedAt
        cycleVisitor.lastExpeditionId = visitor.commission?.id ?? lastExpedition?.expeditionId ?? `legacy-${visitor.id}`
        cycleVisitor.contractOptions = []
      }
    }
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
    itemV2ById: { ...structuredClone(previous?.itemV2ById ?? {}), ...generatedItemStates },
    serviceJobStateById: structuredClone(previous?.serviceJobStateById ?? {}),
    requestRecords: structuredClone(previous?.requestRecords ?? []),
    businessKeys: structuredClone(previous?.businessKeys ?? {}),
    ledger: structuredClone(previous?.ledger ?? []),
    visitorCycle
    ,caravanV2: structuredClone(previous?.caravanV2 ?? createCaravanV2(new Date(normalized.createdAt), !newGame))
    ,chronicleOutbox: structuredClone(previous?.chronicleOutbox ?? [])
  }
  normalizePendingSettlementReservations(persisted as PersistedGameV3)
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

function isPersistedCaravanV2(value: unknown): value is PersistedCaravanV2 {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['upgrades', 'serviceUnlockedAt', 'maintenance', 'capacityReservations'])) return false
  const upgrades = value.upgrades
  if (!isPlainRecord(upgrades) || !hasOnlyKeys(upgrades, ['visitor_quarters', 'blacksmith', 'enchanter'])) return false
  if (!Object.entries(CARAVAN_V2_UPGRADES).every(([id, catalog]) => Number.isInteger(upgrades[id]) && Number(upgrades[id]) >= 0 && Number(upgrades[id]) <= catalog.maxLevel)) return false
  if (!isPlainRecord(value.serviceUnlockedAt) || Object.entries(value.serviceUnlockedAt).some(([id, at]) => !['blacksmith', 'enchanter'].includes(id) || typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) return false
  const maintenance = value.maintenance
  if (!isPlainRecord(maintenance) || !hasOnlyKeys(maintenance, ['policyVersion', 'accountedThroughPeriodKey', 'debts'])
    || maintenance.policyVersion !== 'weekly-v1' || typeof maintenance.accountedThroughPeriodKey !== 'string' || !/^\d{4}-W\d{2}$/.test(maintenance.accountedThroughPeriodKey)
    || !Array.isArray(maintenance.debts) || maintenance.debts.length > 2
    || !maintenance.debts.every((debt) => isPlainRecord(debt) && hasOnlyKeys(debt, ['periodKey', 'gold']) && typeof debt.periodKey === 'string' && Number.isInteger(Number(debt.gold)) && Number(debt.gold) > 0)) return false
  const reservations = value.capacityReservations
  return isPlainRecord(reservations) && Object.entries(reservations).every(([key, reservation]) => isPlainRecord(reservation)
    && hasOnlyKeys(reservation, ['reservationId', 'sourceKind', 'sourceId', 'slots', 'createdAt'])
    && key === `settlement:${reservation.sourceId}` && reservation.reservationId === key && reservation.sourceKind === 'settlement' && typeof reservation.sourceId === 'string'
    && Number.isInteger(Number(reservation.slots)) && Number(reservation.slots) > 0 && typeof reservation.createdAt === 'string' && Number.isFinite(Date.parse(reservation.createdAt)))
}

function isPersistedChronicleOutboxEvent(value: unknown, userId?: string): value is PersistedChronicleOutboxEvent {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['eventId', 'eventKey', 'type', 'occurredAt', 'subject', 'data'])) return false
  if (typeof value.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(value.eventId) || (userId !== undefined && value.eventId !== eventIdFor(userId, String(value.eventKey))) || typeof value.eventKey !== 'string' || !value.eventKey
    || !['visitor_arrived', 'expedition_started', 'expedition_resolved', 'item_found', 'item_custody_changed', 'visitor_died', 'visitor_departed'].includes(String(value.type))
    || typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))) return false
  const subject = value.subject
  return isPlainRecord(subject) && hasOnlyKeys(subject, ['kind', 'id']) && ['visitor', 'expedition', 'item'].includes(String(subject.kind))
    && typeof subject.id === 'string' && Boolean(subject.id) && isPlainRecord(value.data)
    && Object.values(value.data).every((entry) => typeof entry === 'string')
    && isChronicleEventDataValid(value as unknown as PersistedChronicleOutboxEvent)
}

export function isPersistedCanonical(
  document: unknown,
  options: { allowMissingHistoricalRewardV2?: boolean; allowMissingRetainedVisitor?: boolean; skipReservationValidation?: boolean } = {}
): document is PersistedGameV3 {
  if (!document || typeof document !== 'object') return false

  const candidate = document as Record<string, unknown>
  if (!hasOnlyKeys(candidate, [
    '_id', 'userId', 'schemaVersion', 'gold', 'materials', 'caravan', 'stashLimit', 'stash',
    'unlockedRegionIds', 'visitRound', 'visitHistory', 'revision', 'createdAt', 'updatedAt',
    'itemsById', 'itemPlacements', 'expeditionsById', 'recoveriesById', 'settlementsById',
    'serviceJobsById', 'itemV2ById', 'serviceJobStateById', 'requestRecords', 'businessKeys', 'ledger', 'visitorCycle', 'caravanV2', 'chronicleOutbox'
  ])) return false

  if (!isPersistedCaravanV2(candidate.caravanV2) || !Array.isArray(candidate.chronicleOutbox) || candidate.chronicleOutbox.length > 100
    || !candidate.chronicleOutbox.every((event) => isPersistedChronicleOutboxEvent(event))) return false

  const stash = (document as { stash?: unknown }).stash
  const itemsById = (document as { itemsById?: Record<string, Item> }).itemsById
  const itemPlacements = (document as { itemPlacements?: Record<string, PersistedItemPlacement> }).itemPlacements
  const containerMaps = {
    expedition: candidate.expeditionsById,
    recovery: candidate.recoveriesById,
    settlement: candidate.settlementsById,
    service: candidate.serviceJobsById
  }
  const itemV2ById = (candidate as { itemV2ById?: unknown }).itemV2ById
  const serviceJobStateById = (candidate as { serviceJobStateById?: unknown }).serviceJobStateById

  if (candidate.schemaVersion !== SAVE_SCHEMA_VERSION) return false
  if (!Array.isArray(stash) || !isPlainRecord(itemsById) || !isPlainRecord(itemPlacements)) return false
  if (typeof candidate.userId !== 'string' || !candidate.userId) return false
  if (!(candidate.chronicleOutbox as unknown[]).every((event) => isPersistedChronicleOutboxEvent(event, candidate.userId as string))) return false
  if (!Number.isInteger(candidate.gold) || Number(candidate.gold) < 0 || !isResourceMap(candidate.materials)) return false
  if (!Number.isInteger(candidate.stashLimit) || Number(candidate.stashLimit) < 0) return false
  if (!Array.isArray(candidate.unlockedRegionIds) || !candidate.unlockedRegionIds.every((id) => typeof id === 'string' && Boolean(id))) return false
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 0) return false
  if (!Number.isFinite(Date.parse(String(candidate.createdAt))) || !Number.isFinite(Date.parse(String(candidate.updatedAt)))) return false
  if (!Array.isArray(candidate.requestRecords) || !Array.isArray(candidate.ledger)) return false
  if (!isVisitorCycle(candidate.visitorCycle)) return false
  if (!candidate.businessKeys || typeof candidate.businessKeys !== 'object' || Array.isArray(candidate.businessKeys)) return false
  if (!Object.values(candidate.businessKeys as Record<string, unknown>).every((requestId) => typeof requestId === 'string' && Boolean(requestId))) return false
  if (!candidate.visitRound || typeof candidate.visitRound !== 'object' || !Array.isArray((candidate.visitRound as { slots?: unknown }).slots)) return false
  if (!Array.isArray(candidate.visitHistory)) return false
  if (!isCaravan(candidate.caravan)) return false
  const caravan = candidate.caravan as Partial<SaveGame['caravan']>
  if (!caravan.services || !Array.isArray(caravan.services.appraiserQueue)) return false
  const allRounds = [candidate.visitRound, ...candidate.visitHistory]
  if (!allRounds.every(isPersistedRound)) return false
  const visitors = allRounds.flatMap((round) => round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : []))
  const visitorIds = new Set(visitors.map((visitor) => visitor.id))
  if (visitorIds.size !== visitors.length) return false
  const visitorContracts = new Map(visitors.map((visitor) => [visitor.id, visitor.commission?.id]))
  const cycle = candidate.visitorCycle as PersistedVisitorCycle
  if (!options.skipReservationValidation) {
    const pendingReservations = new Set(Object.values(cycle.settlements)
      .filter((settlement) => settlement.state === 'preview_ready' && settlement.rewardItemIds.some((itemId) => itemPlacements[itemId]?.ownerKind !== 'caravan'))
      .map((settlement) => `settlement:${settlement.settlementId}`))
    for (const [key, reservation] of Object.entries((candidate.caravanV2 as PersistedCaravanV2).capacityReservations)) {
      const settlement = cycle.settlements[reservation.sourceId]
      const slots = settlement?.rewardItemIds.filter((itemId) => itemPlacements[itemId]?.ownerKind !== 'caravan').length ?? 0
      if (!pendingReservations.has(key) || !settlement || settlement.state !== 'preview_ready'
        || slots !== reservation.slots || reservation.sourceId !== key.slice('settlement:'.length)) return false
    }
    if (Object.keys((candidate.caravanV2 as PersistedCaravanV2).capacityReservations).length !== pendingReservations.size) return false
  }
  const cycleExpeditionIds = new Set(Object.keys(cycle.expeditions))
  if (Object.values(containerMaps).some((value) => !isContainerMap(value))) return false
  if (!isItemV2Map(itemV2ById) || !isServiceJobStateMap(serviceJobStateById)) return false
  const expeditions = Object.values(candidate.expeditionsById as Record<string, PersistedCustodyContainer>)
  const settlements = Object.values(candidate.settlementsById as Record<string, PersistedCustodyContainer>)
  const recoveries = Object.values(candidate.recoveriesById as Record<string, PersistedCustodyContainer>)
  for (const container of expeditions) {
    const projection = container.projection
    if (projection?.kind !== 'expedition') return false
    if (cycleExpeditionIds.has(container.id)) {
      const cycleExpedition = cycle.expeditions[container.id]
      if (!cycleExpedition || cycleExpedition.visitorId !== projection.visitorId
        || cycleExpedition.contractId !== projection.contractId) return false
      continue
    }
    if (!visitorIds.has(projection.visitorId)) {
      if (!hasRetainedExpeditionDependency(container, settlements, recoveries)) return false
      if (!projection.retainedVisitor && !options.allowMissingRetainedVisitor) return false
      continue
    }
    const visitor = visitors.find((entry) => entry.id === projection.visitorId)!
    if (projection.retainedVisitor
      && (visitor.name !== projection.retainedVisitor.name
        || visitor.departedAt !== projection.retainedVisitor.departedAt)) return false
    if (visitorContracts.get(projection.visitorId) !== projection.contractId) return false
  }
  for (const visitor of visitors) {
    if (!visitor.commission) {
      if (visitor.state === 'commissioned' || visitor.state === 'returned') return false
      if (visitor.state === 'departed' ? !visitor.departedAt : Boolean(visitor.departedAt)) return false
      continue
    }
    const commission = visitor.commission
    const matchingExpeditions = expeditions
      .filter((container) => container.projection?.kind === 'expedition'
        && container.projection.visitorId === visitor.id
        && container.projection.contractId === commission.id)
    if (matchingExpeditions.length !== 1) return false
    const expedition = matchingExpeditions[0]!
    if (expedition.projection?.kind !== 'expedition' || expedition.projection.startsAt !== commission.startedAt) return false
    const matchingSettlements = settlements.filter((container) => container.projection?.kind === 'settlement'
      && container.projection.expeditionId === expedition.id)
    if (commission.status === 'active') {
      if (visitor.state !== 'commissioned' || visitor.departedAt || commission.outcome !== undefined
        || commission.rewardGold !== undefined || commission.rewardItemId !== undefined
        || commission.claimedAt !== undefined || matchingSettlements.length !== 0) return false
    } else {
      if (!commission.outcome || matchingSettlements.length !== 1) return false
      const settlement = matchingSettlements[0]!
      const expectedOutcome = commission.outcome === 'failed'
        ? 'death'
        : commission.outcome === 'partial' ? 'retreated' : 'returned'
      if (settlement?.projection?.kind !== 'settlement'
        || settlement.projection.outcome !== expectedOutcome
        || settlement.projection.appliedAt !== commission.finishesAt) return false
      const expectedGold = commission.outcome === 'complete'
        ? commission.fullRewardGold
        : commission.outcome === 'partial' ? commission.partialRewardGold : 0
      if (commission.rewardGold !== expectedGold) return false
      if (commission.outcome !== 'complete' && commission.rewardItemId !== undefined) return false
      if (commission.rewardItemId && !isCommissionRewardLoot(candidate as unknown as PersistedGameV3, commission)) {
        if (!options.allowMissingHistoricalRewardV2) return false
        const itemId = commission.rewardItemId
        if (!(itemsById as Record<string, unknown>)[itemId]) return false
        if ((itemV2ById as Record<string, unknown>)[itemId] !== undefined) return false
      }
      const expectedSettlementItems = commission.status === 'ready' && commission.rewardItemId
        ? [commission.rewardItemId]
        : []
      if (settlement.itemIds.length !== expectedSettlementItems.length
        || settlement.itemIds.some((itemId, index) => itemId !== expectedSettlementItems[index])) return false
      if (commission.status === 'ready') {
        if (visitor.state !== 'returned' || visitor.departedAt || commission.claimedAt !== undefined) return false
      } else if (visitor.state !== 'departed' || !visitor.departedAt || !commission.claimedAt
        || visitor.departedAt !== commission.claimedAt
        || Date.parse(commission.claimedAt) < Date.parse(commission.finishesAt)) return false
    }
  }
  for (const container of settlements) {
    if (container.projection?.kind !== 'settlement' || !(container.projection.expeditionId in (candidate.expeditionsById as object))) return false
  }
  for (const container of recoveries) {
    if (container.projection?.kind !== 'recovery' || !(container.projection.sourceExpeditionId in (candidate.expeditionsById as object))) return false
  }
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
      if (container.projection?.kind !== placement.custodyKind
        && !(placement.custodyKind === 'service' && container.projection?.kind === 'legacy_appraiser')) return false
    }
  }
  for (const [kind, containers] of Object.entries(containerMaps)) {
    for (const container of Object.values(containers as Record<string, PersistedCustodyContainer>)) {
      if (container.projection?.kind !== kind && !(kind === 'service' && container.projection?.kind === 'legacy_appraiser')) return false
      if (kind === 'service' && container.itemIds.length > 1) return false
      if (kind === 'service' && container.projection?.kind === 'service' && !serviceJobStateById[container.id]) return false
      for (const itemId of container.itemIds) {
        if (activeReferences.has(itemId)) return false
        activeReferences.add(itemId)
        const placement = itemPlacements[itemId]
        if (!placement || placement.custodyKind !== kind || placement.custodyId !== container.id) return false
      }
    }
  }
  for (const [itemId] of Object.entries(itemV2ById)) {
    if (!itemsById[itemId]) return false
  }
  for (const [jobId, serviceState] of Object.entries(serviceJobStateById)) {
    const container = (candidate.serviceJobsById as Record<string, PersistedCustodyContainer>)[jobId]
    if (!container || container.projection?.kind !== 'service' || container.projection.service !== serviceState.service) return false
    if (container.projection.queuedAt !== serviceState.queuedAt || container.projection.startsAt !== serviceState.startedAt) return false
    if (!itemsById[serviceState.itemId]) return false
    const placement = itemPlacements[serviceState.itemId]
    if (serviceState.status === 'queued' || serviceState.status === 'active') {
      if (container.itemIds.length !== 1 || container.itemIds[0] !== serviceState.itemId) return false
      if (placement?.ownerKind !== 'caravan' || placement.custodyKind !== 'service' || placement.custodyId !== jobId) return false
    } else {
      if (container.itemIds.length !== 0) return false
      if (placement?.custodyKind === 'service' && placement.custodyId === jobId) return false
    }
    if (Date.parse(serviceState.startedAt) < Date.parse(serviceState.queuedAt)) return false
    if (Date.parse(serviceState.completesAt) < Date.parse(serviceState.startedAt)) return false
    if (serviceState.status === 'completed' ? !serviceState.completedAt : serviceState.completedAt) return false
    if (serviceState.status === 'failed' ? !serviceState.failedAt : serviceState.failedAt) return false
    if (serviceState.status === 'cancelled' ? !serviceState.cancelledAt : serviceState.cancelledAt) return false
    if (serviceState.service === 'blacksmith') {
      if (!Number.isInteger(serviceState.result.blacksmithLevel) || serviceState.result.affix !== undefined || serviceState.result.enchantCount !== undefined) return false
    } else {
      if (!serviceState.result.affix || !Number.isInteger(serviceState.result.enchantCount)
        || Number(serviceState.result.enchantCount) < 1 || serviceState.result.blacksmithLevel !== undefined) return false
      const expected = getEnchanterOption(itemsById[serviceState.itemId]!, {
        enchantCount: Number(serviceState.result.enchantCount) - 1
      }).affix
      if (expected.stat !== serviceState.result.affix.stat || expected.value !== serviceState.result.affix.value) return false
    }
  }
  const enchanterItemIds = new Set(Object.values(serviceJobStateById)
    .filter((job) => job.service === 'enchanter')
    .map((job) => job.itemId))
  for (const itemId of enchanterItemIds) {
    const jobs = Object.values(serviceJobStateById).filter((job) => job.service === 'enchanter' && job.itemId === itemId)
    const completed = jobs
      .filter((job) => job.status === 'completed')
      .sort((left, right) => Number(left.result.enchantCount) - Number(right.result.enchantCount))
    if (((itemV2ById as Record<string, PersistedItemV2State>)[itemId]?.enchantCount ?? 0) !== completed.length
      || completed.some((job, index) => job.result.enchantCount !== index + 1)) return false
    const inFlight = jobs.filter((job) => job.status === 'queued' || job.status === 'active')
    if (inFlight.length > 1 || inFlight.some((job) => job.result.enchantCount !== completed.length + 1)) return false
    const aborted = jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled')
    if (aborted.some((job) => Number(job.result.enchantCount) > completed.length + 1)) return false
  }
  for (const contract of Object.values(cycle.contracts)) {
    const expedition = cycle.expeditions[contract.expeditionId]
    if (!expedition) return false
    const pendingSettlement = expedition.settlementId ? cycle.settlements[expedition.settlementId] : undefined
    if (expedition.state !== 'settled' && !contract.loanItemIds.every((itemId) => {
      const placement = itemPlacements[itemId]
      if (placement?.ownerKind !== 'caravan') return false
      if (placement.custodyKind === 'expedition' && placement.custodyId === expedition.expeditionId) return true
      return expedition.state === 'awaiting_settlement'
        && pendingSettlement?.state === 'preview_ready'
        && expedition.outcome === pendingSettlement.outcome
        && expedition.outcome !== 'death'
        && placement.custodyKind === 'stash'
    })) return false
  }
  for (const settlement of Object.values(cycle.settlements)) {
    const contract = cycle.contracts[cycle.expeditions[settlement.expeditionId]?.contractId ?? '']
    if (!contract || settlement.loanItemIds.length !== contract.loanItemIds.length
      || settlement.loanItemIds.some((itemId) => !contract.loanItemIds.includes(itemId))) return false
    if (settlement.state === 'preview_ready' && !settlement.rewardItemIds.every((itemId) => {
      const placement = itemPlacements[itemId]
      return placement?.ownerKind === 'caravan'
        && placement.custodyKind === 'settlement' && placement.custodyId === settlement.settlementId
    })) return false
  }
  for (const recovery of Object.values(cycle.recoveries)) {
    const sourceSettlement = Object.values(cycle.settlements)
      .find((settlement) => settlement.expeditionId === recovery.sourceExpeditionId)
    if (!sourceSettlement || sourceSettlement.outcome !== 'death'
      || recovery.itemIds.length !== sourceSettlement.loanItemIds.length
      || recovery.itemIds.some((itemId) => !sourceSettlement.loanItemIds.includes(itemId))) return false
    if ((recovery.state === 'open' || recovery.state === 'assigned')
      && !recovery.itemIds.every((itemId) => itemPlacements[itemId]?.ownerKind === 'caravan'
        && itemPlacements[itemId]?.custodyKind === 'recovery'
        && itemPlacements[itemId]?.custodyId === recovery.recoveryId)) return false
    if ((recovery.state === 'failed' || recovery.state === 'abandoned')
      && !recovery.itemIds.every((itemId) => itemPlacements[itemId]?.ownerKind === 'tombstone'
        && itemPlacements[itemId]?.custodyKind === 'tombstone')) return false
    if (recovery.state === 'assigned' && !recovery.supportLoanItemIds.every((itemId) => itemPlacements[itemId]?.ownerKind === 'caravan'
      && itemPlacements[itemId]?.custodyKind === 'recovery'
      && itemPlacements[itemId]?.custodyId === recovery.recoveryId)) return false
  }
  const ownedCapacity = Object.values(itemPlacements).filter((placement) => placement.ownerKind === 'caravan').length
  const reservedCapacity = Object.values((candidate.caravanV2 as PersistedCaravanV2).capacityReservations).reduce((sum, reservation) => sum + Number(reservation.slots), 0)
  if (ownedCapacity > Number(candidate.stashLimit) || ownedCapacity + reservedCapacity > Number(candidate.stashLimit)) return false

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
        if (!itemsById[visitor.commission.rewardItemId] || !placement) return false
        if (visitor.commission.status === 'claimed') {
          if (!isCommissionRewardLoot(candidate as unknown as PersistedGameV3, visitor.commission)) {
            if (!options.allowMissingHistoricalRewardV2) return false
            const itemId = visitor.commission.rewardItemId
            if (!itemId || !(itemsById as Record<string, unknown>)[itemId]) return false
            if ((itemV2ById as Record<string, unknown>)[itemId] !== undefined) return false
          }
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

  const ledgerKeys = new Set<string>()
  const ledgerRequestIds = new Set<string>()
  const ledgerByRequestId = new Map<string, PersistedLedgerEntry>()
  let previousLedgerRevision = 0
  for (const entry of candidate.ledger as PersistedLedgerEntry[]) {
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, ['at', 'requestId', 'operationKey', 'commandHash', 'businessKey', 'revision', 'goldDelta', 'materialDeltas', 'itemChanges'])) return false
    if (typeof entry.businessKey !== 'string' || !entry.businessKey || ledgerKeys.has(entry.businessKey)) return false
    if (typeof entry.requestId !== 'string' || !entry.requestId || ledgerRequestIds.has(entry.requestId)
      || typeof entry.operationKey !== 'string' || !entry.operationKey
      || typeof entry.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.commandHash)) return false
    if (!Number.isFinite(Date.parse(entry.at)) || !Number.isInteger(entry.revision) || entry.revision < 1) return false
    if (entry.revision <= previousLedgerRevision || entry.revision > Number(candidate.revision)) return false
    if (!Number.isInteger(entry.goldDelta) || !isSignedResourceMap(entry.materialDeltas) || !Array.isArray(entry.itemChanges)
      || !entry.itemChanges.every(isItemChange)) return false
    ledgerKeys.add(entry.businessKey)
    ledgerRequestIds.add(entry.requestId)
    ledgerByRequestId.set(entry.requestId, entry)
    previousLedgerRevision = entry.revision
  }
  for (const [businessKey, requestId] of Object.entries(candidate.businessKeys as Record<string, string>)) {
    if (businessKey.startsWith('maintenance:')) continue
    const ledgerEntry = (candidate.ledger as PersistedLedgerEntry[]).find((entry) => entry.businessKey === businessKey)
    if (!businessKey || !requestId || !ledgerEntry || ledgerEntry.requestId !== requestId) return false
  }
  for (const entry of candidate.ledger as PersistedLedgerEntry[]) {
    if ((candidate.businessKeys as Record<string, string>)[entry.businessKey] !== entry.requestId) return false
  }
  const requestIds = new Set<string>()
  for (const record of candidate.requestRecords as PersistedRequestRecord[]) {
    if (!isPlainRecord(record) || !hasOnlyKeys(record, ['requestId', 'operationKey', 'businessKey', 'commandHash', 'response', 'persistedResponse', 'revision', 'createdAt', 'updatedAt'])) return false
    if (typeof record.requestId !== 'string' || !record.requestId || requestIds.has(record.requestId)) return false
    if (typeof record.operationKey !== 'string' || !record.operationKey
      || typeof record.businessKey !== 'string' || !record.businessKey || !isReplayResponse(record.response)) return false
    if (typeof record.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.commandHash) || !Number.isInteger(record.revision)
      || record.revision < 1 || record.revision > Number(candidate.revision)
      || record.response.revision !== record.revision) return false
    if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) return false
    if (containsInternalFields(record.response)) return false
    if (record.persistedResponse !== undefined
      && (!isPersistedCanonical(record.persistedResponse) || record.persistedResponse.revision !== record.revision)) return false
    const ledgerEntry = ledgerByRequestId.get(record.requestId)
    if (!ledgerEntry || ledgerEntry.operationKey !== record.operationKey
      || ledgerEntry.businessKey !== record.businessKey
      || ledgerEntry.commandHash !== record.commandHash
      || ledgerEntry.revision !== record.revision
      || (candidate.businessKeys as Record<string, string>)[record.businessKey] !== record.requestId) return false
    requestIds.add(record.requestId)
  }
  return true
}

function hasRetainedExpeditionDependency(
  expedition: PersistedCustodyContainer,
  settlements: PersistedCustodyContainer[],
  recoveries: PersistedCustodyContainer[]
): boolean {
  if (expedition.itemIds.length > 0) return true
  return settlements.some((container) => container.projection?.kind === 'settlement'
    && container.projection.expeditionId === expedition.id && container.itemIds.length > 0)
    || recoveries.some((container) => container.projection?.kind === 'recovery'
      && container.projection.sourceExpeditionId === expedition.id && container.itemIds.length > 0)
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
  if (!Number.isFinite(Date.parse(String(value.startedAt))) || !Number.isFinite(Date.parse(String(value.finishesAt)))
    || Date.parse(String(value.startedAt)) > Date.parse(String(value.finishesAt)) || !Number.isFinite(value.outcomeRoll)) return false
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

function readItemV2Map(value: unknown): Record<string, PersistedItemV2State> {
  return isItemV2Map(value) ? structuredClone(value) : {}
}

function readServiceJobStateMap(value: unknown): Record<string, PersistedServiceJobState> {
  return isServiceJobStateMap(value) ? structuredClone(value) : {}
}

function isContainerMap(value: unknown): value is Record<string, PersistedCustodyContainer> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(([id, entry]) => {
    if (!entry || typeof entry !== 'object') return false
    if (!hasOnlyKeys(entry as Record<string, unknown>, ['id', 'itemIds', 'projection'])) return false
    const container = entry as PersistedCustodyContainer
    return container.id === id && Array.isArray(container.itemIds)
      && new Set(container.itemIds).size === container.itemIds.length
      && container.itemIds.every((itemId) => typeof itemId === 'string' && Boolean(itemId))
      && (container.projection === undefined || isCustodyProjection(container.projection))
  })
}

function isItemV2Map(value: unknown): value is Record<string, PersistedItemV2State> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const lootBusinessKeys = new Set<string>()
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, [
      'sealedAffixes', 'blacksmithLevel', 'enchantCount', 'activeImprint', 'pendingImprint', 'imprintHistory', 'provenance'
    ])) return false
    if (entry.sealedAffixes !== undefined && (!Array.isArray(entry.sealedAffixes)
      || !entry.sealedAffixes.every(isAffix))) return false
    if (entry.blacksmithLevel !== undefined && (!Number.isInteger(entry.blacksmithLevel) || Number(entry.blacksmithLevel) < 0)) return false
    if (entry.enchantCount !== undefined && (!Number.isInteger(entry.enchantCount) || Number(entry.enchantCount) < 0)) return false
    if (entry.activeImprint !== undefined && !isImprint(entry.activeImprint, false)) return false
    if (entry.pendingImprint !== undefined && !isImprint(entry.pendingImprint, false)) return false
    if (entry.imprintHistory !== undefined && (!Array.isArray(entry.imprintHistory)
      || !entry.imprintHistory.every((imprint) => isImprint(imprint, true)))) return false
    if (entry.provenance === undefined) return true
    if (!isPlainRecord(entry.provenance)
      || !hasOnlyKeys(entry.provenance, ['zoneId', 'lootTableId', 'configVersion', 'businessKey', 'combinationId', 'imperfectPieceId', 'droppedAt'])
      || typeof entry.provenance.zoneId !== 'string' || !entry.provenance.zoneId
      || (entry.provenance.lootTableId !== undefined && (typeof entry.provenance.lootTableId !== 'string' || !entry.provenance.lootTableId))
      || (entry.provenance.configVersion !== undefined && (typeof entry.provenance.configVersion !== 'string' || !entry.provenance.configVersion))
      || (entry.provenance.businessKey !== undefined && (typeof entry.provenance.businessKey !== 'string' || !entry.provenance.businessKey))
      || (entry.provenance.combinationId !== undefined && (typeof entry.provenance.combinationId !== 'string' || !entry.provenance.combinationId))
      || (entry.provenance.imperfectPieceId !== undefined && (typeof entry.provenance.imperfectPieceId !== 'string' || !entry.provenance.imperfectPieceId))
      || !Number.isFinite(Date.parse(String(entry.provenance.droppedAt)))) return false
    if (entry.provenance.businessKey) {
      if (lootBusinessKeys.has(entry.provenance.businessKey)) return false
      lootBusinessKeys.add(entry.provenance.businessKey)
    }
    return true
  })
}

function isCommissionRewardLoot(game: PersistedGameV3, commission: PersistedVisitorCommission): boolean {
  if (!commission.rewardItemId || commission.outcome !== 'complete') return false
  const item = game.itemsById[commission.rewardItemId]
  const state = game.itemV2ById[commission.rewardItemId]
  const provenance = state?.provenance
  if (!item || !provenance) return false
  let lootTableId: string
  try {
    lootTableId = lootTableIdForZone(commission.regionId)
  } catch {
    return false
  }
  const sealedAffixes = state.sealedAffixes ?? []
  const itemAffixes = item.affixes ?? []
  const completedEnchantments = Object.entries(game.serviceJobStateById)
    .filter(([, job]) => job.service === 'enchanter' && job.itemId === commission.rewardItemId && job.status === 'completed')
    .sort(([, left], [, right]) => Number(left.result.enchantCount) - Number(right.result.enchantCount))
  if ((state.enchantCount ?? 0) !== completedEnchantments.length
    || completedEnchantments.some(([, job], index) => job.result.enchantCount !== index + 1 || !job.result.affix)) return false
  const canonicalAffixes = [
    ...sealedAffixes,
    ...completedEnchantments.map(([, job]) => job.result.affix!)
  ]
  return provenance.businessKey === `loot:${commission.id}:reward`
    && provenance.zoneId === commission.regionId
    && provenance.configVersion === LOOT_CONFIG_VERSION
    && provenance.lootTableId === lootTableId
    && provenance.droppedAt === commission.finishesAt
    && canonicalAffixes.length === itemAffixes.length
    && canonicalAffixes.every((affix, index) => affix.stat === itemAffixes[index]?.stat
      && affix.value === itemAffixes[index]?.value)
}

function isServiceJobStateMap(value: unknown): value is Record<string, PersistedServiceJobState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((entry) => isPlainRecord(entry)
    && hasOnlyKeys(entry, ['status', 'service', 'itemId', 'queuedAt', 'startedAt', 'completesAt', 'completedAt', 'failedAt', 'cancelledAt', 'result'])
    && ['queued', 'active', 'completed', 'failed', 'cancelled'].includes(String(entry.status))
    && ['blacksmith', 'enchanter'].includes(String(entry.service))
    && typeof entry.itemId === 'string' && Boolean(entry.itemId)
    && ['queuedAt', 'startedAt', 'completesAt'].every((key) => Number.isFinite(Date.parse(String(entry[key]))))
    && (entry.completedAt === undefined || Number.isFinite(Date.parse(String(entry.completedAt))))
    && (entry.failedAt === undefined || Number.isFinite(Date.parse(String(entry.failedAt))))
    && (entry.cancelledAt === undefined || Number.isFinite(Date.parse(String(entry.cancelledAt))))
    && isPlainRecord(entry.result)
    && hasOnlyKeys(entry.result, ['blacksmithLevel', 'enchantCount', 'affix'])
    && (entry.result.blacksmithLevel === undefined || (Number.isInteger(entry.result.blacksmithLevel) && Number(entry.result.blacksmithLevel) >= 0))
    && (entry.result.enchantCount === undefined || (Number.isInteger(entry.result.enchantCount) && Number(entry.result.enchantCount) >= 0))
    && (entry.result.affix === undefined || isAffix(entry.result.affix)))
}

function isAffix(value: unknown): boolean {
  return isPlainRecord(value) && hasOnlyKeys(value, ['stat', 'value'])
    && typeof value.stat === 'string' && Number.isFinite(value.value)
}

function isImprint(value: unknown, allowReplacedAt: boolean): boolean {
  return isPlainRecord(value)
    && hasOnlyKeys(value, allowReplacedAt ? ['imprintId', 'label', 'grantedAt', 'replacedAt'] : ['imprintId', 'label', 'grantedAt'])
    && typeof value.imprintId === 'string' && Boolean(value.imprintId)
    && typeof value.label === 'string' && Boolean(value.label)
    && Number.isFinite(Date.parse(String(value.grantedAt)))
    && (value.replacedAt === undefined || Number.isFinite(Date.parse(String(value.replacedAt))))
}

function isCustodyProjection(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'legacy_appraiser') return hasOnlyKeys(value, ['kind'])
  if (value.kind === 'expedition') return hasOnlyKeys(value, ['kind', 'visitorId', 'contractId', 'startsAt', 'retainedVisitor'])
    && typeof value.visitorId === 'string' && Boolean(value.visitorId) && typeof value.contractId === 'string' && Boolean(value.contractId)
    && Number.isFinite(Date.parse(String(value.startsAt)))
    && (value.retainedVisitor === undefined || (isPlainRecord(value.retainedVisitor)
      && hasOnlyKeys(value.retainedVisitor, ['name', 'departedAt'])
      && typeof value.retainedVisitor.name === 'string' && Boolean(value.retainedVisitor.name)
      && Number.isFinite(Date.parse(String(value.retainedVisitor.departedAt)))))
  if (value.kind === 'settlement') return hasOnlyKeys(value, ['kind', 'expeditionId', 'outcome', 'appliedAt'])
    && typeof value.expeditionId === 'string' && Boolean(value.expeditionId) && ['returned', 'retreated', 'death'].includes(String(value.outcome))
    && Number.isFinite(Date.parse(String(value.appliedAt)))
  if (value.kind === 'recovery') return hasOnlyKeys(value, ['kind', 'sourceExpeditionId', 'resolvedAt'])
    && typeof value.sourceExpeditionId === 'string' && Boolean(value.sourceExpeditionId) && Number.isFinite(Date.parse(String(value.resolvedAt)))
  return value.kind === 'service' && hasOnlyKeys(value, ['kind', 'service', 'queuedAt', 'startsAt'])
    && ['blacksmith', 'enchanter'].includes(String(value.service))
    && Number.isFinite(Date.parse(String(value.queuedAt))) && Number.isFinite(Date.parse(String(value.startsAt)))
}

function isPublicSaveGame(value: unknown): value is PublicSaveGame {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'gold', 'caravan', 'stashLimit', 'stash', 'unlockedRegionIds',
    'visitRound', 'visitHistory', 'revision', 'createdAt', 'updatedAt'
  ])) return false
  if (value.schemaVersion !== SAVE_SCHEMA_VERSION || !Number.isInteger(value.gold) || Number(value.gold) < 0) return false
  if (!isCaravan(value.caravan) || !Number.isInteger(value.stashLimit) || Number(value.stashLimit) < 0) return false
  if (!Array.isArray(value.stash) || !value.stash.every(isItem)) return false
  if (!Array.isArray(value.unlockedRegionIds) || !value.unlockedRegionIds.every((id) => typeof id === 'string' && Boolean(id))) return false
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) return false
  if (!Number.isFinite(Date.parse(String(value.createdAt))) || !Number.isFinite(Date.parse(String(value.updatedAt)))) return false
  return isPublicRound(value.visitRound) && Array.isArray(value.visitHistory) && value.visitHistory.every(isPublicRound)
}

function isReplayResponse(value: unknown): value is PublicSaveGame | CommandSuccess {
  if (isPublicSaveGame(value)) return true
  if (!(isPlainRecord(value) && hasOnlyKeys(value, ['requestId', 'revision', 'game'])
    && typeof value.requestId === 'string' && Boolean(value.requestId)
    && Number.isInteger(value.revision) && isPlainRecord(value.game)
    && value.game.contractVersion === 'v2-etapa0-4' && value.game.revision === value.revision)) return false
  try {
    validateGameView(value.game)
    return true
  } catch {
    return false
  }
}

function isPublicRound(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'number', 'slots', 'createdAt'])) return false
  if (typeof value.id !== 'string' || !value.id || !Number.isInteger(value.number) || !Number.isFinite(Date.parse(String(value.createdAt)))) return false
  return Array.isArray(value.slots) && value.slots.every((slot) => isPlainRecord(slot)
    && hasOnlyKeys(slot, ['id', 'visitor', 'nextArrivalCheckAt'])
    && typeof slot.id === 'string' && Boolean(slot.id)
    && (slot.nextArrivalCheckAt === undefined || Number.isFinite(Date.parse(String(slot.nextArrivalCheckAt))))
    && (slot.visitor === undefined || isPublicVisitor(slot.visitor)))
}

function isPublicVisitor(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'id', 'name', 'class', 'level', 'origin', 'equipmentSummary', 'state', 'budget', 'initialBudget',
    'acceptedItemTypes', 'interestedItemTypes', 'offers', 'buyQuotes', 'trades', 'power',
    'commissionOptions', 'commission', 'arrivedAt', 'departedAt'
  ])) return false
  if (!Array.isArray(value.offers)) return false
  const offers: PersistedVisitorOffer[] = []
  for (const offer of value.offers) {
    if (!isPlainRecord(offer) || !hasOnlyKeys(offer, ['id', 'item', 'price', 'purchasedAt']) || !isItem(offer.item)) return false
    if (typeof offer.id !== 'string' || !offer.id || !Number.isInteger(offer.price)) return false
    if (offer.purchasedAt !== undefined && !Number.isFinite(Date.parse(String(offer.purchasedAt)))) return false
    offers.push({ id: offer.id, itemId: offer.item.id, price: Number(offer.price), ...(offer.purchasedAt ? { purchasedAt: String(offer.purchasedAt) } : {}) })
  }
  let commission: PersistedVisitorCommission | undefined
  if (value.commission !== undefined) {
    if (!isPlainRecord(value.commission) || !hasOnlyKeys(value.commission, [
      'optionId', 'title', 'regionId', 'durationMs', 'successChance', 'fullRewardGold', 'partialRewardGold',
      'riskLevel', 'failureConsequence', 'id', 'status', 'startedAt', 'finishesAt', 'outcome',
      'rewardGold', 'rewardItem', 'claimedAt'
    ])) return false
    const { rewardItem, ...rest } = value.commission
    if (rewardItem !== undefined && !isItem(rewardItem)) return false
    commission = { ...rest, outcomeRoll: 0, ...(rewardItem ? { rewardItemId: rewardItem.id } : {}) } as PersistedVisitorCommission
  }
  const { offers: _offers, commission: _commission, ...rest } = value
  return isPersistedVisitor({ ...rest, offers, ...(commission ? { commission } : {}) })
}

function containsInternalFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const keys = new Set(Object.keys(value as object))
  if (['_id', 'userId', '_v2VisitorStates', 'requestRecords', 'businessKeys', 'ledger', 'itemsById', 'itemPlacements', 'expeditionsById', 'recoveriesById', 'settlementsById', 'serviceJobsById', 'itemV2ById', 'serviceJobStateById', 'visitorCycle', 'processedRequestIds', 'processedRequests', 'outcomeRoll']
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
  placements: Record<string, PersistedItemPlacement>,
  previous: PersistedGameV3 | undefined,
  generatedItemStates: Record<string, PersistedItemV2State>,
  dependencies: PersistenceDependencies
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
        const loot = rewardItem ? rewardLootForCommission(visitor.commission, previous, generatedItemStates, dependencies) : undefined
        if (loot) {
          const previousPlacement = previous?.itemPlacements[loot.item.id]
          const claimedFallbackPlacement = previousPlacement
            && (previousPlacement.ownerKind !== 'caravan' || previousPlacement.custodyKind !== 'stash')
            ? previousPlacement
            : undefined
          const alreadyPlaced = placements[loot.item.id]
          if (visitor.commission.status !== 'claimed') {
            registerItem(items, placements, loot.item, {
              ownerKind: 'visitor', ownerId: visitor.id, custodyKind: 'visitor', custodyId: visitor.id
            })
          } else if (!alreadyPlaced && claimedFallbackPlacement) {
            registerItem(items, placements, loot.item, structuredClone(claimedFallbackPlacement))
          }
        }
        commission = { ...structuredClone(rest), ...(loot ? { rewardItemId: loot.item.id } : {}) }
      }
      return { ...structuredClone(slot), visitor: { ...structuredClone(visitor), offers, commission } }
    })
  }
}

function rewardLootForCommission(
  commission: VisitorCommission,
  previous: PersistedGameV3 | undefined,
  generatedItemStates: Record<string, PersistedItemV2State>,
  dependencies: PersistenceDependencies
): { item: Item; state: PersistedItemV2State } {
  const businessKey = `loot:${commission.id}:reward`
  const previousRewardItemId = previous ? previousRewardIdForCommission(previous, commission.id) : undefined
  const existing = previousRewardItemId && previous?.itemV2ById[previousRewardItemId]?.provenance?.businessKey === businessKey
    ? [previousRewardItemId, previous.itemV2ById[previousRewardItemId]!] as const
    : previous
      ? Object.entries(previous.itemV2ById).filter(([, state]) => state.provenance?.businessKey === businessKey).at(0)
      : undefined
  if (existing) {
    const [itemId, state] = existing
    const item = previous?.itemsById[itemId]
    if (item) return { item: structuredClone(item), state: structuredClone(state) }
  }
  const generated = generateLootForZone({
    zoneId: commission.regionId,
    businessKey,
    droppedAt: commission.finishesAt
  }, dependencies)
  generatedItemStates[generated.item.id] = generated.state
  return generated
}

function previousRewardIdForCommission(previous: PersistedGameV3, commissionId: string): string | undefined {
  for (const round of [previous.visitRound, ...previous.visitHistory]) {
    const commission = round.slots.find((slot) => slot.visitor?.commission?.id === commissionId)?.visitor?.commission
    if (commission?.rewardItemId) return commission.rewardItemId
  }
  return undefined
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

function pruneEmptyOrphanedLifecycle(
  expeditions: Record<string, PersistedCustodyContainer>,
  settlements: Record<string, PersistedCustodyContainer>,
  recoveries: Record<string, PersistedCustodyContainer>,
  current: PersistedVisitRound,
  history: PersistedVisitRound[]
): void {
  const visitorIds = new Set([current, ...history].flatMap((round) =>
    round.slots.flatMap((slot) => slot.visitor ? [slot.visitor.id] : [])))
  for (const [expeditionId, expedition] of Object.entries(expeditions)) {
    const projection = expedition.projection
    if (projection?.kind !== 'expedition' || visitorIds.has(projection.visitorId)) continue
    const dependentSettlements = Object.entries(settlements)
      .filter(([, container]) => container.projection?.kind === 'settlement' && container.projection.expeditionId === expeditionId)
    const dependentRecoveries = Object.entries(recoveries)
      .filter(([, container]) => container.projection?.kind === 'recovery' && container.projection.sourceExpeditionId === expeditionId)
    if (expedition.itemIds.length > 0
      || dependentSettlements.some(([, container]) => container.itemIds.length > 0)
      || dependentRecoveries.some(([, container]) => container.itemIds.length > 0)) continue
    for (const [id] of dependentSettlements) delete settlements[id]
    for (const [id] of dependentRecoveries) delete recoveries[id]
    delete expeditions[expeditionId]
  }
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

export type PublicSaveGame = Omit<SaveGame, '_id' | 'userId' | '_effectiveCapacityUsed' | '_v2VisitorStates' | 'processedRequestIds' | 'processedRequests'>

export function sanitizeGameResponse(save: SaveGame): SaveGame {
  return stripPrivateFields(save) as SaveGame
}

function stripPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateFields)
  if (value && typeof value === 'object') {
    const privateKeys = new Set(['_id', 'userId', '_effectiveCapacityUsed', '_v2VisitorStates', 'requestRecords', 'businessKeys', 'ledger', 'itemsById', 'itemPlacements', 'itemV2ById', 'serviceJobStateById', 'visitorCycle', 'processedRequestIds', 'processedRequests', 'outcomeRoll'])
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
