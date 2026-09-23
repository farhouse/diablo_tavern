import { requireUser } from '~/server/utils/auth'
import { listChronicle } from '~/server/domain/chronicle'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const rawLimit = Number(query.limit ?? 50)
  const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined
  return listChronicle(user.id, cursor, limit)
})
