import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb'
import type { SaveGame, User } from '~/types/game'

export type DbUser = Omit<User, '_id'> & { _id?: ObjectId }
type MigratedSaveFields = 'visitRound' | 'visitHistory' | 'processedRequestIds' | 'revision'
export type DbSaveGame = Omit<SaveGame, '_id' | MigratedSaveFields>
  & Partial<Pick<SaveGame, MigratedSaveFields>>
  & { _id?: ObjectId }

let client: MongoClient | undefined
let db: Db | undefined

export async function getDb(): Promise<Db> {
  if (db) return db

  const config = useRuntimeConfig()
  client = client || new MongoClient(config.mongoUri)
  await client.connect()
  db = client.db(config.mongoDbName)
  await ensureIndexes(db)
  return db
}

export async function usersCollection(): Promise<Collection<DbUser>> {
  return (await getDb()).collection<DbUser>('users')
}

export async function saveGamesCollection(): Promise<Collection<DbSaveGame>> {
  return (await getDb()).collection<DbSaveGame>('savegames')
}

async function ensureIndexes(database: Db) {
  await database.collection<User>('users').createIndex({ email: 1 }, { unique: true })
  await database.collection<SaveGame>('savegames').createIndex({ userId: 1 }, { unique: true })
}
