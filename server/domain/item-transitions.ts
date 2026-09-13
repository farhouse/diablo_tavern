import type { PersistedGameV3, PersistedItemPlacement } from '~/server/utils/savegame'

export type ItemTransitionOperation = 'sell' | 'loan' | 'service' | 'recover' | 'return' | 'dismantle'

export interface ItemTransitionCommand {
  operation: ItemTransitionOperation
  itemId: string
  targetId: string
}

export interface ItemTransitionEffect {
  goldDelta: number
  materialDeltas: Record<string, number>
  from: PersistedItemPlacement
  to: PersistedItemPlacement
}

export class ItemTransitionError extends Error {
  override name = 'ItemTransitionError'
}

export function effectiveCapacityUsed(game: PersistedGameV3): number {
  return Object.values(game.itemPlacements).filter((placement) => placement.ownerKind === 'caravan').length
}

export function applyItemTransition(
  current: PersistedGameV3,
  command: ItemTransitionCommand
): { game: PersistedGameV3; effect: ItemTransitionEffect } {
  const item = current.itemsById[command.itemId]
  const from = current.itemPlacements[command.itemId]
  if (!item || !from) throw transitionError('Item does not exist')
  if (!command.targetId) throw transitionError('A targetId is required')

  const game = structuredClone(current)
  let to: PersistedItemPlacement
  let goldDelta = 0
  const materialDeltas: Record<string, number> = {}

  if (command.operation === 'return') {
    if (from.ownerKind !== 'caravan' || from.custodyKind === 'stash') throw transitionError('Only an item away from stash can return')
    to = { ownerKind: 'caravan', custodyKind: 'stash' }
    if (!game.stash.includes(command.itemId)) game.stash.push(command.itemId)
  } else {
    requireAvailableInStash(from)
    game.stash = game.stash.filter((itemId) => itemId !== command.itemId)
    switch (command.operation) {
      case 'sell':
        to = { ownerKind: 'visitor', ownerId: command.targetId, custodyKind: 'visitor', custodyId: command.targetId }
        goldDelta = Math.max(0, item.value)
        game.gold += goldDelta
        break
      case 'loan':
        to = { ownerKind: 'caravan', custodyKind: 'expedition', custodyId: command.targetId }
        break
      case 'service':
        to = { ownerKind: 'caravan', custodyKind: 'service', custodyId: command.targetId }
        break
      case 'recover':
        to = { ownerKind: 'caravan', custodyKind: 'recovery', custodyId: command.targetId }
        break
      case 'dismantle': {
        to = { ownerKind: 'tombstone', custodyKind: 'tombstone', custodyId: command.targetId }
        const scrap = Math.max(1, Math.floor(item.value / 10))
        materialDeltas.scrap = scrap
        game.materials.scrap = (game.materials.scrap ?? 0) + scrap
        break
      }
      default:
        throw transitionError('Unsupported item transition')
    }
  }

  game.itemPlacements[command.itemId] = to
  if (effectiveCapacityUsed(game) > game.stashLimit) throw transitionError('Caravan capacity exceeded')
  return { game, effect: { goldDelta, materialDeltas, from: structuredClone(from), to: structuredClone(to) } }
}

function requireAvailableInStash(placement: PersistedItemPlacement): void {
  if (placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') {
    throw transitionError('Item is not available in caravan stash')
  }
}

function transitionError(message: string): ItemTransitionError {
  return new ItemTransitionError(message)
}
