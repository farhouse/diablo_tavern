import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { ObjectId, type Filter } from 'mongodb'
import type { H3Event } from 'h3'
import type { PublicUser, User } from '~/types/game'
import { type DbUser, usersCollection } from '~/server/utils/db'

const ACCESS_EXPIRES_IN = '20m'
const REFRESH_EXPIRES_IN = '14d'

interface TokenPayload {
  sub: string
  email: string
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function hashRefreshToken(token: string): Promise<string> {
  return bcrypt.hash(token, 10)
}

export async function verifyRefreshTokenHash(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash)
}

export function createAccessToken(user: User): string {
  return signToken(user, ACCESS_EXPIRES_IN)
}

export function createRefreshToken(user: User): string {
  return signToken(user, REFRESH_EXPIRES_IN)
}

export async function requireUser(event: H3Event): Promise<PublicUser> {
  const header = getHeader(event, 'authorization')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : getCookie(event, 'accessToken')
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Missing access token' })

  try {
    const config = useRuntimeConfig()
    const payload = jwt.verify(token, config.jwtSecret) as TokenPayload
    return { id: payload.sub, email: payload.email }
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid access token' })
  }
}

export async function findUserById(id: string): Promise<User | null> {
  if (!ObjectId.isValid(id)) return null
  const users = await usersCollection()
  const user = await users.findOne({ _id: new ObjectId(id) } as Filter<DbUser>)
  return user ? serializeUser(user) : null
}

export function publicUser(user: User): PublicUser {
  return {
    id: String(user._id),
    email: user.email
  }
}

function signToken(user: User, expiresIn: string): string {
  const config = useRuntimeConfig()
  const options: jwt.SignOptions = {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    subject: String(user._id)
  }
  return jwt.sign({ email: user.email }, String(config.jwtSecret), options)
}

export function serializeUser(user: DbUser): User {
  return {
    ...user,
    _id: user._id ? String(user._id) : undefined
  }
}
