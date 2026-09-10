import { requireUser } from '~/server/utils/auth'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  throw createError({ statusCode: 410, statusMessage: 'Hero quests were retired by the visitor commission system' })
})
