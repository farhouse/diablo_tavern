import { createAccessToken, createRefreshToken, hashRefreshToken, publicUser, serializeUser, verifyPassword } from '~/server/utils/auth'
import { usersCollection } from '~/server/utils/db'
import { readRequiredBody, requireString } from '~/server/utils/body'

export default defineEventHandler(async (event) => {
  const body = await readRequiredBody(event)
  const email = requireString(body.email, 'email').toLowerCase()
  const password = requireString(body.password, 'password')

  const users = await usersCollection()
  const dbUser = await users.findOne({ email })
  if (!dbUser || !(await verifyPassword(password, dbUser.passwordHash))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
  }

  const user = serializeUser(dbUser)
  const refreshToken = createRefreshToken(user)
  await users.updateOne({ email }, { $set: { refreshTokenHash: await hashRefreshToken(refreshToken), updatedAt: new Date().toISOString() } })

  return {
    user: publicUser(user),
    accessToken: createAccessToken(user),
    refreshToken
  }
})
