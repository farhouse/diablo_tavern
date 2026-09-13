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
  if (command.operation !== 'return') requireAuthoritativeTarget(current, command)

  const game = structuredClone(current)
  removeFromCustodyContainers(game, command.itemId)
  let to: PersistedItemPlacement
  let goldDelta = 0
  const materialDeltas: Record<string, number> = {}

  if (command.operation === 'return') {
    if (from.ownerKind !== 'caravan' || from.custodyKind === 'stash') throw transitionError('Only an item away from stash can return')
    if (from.custodyId !== command.targetId) throw transitionError('Return target does not match current authoritative custody')
    to = { ownerKind: 'caravan', custodyKind: 'stash' }
    if (!game.stash.includes(command.itemId)) game.stash.push(command.itemId)
  } else {
    requireAvailableInStash(from)
    game.stash = game.stash.filter((itemId) => itemId !== command.itemId)
    switch (command.operation) {
      case 'sell':
        if (!hasVisitor(game, command.targetId)) throw transitionError('Target visitor does not exist')
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
  addToCustodyContainer(game, command.itemId, to)
  if (effectiveCapacityUsed(game) > game.stashLimit) throw transitionError('Caravan capacity exceeded')
  return { game, effect: { goldDelta, materialDeltas, from: structuredClone(from), to: structuredClone(to) } }
}

function hasVisitor(game: PersistedGameV3, visitorId: string): boolean {
  return [game.visitRound, ...game.visitHistory].some((round) =>
    round.slots.some((slot) => slot.visitor?.id === visitorId)
  )
}

function removeFromCustodyContainers(game: PersistedGameV3, itemId: string): void {
  for (const [kind, containers] of Object.entries({
    expedition: game.expeditionsById,
    recovery: game.recoveriesById,
    settlement: game.settlementsById,
    service: game.serviceJobsById
  })) {
    for (const [id, container] of Object.entries(containers)) {
      const containedItem = container.itemIds.includes(itemId)
      container.itemIds = container.itemIds.filter((candidate) => candidate !== itemId)
      // Expeditions and their settlement/recovery history are authoritative
      // lifecycle records. Service jobs end when their only item leaves.
      if (kind === 'service' && containedItem && container.itemIds.length === 0) delete containers[id]
    }
  }
}

function addToCustodyContainer(game: PersistedGameV3, itemId: string, placement: PersistedItemPlacement): void {
  const maps = {
    expedition: game.expeditionsById,
    recovery: game.recoveriesById,
    settlement: game.settlementsById,
    service: game.serviceJobsById
  }
  if (!(placement.custodyKind in maps)) return
  const containers = maps[placement.custodyKind as keyof typeof maps]
  const id = placement.custodyId!
  const existing = containers[id]
  if (!existing) throw transitionError(`Authoritative ${placement.custodyKind} target does not exist`)
  existing.itemIds.push(itemId)
}

function requireAuthoritativeTarget(game: PersistedGameV3, command: ItemTransitionCommand): void {
  const maps = {
    loan: game.expeditionsById,
    service: game.serviceJobsById,
    recover: game.recoveriesById
  }
  const containers = maps[command.operation as keyof typeof maps]
  const target = containers?.[command.targetId]
  if (containers && !target) {
    throw transitionError(`Authoritative ${command.operation} target does not exist`)
  }
  if (command.operation === 'service' && target!.itemIds.length > 0) {
    throw transitionError('Authoritative service target already has an item')
  }
}

function requireAvailableInStash(placement: PersistedItemPlacement): void {
  if (placement.ownerKind !== 'caravan' || placement.custodyKind !== 'stash') {
    throw transitionError('Item is not available in caravan stash')
  }
}

function transitionError(message: string): ItemTransitionError {
  return new ItemTransitionError(message)
}
