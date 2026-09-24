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
    expect(wrapper.text()).toContain('En stash')
    const identify = wrapper.findAll('button').find((entry) => entry.text().toLowerCase().includes('identify'))
    expect(identify).toBeDefined()
    await identify!.trigger('click')
    expect(wrapper.emitted('action')).toBeTruthy()
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
    expect(document.activeElement).toBe(button!.element)
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
  })
})
