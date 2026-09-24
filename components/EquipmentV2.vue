<template>
  <div class="equipment-v2">
    <div ref="content" tabindex="-1" :inert="Boolean(confirmation)">
    <div v-if="loadState === 'loading' && !game" class="equipment-state" aria-busy="true">Cargando inventario confirmado…</div>
    <div v-else-if="!game" class="equipment-state" role="alert">
      <h2>No hay inventario disponible</h2>
      <p>El snapshot V2 todavía no está listo.</p>
      <button class="btn primary" type="button" @click="$emit('reload')">Reintentar carga</button>
    </div>
    <template v-else>
      <section class="equipment-summary" aria-label="Recursos y capacidad">
        <div><span class="eyebrow">Oro</span><strong>{{ game.resources.gold }}g</strong></div>
        <div><span class="eyebrow">Capacidad</span><strong>{{ game.capacity.used }} / {{ game.capacity.limit }}</strong><small v-if="game.capacity.reserved">{{ game.capacity.reserved }} reservados</small></div>
        <div class="materials"><span class="eyebrow">Materiales</span><span v-for="(amount, name) in game.resources.materials" :key="name">{{ name }} · {{ amount }}</span></div>
      </section>

      <div v-if="operationState !== 'idle' || errorMessage" class="page-alert" :class="operationState === 'terminal' ? 'page-alert--error' : 'page-alert--success'" role="status" aria-live="polite">
        <span>{{ statusCopy }}</span>
        <button v-if="operationState === 'uncertain'" class="btn" type="button" @click="$emit('retry')">Reintentar la misma orden</button>
        <button v-else-if="operationState === 'conflict' || snapshotStale" class="btn" type="button" @click="$emit('reload')">Actualizar snapshot</button>
      </div>

      <section v-if="game.capacity.blockers.length" class="card blockers" aria-label="Bloqueos de capacidad">
        <strong>La caravana está al límite.</strong><span>Próximo paso: liberá un espacio o completá un trabajo antes de aceptar más carga.</span>
      </section>

      <section class="service-board" aria-labelledby="services-title">
        <div class="section-title"><div><span class="eyebrow">Equipo y servicios</span><h2 id="services-title">Inventario de la caravana</h2></div><span class="tag">Revisión {{ game.revision }}</span></div>
        <div v-if="!game.items.length" class="card equipment-state"><h3>El stash está vacío</h3><p class="muted">Los objetos recuperados aparecerán aquí cuando el snapshot los publique.</p></div>
        <div v-else class="item-grid">
          <article v-for="item in game.items" :key="item.itemId" class="card equipment-item" :class="`rarity-${item.rarity}`">
            <div class="item-topline"><span class="tag">{{ item.rarity }}</span><span class="muted">nivel {{ item.level }}</span></div>
            <h3>{{ item.name.fallback }}</h3>
            <p class="muted">{{ identification(item) }} · {{ owner(item) }} · {{ custody(item) }}</p>
            <ul v-if="item.identification === 'identified'" class="affixes"><li v-for="affix in item.affixes" :key="affix.affixId">{{ affix.name.fallback }} {{ affix.valueText.fallback }}</li><li v-if="item.activeImprint">Impronta: {{ item.activeImprint.name.fallback }}</li></ul>
            <p v-else class="unidentified">Los afijos están ocultos hasta identificar.</p>
            <div class="item-actions">
              <span v-for="action in item.actions" :key="action.authorizationId" class="action-control">
                <button :id="`action-${action.authorizationId}`" class="btn" :disabled="!action.enabled || operationState === 'pending' || operationState === 'uncertain' || snapshotStale" :aria-describedby="!action.enabled ? `reason-${action.authorizationId}` : undefined" @click="choose(item.itemId, action, $event)">{{ action.label.fallback }}</button>
                <span v-if="!action.enabled" :id="`reason-${action.authorizationId}`" class="action-reason">{{ action.reasonText.fallback }}</span>
              </span>
            </div>
          </article>
        </div>
      </section>

      <section class="jobs" aria-labelledby="jobs-title"><div class="section-title"><h2 id="jobs-title">Trabajos de servicio</h2><span class="muted">El servidor decide cuándo terminan</span></div><div v-if="!game.serviceJobs.length" class="card"><p class="muted">No hay trabajos en curso.</p></div><ul v-else class="job-list"><li v-for="job in game.serviceJobs" :key="job.jobId"><strong>{{ job.service === 'blacksmith' ? 'Herrero' : 'Encantador' }}</strong><span>{{ job.state }}</span><time>{{ jobTime(job) }}</time></li></ul></section>
    </template>
    </div>

    <div v-if="confirmation" class="confirm-backdrop" role="presentation" @click.self="closeConfirmation()">
      <section ref="dialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1" @keydown="trapFocus" @keydown.esc="closeConfirmation()">
        <h2 id="confirm-title">{{ confirmation.action.label.fallback }}</h2><p>{{ confirmation.option.description.fallback }}</p>
        <ul><li v-for="consequence in confirmation.option.consequences" :key="consequence.text.key">{{ consequence.text.fallback }}</li></ul>
        <div class="item-actions"><button ref="cancelButton" class="btn ghost" type="button" @click="closeConfirmation()">Cancelar</button><button class="btn primary" type="button" @click="confirm">Confirmar</button></div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ActionAvailability, GameView, ItemView, ServiceJobView } from '~/shared/types/v2-game-view'
import { selectionFor, type EquipmentAction, type EquipmentEnabledAction, type EquipmentSelection } from '~/utils/v2-equipment-adapter'

const props = defineProps<{ game: GameView | null; loadState: string; operationState: string; errorMessage: string; unavailableReason: string; snapshotStale: boolean }>()
const emit = defineEmits<{ reload: []; retry: []; action: [selection: EquipmentSelection] }>()
const content = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const triggerId = ref<string | null>(null)
const confirmation = ref<{ revision: number; itemId: string; action: EquipmentEnabledAction; option: { optionId: string; description: { fallback: string }; consequences: Array<{ text: { key: string; fallback: string } }>; acknowledgement?: { acknowledgementId: string } } } | null>(null)
const statusCopy = computed(() => props.errorMessage || (props.operationState === 'pending' ? 'Orden enviada; esperando snapshot confirmado…' : props.unavailableReason ? `La acción está bloqueada: ${props.unavailableReason}.` : 'Revisá el estado publicado.'))

watch(() => props.game, (game) => {
  if (!confirmation.value) return
  if (!game || confirmation.value.revision !== game.revision) return closeConfirmation()
  try {
    if (!selectionFor(game, confirmation.value.itemId, confirmation.value.action.action as EquipmentAction, confirmation.value.option.optionId, confirmation.value.option.acknowledgement?.acknowledgementId)) closeConfirmation()
  } catch {
    closeConfirmation()
  }
})
watch(() => props.snapshotStale, (stale) => { if (stale) closeConfirmation(true) })
watch(confirmation, async (value) => {
  if (!value) return
  await nextTick()
  if (confirmation.value === value) cancelButton.value?.focus()
})

function choose(itemId: string, action: ActionAvailability, event?: Event) {
  if (!action.enabled || !['identify_item', 'queue_blacksmith_job', 'queue_enchanter_job', 'dismantle_item', 'replace_boss_imprint'].includes(action.action)) return
  const equipmentAction = action as EquipmentEnabledAction
  const option = equipmentAction.execution.options[0]
  if (!props.game || !option) return
  if ('acknowledgement' in option) {
    const target = event?.currentTarget instanceof HTMLElement ? event.currentTarget : event?.target instanceof HTMLElement ? event.target.closest('button') : null
    trigger.value = target ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    triggerId.value = trigger.value?.id || null
    confirmation.value = { revision: props.game.revision, itemId, action: equipmentAction, option }
  }
  else submit(itemId, equipmentAction, option.optionId)
}
function confirm() {
  if (!confirmation.value) return
  const { itemId, action, option, revision } = confirmation.value
  if (!props.game || props.game.revision !== revision) return closeConfirmation()
  closeConfirmation(false, true)
  submit(itemId, action, option.optionId, option.acknowledgement?.acknowledgementId)
}
function closeConfirmation(preferContent = false, immediate = false) {
  confirmation.value = null
  content.value?.removeAttribute('inert')
  const target = trigger.value
  const restore = () => {
    const currentTarget = target?.isConnected ? target : triggerId.value ? content.value?.querySelector<HTMLElement>(`#${triggerId.value}`) : null
    if (!preferContent && currentTarget && !currentTarget.hasAttribute('disabled')) currentTarget.focus()
    else content.value?.focus()
  }
  restore()
  if (!immediate) nextTick(() => nextTick(restore))
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const focusable = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onBeforeUnmount(() => { confirmation.value = null })
function submit(itemId: string, action: EquipmentEnabledAction, optionId: string, acknowledgementId?: string) {
  if (!props.game) return
  try {
    const selection = selectionFor(props.game, itemId, action.action as EquipmentAction, optionId, acknowledgementId)
    if (selection) emit('action', selection)
  } catch {
    closeConfirmation()
  }
}
function identification(item: ItemView) { return item.identification === 'identified' ? 'Identificado' : 'Sin identificar' }
function owner(item: ItemView) { return item.owner.kind === 'caravan' ? 'Propiedad de la caravana' : 'Prestado por visitante' }
function custody(item: ItemView) { return item.custody.kind === 'stash' ? 'En stash' : `En ${item.custody.kind}` }
function jobTime(job: ServiceJobView) { return 'completesAt' in job ? new Date(job.completesAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : job.state }
</script>

<style scoped>
.equipment-v2 { display: grid; gap: 1rem; }
.equipment-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; padding: 1rem; border: 1px solid var(--line); background: rgba(27,25,22,.88); }
.equipment-summary div { display: grid; gap: .2rem; min-width: 0; }
.equipment-summary strong { color: var(--accent-2); font-size: 1.35rem; }
.equipment-summary small, .materials span:not(.eyebrow) { color: var(--muted); }
.eyebrow { color: var(--accent-2); font-size: .72rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.item-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
.equipment-item { display: grid; gap: .55rem; border-top: 3px solid var(--rarity-color, var(--line)); }
.rarity-magic { --rarity-color: #5b8dee; } .rarity-rare { --rarity-color: #d8a849; } .rarity-legendary { --rarity-color: #b87333; }
.equipment-item h3, .equipment-item p { margin: 0; overflow-wrap: anywhere; }
.item-topline, .item-actions, .job-list li { align-items: center; display: flex; flex-wrap: wrap; gap: .5rem; }
.item-topline { justify-content: space-between; }
.item-actions { margin-top: auto; padding-top: .5rem; }
.item-actions .btn { min-height: 2.75rem; }
.action-control { display: grid; gap: .2rem; min-width: 0; }
.action-reason { color: var(--muted); font-size: .8rem; max-width: 18rem; }
.affixes { color: var(--ok); margin: 0; padding-left: 1.1rem; }
.unidentified { color: var(--muted); font-style: italic; }
.blockers { display: flex; flex-wrap: wrap; gap: .5rem 1rem; border-color: var(--accent-2); }
.job-list { display: grid; gap: .5rem; list-style: none; margin: 0; padding: 0; }
.job-list li { justify-content: space-between; padding: .8rem 1rem; background: var(--panel); border: 1px solid var(--line); }
.job-list time { color: var(--muted); }
.equipment-state { display: grid; gap: .5rem; justify-items: start; }
.equipment-state h2, .equipment-state h3, .equipment-state p { margin: 0; }
.confirm-backdrop { align-items: center; background: rgba(0,0,0,.7); display: flex; inset: 0; justify-content: center; padding: 1rem; position: fixed; z-index: 20; }
.confirm-dialog { background: var(--panel); border: 1px solid var(--accent-2); max-width: 32rem; padding: 1.25rem; width: 100%; }
.confirm-dialog h2, .confirm-dialog p { margin-top: 0; }
@media (max-width: 600px) { .equipment-summary { grid-template-columns: repeat(2, 1fr); } .equipment-summary .materials { grid-column: 1 / -1; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
