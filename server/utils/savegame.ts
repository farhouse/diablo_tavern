import type { Filter } from 'mongodb'
import type { SaveGame } from '~/types/game'
import { createSaveGame, normalizeSaveGame } from '~/utils/game-logic'
import { type DbSaveGame, saveGamesCollection } from '~/server/utils/db'

export async function getSaveGame(userId: string): Promise<SaveGame> {
  const saves = await saveGamesCollection()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await saves.findOne({ userId } as Filter<DbSaveGame>)
    if (!existing) {
      const save = createSaveGame(userId)
      const { _id, ...document } = save
      await saves.updateOne({ userId } as Filter<DbSaveGame>, { $setOnInsert: document }, { upsert: true })
      continue
    }
    const persistedVisitRound = JSON.stringify(existing.visitRound)
    const persistedVisitHistory = JSON.stringify(existing.visitHistory)
    const serialized = serializeSave(existing)
    const needsMigration = !('visitRound' in existing)
      || !('revision' in existing)
      || !('processedRequestIds' in existing)
      || !('processedRequests' in existing)
      || !('visitHistory' in existing)
    const visitStateChanged = persistedVisitRound !== JSON.stringify(serialized.visitRound)
      || persistedVisitHistory !== JSON.stringify(serialized.visitHistory)
    if (needsMigration || visitStateChanged) {
      const currentRevision = typeof existing.revision === 'number' ? existing.revision : 0
      serialized.revision = currentRevision + 1
      const { _id, ...document } = serialized
      const revisionFilter = typeof existing.revision === 'number'
        ? { revision: currentRevision }
        : { revision: { $exists: false } }
      const result = await saves.replaceOne({ _id: existing._id, ...revisionFilter } as Filter<DbSaveGame>, document)
      if (result.modifiedCount !== 1) continue
    }
    return serialized
  }
  throw new Error('Save changed concurrently; retry the operation')
}

export async function replaceSaveGame(save: SaveGame): Promise<SaveGame> {
  normalizeSaveGame(save)
  const saves = await saveGamesCollection()
  const currentRevision = save.revision
  save.revision += 1
  const { _id, ...document } = save
  const revisionFilter = currentRevision === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision: currentRevision }
  const result = await saves.replaceOne({ userId: save.userId, ...revisionFilter } as Filter<DbSaveGame>, document)
  if (result.modifiedCount !== 1) throw new Error('Save changed concurrently; retry the operation')
  return save
}

export async function mutateSaveGameAtomic(
  userId: string,
  requestId: string,
  operationKey: string,
  mutate: (save: SaveGame) => SaveGame | void
): Promise<SaveGame> {
  if (!requestId || requestId.length > 128) throw new Error('A valid requestId is required')
  if (!operationKey || operationKey.length > 512) throw new Error('A valid operationKey is required')
  const saves = await saveGamesCollection()

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentDocument = await saves.findOne({ userId } as Filter<DbSaveGame>)
    if (!currentDocument) {
      await getSaveGame(userId)
      continue
    }
    const rawProcessed = Array.isArray(currentDocument.processedRequests)
      ? currentDocument.processedRequests.find((entry) => entry.requestId === requestId)
      : undefined
    if (rawProcessed) {
      if (!rawProcessed.operationKey || rawProcessed.operationKey === operationKey) return getSaveGame(userId)
      throw new IdempotencyConflictError('requestId was already used for a different operation')
    }
    if (Array.isArray(currentDocument.processedRequestIds) && currentDocument.processedRequestIds.includes(requestId)) {
      return getSaveGame(userId)
    }
    const current = serializeSave(currentDocument)
    const processed = current.processedRequests.find((entry) => entry.requestId === requestId)
    if (processed) {
      if (!processed.operationKey || processed.operationKey === operationKey) return current
      throw new IdempotencyConflictError('requestId was already used for a different operation')
    }
    if (current.processedRequestIds.includes(requestId)) return current

    const currentRevision = current.revision
    const draft = structuredClone(current)
    const changed = mutate(draft) ?? draft
    normalizeSaveGame(changed, { refreshVisitors: false })
    changed.revision = currentRevision + 1
    changed.processedRequestIds = [...current.processedRequestIds, requestId].slice(-100)
    changed.processedRequests = [...current.processedRequests, { requestId, operationKey }].slice(-100)
    const { _id, ...replacement } = changed
    const revisionFilter = currentRevision === 0
      ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
      : { revision: currentRevision }
    const result = await saves.replaceOne({
      userId,
      ...revisionFilter,
      processedRequestIds: { $ne: requestId }
    } as Filter<DbSaveGame>, replacement)
    if (result.modifiedCount === 1) return changed
  }

  throw new Error('Save changed concurrently; retry with the same requestId')
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError'
}

export async function resetSaveGame(userId: string): Promise<SaveGame> {
  const save = createSaveGame(userId)
  const saves = await saveGamesCollection()
  await saves.replaceOne({ userId } as Filter<DbSaveGame>, save, { upsert: true })
  return save
}

export function serializeSave(save: SaveGame | DbSaveGame): SaveGame {
  return normalizeSaveGame({
    ...save,
    _id: save._id ? String(save._id) : undefined
  } as SaveGame)
}
