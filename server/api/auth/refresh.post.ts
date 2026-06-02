import jwt from 'jsonwebtoken'
import { ObjectId, type Filter } from 'mongodb'
import { createAccessToken, createRefreshToken, hashRefreshToken, publicUser, serializeUser, verifyRefreshTokenHash } from '~/server/utils/auth'
import { type DbUser, usersCollection } from '~/server/utils/db'
import { readRequiredBody, requireString } from '~/server/utils/body'

export default defineEventHandler(async (event) => {
  const body = await readRequiredBody(event)
  const refreshToken = requireString(body.refreshToken, 'refreshToken')
  const config = useRuntimeConfig()

  let userId = ''
  try {
    const payload = jwt.verify(refreshToken, config.jwtSecret) as { sub: string }
    userId = payload.sub
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid refresh token' })
  }

  const users = await usersCollection()
  const dbUser = await users.findOne({ _id: new ObjectId(userId) } as Filter<DbUser>)
  if (!dbUser?.refreshTokenHash || !(await verifyRefreshTokenHash(refreshToken, dbUser.refreshTokenHash))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid refresh token' })
  }

  const user = serializeUser(dbUser)
  const nextRefreshToken = createRefreshToken(user)
  await users.updateOne({ _id: new ObjectId(userId) } as Filter<DbUser>, {
    $set: { refreshTokenHash: await hashRefreshToken(nextRefreshToken), updatedAt: new Date().toISOString() }
  })

  return {
    user: publicUser(user),
    accessToken: createAccessToken(user),
    refreshToken: nextRefreshToken
  }
})
