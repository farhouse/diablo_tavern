export type HeroClass = 'barbarian' | 'sorceress' | 'paladin' | 'necromancer'
export type HeroStatus = 'available' | 'onQuest' | 'injured' | 'dead'
export type ItemType = 'weapon' | 'armor' | 'helmet' | 'gloves' | 'boots' | 'ring' | 'amulet' | 'charm'
export type ItemRarity = 'normal' | 'magic' | 'rare' | 'unique'
export type EquipmentSlot = 'weapon' | 'helmet' | 'armor' | 'gloves' | 'boots' | 'amulet' | 'ring1' | 'ring2'
export type StatKey =
  | 'strength'
  | 'dexterity'
  | 'vitality'
  | 'energy'
  | 'life'
  | 'mana'
  | 'fireResist'
  | 'coldResist'
  | 'lightningResist'
  | 'poisonResist'
  | 'magicFind'
  | 'attackPower'
  | 'defense'

export interface BaseStats {
  strength: number
  dexterity: number
  vitality: number
  energy: number
}

export interface DerivedStats {
  life: number
  mana: number
  attackPower: number
  defense: number
  fireResist: number
  coldResist: number
  lightningResist: number
  poisonResist: number
  magicFind: number
}

export interface Affix {
  stat: StatKey
  value: number
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
  position?: {
    x: number
    y: number
  }
}

export type Equipment = Partial<Record<EquipmentSlot, Item>>

export interface Hero {
  id: string
  name: string
  class: HeroClass
  level: number
  xp: number
  baseStats: BaseStats
  derivedStats: DerivedStats
  equipment: Equipment
  status: HeroStatus
}

export interface Quest {
  id: string
  name: string
  act: number
  difficulty: number
  minLevel: number
  requirements?: {
    completedQuestIds?: string[]
  }
  rewards: {
    xp: number
    gold: number
  }
  lootTableId: string
}

export interface QuestProgress {
  questId: string
  completed: boolean
  unlocked: boolean
}

export interface QuestRun {
  id: string
  questId: string
  heroIds: string[]
  result: 'success' | 'failure'
  log: string[]
  loot: Item[]
  xpGained: number
  goldGained: number
  createdAt: string
}

export interface ActiveQuestRun {
  id: string
  questId: string
  heroIds: string[]
  startedAt: string
  finishesAt: string
}

export interface ExpeditionHeroState {
  heroId: string
  temporaryHp: number
  maxTemporaryHp: number
  dead: boolean
  permanentDeath?: boolean
}

export interface ExpeditionEvent {
  id: string
  type: 
    | "enemy"
    | "champion"
    | "evilHero"
    | "treasure"
    | "trap"
    | "rest"
    | "bossClue"
    | "boss"
    | "death"
    | "return"
  createdAt: string
  title: string
  description: string
  damageTaken?: number
  xpGained?: number
  goldFound?: number
  lootFound?: Item[]
  depthGained?: number
}

export interface ActiveExpedition {
  id: string
  questId: string
  heroIds: string[]
  status: "exploring" | "bossReady" | "returning"
  startedAt: string
  lastEventAt: string
  nextEventAt: string
  depth: number
  danger: number
  partyState: ExpeditionHeroState[]
  events: ExpeditionEvent[]
  carriedLoot: Item[]
  carriedGold: number
  carriedXp: number
  bossReady: boolean
  bossDefeated: boolean
}

export interface ExpeditionSummary {
  id: string
  questId: string
  heroIds: string[]
  result: "success" | "retreated" | "defeated" | "death"
  depth: number
  durationMs: number
  loot: Item[]
  gold: number
  xp: number
  heroesStatus: ExpeditionHeroState[]
  events: ExpeditionEvent[]
}

export interface SaveGame {
  _id?: string
  userId: string
  gold: number
  stashLimit: number
  heroes: Hero[]
  stash: Item[]
  pendingLoot: Item[]
  questsProgress: QuestProgress[]
  activeQuestRun?: ActiveQuestRun
  lastQuestRun?: QuestRun
  activeExpeditions: ActiveExpedition[]
  expeditionHistory: ExpeditionSummary[]
  createdAt: string
  updatedAt: string
}

export interface User {
  _id?: string
  email: string
  passwordHash: string
  refreshTokenHash?: string
  createdAt: string
  updatedAt: string
}

export interface PublicUser {
  id: string
  email: string
}
