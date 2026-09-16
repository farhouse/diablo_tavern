<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  ActionAvailability,
  AbandonRecoveryAction,
  AcceptContractAction,
  AssignRecoveryAction,
  ConfirmSettlementAction,
  GameView,
  Id,
  LocalizedText,
  RecoveryView,
  ReconcileGameAction,
  SettlementView,
  VisitorView
} from '~/shared/types/v2-game-view'
import { enabledAction, type VisitorV2Selection } from '~/utils/v2-visitor-adapter'

const props = defineProps<{
  game: GameView | null
  loadState: 'loading' | 'empty' | 'ready'
  operationState?: 'idle' | 'pending' | 'uncertain' | 'conflict' | 'unavailable' | 'terminal'
  errorMessage?: string
  unavailableReason?: string
  nowMs?: number
}>()

const emit = defineEmits<{
  acceptContract: [selection: Extract<VisitorV2Selection, { kind: 'contract' }>]
  startExpedition: [visitorId: string]
  reconcileGame: []
  confirmSettlement: [selection: Extract<VisitorV2Selection, { kind: 'settlement' }>]
  assignRecovery: [selection: Extract<VisitorV2Selection, { kind: 'recovery' }>]
  abandonRecovery: [selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>]
  retry: []
}>()

const operationState = computed(() => props.operationState ?? 'idle')
const busy = computed(() => operationState.value === 'pending' || operationState.value === 'uncertain')
const contractOptions = ref<Record<Id, Id>>({})
const contractLoans = ref<Record<Id, Id[]>>({})
const recoveryBindings = ref<Record<Id, string>>({})
const recoveryLoans = ref<Record<Id, Id[]>>({})
const abandonConfirmations = ref<Record<Id, boolean>>({})
const currentNowMs = ref(0)
const clockClientStartedAt = ref(0)
const clockServerStartedAt = ref(0)
const emittedTransitionKeys = new Set<string>()
let clockTimer: ReturnType<typeof setInterval> | null = null

const statusText = computed(() => {
  if (props.loadState === 'loading') return 'Cargando snapshot V2.'
  if (props.loadState === 'empty') return 'No hay snapshot V2 confirmado.'
  if (operationState.value === 'pending') return 'Procesando orden.'
  if (operationState.value === 'uncertain') return 'Resultado incierto. Reintentá la misma orden.'
  if (operationState.value === 'conflict') return props.errorMessage || 'La partida cambió. Revisá el snapshot actualizado.'
  if (operationState.value === 'unavailable') return props.unavailableReason || 'La acción ya no está disponible.'
  if (operationState.value === 'terminal') return props.errorMessage || 'La orden terminó sin cambiar el snapshot.'
  return 'Snapshot V2 listo.'
})

const countdownText = computed(() => {
  if (!props.game?.nextTransitionAt) return 'Sin transición programada'
  const remaining = Math.max(0, Date.parse(props.game.nextTransitionAt) - currentNowMs.value)
  return remaining === 0 ? 'Transición lista para reconciliar' : `${Math.ceil(remaining / 1000)}s hasta la próxima transición`
})

const reconcileAction = computed(() => enabledAction<ReconcileGameAction>(props.game?.actions, 'reconcile_game'))
const reconcileDisabledReason = computed(() => actionReason(props.game?.actions ?? [], 'reconcile_game'))

function label(text: LocalizedText): string {
  return text.fallback
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function resetClock() {
  clockClientStartedAt.value = Date.now()
  clockServerStartedAt.value = props.nowMs ?? (props.game ? Date.parse(props.game.serverNow) : Date.now())
  updateClock()
}

function updateClock() {
  currentNowMs.value = props.nowMs ?? clockServerStartedAt.value + Math.max(0, Date.now() - clockClientStartedAt.value)
  emitDueReconcile()
}

function startClock() {
  stopClock()
  if (!visible()) return
  updateClock()
  clockTimer = setInterval(updateClock, 1000)
}

function stopClock() {
  if (!clockTimer) return
  clearInterval(clockTimer)
  clockTimer = null
}

function onVisibilityChange() {
  if (!visible()) {
    stopClock()
    return
  }
  startClock()
}

function emitDueReconcile() {
  if (!props.game?.nextTransitionAt || !reconcileAction.value || !visible()) return
  if (Date.parse(props.game.nextTransitionAt) > currentNowMs.value) return
  const key = `${props.game.revision}:${props.game.nextTransitionAt}`
  if (emittedTransitionKeys.has(key)) return
  emittedTransitionKeys.add(key)
  emit('reconcileGame')
}

function selectedContractBinding(visitor: VisitorView) {
  const action = contractAction(visitor)
  if (!action) return null
  const optionId = contractOptions.value[visitor.visitorId] ?? action.execution.bindings[0]?.optionId
  return action.execution.bindings.find((binding) => binding.optionId === optionId) ?? action.execution.bindings[0] ?? null
}

function selectedRecoveryBinding(recovery: RecoveryView) {
  const action = assignAction(recovery)
  if (!action) return null
  const key = recoveryBindings.value[recovery.recoveryId] ?? bindingKey(action.execution.bindings[0])
  return action.execution.bindings.find((binding) => bindingKey(binding) === key) ?? action.execution.bindings[0] ?? null
}

function contractAction(visitor: VisitorView): AcceptContractAction | null {
  return enabledAction<AcceptContractAction>(actionsOf(visitor), 'accept_contract')
}

function assignAction(recovery: RecoveryView): AssignRecoveryAction | null {
  return enabledAction<AssignRecoveryAction>(actionsOf(recovery), 'assign_recovery')
}

function abandonAction(recovery: RecoveryView): AbandonRecoveryAction | null {
  return enabledAction<AbandonRecoveryAction>(actionsOf(recovery), 'abandon_recovery')
}

function bindingKey(binding: { visitorId: Id, optionId: Id } | undefined): string {
  return binding ? `${binding.visitorId}:${binding.optionId}` : ''
}

function itemLabel(itemId: Id): string {
  return label(props.game?.items.find((item) => item.itemId === itemId)?.name ?? { key: itemId, fallback: itemId })
}

function contractOptionLabel(visitor: VisitorView, optionId: Id): string {
  if (!('contractOptions' in visitor)) return optionId
  return label(visitor.contractOptions.find((option) => option.optionId === optionId)?.label ?? { key: optionId, fallback: optionId })
}

function toggleLoan(target: Record<Id, Id[]>, ownerId: Id, itemId: Id, checked: boolean) {
  const current = target[ownerId] ?? []
  target[ownerId] = checked ? [...new Set([...current, itemId])] : current.filter((candidate) => candidate !== itemId)
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked)
}

function actionReason(actions: readonly ActionAvailability[], actionName: ActionAvailability['action']): string {
  const disabled = actions.find((action) => action.action === actionName && !action.enabled)
  if (disabled && !disabled.enabled) return label(disabled.reasonText)
  return enabledAction(actions, actionName) ? '' : 'Acción no publicada en el snapshot.'
}

function reasonId(prefix: string, id: Id): string | undefined {
  return `${prefix}-reason-${id}`
}

function accept(visitor: VisitorView) {
  const action = contractAction(visitor)
  const binding = selectedContractBinding(visitor)
  if (!action || !binding) return
  emit('acceptContract', {
    kind: 'contract',
    visitorId: action.execution.visitorId,
    optionId: binding.optionId,
    loanItemIds: (contractLoans.value[visitor.visitorId] ?? []).filter((itemId) => binding.eligibleLoanItemIds.includes(itemId))
  })
}

function start(visitor: VisitorView) {
  emit('startExpedition', visitor.visitorId)
}

function confirm(settlement: SettlementView) {
  if (!('choiceGroups' in settlement)) return
  emit('confirmSettlement', {
    kind: 'settlement',
    settlementId: settlement.settlementId,
    selectedOptionIds: Object.fromEntries(settlement.choiceGroups.map((group) => [group.groupId, group.defaultOptionId]))
  })
}

function assign(recovery: RecoveryView) {
  const action = assignAction(recovery)
  const binding = selectedRecoveryBinding(recovery)
  if (!action || !binding) return
  emit('assignRecovery', {
    kind: 'recovery',
    recoveryId: action.execution.recoveryId,
    visitorId: binding.visitorId,
    optionId: binding.optionId,
    loanItemIds: (recoveryLoans.value[recovery.recoveryId] ?? []).filter((itemId) => binding.eligibleLoanItemIds.includes(itemId))
  })
}

function abandon(recovery: RecoveryView) {
  const action = enabledAction<AbandonRecoveryAction>(actionsOf(recovery), 'abandon_recovery')
  const acknowledgementId = action?.execution.acknowledgement.acknowledgementId
  if (!action || !acknowledgementId) return
  emit('abandonRecovery', {
    kind: 'abandon_recovery',
    recoveryId: action.execution.recoveryId,
    acknowledgementId
  })
}

function settlementAction(settlement: SettlementView): ConfirmSettlementAction | null {
  return enabledAction<ConfirmSettlementAction>(actionsOf(settlement), 'confirm_settlement')
}

function actionsOf(entity: { actions: readonly ActionAvailability[] }): readonly ActionAvailability[] {
  return entity.actions
}

watch(() => [props.game?.revision, props.game?.serverNow, props.nowMs] as const, resetClock, { immediate: true })

onMounted(() => {
  startClock()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  stopClock()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <section class="v2-cycle" aria-labelledby="v2-cycle-title">
    <header class="v2-cycle__header">
      <div>
        <h2 id="v2-cycle-title">Visitantes V2</h2>
        <p v-if="game" class="v2-cycle__muted">
          Rev. {{ game.revision }} · servidor {{ game.serverNow }} · {{ countdownText }}
        </p>
      </div>
      <button
        class="v2-cycle__button"
        type="button"
        :disabled="busy || !game || !reconcileAction"
        :aria-describedby="reconcileDisabledReason ? 'reconcile-reason' : undefined"
        @click="emit('reconcileGame')"
      >
        Reconciliar
      </button>
      <span v-if="reconcileDisabledReason" id="reconcile-reason" class="v2-cycle__reason">
        {{ reconcileDisabledReason }}
      </span>
    </header>

    <p class="v2-cycle__status" aria-live="polite" data-testid="v2-status">
      {{ statusText }}
    </p>

    <div v-if="loadState === 'loading'" class="v2-cycle__grid" data-testid="v2-loading">
      <span class="v2-cycle__skeleton" />
      <span class="v2-cycle__skeleton" />
    </div>

    <div v-else-if="loadState === 'empty' || !game" class="v2-cycle__empty" data-testid="v2-empty">
      <p>No hay datos V2 disponibles para operar sin mezclar autoridades.</p>
    </div>

    <div v-else class="v2-cycle__body" data-testid="v2-ready">
      <section class="v2-cycle__panel" aria-labelledby="v2-visitors-title">
        <h3 id="v2-visitors-title">Visitantes</h3>
        <article v-for="visitor in game.visitors" :key="visitor.visitorId" class="v2-cycle__row" :data-testid="`visitor-${visitor.state}`">
          <div>
            <strong>{{ label(visitor.name) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ visitor.state }}</p>
            <p v-if="visitor.state === 'departed' || visitor.state === 'dead'" class="v2-cycle__muted">
              Estado terminal sin acciones disponibles.
            </p>
          </div>
          <div class="v2-cycle__actions">
            <button
              v-if="visitor.state === 'available' || visitor.state === 'negotiating'"
              class="v2-cycle__button"
              type="button"
              :disabled="busy || !enabledAction(actionsOf(visitor), 'accept_contract')"
              :aria-describedby="actionReason(actionsOf(visitor), 'accept_contract') ? reasonId('accept', visitor.visitorId) : undefined"
              @click="accept(visitor)"
            >
              Aceptar contrato
            </button>
            <label v-if="contractAction(visitor)" class="v2-cycle__field">
              Contrato
              <select
                v-model="contractOptions[visitor.visitorId]"
                class="v2-cycle__select"
                :disabled="busy"
              >
                <option
                  v-for="binding in contractAction(visitor)?.execution.bindings"
                  :key="binding.optionId"
                  :value="binding.optionId"
                >
                  {{ contractOptionLabel(visitor, binding.optionId) }}
                </option>
              </select>
            </label>
            <fieldset
              v-if="selectedContractBinding(visitor)?.eligibleLoanItemIds.length"
              class="v2-cycle__fieldset"
              :disabled="busy"
            >
              <legend>Préstamos</legend>
              <label
                v-for="itemId in selectedContractBinding(visitor)?.eligibleLoanItemIds"
                :key="itemId"
                class="v2-cycle__check"
              >
                <input
                  type="checkbox"
                  :checked="(contractLoans[visitor.visitorId] ?? []).includes(itemId)"
                  @change="toggleLoan(contractLoans, visitor.visitorId, itemId, eventChecked($event))"
                >
                {{ itemLabel(itemId) }}
              </label>
            </fieldset>
            <span
              v-if="actionReason(actionsOf(visitor), 'accept_contract')"
              :id="reasonId('accept', visitor.visitorId)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(visitor), 'accept_contract') }}
            </span>
            <button
              v-if="visitor.state === 'contracted'"
              class="v2-cycle__button"
              type="button"
              :disabled="busy || !enabledAction(actionsOf(visitor), 'start_expedition')"
              :aria-describedby="actionReason(actionsOf(visitor), 'start_expedition') ? reasonId('start', visitor.visitorId) : undefined"
              @click="start(visitor)"
            >
              Iniciar expedición
            </button>
            <span
              v-if="visitor.state === 'contracted' && actionReason(actionsOf(visitor), 'start_expedition')"
              :id="reasonId('start', visitor.visitorId)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(visitor), 'start_expedition') }}
            </span>
          </div>
        </article>
      </section>

      <section class="v2-cycle__panel" aria-labelledby="v2-expeditions-title">
        <h3 id="v2-expeditions-title">Expediciones</h3>
        <article v-for="expedition in game.expeditions" :key="expedition.expeditionId" class="v2-cycle__row" :data-testid="`expedition-${expedition.state}`">
          <div>
            <strong>{{ expedition.expeditionId }}</strong>
            <p class="v2-cycle__muted">Estado: {{ expedition.state }}</p>
            <p v-if="expedition.state === 'active'" class="v2-cycle__muted">
              {{ expedition.currentHp }}/{{ expedition.maxHp }} vida. El reloj es informativo; sólo el servidor avanza estado.
            </p>
            <p v-if="expedition.state === 'settled'" class="v2-cycle__muted">
              Resultado cerrado: {{ expedition.outcome }}.
            </p>
          </div>
        </article>
      </section>

      <section class="v2-cycle__panel" aria-labelledby="v2-settlements-title">
        <h3 id="v2-settlements-title">Settlement</h3>
        <article v-for="settlement in game.settlements" :key="settlement.settlementId" class="v2-cycle__row" :data-testid="`settlement-${settlement.state}`">
          <div>
            <strong>{{ settlement.settlementId }}</strong>
            <p class="v2-cycle__muted">Estado: {{ settlement.state }}</p>
            <p v-if="'gold' in settlement" class="v2-cycle__muted">
              Oro bruto {{ settlement.gold.gross }}, caravana {{ settlement.gold.caravan }}, visitante {{ settlement.gold.visitor }}.
            </p>
            <ul v-if="'choiceGroups' in settlement" class="v2-cycle__list">
              <li v-for="group in settlement.choiceGroups" :key="group.groupId">
                {{ label(group.label) }}: {{ group.options.map((option) => label(option.label)).join(', ') }}
              </li>
            </ul>
          </div>
          <button
            v-if="settlement.state === 'preview_ready'"
            class="v2-cycle__button"
            type="button"
            :disabled="busy || !settlementAction(settlement)"
            :aria-describedby="actionReason(actionsOf(settlement), 'confirm_settlement') ? reasonId('settlement', settlement.settlementId) : undefined"
            @click="confirm(settlement)"
          >
            Confirmar preview
          </button>
          <span
            v-if="settlement.state === 'preview_ready' && actionReason(actionsOf(settlement), 'confirm_settlement')"
            :id="reasonId('settlement', settlement.settlementId)"
            class="v2-cycle__reason"
          >
            {{ actionReason(actionsOf(settlement), 'confirm_settlement') }}
          </span>
          <p v-else-if="settlement.state === 'preview_expired'" class="v2-cycle__muted">
            Preview expirado según snapshot.
          </p>
        </article>
      </section>

      <section class="v2-cycle__panel" aria-labelledby="v2-recoveries-title">
        <h3 id="v2-recoveries-title">Recovery</h3>
        <article v-for="recovery in game.recoveries" :key="recovery.recoveryId" class="v2-cycle__row" :data-testid="`recovery-${recovery.state}`">
          <div>
            <strong>{{ recovery.recoveryId }}</strong>
            <p class="v2-cycle__muted">Estado: {{ recovery.state }} · objetos {{ recovery.itemIds.join(', ') }}</p>
            <p v-if="recovery.state === 'assigned'" class="v2-cycle__muted">
              Asignado a {{ recovery.assignedVisitorId }} hasta {{ recovery.completesAt }}.
            </p>
            <p v-if="recovery.state === 'failed' || recovery.state === 'abandoned'" class="v2-cycle__muted">
              {{ label(recovery.consequence.text) }}
            </p>
          </div>
          <div v-if="recovery.state === 'open'" class="v2-cycle__actions">
            <button
              class="v2-cycle__button"
              type="button"
              :disabled="busy || !enabledAction(actionsOf(recovery), 'assign_recovery')"
              :aria-describedby="actionReason(actionsOf(recovery), 'assign_recovery') ? reasonId('assign', recovery.recoveryId) : undefined"
              @click="assign(recovery)"
            >
              Asignar recovery
            </button>
            <label v-if="assignAction(recovery)" class="v2-cycle__field">
              Recuperador
              <select
                v-model="recoveryBindings[recovery.recoveryId]"
                class="v2-cycle__select"
                :disabled="busy"
              >
                <option
                  v-for="binding in assignAction(recovery)?.execution.bindings"
                  :key="bindingKey(binding)"
                  :value="bindingKey(binding)"
                >
                  {{ binding.visitorId }} · {{ binding.optionId }}
                </option>
              </select>
            </label>
            <fieldset
              v-if="selectedRecoveryBinding(recovery)?.eligibleLoanItemIds.length"
              class="v2-cycle__fieldset"
              :disabled="busy"
            >
              <legend>Préstamos</legend>
              <label
                v-for="itemId in selectedRecoveryBinding(recovery)?.eligibleLoanItemIds"
                :key="itemId"
                class="v2-cycle__check"
              >
                <input
                  type="checkbox"
                  :checked="(recoveryLoans[recovery.recoveryId] ?? []).includes(itemId)"
                  @change="toggleLoan(recoveryLoans, recovery.recoveryId, itemId, eventChecked($event))"
                >
                {{ itemLabel(itemId) }}
              </label>
            </fieldset>
            <span
              v-if="actionReason(actionsOf(recovery), 'assign_recovery')"
              :id="reasonId('assign', recovery.recoveryId)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(recovery), 'assign_recovery') }}
            </span>
            <label
              v-if="abandonAction(recovery)"
              class="v2-cycle__check"
              :id="`abandon-ack-${recovery.recoveryId}`"
            >
              <input
                v-model="abandonConfirmations[recovery.recoveryId]"
                type="checkbox"
                :disabled="busy"
              >
              {{ label(abandonAction(recovery)!.execution.acknowledgement.text) }}
            </label>
            <button
              class="v2-cycle__button v2-cycle__button--danger"
              type="button"
              :disabled="busy || !abandonAction(recovery) || !abandonConfirmations[recovery.recoveryId]"
              :aria-describedby="[
                actionReason(actionsOf(recovery), 'abandon_recovery') ? reasonId('abandon', recovery.recoveryId) : '',
                abandonAction(recovery) ? `abandon-ack-${recovery.recoveryId}` : ''
              ].filter(Boolean).join(' ') || undefined"
              @click="abandon(recovery)"
            >
              Abandonar
            </button>
            <span
              v-if="actionReason(actionsOf(recovery), 'abandon_recovery')"
              :id="reasonId('abandon', recovery.recoveryId)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(recovery), 'abandon_recovery') }}
            </span>
          </div>
        </article>
      </section>
    </div>

    <button
      v-if="operationState === 'uncertain'"
      class="v2-cycle__button v2-cycle__button--primary"
      type="button"
      data-testid="v2-retry"
      @click="emit('retry')"
    >
      Reintentar misma orden
    </button>
  </section>
</template>

<style scoped>
.v2-cycle {
  display: grid;
  gap: 1rem;
}

.v2-cycle__header,
.v2-cycle__row {
  align-items: start;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.v2-cycle__body,
.v2-cycle__grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.v2-cycle__panel,
.v2-cycle__empty {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
}

.v2-cycle__row {
  background: #14120f;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.75rem;
}

.v2-cycle__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: end;
}

.v2-cycle__field,
.v2-cycle__fieldset,
.v2-cycle__check {
  display: grid;
  gap: 0.35rem;
}

.v2-cycle__check {
  align-items: center;
  grid-auto-flow: column;
  justify-content: start;
}

.v2-cycle__fieldset {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.5rem;
}

.v2-cycle__select {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  min-height: 44px;
  padding: 0.5rem;
}

.v2-cycle__button {
  align-items: center;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  min-height: 44px;
  padding: 0.55rem 0.85rem;
}

.v2-cycle__button--primary {
  background: var(--accent);
  border-color: #ef7d56;
}

.v2-cycle__button--danger {
  border-color: var(--bad);
}

.v2-cycle__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.v2-cycle__button:not(:disabled):hover {
  border-color: var(--accent-2);
}

.v2-cycle__status,
.v2-cycle__reason {
  color: var(--accent-2);
}

.v2-cycle__muted,
.v2-cycle__list {
  color: var(--muted);
}

.v2-cycle__skeleton {
  background: linear-gradient(90deg, var(--panel), var(--panel-2), var(--panel));
  border-radius: 8px;
  display: block;
  min-height: 8rem;
}

@media (max-width: 680px) {
  .v2-cycle__header,
  .v2-cycle__row {
    align-items: stretch;
    flex-direction: column;
  }

  .v2-cycle__actions,
  .v2-cycle__button {
    justify-content: center;
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-cycle__skeleton {
    background: var(--panel);
  }
}
</style>
