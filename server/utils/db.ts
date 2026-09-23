import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb'
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

async function ensureIndexes(database: Db) {
  await database.collection<User>('users').createIndex({ email: 1 }, { unique: true })
  await database.collection<DbSaveGame>('savegames').createIndex({ userId: 1 }, { unique: true })
  await database.collection<DbChronicleEvent>('chronicleEvents').createIndex({ userId: 1, eventId: 1 }, { unique: true })
  await database.collection<DbChronicleEvent>('chronicleEvents').createIndex({ userId: 1, occurredAt: -1, eventId: -1 })
}
