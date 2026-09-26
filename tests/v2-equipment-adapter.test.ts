import { describe, expect, it } from 'vitest'
import { equipmentActionPayload } from '../utils/v2-equipment-adapter'
import type { GameView } from '../shared/types/v2-game-view'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'

const allCases = [...fixtures.retainedPositiveCases, ...fixtures.integratedPositiveCases] as Array<{ id: string; value: unknown }>
const view = allCases.find((entry) => entry.id === 'integrated-services')?.value as GameView

describe('v2 equipment adapter', () => {
  it('builds a payload only from the matching sealed item binding', () => {
    expect(view).toBeDefined()
    const item = view!.items.find((entry) => entry.itemId === 'i1')!
    const action = item.actions.find((entry) => entry.action === 'identify_item' && entry.enabled)
    expect(action?.enabled).toBe(true)
    if (!action || !action.enabled) return
    expect(equipmentActionPayload(view!, item.itemId, action, action.execution.options[0]!.optionId)).toMatchObject({
      itemId: 'i1',
      optionId: action.execution.options[0]!.optionId
    })
  })

  it('rejects a mixed item or option binding', () => {
    expect(view).toBeDefined()
    const item = view!.items.find((entry) => entry.itemId === 'i1')!
    const action = item.actions.find((entry) => entry.action === 'identify_item' && entry.enabled)
    if (!action || !action.enabled) return
    expect(() => equipmentActionPayload(view!, 'other-item', action, action.execution.options[0]!.optionId)).toThrow()
    expect(() => equipmentActionPayload(view!, item.itemId, action, 'foreign-option')).toThrow()
  })
})
