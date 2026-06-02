import type { Filter } from 'mongodb'
import type { SaveGame } from '~/types/game'
import { createSaveGame, normalizeSaveGame } from '~/utils/game-logic'
import { type DbSaveGame, saveGamesCollection } from '~/server/utils/db'

export async function getSaveGame(userId: string): Promise<SaveGame> {
  const saves = await saveGamesCollection()
  const existing = await saves.findOne({ userId } as Filter<DbSaveGame>)
  if (existing) return serializeSave(existing)

  const save = createSaveGame(userId)
  const { _id, ...document } = save
  const result = await saves.insertOne(document)
  return { ...save, _id: String(result.insertedId) }
}

export async function replaceSaveGame(save: SaveGame): Promise<SaveGame> {
  normalizeSaveGame(save)
  const saves = await saveGamesCollection()
  const { _id, ...document } = save
  await saves.replaceOne({ userId: save.userId } as Filter<DbSaveGame>, document, { upsert: true })
  return save
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
