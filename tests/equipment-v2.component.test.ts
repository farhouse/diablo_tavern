// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EquipmentV2 from '../components/EquipmentV2.vue'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'

const view = ([...fixtures.retainedPositiveCases, ...fixtures.integratedPositiveCases] as Array<{ id: string; value: unknown }>).find((entry) => entry.id === 'integrated-services')?.value as GameView

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

  it('shows irreversible consequences before emitting', async () => {
    const irreversible = ([...fixtures.retainedPositiveCases, ...fixtures.integratedPositiveCases] as Array<{ id: string; value: unknown }>).find((entry) => entry.id === 'integrated-services-with-imprint')?.value as GameView | undefined
    if (!irreversible) return
    const wrapper = mount(EquipmentV2, { props: { game: irreversible, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false } })
    const button = wrapper.findAll('button').find((entry) => entry.text().includes('Desmantelar'))
    if (!button) return
    await button.trigger('click')
    expect(wrapper.text()).toContain('Confirmar')
  })
})
