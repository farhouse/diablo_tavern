import type { CaravanUpgradeId } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation, requireMutationEnum } from '~/server/utils/visitor-api'
import { upgradeCaravan } from '~/utils/game-logic'

const validUpgrades: CaravanUpgradeId[] = ['stashWagon', 'appraiser']

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const body = await readMutation(event)
    const upgradeId = requireMutationEnum(body.upgradeId, 'upgradeId', validUpgrades)
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('upgrade', upgradeId), body.expectedRevision, body, (save, deps) => upgradeCaravan(save, upgradeId, deps.now()))
  })
})
