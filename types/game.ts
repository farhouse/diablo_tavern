export type HeroClass = 'barbarian' | 'sorceress' | 'paladin' | 'necromancer'
export type ItemType = 'weapon' | 'armor' | 'helmet' | 'gloves' | 'boots' | 'ring' | 'amulet' | 'charm'
export type ItemRarity = 'normal' | 'magic' | 'rare' | 'unique'
export type StatKey =
  | 'strength' | 'dexterity' | 'vitality' | 'energy' | 'life' | 'mana'
  | 'fireResist' | 'coldResist' | 'lightningResist' | 'poisonResist'
  | 'magicFind' | 'attackPower' | 'defense'

export interface Affix { stat: StatKey; value: number }
export interface BaseStats { strength: number; dexterity: number; vitality: number; energy: number }
export interface Quest {
  id: string
  name: string
  act: number
  difficulty: number
  minLevel: number
  requirements?: { completedQuestIds?: string[] }
  rewards: { xp: number; gold: number }
  lootTableId: string
}

export interface Item {
  id: string
  baseName: string
  displayName: string
  type: ItemType
  rarity: ItemRarity
  identified: boolean
  width: number
  height: number
  requiredLevel: number
  affixes: Affix[]
  value: number
  acquisitionCost?: number
  position?: { x: number; y: number }
}

export type VisitorState = 'open' | 'traded' | 'commissioned' | 'returned' | 'departed'
export type VisitorTradeKind = 'player_bought' | 'player_sold'
export type CommissionOutcome = 'complete' | 'partial' | 'failed'

export interface VisitorOffer { id: string; item: Item; price: number; purchasedAt?: string }
export interface VisitorTrade { requestId: string; kind: VisitorTradeKind; itemId: string; price: number; createdAt: string }

export interface CommissionOption {
  optionId: 'safe' | 'risky'
  title: string
  regionId: string
  durationMs: number
  successChance: number
  fullRewardGold: number
  partialRewardGold: number
  riskLevel: 'low' | 'high'
  failureConsequence: string
}

export interface VisitorCommission extends CommissionOption {
  id: string
  status: 'active' | 'ready' | 'claimed'
  startedAt: string
  finishesAt: string
  outcomeRoll: number
  outcome?: CommissionOutcome
  rewardGold?: number
  rewardItem?: Item
  claimedAt?: string
}

export interface VisitorEquipmentSummaryItem { itemId?: string; name: string; type: ItemType; powerBonus: number }

export interface Visitor {
  id: string
  name: string
  class: HeroClass
  level: number
  origin: string
  equipmentSummary: VisitorEquipmentSummaryItem[]
  state: VisitorState
  budget: number
  initialBudget: number
  acceptedItemTypes: ItemType[]
  interestedItemTypes: ItemType[]
  offers: VisitorOffer[]
  buyQuotes: Record<string, number>
  trades: VisitorTrade[]
  power: number
  commissionOptions: CommissionOption[]
  commission?: VisitorCommission
  arrivedAt: string
  departedAt?: string
}

export interface VisitorSlot { id: string; visitor?: Visitor; nextArrivalCheckAt?: string }
export interface VisitRound { id: string; number: number; slots: VisitorSlot[]; createdAt: string }
export interface ProcessedRequest { requestId: string; operationKey: string }

export type CaravanUpgradeId = 'stashWagon' | 'appraiser'
export interface AppraisalJob { id: string; itemId: string; startedAt: string; finishesAt: string }
export interface CaravanState {
  level: number
  upgrades: Record<CaravanUpgradeId, number>
  services: { appraiserQueue: AppraisalJob[] }
}

export interface SaveGame {
  _id?: string
  schemaVersion: number
  userId: string
  gold: number
  caravan: CaravanState
  stashLimit: number
  stash: Item[]
  unlockedRegionIds: string[]
  visitRound: VisitRound
  visitHistory: VisitRound[]
  processedRequestIds: string[]
  processedRequests: ProcessedRequest[]
  revision: number
  createdAt: string
  updatedAt: string
  /** Server-only context; stripped from every public response. */
  _effectiveCapacityUsed?: number
}

export interface User {
  _id?: string
  email: string
  passwordHash: string
  refreshTokenHash?: string
  createdAt: string
  updatedAt: string
}

export interface PublicUser { id: string; email: string }
