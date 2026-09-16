// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import VisitorCycleV2 from '../components/VisitorCycleV2.vue'

const cases = fixtures.integratedPositiveCases as Array<{ id: string, value: GameView }>

function fixture(id: string): GameView {
  const match = cases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
  return structuredClone(match.value)
}

describe('VisitorCycleV2', () => {
  it('renders loading, empty and ready states with polite announcements', () => {
    const loading = mount(VisitorCycleV2, { props: { game: null, loadState: 'loading' } })
    expect(loading.find('[data-testid="v2-loading"]').exists()).toBe(true)
    expect(loading.get('[data-testid="v2-status"]').attributes('aria-live')).toBe('polite')

    const empty = mount(VisitorCycleV2, { props: { game: null, loadState: 'empty' } })
    expect(empty.text()).toContain('No hay datos V2 disponibles')

    const ready = mount(VisitorCycleV2, { props: { game: fixture('integrated-contract'), loadState: 'ready' } })
    expect(ready.get('[data-testid="v2-ready"]').text()).toContain('Ada')
    expect(ready.text()).toContain('Rev. 10')
  })

  it('emits exact UI intentions for contract, expedition, settlement and recovery actions', async () => {
    const contract = mount(VisitorCycleV2, { props: { game: fixture('integrated-contract'), loadState: 'ready' } })
    await contract.get('button').trigger('click')
    await contract.get('[data-testid="visitor-available"] button').trigger('click')
    expect(contract.emitted('acceptContract')?.[0]).toEqual([{ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }])

    const expedition = mount(VisitorCycleV2, { props: { game: fixture('integrated-expedition'), loadState: 'ready' } })
    await expedition.get('[data-testid="visitor-contracted"] button').trigger('click')
    expect(expedition.emitted('startExpedition')?.[0]).toEqual(['v1'])

    const settlement = mount(VisitorCycleV2, { props: { game: fixture('integrated-settlement'), loadState: 'ready' } })
    await settlement.get('[data-testid="settlement-preview_ready"] button').trigger('click')
    expect(settlement.emitted('confirmSettlement')?.[0]).toEqual([{ kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'renounce' } }])

    const recovery = mount(VisitorCycleV2, { props: { game: fixture('integrated-recovery'), loadState: 'ready' } })
    const buttons = recovery.findAll('[data-testid="recovery-open"] button')
    expect(buttons).toHaveLength(2)
    const [assignButton, abandonButton] = buttons
    if (!assignButton || !abandonButton) throw new Error('Expected recovery controls')
    await assignButton.trigger('click')
    await abandonButton.trigger('click')
    expect(recovery.emitted('assignRecovery')?.[0]).toEqual([{ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }])
    expect(recovery.emitted('abandonRecovery')?.[0]).toEqual([{ kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1' }])
  })

  it('disables controls while pending and exposes conflict, unavailable, uncertain and terminal states', async () => {
    const pending = mount(VisitorCycleV2, {
      props: { game: fixture('integrated-contract'), loadState: 'ready', operationState: 'pending' }
    })
    expect(pending.get('[data-testid="visitor-available"] button').attributes('disabled')).toBeDefined()
    expect(pending.get('[data-testid="visitor-available"] button').attributes('aria-describedby')).toBeUndefined()
    expect(pending.get('[data-testid="v2-status"]').text()).toContain('Procesando')

    const uncertain = mount(VisitorCycleV2, {
      props: { game: fixture('integrated-contract'), loadState: 'ready', operationState: 'uncertain' }
    })
    await uncertain.get('[data-testid="v2-retry"]').trigger('click')
    expect(uncertain.emitted('retry')).toHaveLength(1)

    const unavailable = mount(VisitorCycleV2, {
      props: {
        game: fixture('integrated-contract'),
        loadState: 'ready',
        operationState: 'unavailable',
        unavailableReason: 'OPTION_STALE'
      }
    })
    expect(unavailable.get('[data-testid="v2-status"]').text()).toContain('OPTION_STALE')

    const terminal = mount(VisitorCycleV2, {
      props: {
        game: fixture('integrated-contract'),
        loadState: 'ready',
        operationState: 'terminal',
        errorMessage: 'internal_error'
      }
    })
    expect(terminal.get('[data-testid="v2-status"]').text()).toContain('internal_error')

    const conflict = mount(VisitorCycleV2, {
      props: { game: fixture('integrated-contract'), loadState: 'ready', operationState: 'conflict' }
    })
    expect(conflict.get('[data-testid="v2-status"]').text()).toContain('snapshot actualizado')
  })

  it('represents terminal visitor, expedition, settlement and recovery variants from frontend-only derivatives', () => {
    const game = fixture('integrated-recovery')
    game.visitors = [
      { visitorId: 'departed', name: { key: 'v.departed', fallback: 'Iria' }, state: 'departed', actions: [], departedAt: '2026-09-14T10:30:00Z', lastExpeditionId: 'e-old' },
      { visitorId: 'dead', name: { key: 'v.dead', fallback: 'Nox' }, state: 'dead', actions: [], diedAt: '2026-09-14T10:30:00Z', expeditionId: 'e2', recoveryId: 'r2' }
    ]
    game.expeditions = [
      { expeditionId: 'e-settled', visitorId: 'departed', contractId: 'c1', state: 'settled', actions: [], outcome: 'death', settledAt: '2026-09-14T10:30:00Z', settlementId: 's2', visitorResolution: 'dead' }
    ]
    game.settlements = [
      { settlementId: 's-expired', expeditionId: 'e1', state: 'preview_expired', previewVersion: 1, outcome: 'returned', createdAt: '2026-09-14T10:30:00Z', expiresAt: '2026-09-14T11:30:00Z', gold: { gross: 1, caravan: 1, visitor: 0 }, loans: [], choiceGroups: [], departureSignal: 'unlikely', departureResolution: 'stays', actions: [] },
      { settlementId: 's-settled', expeditionId: 'e2', state: 'settled', outcome: 'returned', appliedAt: '2026-09-14T10:30:00Z', appliedBy: 'confirmation', appliedChoices: [], visitorResolution: 'departs', actions: [] }
    ]
    game.recoveries = [
      { recoveryId: 'r-assigned', sourceExpeditionId: 'e1', itemIds: ['i1'], state: 'assigned', actions: [], assignedVisitorId: 'v2', assignedAt: '2026-09-14T10:30:00Z', completesAt: '2026-09-14T11:30:00Z' },
      { recoveryId: 'r-recovered', sourceExpeditionId: 'e1', itemIds: ['i2'], state: 'recovered', actions: [], resolvedAt: '2026-09-14T10:30:00Z', recoveredItemIds: ['i2'] },
      { recoveryId: 'r-failed', sourceExpeditionId: 'e1', itemIds: ['i3'], state: 'failed', actions: [], resolvedAt: '2026-09-14T10:30:00Z', consequence: { kind: 'fail_recovery', irreversible: true, recoveryId: 'r-failed', destroyedItemIds: ['i3'], text: { key: 'failed', fallback: 'El equipo se perdió.' } } },
      { recoveryId: 'r-abandoned', sourceExpeditionId: 'e1', itemIds: ['i4'], state: 'abandoned', actions: [], resolvedAt: '2026-09-14T10:30:00Z', consequence: { kind: 'fail_recovery', irreversible: true, recoveryId: 'r-abandoned', destroyedItemIds: ['i4'], text: { key: 'abandoned', fallback: 'Abandono confirmado.' } } }
    ]

    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })

    expect(wrapper.text()).toContain('Iria')
    expect(wrapper.text()).toContain('Nox')
    expect(wrapper.text()).toContain('Estado terminal sin acciones disponibles')
    expect(wrapper.text()).toContain('Resultado cerrado: death')
    expect(wrapper.text()).toContain('Preview expirado según snapshot')
    expect(wrapper.text()).toContain('Asignado a v2')
    expect(wrapper.text()).toContain('El equipo se perdió.')
    expect(wrapper.text()).toContain('Abandono confirmado.')
  })

  it('keeps touch targets at 44px and includes reduced-motion fallback CSS', () => {
    const wrapper = mount(VisitorCycleV2, { props: { game: fixture('integrated-contract'), loadState: 'ready' } })
    const source = readFileSync(join(process.cwd(), 'components/VisitorCycleV2.vue'), 'utf8')

    expect(wrapper.html()).toContain('v2-cycle__button')
    expect(source).toContain('min-height: 44px')
    expect(source).toContain('prefers-reduced-motion')
  })
})
