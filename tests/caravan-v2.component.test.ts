// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import fixtures from '../contracts/v2-etapa0-4/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import CaravanV2 from '../components/CaravanV2.vue'
import { caravanUpgradePayload, invalidateCaravanSelection, selectionForCaravanUpgrade } from '../utils/v2-caravan-adapter'

function gameFixture(): GameView {
  const match = fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-system')
  if (!match) throw new Error('Missing integrated-system fixture')
  return structuredClone(match.value) as GameView
}

describe('CaravanV2', () => {
  it('renders every sealed upgrade option and emits the selected binding', async () => {
    const game = gameFixture()
    const action = game.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
    if (!action || action.action !== 'upgrade_caravan' || !action.enabled) throw new Error('Expected upgrade action')
    action.execution.options.push({
      ...structuredClone(action.execution.options[0]!),
      optionId: 'upgrade-2',
      label: { key: 'option.upgrade-2', fallback: 'Desbloquear herrería' }
    })
    const wrapper = mount(CaravanV2, {
      attachTo: document.body,
      props: { game, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false }
    })
    const reviewButtons = wrapper.findAll('button').filter((button) => button.text() === 'Revisar mejora')
    expect(reviewButtons).toHaveLength(2)
    await reviewButtons[1]!.trigger('click')
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Desbloquear herrería')
    const cancel = wrapper.findAll('button').find((button) => button.text() === 'Cancelar')!
    expect(document.activeElement).toBe(cancel.element)
    await wrapper.findAll('button').find((button) => button.text() === 'Confirmar mejora')!.trigger('click')
    expect(wrapper.emitted('upgrade')).toEqual([[{
      optionId: 'upgrade-2', authorizationId: action.authorizationId, revision: game.revision
    }]])
    expect(document.activeElement).toBe(reviewButtons[1]!.element)
    wrapper.unmount()
  })

  it('binds payloads to revision, authorization and option', () => {
    const game = gameFixture()
    const selection = selectionForCaravanUpgrade(game, 'upgrade-1')
    expect(selection).not.toBeNull()
    expect(caravanUpgradePayload(game, selection!)).toEqual({ optionId: 'upgrade-1' })
    expect(invalidateCaravanSelection({ ...game, revision: game.revision + 1 }, selection)).toBeNull()
    const changed = structuredClone(game)
    const action = changed.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
    if (!action) throw new Error('Expected upgrade action')
    action.authorizationId = 'changed-authorization'
    expect(invalidateCaravanSelection(changed, selection)).toBeNull()
  })

  it('closes a sealed review when authorization or option contents change', async () => {
    const game = gameFixture()
    const wrapper = mount(CaravanV2, { attachTo: document.body, props: { game, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    await wrapper.findAll('button').find((button) => button.text() === 'Revisar mejora')!.trigger('click')
    const changed = structuredClone(game)
    const changedAction = changed.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
    if (!changedAction || changedAction.action !== 'upgrade_caravan') throw new Error('Expected changed upgrade action')
    changedAction.authorizationId = 'changed-authorization'
    changedAction.execution.options[0]!.description.fallback = 'Consecuencia cambiada'
    await wrapper.setProps({ game: changed })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.emitted('upgrade')).toBeUndefined()
    wrapper.unmount()
  })

  it('closes and restores focus when the reviewed option is removed', async () => {
    const game = gameFixture()
    const wrapper = mount(CaravanV2, { attachTo: document.body, props: { game, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const trigger = wrapper.findAll('button').find((button) => button.text() === 'Revisar mejora')!
    await trigger.trigger('click')
    const action = game.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
    if (!action || action.action !== 'upgrade_caravan') throw new Error('Expected upgrade action')
    const changed = structuredClone(game)
    const changedAction = changed.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
    if (!changedAction || changedAction.action !== 'upgrade_caravan') throw new Error('Expected changed upgrade action')
    changedAction.execution.options.splice(0, 1)
    await wrapper.setProps({ game: changed })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.caravan-v2').element)
    wrapper.unmount()
  })
})
