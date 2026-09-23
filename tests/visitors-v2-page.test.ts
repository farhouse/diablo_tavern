// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VisitorsV2Page from '../pages/visitors-v2.vue'

const store = vi.hoisted(() => ({
  game: { revision: 7 }, loadState: 'ready', operationState: 'idle',
  errorMessage: 'error', unavailableReason: 'reason', snapshotStale: true,
  load: vi.fn(), acceptContract: vi.fn(), startExpedition: vi.fn(), reconcileGame: vi.fn(),
  reconcileDueTransition: vi.fn(),
  confirmSettlement: vi.fn(), assignRecovery: vi.fn(), abandonRecovery: vi.fn(),
  retryUncertain: vi.fn(), retryConflictReload: vi.fn()
}))

vi.mock('../stores/game-v2', () => ({ useGameV2Store: () => store }))

const VisitorCycleStub = defineComponent({
  name: 'VisitorCycleV2',
  props: ['game', 'loadState', 'operationState', 'errorMessage', 'unavailableReason', 'snapshotStale'],
  emits: ['acceptContract', 'startExpedition', 'reconcileGame', 'reconcileDueTransition', 'confirmSettlement', 'assignRecovery', 'abandonRecovery', 'retry', 'reload'],
  template: `<div>
    <button data-event="accept" @click="$emit('acceptContract', { kind: 'contract' })" />
    <button data-event="start" @click="$emit('startExpedition', 'visitor-1')" />
    <button data-event="reconcile" @click="$emit('reconcileGame')" />
    <button data-event="settlement" @click="$emit('confirmSettlement', { kind: 'settlement' })" />
    <button data-event="assign" @click="$emit('assignRecovery', { kind: 'recovery' })" />
    <button data-event="abandon" @click="$emit('abandonRecovery', { kind: 'abandon_recovery' })" />
    <button data-event="retry" @click="$emit('retry')" />
    <button data-event="reload" @click="$emit('reload')" />
  </div>`
})

describe('/visitors-v2', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads the authoritative snapshot and forwards every state prop', async () => {
    const wrapper = mount(VisitorsV2Page, { global: { stubs: { VisitorCycleV2: VisitorCycleStub } } })
    await nextTick()
    expect(store.load).toHaveBeenCalledOnce()
    expect(wrapper.getComponent(VisitorCycleStub).props()).toMatchObject({
      game: store.game, loadState: 'ready', operationState: 'idle', errorMessage: 'error',
      unavailableReason: 'reason', snapshotStale: true
    })
  })

  it.each([
    ['accept', 'acceptContract'], ['start', 'startExpedition'], ['reconcile', 'reconcileGame'],
    ['settlement', 'confirmSettlement'], ['assign', 'assignRecovery'], ['abandon', 'abandonRecovery'],
    ['retry', 'retryUncertain'], ['reload', 'retryConflictReload']
  ] as const)('forwards %s without adding client authority', async (event, method) => {
    const wrapper = mount(VisitorsV2Page, { global: { stubs: { VisitorCycleV2: VisitorCycleStub } } })
    await wrapper.get(`[data-event="${event}"]`).trigger('click')
    expect(store[method]).toHaveBeenCalledOnce()
  })

  it('routes automatic clock ticks through the deduplicated store helper', async () => {
    const wrapper = mount(VisitorsV2Page, { global: { stubs: { VisitorCycleV2: VisitorCycleStub } } })
    await wrapper.get('[data-event="reconcile"]').trigger('click')
    expect(store.reconcileGame).toHaveBeenCalledOnce()

    await wrapper.getComponent(VisitorCycleStub).vm.$emit('reconcileDueTransition', 123)
    expect(store.reconcileDueTransition).toHaveBeenCalledWith(123)
  })

  it('is linked from authenticated navigation', () => {
    const layout = readFileSync(join(process.cwd(), 'layouts/default.vue'), 'utf8')
    expect(layout).toContain('<NuxtLink to="/visitors-v2">Visitantes V2</NuxtLink>')
  })
})
