<script setup lang="ts">
import { computed } from 'vue'
import type {
  ActionAvailability,
  AbandonRecoveryAction,
  AcceptContractAction,
  AssignRecoveryAction,
  ConfirmSettlementAction,
  GameView,
  RecoveryView,
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
const busy = computed(() => operationState.value === 'pending')
const statusText = computed(() => {
  if (props.loadState === 'loading') return 'Cargando snapshot V2.'
  if (props.loadState === 'empty') return 'No hay snapshot V2 confirmado.'
  if (operationState.value === 'pending') return 'Procesando orden.'
  if (operationState.value === 'uncertain') return 'Resultado incierto. Reintentá la misma orden.'
  if (operationState.value === 'conflict') return 'La partida cambió. Revisá el snapshot actualizado.'
  if (operationState.value === 'unavailable') return props.unavailableReason || 'La acción ya no está disponible.'
  if (operationState.value === 'terminal') return props.errorMessage || 'La orden terminó sin cambiar el snapshot.'
  return 'Snapshot V2 listo.'
})

const countdownText = computed(() => {
  if (!props.game?.nextTransitionAt) return 'Sin transición programada'
  const now = props.nowMs ?? Date.parse(props.game.serverNow)
  const remaining = Math.max(0, Date.parse(props.game.nextTransitionAt) - now)
  return remaining === 0 ? 'Transición lista para reconciliar' : `${Math.ceil(remaining / 1000)}s hasta la próxima transición`
})

function label(text: { fallback: string }): string {
  return text.fallback
}

function reason(action: ActionAvailability | undefined): string {
  return action && !action.enabled ? label(action.reasonText) : ''
}

function disabledAction(actions: readonly ActionAvailability[], actionName: ActionAvailability['action']): ActionAvailability | undefined {
  return actions.find((action) => action.action === actionName && !action.enabled)
}

function accept(visitor: VisitorView) {
  const action = enabledAction<AcceptContractAction>(actionsOf(visitor), 'accept_contract')
  const binding = action?.execution.bindings[0]
  if (!binding) return
  emit('acceptContract', {
    kind: 'contract',
    visitorId: action.execution.visitorId,
    optionId: binding.optionId,
    loanItemIds: []
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
  const action = enabledAction<AssignRecoveryAction>(actionsOf(recovery), 'assign_recovery')
  const binding = action?.execution.bindings[0]
  if (!binding) return
  emit('assignRecovery', {
    kind: 'recovery',
    recoveryId: action.execution.recoveryId,
    visitorId: binding.visitorId,
    optionId: binding.optionId,
    loanItemIds: []
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
        :disabled="busy || !game"
        @click="emit('reconcileGame')"
      >
        Reconciliar
      </button>
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
              :aria-describedby="disabledAction(actionsOf(visitor), 'accept_contract') ? `accept-reason-${visitor.visitorId}` : undefined"
              @click="accept(visitor)"
            >
              Aceptar contrato
            </button>
            <span
              v-if="reason(disabledAction(actionsOf(visitor), 'accept_contract'))"
              :id="`accept-reason-${visitor.visitorId}`"
              class="v2-cycle__reason"
            >
              {{ reason(disabledAction(actionsOf(visitor), 'accept_contract')) }}
            </span>
            <button
              v-if="visitor.state === 'contracted'"
              class="v2-cycle__button"
              type="button"
              :disabled="busy || !enabledAction(actionsOf(visitor), 'start_expedition')"
              @click="start(visitor)"
            >
              Iniciar expedición
            </button>
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
            @click="confirm(settlement)"
          >
            Confirmar preview
          </button>
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
              @click="assign(recovery)"
            >
              Asignar recovery
            </button>
            <button
              class="v2-cycle__button v2-cycle__button--danger"
              type="button"
              :disabled="busy || !enabledAction(actionsOf(recovery), 'abandon_recovery')"
              @click="abandon(recovery)"
            >
              Abandonar
            </button>
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
