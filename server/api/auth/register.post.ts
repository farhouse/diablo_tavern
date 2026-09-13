import { createAccessToken, createRefreshToken, hashPassword, hashRefreshToken, publicUser } from '~/server/utils/auth'
import { type DbSaveGame, saveGamesCollection, usersCollection } from '~/server/utils/db'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { createPersistedGameV3 } from '~/server/utils/savegame'
import { resolveServerRuntimeConfig } from '~/server/utils/runtime-config'

export default defineEventHandler(async (event) => {
  const body = await readRequiredBody(event)
  const email = requireString(body.email, 'email').toLowerCase()
  const password = requireString(body.password, 'password')
  if (password.length < 6) throw createError({ statusCode: 400, statusMessage: 'Password must be at least 6 characters' })

  const config = resolveServerRuntimeConfig(useRuntimeConfig())
  const inviteCode = config.inviteCode
  if (inviteCode) {
    const providedCode = requireString(body.inviteCode, 'inviteCode')
    if (providedCode !== inviteCode) {
      throw createError({ statusCode: 403, statusMessage: 'Invalid invite code' })
    }
  }

  const users = await usersCollection()
  const existing = await users.findOne({ email })
  if (existing) throw createError({ statusCode: 409, statusMessage: 'Email is already registered' })

  const now = new Date().toISOString()
  const passwordHash = await hashPassword(password)
  const userResult = await users.insertOne({ email, passwordHash, createdAt: now, updatedAt: now })
  const user = { _id: String(userResult.insertedId), email, passwordHash, createdAt: now, updatedAt: now }
  const refreshToken = createRefreshToken(user)
  await users.updateOne({ _id: userResult.insertedId }, { $set: { refreshTokenHash: await hashRefreshToken(refreshToken) } })

  const saves = await saveGamesCollection()
  await saves.insertOne(createPersistedGameV3(String(userResult.insertedId)) as unknown as DbSaveGame)

  return {
    user: publicUser(user),
    accessToken: createAccessToken(user),
    refreshToken
  }
})
