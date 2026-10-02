<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HeroSprite from '~/components/HeroSprite.vue'
import ItemSprite from '~/components/ItemSprite.vue'
import type {
  ActionAvailability,
  AbandonRecoveryAction,
  AcceptContractAction,
  AssignRecoveryAction,
  ConfirmSettlementAction,
  GameView,
  Id,
  ItemView,
  LocalizedText,
  RecoveryView,
  ReconcileGameAction,
  SettlementView,
  VisitorView
} from '~/shared/types/v2-game-view'
import { enabledAction, type VisitorV2Selection } from '~/utils/v2-visitor-adapter'
import { heroClassForVisitor, itemTypeForSlot } from '~/utils/game-assets'

const props = defineProps<{
  game: GameView | null
  loadState: 'loading' | 'empty' | 'ready'
  operationState?: 'idle' | 'pending' | 'uncertain' | 'conflict' | 'unavailable' | 'terminal'
  errorMessage?: string
  unavailableReason?: string
  snapshotStale?: boolean
  nowMs?: number
  visitorId?: string
}>()

const emit = defineEmits<{
  acceptContract: [selection: Extract<VisitorV2Selection, { kind: 'contract' }>]
  startExpedition: [visitorId: string]
  reconcileGame: []
  reconcileDueTransition: [nowMs: number]
  confirmSettlement: [selection: Extract<VisitorV2Selection, { kind: 'settlement' }>]
  assignRecovery: [selection: Extract<VisitorV2Selection, { kind: 'recovery' }>]
  abandonRecovery: [selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>]
  retry: []
  reload: []
  close: []
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
let clockTimer: ReturnType<typeof setInterval> | null = null

const statusText = computed(() => {
  if (props.loadState === 'loading') return 'Cargando partida.'
  if (props.loadState === 'empty') return 'No se pudo cargar la partida.'
  if (operationState.value === 'pending') return 'Procesando acción.'
  if (operationState.value === 'uncertain') return 'No pudimos confirmar el resultado. Reintentá la misma acción.'
  if (operationState.value === 'conflict') return props.errorMessage || 'La partida cambió. Revisá el estado actualizado.'
  if (operationState.value === 'unavailable') return props.unavailableReason || 'La acción ya no está disponible.'
  if (operationState.value === 'terminal') return props.errorMessage || 'La acción no produjo cambios.'
  return 'Partida actualizada.'
})

const countdownText = computed(() => {
  if (!props.game?.nextTransitionAt) return 'Sin transición programada'
  const remaining = Math.max(0, Date.parse(props.game.nextTransitionAt) - currentNowMs.value)
  return remaining === 0 ? 'Transición lista para reconciliar' : `${Math.ceil(remaining / 1000)}s hasta la próxima transición`
})

const reconcileAction = computed(() => enabledAction<ReconcileGameAction>(props.game?.actions, 'reconcile_game'))
const reconcileDisabledReason = computed(() => actionReason(props.game?.actions ?? [], 'reconcile_game'))

function isHistoricalVisitor(visitor: VisitorView): boolean {
  return visitor.state === 'departed' || visitor.state === 'dead'
}

const visibleVisitors = computed(() => props.game?.visitors.filter((visitor) => !props.visitorId || visitor.visitorId === props.visitorId) ?? [])
const currentVisitors = computed(() => visibleVisitors.value.filter((visitor) => !isHistoricalVisitor(visitor)))
const historicalVisitors = computed(() => visibleVisitors.value.filter(isHistoricalVisitor))
const visibleExpeditions = computed(() => props.game?.expeditions.filter((expedition) => !props.visitorId || expedition.visitorId === props.visitorId) ?? [])
const visibleExpeditionIds = computed(() => new Set(visibleExpeditions.value.map((expedition) => expedition.expeditionId)))
const visibleSettlements = computed(() => props.game?.settlements.filter((settlement) => !props.visitorId || visibleExpeditionIds.value.has(settlement.expeditionId)) ?? [])
const visibleRecoveries = computed(() => props.game?.recoveries.filter((recovery) => !props.visitorId || visibleExpeditionIds.value.has(recovery.sourceExpeditionId) || ('assignedVisitorId' in recovery && recovery.assignedVisitorId === props.visitorId)) ?? [])
const hasAssignedRecovery = computed(() => visibleRecoveries.value.some((recovery) => recovery.state === 'assigned' && recovery.assignedVisitorId === props.visitorId))
const showJourneyHeader = computed(() => !props.visitorId || (!tradeVisitor.value && (visibleExpeditions.value.length > 0 || hasAssignedRecovery.value)))
const tradeVisitor = computed(() => props.visitorId && !hasAssignedRecovery.value ? currentVisitors.value.find((visitor) => visitor.state === 'available' || visitor.state === 'negotiating') : undefined)
const tradeBinding = computed(() => tradeVisitor.value ? selectedContractBinding(tradeVisitor.value) : null)
const tradeOption = computed(() => {
  const visitor = tradeVisitor.value
  const options = visitor?.state === 'available' ? visitor.contractOptions : visitor?.state === 'negotiating' ? visitor.options : []
  return options.find((option) => option.optionId === tradeBinding.value?.optionId)
})
const selectedTradeLoans = computed(() => (contractLoans.value[tradeVisitor.value?.visitorId ?? ''] ?? []).filter((id) => tradeBinding.value?.eligibleLoanItemIds.includes(id)))
const loanGroups = computed(() => {
  const groups = new Map<string, ItemView[]>()
  const eligible = new Set(tradeBinding.value?.eligibleLoanItemIds ?? [])
  for (const item of props.game?.items ?? []) {
    if (!eligible.has(item.itemId)) continue
    // Unidentified copies may have different hidden properties: never collapse them.
    const key = item.identification === 'unidentified' ? item.itemId : JSON.stringify([item.name, item.slot, item.rarity, item.level, item.affixes, item.activeImprint, item.owner, item.custody])
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return Array.from(groups.values())
})

function rarityLabel(rarity: ItemView['rarity']): string {
  return { common: 'Común', magic: 'Mágico', rare: 'Raro', legendary: 'Legendario' }[rarity]
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return [minutes ? `${minutes} min` : '', seconds % 60 ? `${seconds % 60} s` : ''].filter(Boolean).join(' ') || '0 s'
}

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
  emit('reconcileDueTransition', currentNowMs.value)
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

function stateLabel(state: string): string {
  return ({
    available: 'Disponible', negotiating: 'Negociando', contracted: 'Contratado', travelling: 'En expedición',
    awaiting_settlement: 'Esperando resultado', departed: 'Partió', dead: 'Murió', active: 'En curso',
    completed: 'Completada', settled: 'Resuelta', preview_ready: 'Resultado listo', preview_expired: 'Resultado vencido',
    open: 'Pendiente', assigned: 'Asignada', recovered: 'Recuperada', failed: 'Fallida', abandoned: 'Abandonada'
  } as Record<string, string>)[state] ?? state
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
  return enabledAction(actions, actionName) ? '' : 'Esta acción no está disponible en el estado actual.'
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
  <section
    class="v2-cycle"
    :class="{ 'v2-cycle--focused': visitorId, 'v2-cycle--trade': tradeVisitor }"
    :aria-labelledby="showJourneyHeader ? 'v2-cycle-title' : undefined"
    :aria-label="!showJourneyHeader ? 'Acciones del visitante' : undefined"
    :aria-busy="operationState === 'pending'"
  >
    <header v-if="showJourneyHeader" class="v2-cycle__header">
      <div>
        <h2 id="v2-cycle-title">{{ visitorId ? 'Estado del viaje' : 'Ciclo de visitantes' }}</h2>
        <p v-if="game" class="v2-cycle__muted">
          {{ countdownText }}
        </p>
      </div>
      <button
        class="v2-cycle__button"
        type="button"
        :disabled="locked || !game || !reconcileAction"
        :aria-describedby="reconcileDisabledReason ? 'reconcile-reason' : undefined"
        @click="emit('reconcileGame')"
      >
        Actualizar sucesos
      </button>
      <span v-if="reconcileDisabledReason" id="reconcile-reason" class="v2-cycle__reason">
        {{ reconcileDisabledReason }}
      </span>
    </header>

    <p v-if="!visitorId || operationState !== 'idle' || errorMessage" class="v2-cycle__status" aria-live="polite" data-testid="v2-status">
      {{ statusText }}
    </p>

    <div v-if="loadState === 'loading'" class="v2-cycle__grid" data-testid="v2-loading">
      <span class="v2-cycle__skeleton" />
      <span class="v2-cycle__skeleton" />
    </div>

    <div v-else-if="loadState === 'empty' || !game" class="v2-cycle__empty" data-testid="v2-empty">
      <p>No pudimos cargar la partida. Reintentá desde esta pantalla.</p>
    </div>

    <form v-else-if="tradeVisitor" class="trade-desk" data-testid="v2-ready" @submit.prevent="!locked && accept(tradeVisitor)">
      <div class="trade-desk__body">
        <section class="trade-contract" aria-labelledby="trade-contract-title">
          <h3 id="trade-contract-title">El trato</h3>
          <label v-if="contractAction(tradeVisitor)" class="v2-cycle__field">
            Contrato
            <select v-model="contractOptions[tradeVisitor.visitorId]" class="v2-cycle__select" :disabled="locked">
              <option v-for="binding in contractAction(tradeVisitor)?.execution.bindings" :key="binding.optionId" :value="binding.optionId">{{ contractOptionLabel(tradeVisitor, binding.optionId) }}</option>
            </select>
          </label>
          <template v-if="tradeOption">
            <p class="trade-contract__description">{{ label(tradeOption.description) }}</p>
            <dl class="trade-terms">
              <div><dt>Duración</dt><dd>{{ durationLabel(tradeOption.durationSeconds) }}</dd></div>
              <div><dt>Oro para la caravana</dt><dd>{{ tradeOption.caravanGoldShareBps / 100 }}%</dd></div>
              <div><dt>Prioridad del botín</dt><dd>{{ tradeOption.lootPriority === 'caravan_first' ? 'Caravana' : 'Visitante' }}</dd></div>
              <div><dt>Retirada</dt><dd>{{ tradeOption.retreatThreshold === null ? 'Sin retirada' : `${tradeOption.retreatThreshold} de vida` }}</dd></div>
              <div><dt>Comisión por objeto</dt><dd>{{ tradeOption.loanFeeGold }} oro</dd></div>
            </dl>
            <p class="trade-contract__note">La comisión se suma a la parte de oro de la caravana, hasta el botín disponible.</p>
            <ul v-if="tradeOption.consequences.length" class="trade-consequences"><li v-for="consequence in tradeOption.consequences" :key="consequence.text.key">{{ label(consequence.text) }}</li></ul>
          </template>
          <div v-if="!tradeBinding" class="trade-unavailable" role="status">
            <p>{{ actionReason(actionsOf(tradeVisitor), 'accept_contract') }}</p>
            <button v-if="reconcileAction" class="v2-cycle__button" type="button" :disabled="locked" @click="emit('reconcileGame')">Actualizar sucesos</button>
          </div>
        </section>
        <section class="trade-equipment" aria-labelledby="trade-equipment-title">
          <div class="trade-equipment__heading"><h3 id="trade-equipment-title">Equipo en préstamo</h3><span>Opcional</span></div>
          <p class="trade-equipment__intro">Elegí qué objetos acompañarán al visitante.</p>
          <div v-if="loanGroups.length" class="loan-list">
            <component :is="group.length > 1 ? 'details' : 'div'" v-for="group in loanGroups" :key="group[0]!.itemId" class="loan-group">
              <summary v-if="group.length > 1">
                <ItemSprite :item-type="itemTypeForSlot(group[0]!.slot)" />
                <span class="loan-row__copy"><strong>{{ label(group[0]!.name) }}</strong><span>Nivel {{ group[0]!.level }} · {{ rarityLabel(group[0]!.rarity) }}</span><small>{{ group.length }} copias iguales · Elegir copias</small></span>
                <span class="loan-group__count">{{ group.filter(item => selectedTradeLoans.includes(item.itemId)).length }}/{{ group.length }}</span>
              </summary>
              <label v-for="(item, index) in group" :key="item.itemId" class="loan-row" :class="{ 'loan-row--selected': selectedTradeLoans.includes(item.itemId) }">
                <input type="checkbox" :value="item.itemId" :disabled="locked" :checked="selectedTradeLoans.includes(item.itemId)" @change="toggleLoan(contractLoans, tradeVisitor.visitorId, item.itemId, eventChecked($event))">
                <ItemSprite :item-type="itemTypeForSlot(item.slot)" />
                <span class="loan-row__copy">
                  <strong>{{ label(item.name) }}<span v-if="group.length > 1" class="loan-row__instance"> · Copia {{ index + 1 }}</span></strong>
                  <span>Nivel {{ item.level }} · {{ rarityLabel(item.rarity) }}</span>
                  <small v-if="item.identification === 'unidentified'">Sin identificar</small>
                  <template v-else>
                    <small v-for="affix in item.affixes" :key="affix.affixId">{{ label(affix.name) }}: {{ label(affix.valueText) }}</small>
                    <small v-if="item.activeImprint">{{ label(item.activeImprint.name) }}: {{ label(item.activeImprint.effectText) }}</small>
                  </template>
                </span>
              </label>
            </component>
          </div>
          <p v-else class="trade-equipment__empty">No hay objetos disponibles para prestar con este contrato.</p>
        </section>
      </div>
      <footer class="trade-footer">
        <p aria-live="polite"><strong>{{ selectedTradeLoans.length }}</strong> {{ selectedTradeLoans.length === 1 ? 'objeto en préstamo' : 'objetos en préstamo' }}</p>
        <div class="trade-footer__actions">
          <button class="v2-cycle__button trade-footer__back" type="button" @click="emit('close')">Volver al campamento</button>
          <button class="v2-cycle__button v2-cycle__button--primary" type="submit" :disabled="locked || !tradeBinding">{{ operationState === 'pending' ? 'Aceptando…' : 'Aceptar contrato' }}</button>
        </div>
      </footer>
    </form>

    <div v-else class="v2-cycle__body" data-testid="v2-ready">
      <section class="v2-cycle__panel" aria-labelledby="v2-visitors-title">
        <h3 id="v2-visitors-title">{{ visitorId ? 'Decisión actual' : 'Visitantes' }}</h3>
        <p v-if="currentVisitors.length === 0" class="v2-cycle__muted" data-testid="v2-visitors-empty">
          No hay visitantes con decisiones pendientes.
        </p>
        <article v-for="(visitor, visitorIndex) in currentVisitors" :key="visitor.visitorId" class="v2-cycle__row" :data-testid="`visitor-${visitor.state}`">
          <HeroSprite v-if="!visitorId" :hero-class="heroClassForVisitor(visitor.visitorId)" :alt="`Retrato de ${label(visitor.name)}`" />
          <div class="v2-cycle__details">
            <strong v-if="!visitorId">{{ label(visitor.name) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ stateLabel(visitor.state) }}</p>
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

      <section v-if="!visitorId || visibleExpeditions.length" class="v2-cycle__panel" aria-labelledby="v2-expeditions-title">
        <h3 id="v2-expeditions-title">Expediciones</h3>
        <article v-for="expedition in visibleExpeditions" :key="expedition.expeditionId" class="v2-cycle__row" :data-testid="`expedition-${expedition.state}`">
          <div>
            <strong>{{ expeditionTitle(expedition.visitorId) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ stateLabel(expedition.state) }}</p>
            <p v-if="expedition.state === 'active'" class="v2-cycle__muted">
              {{ expedition.currentHp }}/{{ expedition.maxHp }} vida. El reloj es informativo; sólo el servidor avanza estado.
            </p>
            <p v-if="expedition.state === 'settled'" class="v2-cycle__muted">
              Resultado cerrado: {{ expedition.outcome }}.
            </p>
          </div>
        </article>
      </section>

      <section v-if="!visitorId || visibleSettlements.length" class="v2-cycle__panel" aria-labelledby="v2-settlements-title">
        <h3 id="v2-settlements-title">Resultados</h3>
        <article v-for="(settlement, settlementIndex) in visibleSettlements" :key="settlement.settlementId" class="v2-cycle__row" :data-testid="`settlement-${settlement.state}`">
          <div>
            <strong>{{ settlementTitle(settlement) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ stateLabel(settlement.state) }}</p>
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
            Confirmar resultado
          </button>
          <span
            v-if="settlement.state === 'preview_ready' && actionReason(actionsOf(settlement), 'confirm_settlement')"
            :id="internalId('settlement-reason', settlementIndex)"
            class="v2-cycle__reason"
          >
            {{ actionReason(actionsOf(settlement), 'confirm_settlement') }}
          </span>
          <p v-else-if="settlement.state === 'preview_expired'" class="v2-cycle__muted">
            Este resultado venció. Actualizá los sucesos para continuar.
          </p>
        </article>
      </section>

      <section v-if="!visitorId || visibleRecoveries.length" class="v2-cycle__panel" aria-labelledby="v2-recoveries-title">
        <h3 id="v2-recoveries-title">Recuperaciones</h3>
        <article v-for="(recovery, recoveryIndex) in visibleRecoveries" :key="recovery.recoveryId" class="v2-cycle__row" :data-testid="`recovery-${recovery.state}`">
          <div>
            <strong>{{ recoveryTitle(recovery) }}</strong>
            <p class="v2-cycle__muted">Estado: {{ stateLabel(recovery.state) }}</p>
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
              Iniciar recuperación
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

      <section v-if="historicalVisitors.length" class="v2-cycle__panel v2-cycle__history-panel" aria-labelledby="v2-history-title">
        <h3 id="v2-history-title">Historial</h3>
        <details class="v2-cycle__history" data-testid="v2-history">
          <summary>Historial de visitantes ({{ historicalVisitors.length }})</summary>
          <div class="v2-cycle__history-list">
            <article v-for="visitor in historicalVisitors" :key="visitor.visitorId" class="v2-cycle__row" :data-testid="`visitor-${visitor.state}`">
              <HeroSprite :hero-class="heroClassForVisitor(visitor.visitorId)" :alt="`Retrato de ${label(visitor.name)}`" />
              <div class="v2-cycle__details">
                <strong>{{ label(visitor.name) }}</strong>
                <p class="v2-cycle__muted">Estado: {{ stateLabel(visitor.state) }}</p>
                <p class="v2-cycle__muted">Estado terminal sin acciones disponibles.</p>
              </div>
            </article>
          </div>
        </details>
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
      Volver a cargar la partida
    </button>
  </section>
</template>

<style scoped>
.v2-cycle {
  display: grid;
  gap: 1rem;
}

.v2-cycle--focused .v2-cycle__body {
  grid-template-columns: 1fr;
}

.v2-cycle--focused .v2-cycle__panel {
  background: rgba(20, 17, 13, .92);
  border-color: #5c4730;
  border-radius: 0;
}

.v2-cycle--focused .v2-cycle__row {
  background: rgba(8, 8, 10, .7);
  border-color: #463827;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
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
  flex-wrap: wrap;
  padding: 0.75rem;
}

.v2-cycle__history {
  border-top: 1px solid var(--line);
  padding-top: 0.75rem;
}

.v2-cycle__history-panel {
  grid-column: 1 / -1;
}

.v2-cycle__history summary {
  cursor: pointer;
  min-height: 44px;
  padding: 0.65rem 0;
}

.v2-cycle__history-list {
  display: grid;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

.v2-cycle__actions {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: start;
  width: 100%;
}

.v2-cycle__details {
  flex: 1;
  min-width: 0;
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
  max-width: 100%;
  padding: 0.5rem;
  width: 100%;
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

.v2-cycle--trade { display: flex; flex-direction: column; gap: 0; min-height: 0; overflow: hidden; }
.v2-cycle--trade > .v2-cycle__status { flex: 0 0 auto; margin: 0; padding: .75rem 1.5rem; }
.v2-cycle--trade > .v2-cycle__button { align-self: stretch; flex: 0 0 auto; margin: .5rem 1.5rem; width: auto; }
.trade-desk { color-scheme: dark; display: flex; flex: 1; flex-direction: column; min-height: 0; }
.trade-desk__body { display: grid; flex: 1; gap: 2rem; grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); min-height: 0; overflow: hidden; padding: 1.5rem; }
.trade-desk h3 { color: var(--text); font-family: Georgia, 'Times New Roman', serif; font-size: 1.4rem; margin: 0 0 1rem; }
.trade-contract, .trade-equipment { min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.trade-contract .v2-cycle__field { align-content: start; color: var(--muted); font-size: .875rem; gap: .5rem; }
.trade-contract .v2-cycle__select { color: var(--text); font-size: 1rem; height: 2.875rem; }
.trade-contract__description { line-height: 1.6; margin: 1rem 0; }
.trade-terms { margin: 1.5rem 0 0; }
.trade-terms div { align-items: baseline; border-top: 1px solid var(--line); display: flex; gap: 1rem; justify-content: space-between; padding: .75rem 0; }
.trade-terms dt { color: var(--muted); font-size: .875rem; }
.trade-terms dd { font-variant-numeric: tabular-nums; margin: 0; text-align: right; }
.trade-contract__note { color: var(--muted); font-size: .8125rem; line-height: 1.55; margin: .5rem 0 0; }
.trade-consequences { color: var(--accent-2); font-size: .875rem; line-height: 1.6; padding-left: 1rem; }
.trade-unavailable { color: var(--accent-2); line-height: 1.6; }
.trade-equipment { border-left: 1px solid var(--line); padding-left: 2rem; }
.trade-equipment__heading { align-items: baseline; display: flex; flex-wrap: wrap; gap: .5rem 1rem; justify-content: space-between; }
.trade-equipment__heading h3 { margin-bottom: .4rem; }
.trade-equipment__heading > span, .trade-equipment__intro { color: var(--muted); font-size: .875rem; }
.trade-equipment__intro { line-height: 1.5; margin: 0 0 1rem; }
.trade-equipment__empty { color: var(--muted); line-height: 1.6; margin: 2rem 0; }
.loan-group { border-top: 1px solid var(--line); }
.loan-group summary { align-items: center; cursor: pointer; display: flex; gap: .75rem; list-style: none; min-height: 4.75rem; padding: .65rem .25rem; }
.loan-group summary::-webkit-details-marker { display: none; }
.loan-group summary::after { border-bottom: 1.5px solid currentColor; border-right: 1.5px solid currentColor; content: ''; flex: 0 0 auto; height: .4rem; margin-right: .5rem; transform: rotate(45deg); width: .4rem; }
.loan-group[open] summary::after { transform: rotate(225deg); }
.loan-group__count { color: var(--accent-2); font-size: .875rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.loan-row { align-items: center; cursor: pointer; display: flex; gap: .65rem; min-height: 4.75rem; padding: .65rem .25rem; }
.loan-row--selected { background: #2b241a; }
.loan-row:hover, .loan-group summary:hover { background: var(--panel-2); }
.loan-row input { accent-color: var(--accent-2); flex: 0 0 auto; height: 1.125rem; margin: 0 .15rem; width: 1.125rem; }
.loan-row__copy { display: grid; flex: 1; gap: .2rem; min-width: 0; overflow-wrap: anywhere; }
.loan-row__copy strong { font-size: .9375rem; font-weight: 600; line-height: 1.35; }
.loan-row__copy > span, .loan-row__copy small, .loan-row__instance { color: var(--muted); font-size: .8125rem; font-weight: 400; line-height: 1.4; }
.loan-group :deep(.item-sprite) { height: 2.75rem; width: 2.75rem; }
.trade-footer { align-items: center; background: #201a14; border-top: 1px solid #5c4730; display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: .75rem; justify-content: space-between; padding: 1rem 1.5rem; }
.trade-footer p { color: var(--muted); font-size: .875rem; margin: 0; }
.trade-footer p strong { color: var(--text); font-variant-numeric: tabular-nums; }
.trade-footer__actions { display: flex; gap: .75rem; }
.trade-footer .v2-cycle__button { justify-content: center; }
.trade-footer__back { background: transparent; border-color: transparent; }
.trade-footer .v2-cycle__button--primary { background: #a94327; border-color: #bf6144; color: #fff4e8; }
.trade-footer .v2-cycle__button--primary:not(:disabled):hover { background: #bd4c2e; }
.trade-desk :is(button, select, input, summary):focus-visible { outline: 3px solid var(--accent-2); outline-offset: 3px; }

@media (max-width: 680px) {
  .trade-desk__body { align-content: start; gap: 1.75rem; grid-template-columns: 1fr; overflow-y: auto; overscroll-behavior: contain; padding: 1rem; }
  .trade-contract, .trade-equipment { min-height: auto; overflow: visible; }
  .trade-equipment { border-left: 0; border-top: 1px solid var(--line); padding: 1.5rem 0 0; }
  .trade-footer { gap: .5rem; padding: .75rem 1rem; }
  .trade-footer__actions { display: grid; gap: .5rem; grid-template-columns: 1fr 1fr; width: 100%; }
  .trade-footer .v2-cycle__button { font-size: .8125rem; padding: .5rem; }
}

@media (max-width: 680px) {
  .v2-cycle__header,
  .v2-cycle__row {
    align-items: stretch;
    flex-direction: column;
  }

  .v2-cycle__actions,
  .v2-cycle__button,
  .v2-cycle__body,
  .v2-cycle__grid {
    justify-content: center;
    width: 100%;
  }

  .v2-cycle__body,
  .v2-cycle__grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-cycle__skeleton {
    background: var(--panel);
  }
}
</style>
