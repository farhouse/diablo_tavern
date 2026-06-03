import type { HeroClass } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { createHero, touchSave, normalizeSaveGame, getHeroCapacity, getActiveHeroCount, getHireCost } from '~/utils/game-logic'
import { heroClassStats } from '~/utils/game-data'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readRequiredBody(event)
  const heroClass = requireString(body.class, 'class') as HeroClass
  if (!(heroClass in heroClassStats)) throw createError({ statusCode: 400, statusMessage: 'Invalid hero class' })

  const save = normalizeSaveGame(await getSaveGame(user.id))
  const hireCost = getHireCost(save)
  if (save.gold < hireCost) throw createError({ statusCode: 400, statusMessage: 'Not enough gold' })
  if (getActiveHeroCount(save) >= getHeroCapacity(save)) throw createError({ statusCode: 400, statusMessage: 'Hero roster is full. Upgrade Wagons.' })

  save.gold -= hireCost
  save.heroes.push(createHero(heroClass))
  return replaceSaveGame(touchSave(save))
})
