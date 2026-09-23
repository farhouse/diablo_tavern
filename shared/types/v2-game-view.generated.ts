// Generated from contracts/v2-etapa0-4/schema.json. Do not edit by hand.
// Run `pnpm generate:v2-types` after changing the normative schema.

export type Id = string

export type UtcDateTime = string

export type LocalizedText = {
  key: string
  fallback: string
}

export type ActionId = "accept_contract" | "start_expedition" | "reconcile_game" | "confirm_settlement" | "assign_recovery" | "abandon_recovery" | "sell_item_to_visitor" | "identify_item" | "queue_blacksmith_job" | "queue_enchanter_job" | "dismantle_item" | "replace_boss_imprint" | "upgrade_caravan"

export type UnavailableReason = "VISITOR_NOT_AVAILABLE" | "EXPEDITION_NOT_READY" | "MAINTENANCE_DEBT" | "SERVICE_LOCKED" | "RECOVERY_LIMIT_REACHED" | "CAPACITY_FULL" | "ITEM_IN_USE" | "ITEM_NOT_OWNED" | "OPTION_STALE" | "SETTLEMENT_PENDING" | "TERMINAL_ENTITY"

export type EnabledAction = AcceptContractAction | StartExpeditionAction | ReconcileGameAction | ConfirmSettlementAction | AssignRecoveryAction | AbandonRecoveryAction | SellItemAction | IdentifyItemAction | BlacksmithAction | EnchanterAction | DismantleAction | ReplaceImprintAction | UpgradeCaravanAction

export type DisabledAction = { [Action in ActionId]: Omit<{
  action: ActionId
  targetId?: Id
  enabled: false
  label: LocalizedText
  reason: UnavailableReason
  reasonText: LocalizedText
  consequences: Array<ConsequenceView>
  authorizationId: Id
}, 'action'> & { action: Action } }[ActionId]

export type ActionAvailability = EnabledAction | DisabledAction

export type CaravanOwner = {
  kind: "caravan"
}

export type VisitorOwner = {
  kind: "visitor"
  visitorId: Id
}

export type ItemOwner = CaravanOwner | VisitorOwner

export type StashCustody = {
  kind: "stash"
}

export type VisitorCustody = {
  kind: "visitor"
  visitorId: Id
}

export type ExpeditionCustody = {
  kind: "expedition"
  expeditionId: Id
  visitorId: Id
}

export type RecoveryCustody = {
  kind: "recovery"
  recoveryId: Id
}

export type SettlementCustody = {
  kind: "settlement"
  settlementId: Id
}

export type ServiceCustody = {
  kind: "service"
  jobId: Id
}

export type ItemCustody = StashCustody | VisitorCustody | ExpeditionCustody | RecoveryCustody | SettlementCustody | ServiceCustody

export type AffixView = {
  affixId: Id
  name: LocalizedText
  valueText: LocalizedText
}

export type ImprintView = {
  imprintId: Id
  bossId: Id
  name: LocalizedText
  effectText: LocalizedText
}

export type ItemBase = Omit<{
  itemId: Id
  name: LocalizedText
  slot: "weapon" | "armor" | "accessory"
  rarity: "common" | "magic" | "rare" | "legendary"
  level: number
  owner: ItemOwner
  custody: ItemCustody
  actions: Array<ActionAvailability>
}, 'owner' | 'custody'> & (
  | { owner: VisitorOwner; custody: VisitorCustody }
  | { owner: CaravanOwner; custody: StashCustody | ExpeditionCustody | RecoveryCustody | SettlementCustody | ServiceCustody }
)

export type UnidentifiedItemView = ItemBase & {
  identification: "unidentified"
}

export type IdentifiedItemView = ItemBase & {
  identification: "identified"
  affixes: Array<AffixView>
  activeImprint: null | ImprintView
}

export type ItemView = UnidentifiedItemView | IdentifiedItemView

export type LoseItemConsequence = {
  kind: "lose_items"
  irreversible: true
  itemIds: Array<Id>
  text: LocalizedText
}

export type DestroyItemConsequence = {
  kind: "destroy_items"
  irreversible: true
  itemIds: Array<Id>
  text: LocalizedText
}

export type TransferItemConsequence = {
  kind: "transfer_items"
  irreversible: true
  itemIds: Array<Id>
  newOwner: ItemOwner
  text: LocalizedText
}

export type SpendResourceConsequence = {
  kind: "spend_resource"
  irreversible: true
  resourceId: Id
  amount: number
  text: LocalizedText
}

export type RenounceRewardConsequence = {
  kind: "renounce_reward"
  irreversible: true
  rewardItemIds: Array<Id>
  text: LocalizedText
}

export type ReplaceImprintConsequence = {
  kind: "replace_imprint"
  irreversible: true
  itemId: Id
  replacedImprint: LocalizedText
  text: LocalizedText
}

export type DepartVisitorConsequence = {
  kind: "depart_visitor"
  irreversible: true
  visitorId: Id
  text: LocalizedText
}

export type FailRecoveryConsequence = {
  kind: "fail_recovery"
  irreversible: true
  recoveryId: Id
  destroyedItemIds: Array<Id>
  text: LocalizedText
}

export type ConsequenceView = LoseItemConsequence | DestroyItemConsequence | TransferItemConsequence | SpendResourceConsequence | RenounceRewardConsequence | ReplaceImprintConsequence | DepartVisitorConsequence | FailRecoveryConsequence

export type ChoiceOption = {
  optionId: Id
  label: LocalizedText
  itemIds: Array<Id>
  capacityDelta: number
  consequences: Array<ConsequenceView>
}

export type ChoiceGroup = {
  groupId: Id
  required: true
  defaultOptionId: Id
  label: LocalizedText
  options: Array<ChoiceOption>
}

export type ContractOptionView = {
  optionId: Id
  label: LocalizedText
  description: LocalizedText
  durationSeconds: number
  caravanGoldShareBps: number
  lootPriority: "caravan_first" | "visitor_first"
  retreatThreshold: null | number
  loanFeeGold: number
  consequences: Array<ConsequenceView>
}

export type RecoveryOptionView = {
  optionId: Id
  label: LocalizedText
  description: LocalizedText
  durationSeconds: number
  consequences: Array<ConsequenceView>
}

export type VisitorBase = {
  visitorId: Id
  name: LocalizedText
  state: string
  actions: Array<ActionAvailability>
}

export type VisitorAvailable = VisitorStateAvailable

export type VisitorStateAvailable = VisitorBase & {
  state: "available"
  departureSignal: "unlikely" | "possible" | "likely"
  contractOptions: Array<ContractOptionView>
}

export type VisitorNegotiating = VisitorBase & {
  state: "negotiating"
  negotiationId: Id
  options: Array<ContractOptionView>
  expiresAt: UtcDateTime
}

export type VisitorContracted = VisitorBase & {
  state: "contracted"
  contractId: Id
}

export type VisitorAway = VisitorBase & {
  state: "away"
  contractId: Id
  expeditionId: Id
}

export type VisitorAwaitingSettlement = VisitorBase & {
  state: "awaiting_settlement"
  expeditionId: Id
  settlementId: Id
  outcome: ExpeditionOutcome
}

export type VisitorDeparted = VisitorBase & {
  state: "departed"
  actions: Array<never>
  departedAt: UtcDateTime
  lastExpeditionId: Id
}

export type VisitorDead = VisitorBase & {
  state: "dead"
  actions: Array<never>
  diedAt: UtcDateTime
  expeditionId: Id
  recoveryId: Id
}

export type VisitorView = VisitorAvailable | VisitorNegotiating | VisitorContracted | VisitorAway | VisitorAwaitingSettlement | VisitorDeparted | VisitorDead

export type ExpeditionOutcome = "returned" | "retreated" | "death"

export type ExpeditionBase = {
  expeditionId: Id
  visitorId: Id
  contractId: Id
  state: string
  actions: Array<ActionAvailability>
}

export type ExpeditionScheduled = ExpeditionBase & {
  state: "scheduled"
  startsAt: UtcDateTime
}

export type ExpeditionActive = ExpeditionBase & {
  state: "active"
  startedAt: UtcDateTime
  nextEventAt: UtcDateTime
  currentHp: number
  maxHp: number
}

export type ExpeditionAwaiting = ExpeditionBase & {
  state: "awaiting_settlement"
  outcome: ExpeditionOutcome
  resolvedAt: UtcDateTime
  settlementId: Id
}

export type ExpeditionSettled = ExpeditionBase & {
  state: "settled"
  actions: Array<never>
  outcome: ExpeditionOutcome
  settledAt: UtcDateTime
  settlementId: Id
  visitorResolution: "stays" | "departs" | "dead"
}

export type ExpeditionView = ExpeditionScheduled | ExpeditionActive | ExpeditionAwaiting | ExpeditionSettled

export type SettlementPreviewFields = {
  settlementId: Id
  expeditionId: Id
  state: string
  previewVersion: number
  outcome: ExpeditionOutcome
  createdAt: UtcDateTime
  expiresAt: UtcDateTime
  gold: {
    gross: number
    caravan: number
    visitor: number
  }
  loans: Array<{
    itemId: Id
    resolution: "return" | "recovery"
  }>
  choiceGroups: Array<ChoiceGroup>
  departureSignal: "unlikely" | "possible" | "likely"
  departureResolution: "stays" | "departs" | "dead"
  actions: Array<ActionAvailability>
}

export type SettlementReady = SettlementPreviewFields & {
  state: "preview_ready"
}

export type SettlementExpired = SettlementPreviewFields & {
  state: "preview_expired"
}

export type SettlementSettled = {
  settlementId: Id
  expeditionId: Id
  state: "settled"
  outcome: ExpeditionOutcome
  appliedAt: UtcDateTime
  appliedBy: "confirmation" | "expiry_default"
  appliedChoices: Array<{
    groupId: Id
    optionId: Id
    label: LocalizedText
  }>
  visitorResolution: "stays" | "departs" | "dead"
  actions: Array<never>
}

export type SettlementView = SettlementReady | SettlementExpired | SettlementSettled

export type RecoveryBase = {
  recoveryId: Id
  sourceExpeditionId: Id
  itemIds: Array<Id>
  state: string
  actions: Array<ActionAvailability>
}

export type RecoveryOpen = RecoveryBase & {
  state: "open"
  expiresAt: UtcDateTime
  options: Array<RecoveryOptionView>
}

export type RecoveryAssigned = RecoveryBase & {
  state: "assigned"
  assignedVisitorId: Id
  assignedAt: UtcDateTime
  completesAt: UtcDateTime
}

export type RecoveryRecovered = RecoveryBase & {
  state: "recovered"
  actions: Array<never>
  resolvedAt: UtcDateTime
  recoveredItemIds: Array<Id>
}

export type RecoveryFailed = RecoveryBase & {
  state: "failed"
  actions: Array<never>
  resolvedAt: UtcDateTime
  consequence: FailRecoveryConsequence
}

export type RecoveryAbandoned = RecoveryBase & {
  state: "abandoned"
  actions: Array<never>
  resolvedAt: UtcDateTime
  consequence: FailRecoveryConsequence
}

export type RecoveryView = RecoveryOpen | RecoveryAssigned | RecoveryRecovered | RecoveryFailed | RecoveryAbandoned

export type ServiceJobBase = {
  jobId: Id
  itemId: Id
  service: "blacksmith" | "enchanter"
  state: string
  label: LocalizedText
  actions: Array<ActionAvailability>
}

export type ServiceQueued = ServiceJobBase & {
  state: "queued"
  queuedAt: UtcDateTime
  startsAt: UtcDateTime
}

export type ServiceActive = ServiceJobBase & {
  state: "active"
  startedAt: UtcDateTime
  completesAt: UtcDateTime
}

export type ServiceCompleted = ServiceJobBase & {
  state: "completed"
  actions: Array<never>
  completedAt: UtcDateTime
  resultText: LocalizedText
}

export type ServiceFailed = ServiceJobBase & {
  state: "failed"
  actions: Array<never>
  failedAt: UtcDateTime
  reasonText: LocalizedText
  consequences: Array<ConsequenceView>
}

export type ServiceCancelled = ServiceJobBase & {
  state: "cancelled"
  actions: Array<never>
  cancelledAt: UtcDateTime
  consequences: Array<ConsequenceView>
}

export type ServiceJobView = ServiceQueued | ServiceActive | ServiceCompleted | ServiceFailed | ServiceCancelled

export type GameView = {
  contractVersion: "v2-etapa0-4"
  labelCatalogVersion: "es-AR-v1"
  revision: number
  serverNow: UtcDateTime
  nextTransitionAt: null | UtcDateTime
  resources: {
    gold: number
    materials: {
      [key: string]: number
    }
  }
  capacity: {
    used: number
    limit: number
    reserved: number
    blockers: Array<UnavailableReason>
  }
  caravan: {
    visitorCapacity: {
      used: number
      limit: number
    }
    upgrades: Array<{
      upgradeId: "visitor_quarters" | "blacksmith" | "enchanter"
      level: number
      maxLevel: number
    }>
    maintenance: {
      periodKey: string
      nextDueAt: UtcDateTime
      status: "current" | "debt"
      debtPeriods: number
      debtGold: number
    }
  }
  visitors: Array<VisitorView>
  expeditions: Array<ExpeditionView>
  settlements: Array<SettlementView>
  recoveries: Array<RecoveryView>
  serviceJobs: Array<ServiceJobView>
  items: Array<ItemView>
  actions: Array<ActionAvailability>
}

export type AcceptContractAction = {
  authorizationId: Id
  action: "accept_contract"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    visitorId: Id
    bindings: Array<{
      optionId: Id
      eligibleLoanItemIds: Array<Id>
      expiresAt: UtcDateTime
    }>
  }
}

export type StartExpeditionAction = {
  authorizationId: Id
  action: "start_expedition"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    contractId: Id
  }
}

export type ReconcileGameAction = {
  authorizationId: Id
  action: "reconcile_game"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  execution: Record<string, never>
}

export type ConfirmSettlementAction = {
  authorizationId: Id
  action: "confirm_settlement"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    settlementId: Id
    previewVersion: number
    expiresAt: UtcDateTime
    groups: Array<{
      groupId: Id
      eligibleOptionIds: Array<Id>
    }>
  }
}

export type AssignRecoveryAction = {
  authorizationId: Id
  action: "assign_recovery"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    recoveryId: Id
    bindings: Array<{
      optionId: Id
      visitorId: Id
      eligibleLoanItemIds: Array<Id>
      expiresAt: UtcDateTime
    }>
  }
}

export type AbandonRecoveryAction = {
  authorizationId: Id
  action: "abandon_recovery"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    recoveryId: Id
    acknowledgement: {
      acknowledgementId: Id
      expiresAt: UtcDateTime
      text: LocalizedText
    }
  }
}

export type SellItemAction = {
  authorizationId: Id
  action: "sell_item_to_visitor"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    offers: Array<{
      offerId: Id
      visitorId: Id
      itemId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
    }>
  }
}

export type IdentifyItemAction = {
  authorizationId: Id
  action: "identify_item"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
    }>
  }
}

export type BlacksmithAction = {
  authorizationId: Id
  action: "queue_blacksmith_job"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
    }>
  }
}

export type EnchanterAction = {
  authorizationId: Id
  action: "queue_enchanter_job"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
    }>
  }
}

export type DismantleAction = {
  authorizationId: Id
  action: "dismantle_item"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
      acknowledgement: {
        acknowledgementId: Id
        expiresAt: UtcDateTime
        text: LocalizedText
      }
    }>
  }
}

export type ReplaceImprintAction = {
  authorizationId: Id
  action: "replace_boss_imprint"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  targetId: Id
  execution: {
    itemId: Id
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
      acknowledgement: {
        acknowledgementId: Id
        expiresAt: UtcDateTime
        text: LocalizedText
      }
    }>
  }
}

export type UpgradeCaravanAction = {
  authorizationId: Id
  action: "upgrade_caravan"
  enabled: true
  label: LocalizedText
  consequences: Array<ConsequenceView>
  execution: {
    options: Array<{
      optionId: Id
      expiresAt: UtcDateTime
      label: LocalizedText
      description: LocalizedText
      consequences: Array<ConsequenceView>
    }>
  }
}
