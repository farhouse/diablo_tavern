import type { CaravanUpgradeId } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { upgradeCaravan } from '~/utils/game-logic'

const validUpgrades: CaravanUpgradeId[] = ['stashWagon', 'appraiser']

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readMutation(event)
  const upgradeId = requireString(body.upgradeId, 'upgradeId') as CaravanUpgradeId
  if (!validUpgrades.includes(upgradeId)) throw createError({ statusCode: 400, statusMessage: 'Invalid upgrade' })
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('upgrade', upgradeId), body.expectedRevision, (save) => upgradeCaravan(save, upgradeId))
  } catch (error) {
    mutationError(error, 'Cannot upgrade')
  }
})
