<template>
  <div class="caravan-v2" ref="root">
    <div ref="content" class="caravan-content" tabindex="-1">
    <div v-if="!game && loadState === 'loading'" class="card state" aria-busy="true">Cargando caravana confirmada…</div>
    <div v-else-if="!game" class="card state" role="alert"><h2>No hay caravana disponible</h2><p>El snapshot V2 todavía no está listo.</p><button class="btn primary" type="button" @click="$emit('reload')">Reintentar carga</button></div>
    <template v-else>
      <div v-if="operationState !== 'idle' || errorMessage" class="page-alert" :class="operationState === 'terminal' ? 'page-alert--error' : 'page-alert--success'" role="status" aria-live="polite">
        <span>{{ errorMessage || operationLabel }}</span>
        <button v-if="operationState === 'uncertain'" class="btn" type="button" @click="$emit('retry')">Reintentar la misma orden</button>
        <button v-else-if="snapshotStale || operationState === 'conflict'" class="btn" type="button" @click="$emit('reload')">Actualizar snapshot</button>
      </div>

      <section class="caravan-hero card" aria-labelledby="caravan-title">
        <div><span class="eyebrow">Campamento · V2</span><h2 id="caravan-title">La caravana sostiene el próximo viaje</h2><p class="muted">Capacidad, servicios y manutención tal como los publicó el servidor.</p></div>
        <span class="tag">Revisión {{ game.revision }}</span>
      </section>
      <section class="stats" aria-label="Estado de la caravana">
        <div class="stat"><span class="eyebrow">Visitantes</span><strong>{{ game.caravan.visitorCapacity.used }} / {{ game.caravan.visitorCapacity.limit }}</strong><span class="muted">ocupación publicada</span></div>
        <div class="stat"><span class="eyebrow">Manutención</span><strong :class="game.caravan.maintenance.status === 'debt' ? 'debt' : 'ok'">{{ game.caravan.maintenance.status === 'debt' ? 'Con deuda' : 'Al día' }}</strong><span class="muted">{{ game.caravan.maintenance.debtPeriods }} períodos · {{ game.caravan.maintenance.debtGold }} oro</span></div>
        <div class="stat"><span class="eyebrow">Vencimiento</span><strong>{{ formatDate(game.caravan.maintenance.nextDueAt) }}</strong><span class="muted">reloj del servidor: {{ formatDate(game.serverNow) }}</span></div>
      </section>
      <div v-if="game.caravan.maintenance.status === 'debt'" class="card debt-notice" role="alert"><strong>Hay deuda de manutención.</strong><span>Las acciones bloqueadas se mantienen así hasta que una reconciliación publique un nuevo snapshot.</span></div>

      <section aria-labelledby="upgrades-title"><div class="section-title"><div><span class="eyebrow">Progresión</span><h2 id="upgrades-title">Mejoras de caravana</h2></div></div><div class="upgrade-grid"><article v-for="upgrade in game.caravan.upgrades" :key="upgrade.upgradeId" class="card upgrade-card"><div class="row"><h3>{{ upgradeName(upgrade.upgradeId) }}</h3><span class="tag">{{ upgrade.level }} / {{ upgrade.maxLevel }}</span></div><div class="upgrade-track" aria-hidden="true"><span :style="{ width: `${upgrade.maxLevel ? (upgrade.level / upgrade.maxLevel) * 100 : 0}%` }" /></div><p class="muted">{{ upgradeDescription(upgrade.upgradeId) }}</p></article></div></section>

      <section class="card actions-card" aria-labelledby="actions-title"><div class="row"><div><span class="eyebrow">Autorizaciones selladas</span><h2 id="actions-title">Acciones disponibles</h2></div><span v-if="!upgradeAction" class="tag">Sin mejoras habilitadas</span></div><div v-if="upgradeAction" class="upgrade-options"><div v-for="option in upgradeAction.execution.options" :key="option.optionId" class="upgrade-option"><div><strong>{{ option.label.fallback }}</strong><p class="muted">{{ option.description.fallback }}</p></div><button class="btn primary" type="button" :disabled="disabled" @click="openConfirmation(option, $event)">Revisar mejora</button></div></div><p v-else class="muted">La caravana está bloqueada por el snapshot actual. Revisá deuda o esperá una nueva autorización.</p></section>
    </template>
    </div>

    <div v-if="confirmation" class="confirm-backdrop" role="presentation" @click.self="closeConfirmation"><section ref="dialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="upgrade-confirm-title" tabindex="-1" @keydown="trapFocus" @keydown.esc="closeConfirmation"><h2 id="upgrade-confirm-title">{{ confirmation.option.label.fallback }}</h2><p>{{ confirmation.option.description.fallback }}</p><h3>Consecuencias publicadas</h3><ul><li v-for="consequence in confirmation.option.consequences" :key="consequence.text.key">{{ consequence.text.fallback }}</li><li v-if="!confirmation.option.consequences.length">La mejora se aplicará únicamente cuando el servidor publique una nueva revisión.</li></ul><div class="item-actions"><button ref="cancelButton" class="btn ghost" type="button" @click="closeConfirmation">Cancelar</button><button class="btn primary" type="button" @click="confirmUpgrade">Confirmar mejora</button></div></section></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import type { GameView, UpgradeCaravanAction } from '~/shared/types/v2-game-view'
import { selectionForCaravanUpgrade, type CaravanSelection } from '~/utils/v2-caravan-adapter'

const props = defineProps<{ game: GameView | null; loadState: string; operationState: string; errorMessage: string; unavailableReason: string; snapshotStale: boolean }>()
const emit = defineEmits<{ reload: []; retry: []; upgrade: [selection: CaravanSelection] }>()
const confirmation = ref<({ revision: number; authorizationId: string; option: UpgradeCaravanAction['execution']['options'][number] }) | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const root = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const confirmationTrigger = ref<HTMLElement | null>(null)
const confirmationOptionSignature = ref('')
const inertElements = new Map<HTMLElement, boolean>()
const disabled = computed(() => props.snapshotStale || props.operationState === 'pending' || props.operationState === 'uncertain')
const upgradeAction = computed(() => props.game ? props.game.actions.find((action): action is UpgradeCaravanAction => action.action === 'upgrade_caravan' && action.enabled) ?? null : null)
const operationLabel = computed(() => props.operationState === 'pending' ? 'Mejora enviada; esperando snapshot confirmado…' : props.unavailableReason ? `La acción está bloqueada: ${props.unavailableReason}.` : 'Revisá el estado publicado.')
const reviewIdentity = computed(() => {
  const action = upgradeAction.value
  const option = confirmation.value ? action?.execution.options.find((candidate) => candidate.optionId === confirmation.value?.option.optionId) : null
  return JSON.stringify({ revision: props.game?.revision, stale: props.snapshotStale, authorizationId: action?.authorizationId, option })
})
watch(reviewIdentity, () => {
  if (!confirmation.value) return
  if (!props.game) return closeConfirmation()
  const action = upgradeAction.value
  const option = action?.execution.options.find((candidate) => candidate.optionId === confirmation.value?.option.optionId)
  if (props.snapshotStale || props.game.revision !== confirmation.value.revision || action?.authorizationId !== confirmation.value.authorizationId || !option || optionSignature(option) !== confirmationOptionSignature.value) closeConfirmation()
})
watch(confirmation, async (value) => { if (value) { await nextTick(); cancelButton.value?.focus() } })
function optionSignature(option: UpgradeCaravanAction['execution']['options'][number]) { return JSON.stringify(option) }
function setOutsideInert(enabled: boolean) {
  if (!enabled) {
    for (const [element, previous] of inertElements) element.inert = previous
    inertElements.clear()
    return
  }
  const dialogContent = content.value
  const modalRoot = root.value
  if (!dialogContent || !modalRoot) return
  if (!inertElements.has(dialogContent)) inertElements.set(dialogContent, dialogContent.inert)
  dialogContent.inert = true
  let child: HTMLElement = modalRoot
  let parent = modalRoot.parentElement
  while (parent) {
    for (const sibling of [...parent.children]) {
      if (sibling !== child && sibling instanceof HTMLElement) {
        if (!inertElements.has(sibling)) inertElements.set(sibling, sibling.inert)
        sibling.inert = true
      }
    }
    child = parent
    parent = parent.parentElement
  }
}
function openConfirmation(option: UpgradeCaravanAction['execution']['options'][number], event: MouseEvent) {
  const action = upgradeAction.value
  if (!action || disabled.value || !action.execution.options.some((candidate) => candidate.optionId === option.optionId)) return
  confirmationTrigger.value = event.currentTarget as HTMLElement
  confirmationOptionSignature.value = optionSignature(option)
  confirmation.value = { revision: props.game!.revision, authorizationId: action.authorizationId, option: structuredClone(toRaw(option)) }
  setOutsideInert(true)
}
async function closeConfirmation() {
  const trigger = confirmationTrigger.value
  confirmation.value = null
  confirmationTrigger.value = null
  confirmationOptionSignature.value = ''
  setOutsideInert(false)
  await nextTick()
  if (trigger?.isConnected && !trigger.hasAttribute('disabled')) trigger.focus()
  else content.value?.focus()
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])]
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
async function confirmUpgrade() {
  const current = confirmation.value
  const action = upgradeAction.value
  const option = action?.execution.options.find((candidate) => candidate.optionId === current?.option.optionId)
  if (!current || !props.game || props.game.revision !== current.revision || !action || action.authorizationId !== current.authorizationId || !option || optionSignature(option) !== confirmationOptionSignature.value) return closeConfirmation()
  const selection = { optionId: current.option.optionId, authorizationId: current.authorizationId, revision: current.revision }
  const trigger = confirmationTrigger.value
  await closeConfirmation()
  emit('upgrade', selection)
  await nextTick()
  if (trigger?.isConnected && !trigger.hasAttribute('disabled')) trigger.focus()
  else content.value?.focus()
}
function formatDate(value: string) { return new Date(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) }
function upgradeName(value: string) { return ({ visitor_quarters: 'Alojamiento', blacksmith: 'Herrería', enchanter: 'Encantamiento' } as Record<string, string>)[value] ?? value }
function upgradeDescription(value: string) { return ({ visitor_quarters: 'Más espacio para visitantes.', blacksmith: 'Desbloquea el servicio del herrero.', enchanter: 'Desbloquea el servicio del encantador.' } as Record<string, string>)[value] ?? 'Mejora publicada por la caravana.' }
onBeforeUnmount(() => setOutsideInert(false))
</script>

<style scoped>
.caravan-v2 { display: grid; gap: 1rem; }
.caravan-hero { align-items: end; background: linear-gradient(125deg, rgba(75, 35, 26, .95), rgba(27, 25, 22, .94) 65%); display: flex; gap: 1rem; justify-content: space-between; min-height: 10rem; }
.caravan-hero h2, .upgrade-card h3, .actions-card h2, .confirm-dialog h2, .confirm-dialog h3 { margin: 0; }
.stats, .upgrade-grid { display: grid; gap: 1rem; grid-template-columns: repeat(3, 1fr); }
.stat { background: var(--panel); border: 1px solid var(--line); display: grid; gap: .25rem; padding: 1rem; }
.stat strong { color: var(--accent-2); font-size: 1.5rem; }
.stat strong.ok { color: var(--ok); } .stat strong.debt, .debt-notice { color: var(--bad); }
.debt-notice { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
.upgrade-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.upgrade-card { display: grid; gap: .75rem; }
.upgrade-card p { margin: 0; }
.upgrade-track { background: #14120f; border: 1px solid var(--line); height: .55rem; overflow: hidden; }
.upgrade-track span { background: var(--accent-2); display: block; height: 100%; }
.upgrade-options { display: grid; gap: .75rem; padding-top: .8rem; }
.upgrade-option { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 1rem; justify-content: space-between; padding-top: .8rem; }
.upgrade-option p { margin: .25rem 0 0; }
.state { display: grid; gap: .5rem; justify-items: start; }
.state h2, .state p { margin: 0; }
.item-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.item-actions .btn, .upgrade-option .btn { min-height: 44px; }
.confirm-backdrop { align-items: center; background: rgba(0,0,0,.7); display: flex; inset: 0; justify-content: center; padding: 1rem; position: fixed; z-index: 20; }
.confirm-dialog { background: var(--panel); border: 1px solid var(--accent-2); max-width: 34rem; padding: 1.25rem; width: 100%; }
.confirm-dialog p { color: var(--muted); }
@media (max-width: 700px) { .stats { grid-template-columns: 1fr; } .upgrade-grid { grid-template-columns: minmax(0, 1fr); } .caravan-hero, .upgrade-option { align-items: stretch; flex-direction: column; } }
@media (max-width: 200px) { .upgrade-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
