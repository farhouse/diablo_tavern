// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fixtures from '../contracts/v2-etapa0-4/fixtures.json'
import type { GameView, VisitorView } from '../shared/types/v2-game-view'
import VisitorCycleV2 from '../components/VisitorCycleV2.vue'

const cases = fixtures.integratedPositiveCases.map((candidate) => ({ id: candidate.id, value: candidate.value as GameView }))
const retainedCases = fixtures.retainedPositiveCases as Array<{ id: string, value: unknown }>

function fixture(id: string): GameView {
  const match = cases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
  return structuredClone(match.value)
}

describe('VisitorCycleV2', () => {
  beforeEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

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
    expect(abandonButton.attributes('disabled')).toBeDefined()
    await recovery.get('[data-testid="recovery-open"] input[type="checkbox"]').setValue(true)
    await abandonButton.trigger('click')
    expect(recovery.emitted('assignRecovery')?.[0]).toEqual([{ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }])
    expect(recovery.emitted('abandonRecovery')?.[0]).toEqual([{ kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1' }])
  })

  it('renders the published negotiating option label and emits its exact selection', async () => {
    const game = fixture('integrated-contract')
    const available = game.visitors[0]
    const retained = retainedCases.find((candidate) => candidate.id === 'visitor-negotiating')
    if (!available || !retained) throw new Error('Expected contract and negotiating fixtures')
    const negotiating = structuredClone(retained.value) as VisitorView
    negotiating.actions = structuredClone(available.actions)
    game.visitors = [negotiating]

    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })
    expect(wrapper.get('[data-testid="visitor-negotiating"] option').text()).toBe('Reparto estándar')
    await wrapper.get('[data-testid="visitor-negotiating"] button').trigger('click')
    expect(wrapper.emitted('acceptContract')).toEqual([[
      { kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }
    ]])
  })

  it('requires accepting the new acknowledgement after a frontend-only revision change', async () => {
    const game = fixture('integrated-recovery')
    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })
    const checkbox = wrapper.get('#v2-abandon-ack-0 input')
    const button = wrapper.get('.v2-cycle__button--danger')
    await checkbox.setValue(true)
    expect(button.attributes('disabled')).toBeUndefined()

    const replacement = fixture('integrated-recovery')
    replacement.revision = game.revision + 1
    const action = replacement.recoveries[0]?.actions.find((candidate) => candidate.action === 'abandon_recovery')
    if (!action || action.action !== 'abandon_recovery' || !action.enabled) throw new Error('Expected abandon action')
    action.execution.acknowledgement.acknowledgementId = 'ack-r1-new'
    action.execution.acknowledgement.text = { key: 'ack.new', fallback: 'Acepto las nuevas consecuencias.' }
    await wrapper.setProps({ game: replacement })

    expect(wrapper.get('#v2-abandon-ack-0').text()).toContain('Acepto las nuevas consecuencias.')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('abandonRecovery')).toBeUndefined()
    await checkbox.setValue(true)
    await button.trigger('click')
    expect(wrapper.emitted('abandonRecovery')).toEqual([[{
      kind: 'abandon_recovery', recoveryId: 'r1', acknowledgementId: 'ack-r1-new'
    }]])
    wrapper.unmount()
  })

  it('renders explicit binding and loan choices for contract and recovery', async () => {
    const contractGame = fixture('integrated-contract')
    const visitor = contractGame.visitors[0]
    if (!visitor || !('contractOptions' in visitor)) throw new Error('Expected contract visitor')
    visitor.contractOptions.push({
      ...visitor.contractOptions[0]!,
      optionId: 'o2',
      label: { key: 'contract.loan', fallback: 'Contrato con préstamo' }
    })
    const acceptAction = visitor.actions.find((action) => action.action === 'accept_contract' && action.enabled)
    if (!acceptAction || acceptAction.action !== 'accept_contract' || !acceptAction.enabled) throw new Error('Expected accept action')
    acceptAction.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: ['i1'], expiresAt: '2026-09-15T10:30:00Z' })

    const contract = mount(VisitorCycleV2, { props: { game: contractGame, loadState: 'ready' } })
    await contract.get('[data-testid="visitor-available"] select').setValue('o2')
    await contract.get('[data-testid="visitor-available"] input[type="checkbox"]').setValue(true)
    await contract.get('[data-testid="visitor-available"] button').trigger('click')
    expect(contract.emitted('acceptContract')?.[0]).toEqual([{ kind: 'contract', visitorId: 'v1', optionId: 'o2', loanItemIds: ['i1'] }])

    const recoveryGame = fixture('integrated-recovery')
    const recoveryView = recoveryGame.recoveries[0]
    if (!recoveryView) throw new Error('Expected recovery')
    const assignAction = recoveryView.actions.find((action) => action.action === 'assign_recovery' && action.enabled)
    if (!assignAction || assignAction.action !== 'assign_recovery' || !assignAction.enabled) throw new Error('Expected assign action')
    recoveryGame.visitors.push({
      ...structuredClone(recoveryGame.visitors[0]!),
      visitorId: 'v3',
      name: { key: 'visitor.v3', fallback: 'Cira' }
    })
    if (recoveryView.state !== 'open') throw new Error('Expected open recovery')
    recoveryView.options.push({
      ...structuredClone(recoveryView.options[0]!),
      optionId: 'ro2',
      label: { key: 'recovery.fast', fallback: 'Recuperación rápida' }
    })
    assignAction.execution.bindings.push({ visitorId: 'v3', optionId: 'ro2', eligibleLoanItemIds: ['i4'], expiresAt: '2026-09-15T10:30:00Z' })

    const recovery = mount(VisitorCycleV2, { props: { game: recoveryGame, loadState: 'ready' } })
    expect(recovery.get('[data-testid="recovery-open"] select').text()).toContain('Cira · Recuperación rápida')
    await recovery.get('[data-testid="recovery-open"] select').setValue(JSON.stringify(['v3', 'ro2']))
    await recovery.get('[data-testid="recovery-open"] input[type="checkbox"]').setValue(true)
    await recovery.get('[data-testid="recovery-open"] button').trigger('click')
    expect(recovery.emitted('assignRecovery')?.[0]).toEqual([{ kind: 'recovery', recoveryId: 'r1', visitorId: 'v3', optionId: 'ro2', loanItemIds: ['i4'] }])
  })

  it('keeps recovery bindings distinct when opaque IDs contain separators and renders only published copy', async () => {
    const game = fixture('integrated-recovery')
    const recovery = game.recoveries[0]
    if (!recovery || recovery.state !== 'open') throw new Error('Expected open recovery')
    const action = recovery.actions.find((candidate) => candidate.action === 'assign_recovery' && candidate.enabled)
    if (!action || action.action !== 'assign_recovery' || !action.enabled) throw new Error('Expected assign action')
    game.visitors = [
      { ...structuredClone(game.visitors[0]!), visitorId: 'a:b', name: { key: 'visitor.one', fallback: 'Alda' } },
      { ...structuredClone(game.visitors[0]!), visitorId: 'a', name: { key: 'visitor.two', fallback: 'Brena' } }
    ]
    recovery.options = [
      { ...structuredClone(recovery.options[0]!), optionId: 'c', label: { key: 'recovery.one', fallback: 'Ruta cauta' } },
      { ...structuredClone(recovery.options[0]!), optionId: 'b:c', label: { key: 'recovery.two', fallback: 'Ruta veloz' } }
    ]
    action.execution.bindings = [
      { visitorId: 'a:b', optionId: 'c', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' },
      { visitorId: 'a', optionId: 'b:c', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' }
    ]

    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })
    const select = wrapper.get('[data-testid="recovery-open"] select')
    expect(select.text()).toContain('Alda · Ruta cauta')
    expect(select.text()).toContain('Brena · Ruta veloz')
    expect(select.text()).not.toContain('a:b')
    expect(select.text()).not.toContain('b:c')

    await wrapper.get('[data-testid="recovery-open"] button').trigger('click')
    await select.setValue(JSON.stringify(['a', 'b:c']))
    await wrapper.get('[data-testid="recovery-open"] button').trigger('click')
    expect(wrapper.emitted('assignRecovery')).toEqual([
      [{ kind: 'recovery', recoveryId: 'r1', visitorId: 'a:b', optionId: 'c', loanItemIds: [] }],
      [{ kind: 'recovery', recoveryId: 'r1', visitorId: 'a', optionId: 'b:c', loanItemIds: [] }]
    ])
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
    expect(uncertain.get('[data-testid="visitor-available"] button').attributes('disabled')).toBeDefined()
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
      props: { game: fixture('integrated-contract'), loadState: 'ready', operationState: 'conflict', errorMessage: 'No se pudo actualizar', snapshotStale: true }
    })
    expect(conflict.get('[data-testid="v2-status"]').text()).toContain('No se pudo actualizar')
    expect(conflict.get('[data-testid="visitor-available"] button').attributes('disabled')).toBeDefined()
    await conflict.get('[data-testid="v2-reload"]').trigger('click')
    expect(conflict.emitted('reload')).toHaveLength(1)
  })

  it('derives reconcile availability from game actions and keeps signalling while a visible transition is due', async () => {
    const unavailable = mount(VisitorCycleV2, { props: { game: fixture('integrated-contract'), loadState: 'ready' } })
    expect(unavailable.get('header button').attributes('disabled')).toBeDefined()
    expect(unavailable.get('header button').attributes('aria-describedby')).toBe('reconcile-reason')
    expect(unavailable.get('#reconcile-reason').text()).toContain('Acción no publicada')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T10:30:00Z'))
    const game = fixture('integrated-system')
    game.serverNow = '2026-09-14T10:30:00Z'
    game.nextTransitionAt = '2026-09-14T10:30:01Z'
    const wrapper = mount(VisitorCycleV2, { attachTo: document.body, props: { game, loadState: 'ready' } })

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('reconcileDueTransition')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.emitted('reconcileDueTransition')).toHaveLength(3)
  })

  it('pauses transition checks while hidden and reconciles once after returning visible', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T10:30:00Z'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const game = fixture('integrated-system')
    game.serverNow = '2026-09-14T10:30:00Z'
    game.nextTransitionAt = '2026-09-14T10:30:01Z'
    const wrapper = mount(VisitorCycleV2, { attachTo: document.body, props: { game, loadState: 'ready' } })

    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.emitted('reconcileDueTransition')).toBeUndefined()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(wrapper.emitted('reconcileDueTransition')).toHaveLength(1)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(wrapper.emitted('reconcileDueTransition')).toHaveLength(2)
  })

  it('does not consume a due transition while pending or uncertain', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T10:30:00Z'))
    const game = fixture('integrated-system')
    game.serverNow = '2026-09-14T10:30:00Z'
    game.nextTransitionAt = '2026-09-14T10:30:01Z'
    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready', operationState: 'pending' } })

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('reconcileDueTransition')).toBeUndefined()

    await wrapper.setProps({ operationState: 'uncertain' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('reconcileDueTransition')).toBeUndefined()

    await wrapper.setProps({ operationState: 'idle' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('reconcileDueTransition')).toHaveLength(1)
  })

  it('resets contract and recovery selections when a newer snapshot removes the selected binding', async () => {
    const contractGame = fixture('integrated-contract')
    const visitor = contractGame.visitors[0]
    if (!visitor || !('contractOptions' in visitor)) throw new Error('Expected contract visitor')
    visitor.contractOptions.push({ ...visitor.contractOptions[0]!, optionId: 'o2', label: { key: 'contract.two', fallback: 'Contrato alterno' } })
    const acceptAction = visitor.actions.find((action) => action.action === 'accept_contract' && action.enabled)
    if (!acceptAction || acceptAction.action !== 'accept_contract' || !acceptAction.enabled) throw new Error('Expected accept action')
    acceptAction.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' })
    const contract = mount(VisitorCycleV2, { props: { game: contractGame, loadState: 'ready' } })
    await contract.get('[data-testid="visitor-available"] select').setValue('o2')

    const contractReplacement = fixture('integrated-contract')
    contractReplacement.revision = contractGame.revision + 1
    await contract.setProps({ game: contractReplacement })
    await contract.get('[data-testid="visitor-available"] button').trigger('click')
    expect(contract.emitted('acceptContract')?.[0]).toEqual([{ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] }])

    const recoveryGame = fixture('integrated-recovery')
    const recoveryView = recoveryGame.recoveries[0]
    if (!recoveryView) throw new Error('Expected recovery')
    const assignAction = recoveryView.actions.find((action) => action.action === 'assign_recovery' && action.enabled)
    if (!assignAction || assignAction.action !== 'assign_recovery' || !assignAction.enabled) throw new Error('Expected assign action')
    assignAction.execution.bindings.push({ visitorId: 'v3', optionId: 'ro2', eligibleLoanItemIds: [], expiresAt: '2026-09-15T10:30:00Z' })
    const recovery = mount(VisitorCycleV2, { props: { game: recoveryGame, loadState: 'ready' } })
    await recovery.get('[data-testid="recovery-open"] select').setValue(JSON.stringify(['v3', 'ro2']))

    const recoveryReplacement = fixture('integrated-recovery')
    recoveryReplacement.revision = recoveryGame.revision + 1
    await recovery.setProps({ game: recoveryReplacement })
    await recovery.get('[data-testid="recovery-open"] button').trigger('click')
    expect(recovery.emitted('assignRecovery')?.[0]).toEqual([{ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] }])
  })

  it('lets settlement choose one native option per required group with keyboard focus', async () => {
    const game = fixture('integrated-settlement')
    const settlement = game.settlements[0]
    if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement fixture')
    settlement.choiceGroups[0]!.options.push({
      optionId: 'keep-foreign',
      label: { key: 'option.keep', fallback: 'Conservar botín' },
      itemIds: ['reward1'],
      capacityDelta: 1,
      consequences: []
    })
    settlement.choiceGroups.push({
      groupId: 'g2',
      required: true,
      defaultOptionId: 'leave-map',
      label: { key: 'settlement.map', fallback: 'Mapa encontrado' },
      options: [
        { optionId: 'leave-map', label: { key: 'option.leave-map', fallback: 'Dejar mapa' }, itemIds: [], capacityDelta: 0, consequences: [] },
        { optionId: 'take-map', label: { key: 'option.take-map', fallback: 'Tomar mapa' }, itemIds: ['map1'], capacityDelta: 1, consequences: [] }
      ]
    })
    const action = settlement.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
    action.execution.groups = [
      { groupId: 'g1', eligibleOptionIds: ['renounce', 'keep-foreign'] },
      { groupId: 'g2', eligibleOptionIds: ['leave-map', 'take-map'] }
    ]

    const wrapper = mount(VisitorCycleV2, { attachTo: document.body, props: { game, loadState: 'ready' } })
    const radios = wrapper.findAll('[data-testid="settlement-preview_ready"] input[type="radio"]')
    const keepForeign = radios.find((radio) => radio.attributes('name') === 'v2-settlement-choice-0-0' && radio.element.getAttribute('type') === 'radio' && radio.element.nextSibling?.textContent?.includes('Conservar'))
    const takeMap = radios.find((radio) => radio.attributes('name') === 'v2-settlement-choice-0-1' && radio.element.nextSibling?.textContent?.includes('Tomar'))
    if (!keepForeign || !takeMap) throw new Error('Expected settlement radios')

    const keepForeignInput = keepForeign.element as HTMLInputElement
    const takeMapInput = takeMap.element as HTMLInputElement
    keepForeignInput.focus()
    expect(document.activeElement).toBe(keepForeignInput)
    await keepForeign.trigger('keydown', { key: ' ' })
    takeMapInput.focus()
    expect(document.activeElement).toBe(takeMapInput)
    await takeMap.trigger('keydown', { key: ' ' })
    await wrapper.get('[data-testid="settlement-preview_ready"] button').trigger('click')

    expect(wrapper.emitted('confirmSettlement')?.[0]).toEqual([{ kind: 'settlement', settlementId: 's1', selectedOptionIds: { g1: 'keep-foreign', g2: 'take-map' } }])
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
    expect(wrapper.text()).toContain('Asignado a Visitante no disponible')
    expect(wrapper.text()).toContain('El equipo se perdió.')
    expect(wrapper.text()).toContain('Abandono confirmado.')
  })

  it('keeps opaque tokens out of copy and uses safe, unique control identities', () => {
    const game = fixture('integrated-settlement')
    const visitor = game.visitors[0]!
    const expedition = game.expeditions[0]!
    const settlement = game.settlements[0]
    if (!settlement || !('choiceGroups' in settlement)) throw new Error('Expected settlement preview')
    visitor.visitorId = 'visitor token:one'
    expedition.visitorId = visitor.visitorId
    expedition.expeditionId = 'expedition token:one'
    settlement.expeditionId = expedition.expeditionId
    settlement.settlementId = 'settlement token:one'
    settlement.choiceGroups[0]!.groupId = 'group token-one'
    const action = settlement.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!action || action.action !== 'confirm_settlement' || !action.enabled) throw new Error('Expected settlement action')
    action.targetId = settlement.settlementId
    action.execution.settlementId = settlement.settlementId
    action.execution.groups[0]!.groupId = settlement.choiceGroups[0]!.groupId

    const second = structuredClone(settlement)
    second.settlementId = 'settlement-token one'
    second.choiceGroups[0]!.groupId = 'group-token one'
    const secondAction = second.actions.find((candidate) => candidate.action === 'confirm_settlement' && candidate.enabled)
    if (!secondAction || secondAction.action !== 'confirm_settlement' || !secondAction.enabled) throw new Error('Expected second settlement action')
    secondAction.targetId = second.settlementId
    secondAction.execution.settlementId = second.settlementId
    secondAction.execution.groups[0]!.groupId = second.choiceGroups[0]!.groupId
    game.settlements.push(second)

    const recoverySource = fixture('integrated-recovery')
    const recovery = recoverySource.recoveries[0]!
    recovery.recoveryId = 'recovery token:one'
    recovery.itemIds = ['missing item token']
    game.recoveries = [recovery]

    const wrapper = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })
    const text = wrapper.text()
    for (const token of [visitor.visitorId, expedition.expeditionId, settlement.settlementId, second.settlementId, recovery.recoveryId, 'missing item token']) {
      expect(text).not.toContain(token)
    }
    expect(text).toContain('Expedición de Ada')
    expect(text).toContain('Resolución de Ada')
    expect(text).toContain('Recuperación de Objeto no disponible')

    const ids = wrapper.findAll('[id]').map((node) => node.attributes('id')).filter((id): id is string => Boolean(id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => !/\s|:/.test(id))).toBe(true)
    const radioNames = wrapper.findAll('input[type="radio"]').map((node) => node.attributes('name'))
    expect(new Set(radioNames)).toEqual(new Set(['v2-settlement-choice-0-0', 'v2-settlement-choice-1-0']))
    for (const node of wrapper.findAll('[aria-describedby]')) {
      for (const id of node.attributes('aria-describedby')!.split(' ')) expect(wrapper.find(`#${id}`).exists()).toBe(true)
    }
  })

  it('keeps touch targets at 44px and includes reduced-motion fallback CSS', () => {
    const wrapper = mount(VisitorCycleV2, { props: { game: fixture('integrated-contract'), loadState: 'ready' } })
    const source = readFileSync(join(process.cwd(), 'components/VisitorCycleV2.vue'), 'utf8')

    expect(wrapper.html()).toContain('v2-cycle__button')
    for (const selector of ['v2-cycle__button', 'v2-cycle__select', 'v2-cycle__check']) {
      const rule = source.match(new RegExp(`}\\s*\\.${selector}\\s*\\{([^}]+)\\}`))?.[1]
      expect(rule, selector).toMatch(/min-height:\s*44px/)
    }
    for (const id of ['integrated-contract', 'integrated-settlement', 'integrated-recovery']) {
      const game = fixture(id)
      if (id === 'integrated-recovery') {
        const action = game.recoveries[0]?.actions.find((candidate) => candidate.action === 'assign_recovery')
        if (!action || action.action !== 'assign_recovery' || !action.enabled) throw new Error('Expected assign action')
        action.execution.bindings[0]!.eligibleLoanItemIds = ['i4']
      }
      const controls = mount(VisitorCycleV2, { props: { game, loadState: 'ready' } })
      const inputs = controls.findAll('input[type="checkbox"], input[type="radio"]')
      expect(inputs.length).toBeGreaterThan(0)
      if (id === 'integrated-recovery') expect(inputs).toHaveLength(2)
      for (const input of inputs) {
        expect(input.element.closest('label')?.classList.contains('v2-cycle__check')).toBe(true)
      }
      controls.unmount()
    }
    wrapper.unmount()
    expect(source).toContain('prefers-reduced-motion')
  })
})
