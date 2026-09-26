// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CaravanV2 from '../components/CaravanV2.vue'
import fixtures from '../contracts/v2-etapa0-4/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'

function gameWithOptions() {
  const game = structuredClone(fixtures.integratedPositiveCases.find((candidate) => candidate.id === 'integrated-system')!.value) as GameView
  const action = game.actions.find((candidate) => candidate.action === 'upgrade_caravan' && candidate.enabled)
  if (!action || action.action !== 'upgrade_caravan') throw new Error('Expected caravan authorization')
  action.execution.options.push({ ...action.execution.options[0]!, optionId: 'second-option', label: { ...action.execution.options[0]!.label, fallback: 'Herrería' } })
  return game
}

const props = (game: GameView) => ({ game, loadState: 'ready', operationState: 'idle', errorMessage: '', unavailableReason: '', snapshotStale: false })

describe('Caravan V2 component', () => {
  it('renders every sealed option and submits the selected option', async () => {
    const wrapper = mount(CaravanV2, { props: props(gameWithOptions()) })
    expect(wrapper.text()).toContain('Alojamiento')
    expect(wrapper.text()).toContain('Herrería')
    const buttons = wrapper.findAll('button').filter((button) => button.text() === 'Revisar mejora')
    expect(buttons).toHaveLength(2)
    await buttons[1]!.trigger('click')
    await wrapper.get('[role="alertdialog"] button.primary').trigger('click')
    expect(wrapper.emitted('upgrade')?.[0]?.[0]).toMatchObject({ optionId: 'second-option' })
  })

  it('traps focus and restores the option trigger on Escape', async () => {
    const wrapper = mount(CaravanV2, { attachTo: document.body, props: props(gameWithOptions()) })
    const trigger = wrapper.findAll('button').find((button) => button.text() === 'Revisar mejora')!
    await trigger.trigger('click')
    const dialog = wrapper.get('[role="alertdialog"]')
    const buttons = dialog.findAll('button')
    await buttons[1]!.trigger('focus')
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0]!.element)
    await dialog.trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(trigger.element)
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
