<template>
  <div class="equipment-v2" :class="{ 'equipment-v2--service': service !== 'all' || modal }">
    <div ref="content" class="equipment-content" tabindex="-1" :inert="Boolean(confirmation)">
    <div v-if="loadState === 'loading' && !game" class="equipment-state" aria-busy="true">{{ service === 'all' ? 'Cargando inventario confirmado…' : 'Preparando los objetos…' }}</div>
    <div v-else-if="!game" class="equipment-state" role="alert">
      <h2>No hay inventario disponible</h2>
      <p>No pudimos cargar la partida.</p>
      <button class="btn primary" type="button" @click="$emit('reload')">Reintentar carga</button>
    </div>
    <template v-else>
      <section class="equipment-summary" aria-label="Recursos y capacidad">
        <div><span class="eyebrow">Oro</span><strong>{{ game.resources.gold }}g</strong></div>
        <div><span class="eyebrow">Capacidad</span><strong>{{ game.capacity.used }} / {{ game.capacity.limit }}</strong><small v-if="game.capacity.reserved">{{ game.capacity.reserved }} reservados</small></div>
        <div class="materials"><span class="eyebrow">Materiales</span><span v-for="(amount, name) in game.resources.materials" :key="name">{{ name }} · {{ amount }}</span><span v-if="service !== 'all' && !Object.keys(game.resources.materials).length">Sin materiales</span></div>
      </section>

      <div v-if="operationState !== 'idle' || errorMessage" class="page-alert" :class="statusIsError ? 'page-alert--error' : 'page-alert--success'" :role="statusIsError ? 'alert' : 'status'" :aria-live="statusIsError ? 'assertive' : 'polite'">
        <span>{{ statusCopy }}</span>
        <button v-if="operationState === 'uncertain'" class="btn" type="button" @click="$emit('retry')">Reintentar la misma orden</button>
        <button v-else-if="operationState === 'conflict' || snapshotStale" class="btn" type="button" @click="$emit('reload')">Actualizar partida</button>
      </div>

      <section v-if="game.capacity.blockers.length" class="card blockers" aria-label="Bloqueos de capacidad">
        <strong>La caravana está al límite.</strong><span>Próximo paso: liberá un espacio o completá un trabajo antes de aceptar más carga.</span>
      </section>

      <section class="service-board" aria-labelledby="services-title">
        <div class="section-title"><div><span v-if="service === 'all'" class="eyebrow">{{ serviceLabel }}</span><h2 id="services-title">{{ service === 'all' ? 'Inventario de la caravana' : 'Objetos de la caravana' }}</h2></div><span v-if="service === 'all'" class="tag">Revisión {{ game.revision }}</span><span v-else class="inventory-count">{{ game.items.length }} {{ game.items.length === 1 ? 'objeto' : 'objetos' }}</span></div>
        <div v-if="!game.items.length" class="card equipment-state"><h3>No tenés objetos guardados</h3><p class="muted">{{ service === 'all' ? 'Los objetos que consigas aparecerán acá.' : 'Revisá tus expediciones y volvé cuando tengas objetos guardados.' }}</p></div>
        <div v-else class="item-grid">
          <article v-for="item in game.items" :key="item.itemId" class="card equipment-item" :class="`rarity-${item.rarity}`">
            <div class="item-identity">
              <ItemSprite :item-type="itemTypeForSlot(item.slot)" :alt="service === 'all' ? `Objeto: ${item.name.fallback}` : ''" />
              <div>
                <div class="item-topline"><span class="tag">{{ service === 'all' ? item.rarity : rarityLabel(item.rarity) }}</span><span class="muted">nivel {{ item.level }}</span></div>
                <h3>{{ item.name.fallback }}</h3>
                <p class="muted">{{ identification(item) }} · {{ owner(item) }} · {{ custody(item) }}</p>
              </div>
            </div>
            <ul v-if="item.identification === 'identified'" class="affixes"><li v-for="affix in item.affixes" :key="affix.affixId">{{ affix.name.fallback }} {{ affix.valueText.fallback }}</li><li v-if="item.activeImprint">Impronta: {{ item.activeImprint.name.fallback }}</li></ul>
            <p v-else class="unidentified">{{ service === 'all' ? 'Los afijos están ocultos hasta identificar.' : 'Propiedades sin revelar.' }}</p>
            <div class="item-actions">
              <span v-for="action in visibleActions(item)" :key="action.authorizationId" class="action-control">
                <button :id="`action-${action.authorizationId}`" class="btn" :class="{ primary: service !== 'all' && action.action !== 'dismantle_item' }" :disabled="!action.enabled || operationState === 'pending' || operationState === 'uncertain' || snapshotStale" :aria-describedby="!action.enabled ? `reason-${action.authorizationId}` : undefined" @click="choose(item.itemId, action, $event)">{{ service !== 'all' && action.action === 'queue_blacksmith_job' ? 'Mejorar' : action.label.fallback }}</button>
                <span v-if="!action.enabled" :id="`reason-${action.authorizationId}`" class="action-reason">{{ action.reasonText.fallback }}</span>
              </span>
            </div>
          </article>
        </div>
      </section>

      <section v-if="service !== 'appraiser'" class="jobs" aria-labelledby="jobs-title">
        <div class="section-title"><h2 id="jobs-title">{{ service === 'all' ? 'Trabajos de servicio' : 'Trabajos de herrería' }}</h2><span v-if="service === 'all'" class="muted">El servidor decide cuándo terminan</span></div>
        <div v-if="!visibleJobs.length" class="card jobs-empty"><p class="muted">{{ service === 'all' ? 'No hay trabajos en curso.' : 'No hay trabajos en curso. Las mejoras que encargues aparecerán acá.' }}</p></div>
        <ul v-else class="job-list"><li v-for="job in visibleJobs" :key="job.jobId"><strong>{{ service === 'all' ? (job.service === 'blacksmith' ? 'Herrero' : 'Encantador') : job.label.fallback }}</strong><span>{{ service === 'all' ? job.state : jobStateLabel(job.state) }}</span><time v-if="service === 'all' || 'completesAt' in job">{{ service !== 'all' ? 'Listo a las ' : '' }}{{ jobTime(job) }}</time></li></ul>
      </section>
    </template>
    </div>

    <div v-if="confirmation" class="confirm-backdrop" role="presentation" @click.self="closeConfirmation()">
      <section ref="dialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1" @keydown="trapFocus" @keydown.esc.stop.prevent="closeConfirmation()">
        <h2 id="confirm-title">{{ confirmation.action.label.fallback }}</h2><p>{{ confirmation.option.description.fallback }}</p>
        <ul><li v-for="consequence in confirmation.option.consequences" :key="consequence.text.key">{{ consequence.text.fallback }}</li></ul>
        <div class="item-actions"><button ref="cancelButton" class="btn ghost" type="button" @click="closeConfirmation()">Cancelar</button><button class="btn primary" type="button" @click="confirm">Confirmar</button></div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ItemSprite from '~/components/ItemSprite.vue'
import type { ActionAvailability, GameView, ItemView, ServiceJobView } from '~/shared/types/v2-game-view'
import { itemTypeForSlot } from '~/utils/game-assets'
import { itemAction, selectionFor, type EquipmentAction, type EquipmentEnabledAction, type EquipmentSelection } from '~/utils/v2-equipment-adapter'

const props = withDefaults(defineProps<{ game: GameView | null; loadState: string; operationState: string; errorMessage: string; unavailableReason: string; snapshotStale: boolean; service?: 'all' | 'appraiser' | 'blacksmith'; modal?: boolean }>(), { service: 'all', modal: false })
const emit = defineEmits<{ reload: []; retry: []; action: [selection: EquipmentSelection] }>()
const content = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const triggerId = ref<string | null>(null)
const confirmation = ref<{ revision: number; itemId: string; action: EquipmentEnabledAction; option: { optionId: string; description: { fallback: string }; consequences: Array<{ text: { key: string; fallback: string } }>; acknowledgement?: { acknowledgementId: string } } } | null>(null)
const serviceLabel = computed(() => props.service === 'appraiser' ? 'Tasador' : props.service === 'blacksmith' ? 'Herrería' : 'Equipo y servicios')
const visibleJobs = computed(() => props.game?.serviceJobs.filter((job) => props.service === 'all' || job.service === props.service) ?? [])
const statusIsError = computed(() => Boolean(props.errorMessage) || ['terminal', 'conflict', 'uncertain'].includes(props.operationState))
const statusCopy = computed(() => props.errorMessage || (props.operationState === 'pending' ? 'Procesando la acción…' : props.unavailableReason ? `La acción está bloqueada: ${props.unavailableReason}.` : 'Partida actualizada.'))

watch(() => props.game, (game) => {
  if (!confirmation.value) return
  if (!game || confirmation.value.revision !== game.revision) return closeConfirmation()
  try {
    const item = game.items.find((entry) => entry.itemId === confirmation.value?.itemId)
    const published = item && itemAction(item, confirmation.value.action.action as EquipmentAction)
    if (!published || published.authorizationId !== confirmation.value.action.authorizationId
      || !selectionFor(game, confirmation.value.itemId, confirmation.value.action.action as EquipmentAction, confirmation.value.option.optionId, confirmation.value.option.acknowledgement?.acknowledgementId)) closeConfirmation()
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
    const fallback = triggerId.value ? document.getElementById(triggerId.value) : null
    const currentTarget = target?.isConnected ? target : fallback && content.value?.contains(fallback) ? fallback : null
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
function rarityLabel(rarity: ItemView['rarity']) { return { common: 'Común', magic: 'Mágico', rare: 'Raro', legendary: 'Legendario' }[rarity] }
function jobStateLabel(state: ServiceJobView['state']) { return { queued: 'En espera', active: 'En curso', completed: 'Completado', failed: 'Fallido', cancelled: 'Cancelado' }[state] }
function owner(item: ItemView) { return item.owner.kind === 'caravan' ? 'Propiedad de la caravana' : 'Prestado por visitante' }
function custody(item: ItemView) { return item.custody.kind === 'stash' ? 'Guardado' : 'En uso' }
function jobTime(job: ServiceJobView) { return 'completesAt' in job ? new Date(job.completesAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : job.state }
function visibleActions(item: ItemView) {
  if (props.service === 'all') return item.actions
  const allowed = props.service === 'appraiser' ? ['identify_item'] : ['queue_blacksmith_job', 'dismantle_item']
  return item.actions.filter((action) => allowed.includes(action.action))
}
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
.item-identity { align-items: center; display: flex; gap: .75rem; min-width: 0; }
.item-identity > div { flex: 1; min-width: 0; }
.item-identity :deep(.item-sprite) { height: 64px; width: 64px; }
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
.equipment-v2--service { font-size: 1rem; line-height: 1.5; }
.equipment-v2--service .equipment-content { display: grid; gap: 1.5rem; min-width: 0; }
.equipment-v2--service .equipment-summary { align-items: start; background: transparent; border: 0; border-bottom: 1px solid var(--line); gap: 1rem 2rem; grid-template-columns: auto auto minmax(0, 1fr); padding: 0 0 1.25rem; }
.equipment-v2--service .equipment-summary strong { color: var(--text); font-size: 1rem; font-variant-numeric: tabular-nums; }
.equipment-v2--service .equipment-summary > div:first-child strong { color: var(--accent-2); }
.equipment-v2--service .equipment-summary .eyebrow { color: var(--muted); font-size: .875rem; font-weight: 400; letter-spacing: 0; text-transform: none; }
.equipment-v2--service .equipment-summary small { font-size: .875rem; }
.equipment-v2--service .materials { align-content: start; display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .875rem; }
.equipment-v2--service .materials .eyebrow { flex-basis: 100%; }
.equipment-v2--service .materials span:not(.eyebrow) { color: var(--text); }
.equipment-v2--service .section-title { align-items: center; gap: .5rem 1rem; margin-bottom: .75rem; }
.equipment-v2--service .section-title h2 { font-size: 1rem; font-weight: 600; }
.inventory-count { color: var(--muted); font-size: .875rem; white-space: nowrap; }
.equipment-v2--service .item-grid { gap: 0; grid-template-columns: minmax(0, 1fr); }
.equipment-v2--service .equipment-item { background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; column-gap: 1.5rem; grid-template-columns: minmax(0, 1fr) auto; padding: 1.25rem 0; row-gap: .5rem; }
.equipment-v2--service .equipment-item:first-child { padding-top: .5rem; }
.equipment-v2--service .item-identity { align-items: start; grid-column: 1; }
.equipment-v2--service .item-identity > div { display: flex; flex-direction: column; gap: .25rem; }
.equipment-v2--service .item-identity :deep(.item-sprite) { background: var(--panel-2); border: 1px solid var(--line); height: 56px; padding: .25rem; width: 56px; }
.equipment-v2--service .equipment-item h3 { font-size: 1rem; font-weight: 600; line-height: 1.4; order: -1; }
.equipment-v2--service .item-topline { gap: .5rem .75rem; justify-content: start; font-size: .875rem; }
.equipment-v2--service .item-topline .tag { background: transparent; border: 0; color: var(--rarity-color, var(--muted)); font-size: inherit; padding: 0; }
.equipment-v2--service .rarity-magic { --rarity-color: #83a8ee; }
.equipment-v2--service .rarity-legendary { --rarity-color: #d3965f; }
.equipment-v2--service .item-identity p { font-size: .875rem; }
.equipment-v2--service .affixes, .equipment-v2--service .unidentified { font-size: .875rem; grid-column: 1; margin-left: 4.25rem; }
.equipment-v2--service .affixes { color: var(--text); }
.equipment-v2--service .unidentified { font-style: normal; }
.equipment-v2--service .equipment-item > .item-actions { align-content: center; align-items: start; grid-column: 2; grid-row: 1 / span 2; justify-content: end; margin: 0; max-width: 19rem; padding: 0; }
.equipment-v2--service .action-control { flex: 1 1 7.5rem; }
.equipment-v2--service .item-actions .btn { font-size: .875rem; justify-content: center; }
.equipment-v2--service .action-reason { font-size: .875rem; line-height: 1.4; max-width: 19rem; }
.equipment-v2--service .equipment-state { background: transparent; border: 0; padding: 1rem 0 1.5rem; }
.equipment-v2--service .equipment-state h3 { font-size: 1rem; }
.equipment-v2--service .equipment-state p { color: var(--muted); max-width: 48ch; }
.equipment-v2--service .jobs-empty { background: transparent; border: 0; padding: 0; }
.equipment-v2--service .jobs-empty p { margin: 0; font-size: .875rem; }
.equipment-v2--service .job-list { gap: 0; }
.equipment-v2--service .job-list li { background: transparent; border: 0; border-bottom: 1px solid var(--line); font-size: .875rem; padding: .75rem 0; }
.equipment-v2--service .job-list strong { flex: 1; font-weight: 500; }
.equipment-v2--service .confirm-dialog { max-height: calc(100dvh - 2rem); overflow-y: auto; }
@media (max-width: 600px) { .equipment-summary { grid-template-columns: repeat(2, 1fr); } .equipment-summary .materials { grid-column: 1 / -1; } }
@media (max-width: 700px) {
  .equipment-v2--service .equipment-item { grid-template-columns: minmax(0, 1fr); }
  .equipment-v2--service .equipment-item > .item-actions { grid-column: 1; grid-row: auto; justify-content: start; margin-top: .25rem; max-width: none; }
  .equipment-v2--service .action-control { flex: 0 1 auto; }
}
@media (max-width: 600px) {
  .equipment-v2--service .equipment-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .equipment-v2--service .section-title { align-items: baseline; }
  .equipment-v2--service .action-control { flex: 1 1 8rem; }
  .equipment-v2--service .action-reason { max-width: none; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
