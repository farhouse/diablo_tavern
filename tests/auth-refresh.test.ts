import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { ObjectId } from 'mongodb'

const { usersCollection } = vi.hoisted(() => ({
  usersCollection: {
    findOne: vi.fn(),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 }))
  }
}))

vi.mock('../server/utils/db', () => ({
  usersCollection: async () => usersCollection
}))

const originalJwtSecret = process.env.JWT_SECRET
const originalNuxtJwtSecret = process.env.NUXT_JWT_SECRET

describe('POST /api/auth/refresh', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.JWT_SECRET = 'runtime-only-secret'
    delete process.env.NUXT_JWT_SECRET
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({ jwtSecret: 'compiled-default-secret' }))
    vi.stubGlobal('createError', (definition: Record<string, unknown>) => Object.assign(
      new Error(String(definition.statusMessage)),
      definition
    ))
  })

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = originalJwtSecret
    if (originalNuxtJwtSecret === undefined) delete process.env.NUXT_JWT_SECRET
    else process.env.NUXT_JWT_SECRET = originalNuxtJwtSecret
  })

  it('verifies refresh tokens with the same runtime-only secret used to sign them', async () => {
    const { createRefreshToken, hashRefreshToken } = await import('../server/utils/auth')
    const user = {
      _id: new ObjectId(),
      email: 'refresh@example.test',
      passwordHash: 'unused',
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z'
    }
    const refreshToken = createRefreshToken({ ...user, _id: String(user._id) })
    usersCollection.findOne.mockResolvedValueOnce({
      ...user,
      refreshTokenHash: await hashRefreshToken(refreshToken)
    })
    vi.stubGlobal('readBody', async () => ({ refreshToken }))

    const { default: handler } = await import('../server/api/auth/refresh.post')
    const response = await handler({} as never)

    expect(jwt.verify(response.refreshToken, 'runtime-only-secret')).toMatchObject({ sub: String(user._id) })
    expect(response.user).toEqual({ id: String(user._id), email: user.email })
    expect(usersCollection.updateOne).toHaveBeenCalledOnce()
  })
})
