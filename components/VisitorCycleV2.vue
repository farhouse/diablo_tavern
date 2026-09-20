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
  snapshotStale?: boolean
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
  reload: []
}>()

const operationState = computed(() => props.operationState ?? 'idle')
const busy = computed(() => operationState.value === 'pending' || operationState.value === 'uncertain')
const locked = computed(() => busy.value || props.snapshotStale === true)
const contractOptions = ref<Record<Id, Id>>({})
const contractLoans = ref<Record<Id, Id[]>>({})
const recoveryBindings = ref<Record<Id, string>>({})
const recoveryLoans = ref<Record<Id, Id[]>>({})
const settlementChoices = ref<Record<Id, Record<Id, Id>>>({})
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
  if (!props.game?.nextTransitionAt || !reconcileAction.value || !visible() || locked.value) return
  if (Date.parse(props.game.nextTransitionAt) > currentNowMs.value) return
  const key = `${props.game.revision}:${props.game.nextTransitionAt}`
  if (emittedTransitionKeys.has(key)) return
  emit('reconcileGame')
  emittedTransitionKeys.add(key)
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
  const key = recoveryBindings.value[recovery.recoveryId] ?? recoveryBindingKey(action.execution.bindings[0])
  return action.execution.bindings.find((binding) => recoveryBindingKey(binding) === key) ?? action.execution.bindings[0] ?? null
}

function selectedSettlementOption(settlement: SettlementView, groupId: Id): Id {
  if (!('choiceGroups' in settlement)) return ''
  const action = settlementAction(settlement)
  const group = settlement.choiceGroups.find((candidate) => candidate.groupId === groupId)
  const eligible = action?.execution.groups.find((candidate) => candidate.groupId === groupId)?.eligibleOptionIds ?? []
  const optionIds = group?.options.map((option) => option.optionId) ?? []
  const selected = settlementChoices.value[settlement.settlementId]?.[groupId]
  if (selected && eligible.includes(selected) && optionIds.includes(selected)) return selected
  if (group?.defaultOptionId && eligible.includes(group.defaultOptionId)) return group.defaultOptionId
  return eligible.find((optionId) => optionIds.includes(optionId)) ?? ''
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

function recoveryBindingLabel(recovery: RecoveryView, binding: { visitorId: Id, optionId: Id }): string {
  const visitor = props.game?.visitors.find((candidate) => candidate.visitorId === binding.visitorId)
  const option = recovery?.state === 'open' ? recovery.options.find((candidate) => candidate.optionId === binding.optionId) : undefined
  return `${visitor ? label(visitor.name) : 'Visitante no disponible'} · ${option ? label(option.label) : 'Opción no disponible'}`
}

function recoveryBindingKey(binding: { visitorId: Id, optionId: Id } | undefined): string {
  return binding ? JSON.stringify([binding.visitorId, binding.optionId]) : ''
}

function itemLabel(itemId: Id): string {
  const item = props.game?.items.find((candidate) => candidate.itemId === itemId)
  return item ? label(item.name) : 'Objeto no disponible'
}

function contractOptionLabel(visitor: VisitorView, optionId: Id): string {
  const options = visitor.state === 'available'
    ? visitor.contractOptions
    : visitor.state === 'negotiating'
      ? visitor.options
      : []
  const option = options.find((candidate) => candidate.optionId === optionId)
  return option ? label(option.label) : 'Opción no disponible'
}

function visitorLabel(visitorId: Id): string {
  const visitor = props.game?.visitors.find((candidate) => candidate.visitorId === visitorId)
  return visitor ? label(visitor.name) : 'Visitante no disponible'
}

function expeditionTitle(visitorId: Id): string {
  return `Expedición de ${visitorLabel(visitorId)}`
}

function settlementTitle(settlement: SettlementView): string {
  const expedition = props.game?.expeditions.find((candidate) => candidate.expeditionId === settlement.expeditionId)
  return expedition ? `Resolución de ${visitorLabel(expedition.visitorId)}` : 'Resolución de expedición'
}

function recoveryTitle(recovery: RecoveryView): string {
  const names = recovery.itemIds.map(itemLabel)
  return names.length ? `Recuperación de ${names.join(', ')}` : 'Recuperación pendiente'
}

function toggleLoan(target: Record<Id, Id[]>, ownerId: Id, itemId: Id, checked: boolean) {
  const current = target[ownerId] ?? []
  target[ownerId] = checked ? [...new Set([...current, itemId])] : current.filter((candidate) => candidate !== itemId)
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked)
}

function setSettlementChoice(settlementId: Id, groupId: Id, optionId: Id) {
  settlementChoices.value[settlementId] = {
    ...(settlementChoices.value[settlementId] ?? {}),
    [groupId]: optionId
  }
}

function actionReason(actions: readonly ActionAvailability[], actionName: ActionAvailability['action']): string {
  const disabled = actions.find((action) => action.action === actionName && !action.enabled)
  if (disabled && !disabled.enabled) return label(disabled.reasonText)
  return enabledAction(actions, actionName) ? '' : 'Acción no publicada en el snapshot.'
}

function internalId(scope: string, ...indices: number[]): string {
  return `v2-${scope}-${indices.join('-')}`
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
    selectedOptionIds: Object.fromEntries(settlement.choiceGroups.map((group) => [group.groupId, selectedSettlementOption(settlement, group.groupId)]))
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

function syncLocalSelections() {
  if (!props.game) {
    contractOptions.value = {}
    contractLoans.value = {}
    recoveryBindings.value = {}
    recoveryLoans.value = {}
    settlementChoices.value = {}
    abandonConfirmations.value = {}
    return
  }

  const nextContractOptions: Record<Id, Id> = {}
  const nextContractLoans: Record<Id, Id[]> = {}
  for (const visitor of props.game.visitors) {
    const action = contractAction(visitor)
    if (!action) continue
    const current = contractOptions.value[visitor.visitorId]
    const binding = action.execution.bindings.find((candidate) => candidate.optionId === current) ?? action.execution.bindings[0]
    if (!binding) continue
    nextContractOptions[visitor.visitorId] = binding.optionId
    nextContractLoans[visitor.visitorId] = (contractLoans.value[visitor.visitorId] ?? []).filter((itemId) => binding.eligibleLoanItemIds.includes(itemId))
  }
  contractOptions.value = nextContractOptions
  contractLoans.value = nextContractLoans

  const nextRecoveryBindings: Record<Id, string> = {}
  const nextRecoveryLoans: Record<Id, Id[]> = {}
  const nextAbandonConfirmations: Record<Id, boolean> = {}
  for (const recovery of props.game.recoveries) {
    const action = assignAction(recovery)
    if (action) {
      const current = recoveryBindings.value[recovery.recoveryId]
      const binding = action.execution.bindings.find((candidate) => recoveryBindingKey(candidate) === current) ?? action.execution.bindings[0]
      if (binding) {
        nextRecoveryBindings[recovery.recoveryId] = recoveryBindingKey(binding)
        nextRecoveryLoans[recovery.recoveryId] = (recoveryLoans.value[recovery.recoveryId] ?? []).filter((itemId) => binding.eligibleLoanItemIds.includes(itemId))
      }
    }
  }
  recoveryBindings.value = nextRecoveryBindings
  recoveryLoans.value = nextRecoveryLoans
  abandonConfirmations.value = nextAbandonConfirmations

  const nextSettlementChoices: Record<Id, Record<Id, Id>> = {}
  for (const settlement of props.game.settlements) {
    if (!('choiceGroups' in settlement) || !settlementAction(settlement)) continue
    const groups: Record<Id, Id> = {}
    for (const group of settlement.choiceGroups) {
      const selected = selectedSettlementOption(settlement, group.groupId)
      if (selected) groups[group.groupId] = selected
    }
    nextSettlementChoices[settlement.settlementId] = groups
  }
  settlementChoices.value = nextSettlementChoices
}

watch(() => [props.game?.revision, props.game?.serverNow, props.nowMs] as const, resetClock, { immediate: true })
watch(() => props.game?.revision, syncLocalSelections, { immediate: true })

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
        :disabled="locked || !game || !reconcileAction"
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
        <article v-for="(visitor, visitorIndex) in game.visitors" :key="visitor.visitorId" class="v2-cycle__row" :data-testid="`visitor-${visitor.state}`">
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
              :disabled="locked || !enabledAction(actionsOf(visitor), 'accept_contract')"
              :aria-describedby="actionReason(actionsOf(visitor), 'accept_contract') ? internalId('accept-reason', visitorIndex) : undefined"
              @click="accept(visitor)"
            >
              Aceptar contrato
            </button>
            <label v-if="contractAction(visitor)" class="v2-cycle__field">
              Contrato
              <select
                v-model="contractOptions[visitor.visitorId]"
                class="v2-cycle__select"
                :disabled="locked"
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
              :disabled="locked"
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
              :id="internalId('accept-reason', visitorIndex)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(visitor), 'accept_contract') }}
            </span>
            <button
              v-if="visitor.state === 'contracted'"
              class="v2-cycle__button"
              type="button"
              :disabled="locked || !enabledAction(actionsOf(visitor), 'start_expedition')"
              :aria-describedby="actionReason(actionsOf(visitor), 'start_expedition') ? internalId('start-reason', visitorIndex) : undefined"
              @click="start(visitor)"
            >
              Iniciar expedición
            </button>
            <span
              v-if="visitor.state === 'contracted' && actionReason(actionsOf(visitor), 'start_expedition')"
              :id="internalId('start-reason', visitorIndex)"
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
            <strong>{{ expeditionTitle(expedition.visitorId) }}</strong>
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
        <article v-for="(settlement, settlementIndex) in game.settlements" :key="settlement.settlementId" class="v2-cycle__row" :data-testid="`settlement-${settlement.state}`">
          <div>
            <strong>{{ settlementTitle(settlement) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ settlement.state }}</p>
            <p v-if="'gold' in settlement" class="v2-cycle__muted">
              Oro bruto {{ settlement.gold.gross }}, caravana {{ settlement.gold.caravan }}, visitante {{ settlement.gold.visitor }}.
            </p>
            <fieldset
              v-for="(group, groupIndex) in 'choiceGroups' in settlement ? settlement.choiceGroups : []"
              :key="group.groupId"
              class="v2-cycle__fieldset"
              :disabled="locked"
            >
              <legend>{{ label(group.label) }}</legend>
              <label
                v-for="option in group.options"
                :key="option.optionId"
                class="v2-cycle__check"
              >
                <input
                  type="radio"
                  :name="internalId('settlement-choice', settlementIndex, groupIndex)"
                  :checked="selectedSettlementOption(settlement, group.groupId) === option.optionId"
                  :disabled="!settlementAction(settlement)?.execution.groups.find((candidate) => candidate.groupId === group.groupId)?.eligibleOptionIds.includes(option.optionId)"
                  @change="setSettlementChoice(settlement.settlementId, group.groupId, option.optionId)"
                  @keydown.space.prevent="setSettlementChoice(settlement.settlementId, group.groupId, option.optionId)"
                >
                {{ label(option.label) }}
              </label>
            </fieldset>
          </div>
          <button
            v-if="settlement.state === 'preview_ready'"
            class="v2-cycle__button"
            type="button"
            :disabled="locked || !settlementAction(settlement)"
            :aria-describedby="actionReason(actionsOf(settlement), 'confirm_settlement') ? internalId('settlement-reason', settlementIndex) : undefined"
            @click="confirm(settlement)"
          >
            Confirmar preview
          </button>
          <span
            v-if="settlement.state === 'preview_ready' && actionReason(actionsOf(settlement), 'confirm_settlement')"
            :id="internalId('settlement-reason', settlementIndex)"
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
        <article v-for="(recovery, recoveryIndex) in game.recoveries" :key="recovery.recoveryId" class="v2-cycle__row" :data-testid="`recovery-${recovery.state}`">
          <div>
            <strong>{{ recoveryTitle(recovery) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ recovery.state }}</p>
            <p v-if="recovery.state === 'assigned'" class="v2-cycle__muted">
              Asignado a {{ visitorLabel(recovery.assignedVisitorId) }} hasta {{ recovery.completesAt }}.
            </p>
            <p v-if="recovery.state === 'failed' || recovery.state === 'abandoned'" class="v2-cycle__muted">
              {{ label(recovery.consequence.text) }}
            </p>
          </div>
          <div v-if="recovery.state === 'open'" class="v2-cycle__actions">
            <button
              class="v2-cycle__button"
              type="button"
              :disabled="locked || !enabledAction(actionsOf(recovery), 'assign_recovery')"
              :aria-describedby="actionReason(actionsOf(recovery), 'assign_recovery') ? internalId('assign-reason', recoveryIndex) : undefined"
              @click="assign(recovery)"
            >
              Asignar recovery
            </button>
            <label v-if="assignAction(recovery)" class="v2-cycle__field">
              Recuperador
              <select
                v-model="recoveryBindings[recovery.recoveryId]"
                class="v2-cycle__select"
                :disabled="locked"
              >
                <option
                  v-for="binding in assignAction(recovery)?.execution.bindings"
                  :key="recoveryBindingKey(binding)"
                  :value="recoveryBindingKey(binding)"
                >
                  {{ recoveryBindingLabel(recovery, binding) }}
                </option>
              </select>
            </label>
            <fieldset
              v-if="selectedRecoveryBinding(recovery)?.eligibleLoanItemIds.length"
              class="v2-cycle__fieldset"
              :disabled="locked"
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
              :id="internalId('assign-reason', recoveryIndex)"
              class="v2-cycle__reason"
            >
              {{ actionReason(actionsOf(recovery), 'assign_recovery') }}
            </span>
            <label
              v-if="abandonAction(recovery)"
              class="v2-cycle__check"
              :id="internalId('abandon-ack', recoveryIndex)"
            >
              <input
                v-model="abandonConfirmations[recovery.recoveryId]"
                type="checkbox"
                :disabled="locked"
              >
              {{ label(abandonAction(recovery)!.execution.acknowledgement.text) }}
            </label>
            <button
              class="v2-cycle__button v2-cycle__button--danger"
              type="button"
              :disabled="locked || !abandonAction(recovery) || !abandonConfirmations[recovery.recoveryId]"
              :aria-describedby="[
                actionReason(actionsOf(recovery), 'abandon_recovery') ? internalId('abandon-reason', recoveryIndex) : '',
                abandonAction(recovery) ? internalId('abandon-ack', recoveryIndex) : ''
              ].filter(Boolean).join(' ') || undefined"
              @click="abandon(recovery)"
            >
              Abandonar
            </button>
            <span
              v-if="actionReason(actionsOf(recovery), 'abandon_recovery')"
              :id="internalId('abandon-reason', recoveryIndex)"
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
    <button
      v-if="operationState === 'conflict' && snapshotStale"
      class="v2-cycle__button v2-cycle__button--primary"
      type="button"
      data-testid="v2-reload"
      @click="emit('reload')"
    >
      Reintentar carga del snapshot
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
  min-height: 44px;
  min-width: 44px;
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
