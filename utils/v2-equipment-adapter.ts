import type {
  ActionAvailability,
  GameView,
  ItemView,
  ActionId,
  EnabledAction
} from '~/shared/types/v2-game-view'

export type EquipmentAction = Extract<ActionId, 'identify_item' | 'queue_blacksmith_job' | 'queue_enchanter_job' | 'dismantle_item' | 'replace_boss_imprint'>
export type EquipmentEnabledAction = Extract<EnabledAction, { action: EquipmentAction }>

export type EquipmentSelection = {
  itemId: string
  action: EquipmentAction
  optionId: string
  acknowledgementId?: string
  revision: number
}

export type EquipmentCommandPayload = {
  itemId: string
  optionId: string
  acknowledgementId?: string
}

export function itemAction(item: ItemView, action: EquipmentAction): EquipmentEnabledAction | null {
  const candidate = item.actions.find((entry) => entry.action === action)
  return candidate?.enabled && ['identify_item', 'queue_blacksmith_job', 'queue_enchanter_job', 'dismantle_item', 'replace_boss_imprint'].includes(candidate.action)
    ? candidate as EquipmentEnabledAction
    : null
}

export function equipmentActionPayload(game: GameView, itemId: string, action: EquipmentEnabledAction, optionId: string, acknowledgementId?: string): EquipmentCommandPayload {
  if (action.targetId !== itemId || action.execution.itemId !== itemId) throw new Error('La autorización no corresponde al objeto seleccionado')
  const option = action.execution.options.find((entry) => entry.optionId === optionId)
  if (!option) throw new Error('La opción de servicio ya no está disponible')
  const requiresAcknowledgement = action.action === 'dismantle_item' || action.action === 'replace_boss_imprint'
  if (requiresAcknowledgement && !acknowledgementId) throw new Error('Falta confirmar la consecuencia irreversible')
  if (!requiresAcknowledgement && acknowledgementId !== undefined) throw new Error('La acción no admite acknowledgement')
  if (requiresAcknowledgement && (!isAcknowledgedOption(option) || option.acknowledgement.acknowledgementId !== acknowledgementId)) throw new Error('La confirmación no corresponde a la opción')
  if (!game.items.some((item) => item.itemId === itemId)) throw new Error('El objeto ya no existe en el snapshot')
  return { itemId, optionId, ...(acknowledgementId ? { acknowledgementId } : {}) }
}

function isAcknowledgedOption(option: unknown): option is { acknowledgement: { acknowledgementId: string } } {
  return typeof option === 'object' && option !== null && 'acknowledgement' in option
    && typeof option.acknowledgement === 'object' && option.acknowledgement !== null
    && 'acknowledgementId' in option.acknowledgement && typeof option.acknowledgement.acknowledgementId === 'string'
}

export function selectionFor(game: GameView, itemId: string, action: EquipmentAction, optionId: string, acknowledgementId?: string): EquipmentSelection | null {
  const item = game.items.find((entry) => entry.itemId === itemId)
  const authorized = item && itemAction(item, action)
  if (!item || !authorized) return null
  equipmentActionPayload(game, itemId, authorized, optionId, acknowledgementId)
  return { itemId, action, optionId, ...(acknowledgementId ? { acknowledgementId } : {}), revision: game.revision }
}

export function invalidateEquipmentSelection(game: GameView | null, selection: EquipmentSelection | null): EquipmentSelection | null {
  if (!game || !selection || selection.revision !== game.revision) return null
  try {
    return selectionFor(game, selection.itemId, selection.action, selection.optionId, selection.acknowledgementId)
  } catch {
    return null
  }
}
