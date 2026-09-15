import { requireUser } from '~/server/utils/auth'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  throw createError({ statusCode: 410, statusMessage: 'Use V2 dismantle_item with sealed acknowledgement' })
})
