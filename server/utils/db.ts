import { MongoClient, MongoServerError, ObjectId, type Collection, type Db, type Document } from 'mongodb'
import type { User } from '~/types/game'
import { resolveServerRuntimeConfig } from '~/server/utils/runtime-config'

export type DbUser = Omit<User, '_id'> & { _id?: ObjectId }
export type DbSaveGame = { userId: string; _id?: ObjectId; [key: string]: unknown }
export type DbChronicleEvent = { userId: string; eventId: string; eventKey: string; type: string; occurredAt: string; subject: { kind: string; id: string }; data: Record<string, string> }

let client: MongoClient | undefined
let db: Db | undefined

export async function getDb(): Promise<Db> {
  if (db) return db

  const config = resolveServerRuntimeConfig(useRuntimeConfig())
  validateDatabaseConfig(config)
  client = client || new MongoClient(config.mongoUri)
  await client.connect()
  db = client.db(config.mongoDbName)
  await ensureIndexes(db)
  return db
}

export function validateDatabaseConfig(config: { mongoUri?: unknown; mongoDbName?: unknown }): void {
  if (typeof config.mongoUri !== 'string' || !config.mongoUri.trim()) throw new Error('MONGO_URI is required')
  if (!/^mongodb(?:\+srv)?:\/\//.test(config.mongoUri)) throw new Error('MONGO_URI must use mongodb:// or mongodb+srv://')
  if (typeof config.mongoDbName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.mongoDbName)) {
    throw new Error('MONGO_DB_NAME must be 1-64 safe characters')
  }
}

export async function usersCollection(): Promise<Collection<DbUser>> {
  return (await getDb()).collection<DbUser>('users')
}

export async function saveGamesCollection(): Promise<Collection<DbSaveGame>> {
  return (await getDb()).collection<DbSaveGame>('savegames')
}

export async function chronicleEventsCollection(): Promise<Collection<DbChronicleEvent>> {
  return (await getDb()).collection<DbChronicleEvent>('chronicleEvents')
}

export async function ensureIndexes(database: Db) {
  await ensureIndex(database.collection<User>('users'), { email: 1 }, true)
  await ensureIndex(database.collection<DbSaveGame>('savegames'), { userId: 1 }, true)
  await ensureIndex(database.collection<DbChronicleEvent>('chronicleEvents'), { userId: 1, eventId: 1 }, true)
  await ensureIndex(database.collection<DbChronicleEvent>('chronicleEvents'), { userId: 1, occurredAt: -1, eventId: -1 }, false)
}

async function ensureIndex<TSchema extends Document>(
  collection: Collection<TSchema>,
  key: Record<string, 1 | -1>,
  unique: boolean
): Promise<void> {
  let indexes: Array<{ key?: Record<string, unknown>; unique?: boolean }>
  try {
    indexes = await collection.listIndexes().toArray()
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 26) throw error
    indexes = []
  }
  const entries = Object.entries(key)
  const equivalent = indexes.some((index) => {
    const indexEntries = Object.entries(index.key ?? {})
    return Boolean(index.unique) === unique
      && indexEntries.length === entries.length
      && entries.every(([field, direction], position) => {
        const candidate = indexEntries[position]
        return candidate?.[0] === field && candidate[1] === direction
      })
  })
  if (!equivalent) await collection.createIndex(key, unique ? { unique: true } : undefined)
}
