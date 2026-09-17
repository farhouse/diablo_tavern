export * from './v2-game-view.generated'

import type { ActionAvailability, ActionId } from './v2-game-view.generated'

export const ACTION_IDS = [
  'accept_contract',
  'start_expedition',
  'reconcile_game',
  'confirm_settlement',
  'assign_recovery',
  'abandon_recovery',
  'sell_item_to_visitor',
  'identify_item',
  'queue_blacksmith_job',
  'queue_enchanter_job',
  'dismantle_item',
  'replace_boss_imprint',
  'upgrade_caravan'
] as const satisfies readonly ActionId[]

const ACTION_ID_EXHAUSTIVENESS = {
  accept_contract: true,
  start_expedition: true,
  reconcile_game: true,
  confirm_settlement: true,
  assign_recovery: true,
  abandon_recovery: true,
  sell_item_to_visitor: true,
  identify_item: true,
  queue_blacksmith_job: true,
  queue_enchanter_job: true,
  dismantle_item: true,
  replace_boss_imprint: true,
  upgrade_caravan: true
} satisfies Record<ActionId, true>

export function assertNever(value: never, context = 'Unexpected DTO variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`)
}

export function actionExecution(action: ActionAvailability): ActionAvailability['action'] {
  if (!action.enabled) return action.action
  switch (action.action) {
    case 'accept_contract':
    case 'start_expedition':
    case 'reconcile_game':
    case 'confirm_settlement':
    case 'assign_recovery':
    case 'abandon_recovery':
    case 'sell_item_to_visitor':
    case 'identify_item':
    case 'queue_blacksmith_job':
    case 'queue_enchanter_job':
    case 'dismantle_item':
    case 'replace_boss_imprint':
    case 'upgrade_caravan':
      return action.action
    default:
      return assertNever(action, 'Unhandled ActionAvailability')
  }
}

void ACTION_ID_EXHAUSTIVENESS
