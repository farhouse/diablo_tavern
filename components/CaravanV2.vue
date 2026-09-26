<template>
  <div class="caravan-v2" ref="content" tabindex="-1">
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

      <section class="card actions-card" aria-labelledby="actions-title"><div class="row"><div><span class="eyebrow">Autorizaciones selladas</span><h2 id="actions-title">Acciones disponibles</h2></div><span v-if="!upgradeAction" class="tag">Sin mejoras habilitadas</span></div><div v-if="upgradeAction" class="upgrade-option"><div><strong>{{ upgradeAction.execution.options[0]?.label.fallback }}</strong><p class="muted">{{ upgradeAction.execution.options[0]?.description.fallback }}</p></div><button class="btn primary" type="button" :disabled="disabled" @click="openConfirmation">Revisar mejora</button></div><p v-else class="muted">La caravana está bloqueada por el snapshot actual. Revisá deuda o esperá una nueva autorización.</p></section>
    </template>

    <div v-if="confirmation" class="confirm-backdrop" role="presentation" @click.self="closeConfirmation"><section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="upgrade-confirm-title" @keydown.esc="closeConfirmation"><h2 id="upgrade-confirm-title">{{ confirmation.option.label.fallback }}</h2><p>{{ confirmation.option.description.fallback }}</p><h3>Consecuencias publicadas</h3><ul><li v-for="consequence in confirmation.option.consequences" :key="consequence.text.key">{{ consequence.text.fallback }}</li><li v-if="!confirmation.option.consequences.length">La mejora se aplicará únicamente cuando el servidor publique una nueva revisión.</li></ul><div class="item-actions"><button ref="cancelButton" class="btn ghost" type="button" @click="closeConfirmation">Cancelar</button><button class="btn primary" type="button" @click="confirmUpgrade">Confirmar mejora</button></div></section></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { GameView, UpgradeCaravanAction } from '~/shared/types/v2-game-view'
import { selectionForCaravanUpgrade, type CaravanSelection } from '~/utils/v2-caravan-adapter'

const props = defineProps<{ game: GameView | null; loadState: string; operationState: string; errorMessage: string; unavailableReason: string; snapshotStale: boolean }>()
const emit = defineEmits<{ reload: []; retry: []; upgrade: [selection: CaravanSelection] }>()
const confirmation = ref<({ revision: number; action: UpgradeCaravanAction; option: UpgradeCaravanAction['execution']['options'][number] }) | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const disabled = computed(() => props.snapshotStale || props.operationState === 'pending' || props.operationState === 'uncertain')
const upgradeAction = computed(() => props.game ? props.game.actions.find((action): action is UpgradeCaravanAction => action.action === 'upgrade_caravan' && action.enabled) ?? null : null)
const operationLabel = computed(() => props.operationState === 'pending' ? 'Mejora enviada; esperando snapshot confirmado…' : props.unavailableReason ? `La acción está bloqueada: ${props.unavailableReason}.` : 'Revisá el estado publicado.')
watch(() => [props.game?.revision, props.snapshotStale], () => { if (confirmation.value && (!props.game || props.game.revision !== confirmation.value.revision || !selectionForCaravanUpgrade(props.game, confirmation.value.option.optionId))) closeConfirmation() })
watch(confirmation, async (value) => { if (value) { await nextTick(); cancelButton.value?.focus() } })
function openConfirmation() { const action = upgradeAction.value; const option = action?.execution.options[0]; if (action && option && !disabled.value) confirmation.value = { revision: props.game!.revision, action, option } }
function closeConfirmation() { confirmation.value = null }
function confirmUpgrade() { if (!confirmation.value || !props.game || props.game.revision !== confirmation.value.revision) return closeConfirmation(); const selection = selectionForCaravanUpgrade(props.game, confirmation.value.option.optionId); closeConfirmation(); if (selection) emit('upgrade', selection) }
function formatDate(value: string) { return new Date(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) }
function upgradeName(value: string) { return ({ visitor_quarters: 'Alojamiento', blacksmith: 'Herrería', enchanter: 'Encantamiento' } as Record<string, string>)[value] ?? value }
function upgradeDescription(value: string) { return ({ visitor_quarters: 'Más espacio para visitantes.', blacksmith: 'Desbloquea el servicio del herrero.', enchanter: 'Desbloquea el servicio del encantador.' } as Record<string, string>)[value] ?? 'Mejora publicada por la caravana.' }
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
.upgrade-option { align-items: center; display: flex; gap: 1rem; justify-content: space-between; padding-top: .8rem; }
.upgrade-option p { margin: .25rem 0 0; }
.state { display: grid; gap: .5rem; justify-items: start; }
.state h2, .state p { margin: 0; }
.item-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.confirm-backdrop { align-items: center; background: rgba(0,0,0,.7); display: flex; inset: 0; justify-content: center; padding: 1rem; position: fixed; z-index: 20; }
.confirm-dialog { background: var(--panel); border: 1px solid var(--accent-2); max-width: 34rem; padding: 1.25rem; width: 100%; }
.confirm-dialog p { color: var(--muted); }
@media (max-width: 700px) { .stats { grid-template-columns: 1fr; } .caravan-hero, .upgrade-option { align-items: stretch; flex-direction: column; } }
</style>
