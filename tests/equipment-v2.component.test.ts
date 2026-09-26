// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EquipmentV2 from '../components/EquipmentV2.vue'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'

const allFixtures = [...fixtures.retainedPositiveCases, ...fixtures.integratedPositiveCases] as Array<{ id: string; value: unknown }>
const view = allFixtures.find((entry) => entry.id === 'integrated-services')?.value as GameView
const destructive = allFixtures.find((entry) => entry.id === 'integrated-destructive')?.value as GameView
if (!view) throw new Error('Missing required fixture: integrated-services')
if (!destructive) throw new Error('Missing required fixture: integrated-destructive')

describe('EquipmentV2', () => {
  it('renders ownership/custody and sends a reversible action from published execution', async () => {
    const wrapper = mount(EquipmentV2, {
      props: { game: view, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false }
    })
    expect(wrapper.text()).toContain('Propiedad de la caravana')
    expect(wrapper.text()).toContain('Guardado')
    expect(wrapper.findAll('img[src^="/images/game/items/"]')).toHaveLength(view.items.length)
    const identify = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('identify'))
    expect(identify).toBeDefined()
    await identify!.trigger('click')
    expect(wrapper.emitted('action')).toBeTruthy()
    wrapper.unmount()
  })

  it('shows irreversible consequences before emitting and restores focus on cancel', async () => {
    const wrapper = mount(EquipmentV2, { attachTo: document.body, props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))
    expect(button).toBeDefined()
    await button!.trigger('click')
    expect(wrapper.text()).toContain('Confirmar')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true)
    const cancel = wrapper.findAll('button').find((entry) => entry.text() === 'Cancelar')
    expect(cancel).toBeDefined()
    expect(document.activeElement).toBe(cancel!.element)
    await cancel!.trigger('click')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(document.activeElement?.id).toBe(button!.element.id)
    wrapper.unmount()
  })

  it('restores focus before confirming an irreversible action emits a pending operation', async () => {
    let activeElementAtEmit: Element | null = null
    const wrapper = mount(EquipmentV2, {
      attachTo: document.body,
      props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false },
      attrs: { onAction: () => { activeElementAtEmit = document.activeElement } }
    })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))!
    await button.trigger('click')
    await wrapper.findAll('button').find((entry) => entry.text() === 'Confirmar')!.trigger('click')
    expect(wrapper.emitted('action')).toHaveLength(1)
    expect(activeElementAtEmit).toBe(button.element)
    expect(document.activeElement?.id).toBe(button.element.id)
    wrapper.unmount()
  })

  it('closes stale confirmation and focuses a valid content destination', async () => {
    const wrapper = mount(EquipmentV2, { attachTo: document.body, props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))!
    await button.trigger('click')
    await wrapper.setProps({ snapshotStale: true })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('[tabindex="-1"]').element)
    wrapper.unmount()
  })

  it('invalidates an open confirmation when the published revision changes', async () => {
    const wrapper = mount(EquipmentV2, { props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))
    expect(button).toBeDefined()
    await button!.trigger('click')
    await wrapper.setProps({ game: { ...view, revision: view.revision + 1 } })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.emitted('action')).toBeUndefined()
    wrapper.unmount()
  })

  it('invalidates an open confirmation when its authorization changes at the same revision', async () => {
    const wrapper = mount(EquipmentV2, { props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))!
    await button.trigger('click')
    const changed = structuredClone(destructive)
    const item = changed.items.find((entry) => entry.actions.some((action) => action.action === 'dismantle_item'))!
    const action = item.actions.find((entry) => entry.enabled && entry.action === 'dismantle_item')
    if (!action || !action.enabled || action.action !== 'dismantle_item' || !('acknowledgement' in action.execution.options[0]!)) throw new Error('Expected acknowledgement option')
    action.authorizationId = 'changed-authorization'
    await wrapper.setProps({ game: changed })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.emitted('action')).toBeUndefined()
    wrapper.unmount()
  })

  it('invalidates an open confirmation when its option changes at the same revision', async () => {
    const wrapper = mount(EquipmentV2, { props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))!
    await button.trigger('click')
    const changed = structuredClone(destructive)
    const item = changed.items.find((entry) => entry.actions.some((action) => action.action === 'dismantle_item'))!
    const action = item.actions.find((entry) => entry.enabled && entry.action === 'dismantle_item')
    if (!action || !action.enabled || action.action !== 'dismantle_item') throw new Error('Expected acknowledgement option')
    const option = action.execution.options[0]
    if (!option) throw new Error('Expected service option')
    option.optionId = 'changed-option'
    await wrapper.setProps({ game: changed })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('invalidates an open confirmation when its acknowledgement changes at the same revision', async () => {
    const wrapper = mount(EquipmentV2, { props: { game: destructive, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('dismantle'))!
    await button.trigger('click')
    const changed = structuredClone(destructive)
    const item = changed.items.find((entry) => entry.actions.some((action) => action.action === 'dismantle_item'))!
    const action = item.actions.find((entry) => entry.enabled && entry.action === 'dismantle_item')
    if (!action || !action.enabled || action.action !== 'dismantle_item' || !('acknowledgement' in action.execution.options[0]!)) throw new Error('Expected acknowledgement option')
    action.execution.options[0].acknowledgement.acknowledgementId = 'changed-acknowledgement'
    await wrapper.setProps({ game: changed })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('restores focus safely for an opaque disconnected authorization id', async () => {
    const changed = structuredClone(destructive)
    const item = changed.items.find((entry) => entry.actions.some((action) => action.action === 'dismantle_item'))!
    const action = item.actions.find((entry) => entry.enabled && entry.action === 'dismantle_item')
    if (!action) throw new Error('Expected dismantle action')
    action.authorizationId = 'auth:opaque.[v1]'
    const wrapper = mount(EquipmentV2, { attachTo: document.body, props: { game: changed, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.find('#action-auth\\:opaque\\.\\[v1\\]')
    await button.trigger('click')
    button.element.remove()
    await wrapper.setProps({ snapshotStale: true })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('[tabindex="-1"]').element)
    wrapper.unmount()
  })
})
