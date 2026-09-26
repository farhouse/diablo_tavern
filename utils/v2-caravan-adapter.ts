import type { GameView, UpgradeCaravanAction } from '~/shared/types/v2-game-view'

export type CaravanSelection = {
  optionId: string
  authorizationId: string
  revision: number
}

export function caravanUpgradeAction(game: GameView): UpgradeCaravanAction | null {
  const action = game.actions.find((candidate) => candidate.action === 'upgrade_caravan')
  return action?.enabled && action.action === 'upgrade_caravan' ? action : null
}

export function caravanUpgradePayload(game: GameView, selection: CaravanSelection): { optionId: string } {
  if (selection.revision !== game.revision) throw new Error('La revisión de la caravana cambió')
  const action = caravanUpgradeAction(game)
  if (!action || action.authorizationId !== selection.authorizationId) throw new Error('La autorización de mejora ya no está disponible')
  if (!action.execution.options.some((option) => option.optionId === selection.optionId)) throw new Error('La opción de mejora ya no está disponible')
  return { optionId: selection.optionId }
}

export function selectionForCaravanUpgrade(game: GameView, optionId: string): CaravanSelection | null {
  const action = caravanUpgradeAction(game)
  if (!action) return null
  try {
    caravanUpgradePayload(game, { optionId, authorizationId: action.authorizationId, revision: game.revision })
    return { optionId, authorizationId: action.authorizationId, revision: game.revision }
  } catch {
    return null
  }
}

export function invalidateCaravanSelection(game: GameView | null, selection: CaravanSelection | null): CaravanSelection | null {
  if (!game || !selection) return null
  try {
    return selectionForCaravanUpgrade(game, selection.optionId)?.authorizationId === selection.authorizationId
      ? selectionForCaravanUpgrade(game, selection.optionId)
      : null
  } catch {
    return null
  }
}
