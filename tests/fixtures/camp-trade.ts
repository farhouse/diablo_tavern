import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GameView, ItemView } from '../../shared/types/v2-game-view'

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts/v2-etapa0-4/fixtures.json'), 'utf8')) as { integratedPositiveCases: Array<{ id: string; value: GameView }> }

export function campTradeFixture(): GameView {
  const game = structuredClone(fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-contract')!.value)
  const visitor = game.visitors[0]
  if (!visitor || visitor.state !== 'available') throw new Error('Expected contract visitor')
  const action = visitor.actions.find((candidate) => candidate.action === 'accept_contract')
  if (!action?.enabled || action.action !== 'accept_contract') throw new Error('Expected accept action')

  game.items = Array.from({ length: 20 }, (_, index): ItemView => ({
    itemId: `loan-${index + 1}`,
    name: { key: index < 6 ? 'item.sword' : `item.${index}`, fallback: index < 6 ? 'Espada del alba' : index === 19 ? 'Reliquia no disponible' : `Equipo de viaje ${index + 1}` },
    slot: index < 6 ? 'weapon' : index % 2 ? 'armor' : 'accessory',
    rarity: 'rare',
    level: index === 4 ? 7 : 4,
    owner: { kind: 'caravan' },
    custody: { kind: 'stash' },
    identification: 'identified',
    affixes: [{ affixId: 'strength', name: { key: 'affix.strength', fallback: 'Fuerza' }, valueText: { key: index === 5 ? 'affix.eight' : 'affix.three', fallback: index === 5 ? '+8' : '+3' } }],
    activeImprint: null,
    actions: []
  }))
  game.capacity = { ...game.capacity, used: 20, limit: 30 }
  visitor.contractOptions.push({ ...visitor.contractOptions[0]!, optionId: 'o2', label: { key: 'contract.limited', fallback: 'Préstamo limitado' } })
  action.execution.bindings = [
    { ...action.execution.bindings[0]!, eligibleLoanItemIds: game.items.slice(0, 19).map((item) => item.itemId) },
    { ...action.execution.bindings[0]!, optionId: 'o2', eligibleLoanItemIds: ['loan-2', 'loan-3'] }
  ]
  return game
}
