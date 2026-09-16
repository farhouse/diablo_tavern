import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Affix, Item, ItemRarity, StatKey } from '~/types/game'
import { applyItemTransition } from '~/server/domain/item-transitions'
import type { PersistedGameV3, PersistedItemV2State, PersistenceDependencies } from '~/server/utils/savegame'
import { resolveServerRuntimeConfig } from '~/server/utils/runtime-config'

export type EquipmentV2Action =
  | 'identify_item'
  | 'queue_blacksmith_job'
  | 'queue_enchanter_job'
  | 'dismantle_item'
  | 'replace_boss_imprint'
  | 'complete_service_job'

export interface EquipmentV2Command {
  action: EquipmentV2Action
  itemId?: string
  jobId?: string
  optionId?: string
  acknowledgementId?: string
}

export class EquipmentV2Error extends Error {
  override name = 'EquipmentV2Error'
}

const IDENTIFY_OPTIONS: Record<ItemRarity, { optionId: string; gold: number }> = {
  normal: { optionId: 'identify-free', gold: 0 },
  magic: { optionId: 'identify-standard', gold: 50 },
  rare: { optionId: 'identify-rare', gold: 110 },
  unique: { optionId: 'identify-legendary', gold: 200 }
}

const BLACKSMITH_BASE_GOLD = 75
const ENCHANTER_BASE_GOLD = 90
const JOB_DURATION_MS = 60_000
const IMPRINT_OPTION_ID = 'replace-active-imprint'

export function applyEquipmentV2Command(
  current: PersistedGameV3,
  command: EquipmentV2Command,
  dependencies: PersistenceDependencies
): PersistedGameV3 {
  const game = structuredClone(current)
  switch (command.action) {
    case 'identify_item':
      identifyItem(game, requireItemId(command), requireOption(command))
      return game
    case 'queue_blacksmith_job':
      queueServiceJob(game, requireItemId(command), requireOption(command), 'blacksmith', dependencies)
      return game
    case 'queue_enchanter_job':
      queueServiceJob(game, requireItemId(command), requireOption(command), 'enchanter', dependencies)
      return game
    case 'complete_service_job':
      completeServiceJob(game, requireString(command.jobId, 'jobId'), dependencies)
      return game
    case 'dismantle_item':
      validateOption(game, requireItemId(command), command.action, requireOption(command), requireAcknowledgement(command), dependencies)
      return applyItemTransition(game, {
        operation: 'dismantle',
        itemId: requireItemId(command),
        targetId: `dismantle-${requireItemId(command)}`
      }).game
    case 'replace_boss_imprint':
      replaceBossImprint(game, requireItemId(command), requireOption(command), requireAcknowledgement(command), dependencies)
      return game
  }
}

export function authorizeEquipmentV2Command(
  game: PersistedGameV3,
  command: EquipmentV2Command,
  dependencies: PersistenceDependencies
): void {
  if (command.action === 'complete_service_job') return
  validateOption(game, requireItemId(command), command.action, requireOption(command), command.acknowledgementId, dependencies)
}

export function getIdentifyOption(item: Item): { optionId: string; gold: number } {
  return IDENTIFY_OPTIONS[item.rarity]
}

export function getBlacksmithOption(item: Item, state: PersistedItemV2State | undefined): { optionId: string; gold: number; nextLevel: number } {
  const nextLevel = (state?.blacksmithLevel ?? 0) + 1
  return { optionId: `blacksmith-rank-${nextLevel}`, gold: BLACKSMITH_BASE_GOLD * nextLevel, nextLevel }
}

export function getEnchanterOption(item: Item, state: PersistedItemV2State | undefined): { optionId: string; gold: number; seed: string; affix: Affix } {
  const seed = `${item.id}:${state?.enchantCount ?? 0}`
  const stat = stableStat(seed)
  const value = 2 + (stableNumber(seed) % 8)
  return { optionId: `enchant-${state?.enchantCount ?? 0}`, gold: ENCHANTER_BASE_GOLD, seed, affix: { stat, value } }
}

export function getDismantleOption(item: Item): { optionId: string; acknowledgementId: string; materials: Record<string, number> } {
  const scrap = Math.max(1, Math.floor(item.value / 10))
  return { optionId: `dismantle-${item.id}`, acknowledgementId: `ack-dismantle-${item.id}`, materials: { scrap } }
}

export function getImprintOption(item: Item, state: PersistedItemV2State | undefined): { optionId: string; acknowledgementId: string } | null {
  if (!item.identified || state?.pendingImprint === undefined) return null
  return { optionId: IMPRINT_OPTION_ID, acknowledgementId: `ack-imprint-${item.id}` }
}

export function sealEquipmentActionToken(
  game: PersistedGameV3,
  itemId: string,
  action: EquipmentV2Action,
  semanticId: string,
  kind: 'authorization' | 'option' | 'acknowledgement',
  expiresAt = equipmentActionExpiresAt(new Date(game.updatedAt))
): string {
  const payload = [
    game.userId,
    game.createdAt,
    game.revision,
    itemId,
    action,
    semanticId,
    kind,
    expiresAt,
    imprintTokenPart(game, itemId, action)
  ].join('|')
  const signature = createHmac('sha256', equipmentTokenSecret()).update(payload).digest('base64url')
  return ['eqv2', kind, Buffer.from(expiresAt).toString('base64url'), signature].join('.')
}

export function equipmentActionExpiresAt(now: Date): string {
  return new Date(now.getTime() + 5 * 60_000).toISOString()
}

export function canUseEquipmentService(game: PersistedGameV3, itemId: string): boolean {
  const placement = game.itemPlacements[itemId]
  return Boolean(game.itemsById[itemId] && placement?.ownerKind === 'caravan' && placement.custodyKind === 'stash')
}

function identifyItem(game: PersistedGameV3, itemId: string, optionId: string): void {
  const item = requireStashItem(game, itemId)
  const option = getIdentifyOption(item)
  const expiresAt = tokenExpiresAt(optionId, 'option')
  if (!expiresAt || !sameToken(sealEquipmentActionToken(game, itemId, 'identify_item', option.optionId, 'option', expiresAt), optionId)) throw domainError('identify option does not match item')
  if (item.identified) throw domainError('Item is already identified')
  debitGold(game, option.gold)
  item.identified = true
  ensureItemState(game, itemId).sealedAffixes = structuredClone(item.affixes)
}

function queueServiceJob(
  game: PersistedGameV3,
  itemId: string,
  optionId: string,
  service: 'blacksmith' | 'enchanter',
  dependencies: PersistenceDependencies
): void {
  const item = requireStashItem(game, itemId)
  const state = ensureItemState(game, itemId)
  const option = service === 'blacksmith' ? getBlacksmithOption(item, state) : getEnchanterOption(item, state)
  const action = service === 'blacksmith' ? 'queue_blacksmith_job' : 'queue_enchanter_job'
  const expiresAt = tokenExpiresAt(optionId, 'option')
  if (!expiresAt || !sameToken(sealEquipmentActionToken(game, itemId, action, option.optionId, 'option', expiresAt), optionId)) throw domainError(`${service} option does not match item`)
  debitGold(game, option.gold)

  const now = dependencies.now()
  const jobId = `${service}-${dependencies.uuid()}`
  const queuedAt = now.toISOString()
  const completesAt = new Date(now.getTime() + JOB_DURATION_MS).toISOString()
  game.serviceJobsById[jobId] = {
    id: jobId,
    itemIds: [],
    projection: { kind: 'service', service, queuedAt, startsAt: queuedAt }
  }
  game.serviceJobStateById[jobId] = {
    status: 'active',
    service,
    itemId,
    queuedAt,
    startedAt: queuedAt,
    completesAt,
    result: service === 'blacksmith'
      ? { blacksmithLevel: getBlacksmithOption(item, state).nextLevel }
      : { enchantCount: (state.enchantCount ?? 0) + 1, affix: (option as ReturnType<typeof getEnchanterOption>).affix }
  }

  const transitioned = applyItemTransition(game, { operation: 'service', itemId, targetId: jobId }).game
  Object.assign(game, transitioned)
}

function completeServiceJob(game: PersistedGameV3, jobId: string, dependencies: PersistenceDependencies): void {
  const job = game.serviceJobsById[jobId]
  const state = game.serviceJobStateById[jobId]
  if (!state) throw domainError('Service job not found')
  if (state.status === 'completed') return
  if (state.status === 'failed' || state.status === 'cancelled') throw domainError('Service job is terminal')
  const itemId = state.itemId
  if (!job || job.itemIds[0] !== itemId) throw domainError('Service job not found')
  if (Date.parse(state.completesAt) > dependencies.now().getTime()) throw domainError('Service job is not complete')
  const item = game.itemsById[itemId]
  if (!item) throw domainError('Service item not found')
  const itemState = ensureItemState(game, itemId)
  if (state.result.blacksmithLevel !== undefined) {
    itemState.blacksmithLevel = state.result.blacksmithLevel
    item.value += 25 * state.result.blacksmithLevel
  }
  if (state.result.affix) {
    itemState.enchantCount = state.result.enchantCount ?? ((itemState.enchantCount ?? 0) + 1)
    item.affixes = [...item.affixes, state.result.affix]
  }
  state.status = 'completed'
  state.completedAt = dependencies.now().toISOString()
  const transitioned = applyItemTransition(game, { operation: 'return', itemId, targetId: jobId }).game
  Object.assign(game, transitioned)
  game.serviceJobsById[jobId] = job
  game.serviceJobsById[jobId]!.itemIds = []
}

function replaceBossImprint(game: PersistedGameV3, itemId: string, optionId: string, acknowledgementId: string, dependencies: PersistenceDependencies): void {
  const item = requireStashItem(game, itemId)
  const state = ensureItemState(game, itemId)
  const option = getImprintOption(item, state)
  if (!option
    || !matchesSealedToken(game, itemId, 'replace_boss_imprint', option.optionId, 'option', optionId)
    || !matchesSealedToken(game, itemId, 'replace_boss_imprint', option.acknowledgementId, 'acknowledgement', acknowledgementId)) {
    throw domainError('imprint acknowledgement does not match item')
  }
  if (state.activeImprint) {
    state.imprintHistory = [...(state.imprintHistory ?? []), { ...state.activeImprint, replacedAt: dependencies.now().toISOString() }]
  }
  state.activeImprint = state.pendingImprint
  delete state.pendingImprint
}

function imprintTokenPart(game: PersistedGameV3, itemId: string, action: EquipmentV2Action): string {
  if (action !== 'replace_boss_imprint') return ''
  const pending = game.itemV2ById[itemId]?.pendingImprint
  return pending ? `${pending.imprintId}:${pending.grantedAt}` : ''
}

function validateOption(
  game: PersistedGameV3,
  itemId: string,
  action: EquipmentV2Action,
  optionId: string,
  acknowledgementId: string | undefined,
  dependencies: PersistenceDependencies
): void {
  const item = requireStashItem(game, itemId)
  const state = game.itemV2ById[itemId]
  const semantic = action === 'identify_item' ? getIdentifyOption(item).optionId
    : action === 'queue_blacksmith_job' ? getBlacksmithOption(item, state).optionId
      : action === 'queue_enchanter_job' ? getEnchanterOption(item, state).optionId
        : action === 'dismantle_item' ? getDismantleOption(item).optionId
          : action === 'replace_boss_imprint' ? getImprintOption(item, state)?.optionId
            : undefined
  if (!semantic || !matchesSealedToken(game, itemId, action, semantic, 'option', optionId)) {
    throw domainError('equipment action authorization does not match item')
  }
  const optionExpiresAt = tokenExpiresAt(optionId, 'option')
  if (!optionExpiresAt || dependencies.now().getTime() >= Date.parse(optionExpiresAt)) throw domainError('equipment action authorization expired')
  const expectedAck = action === 'dismantle_item' ? getDismantleOption(item).acknowledgementId
    : action === 'replace_boss_imprint' ? getImprintOption(item, state)?.acknowledgementId
      : undefined
  if (expectedAck) {
    const ackExpiresAt = tokenExpiresAt(acknowledgementId, 'acknowledgement')
    if (!acknowledgementId || !matchesSealedToken(game, itemId, action, expectedAck, 'acknowledgement', acknowledgementId)
      || !ackExpiresAt || dependencies.now().getTime() >= Date.parse(ackExpiresAt)) {
      throw domainError('equipment action acknowledgement does not match item')
    }
  } else if (acknowledgementId !== undefined) {
    throw domainError('equipment action acknowledgement is not allowed')
  }
}

function matchesSealedToken(
  game: PersistedGameV3,
  itemId: string,
  action: EquipmentV2Action,
  semanticId: string,
  kind: 'authorization' | 'option' | 'acknowledgement',
  token: string | undefined
): boolean {
  const expiresAt = tokenExpiresAt(token, kind)
  return Boolean(expiresAt && token && sameToken(sealEquipmentActionToken(game, itemId, action, semanticId, kind, expiresAt), token))
}

function tokenExpiresAt(token: string | undefined, kind: 'authorization' | 'option' | 'acknowledgement'): string | undefined {
  const parts = token?.split('.')
  if (parts?.length !== 4 || parts[0] !== 'eqv2' || parts[1] !== kind) return undefined
  try {
    const expiresAt = Buffer.from(parts[2]!, 'base64url').toString()
    return Number.isFinite(Date.parse(expiresAt)) ? expiresAt : undefined
  } catch {
    return undefined
  }
}

function sameToken(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
}

function equipmentTokenSecret(): string {
  const runtimeConfig = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : {}
  const secret = resolveServerRuntimeConfig(runtimeConfig).jwtSecret
  if (!secret || secret === 'dev-secret-change-me') throw domainError('equipment token secret is not configured')
  return secret
}

function requireStashItem(game: PersistedGameV3, itemId: string): Item {
  const item = game.itemsById[itemId]
  if (!item || !canUseEquipmentService(game, itemId)) throw domainError('Item is not available in caravan stash')
  return item
}

function ensureItemState(game: PersistedGameV3, itemId: string): PersistedItemV2State {
  game.itemV2ById[itemId] ??= {}
  return game.itemV2ById[itemId]!
}

function debitGold(game: PersistedGameV3, amount: number): void {
  if (game.gold < amount) throw domainError('Not enough gold')
  game.gold -= amount
}

function requireItemId(command: EquipmentV2Command): string {
  return requireString(command.itemId, 'itemId')
}

function requireOption(command: EquipmentV2Command): string {
  return requireString(command.optionId, 'optionId')
}

function requireAcknowledgement(command: EquipmentV2Command): string {
  return requireString(command.acknowledgementId, 'acknowledgementId')
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw domainError(`${field} is required`)
  return value
}

function stableStat(seed: string): StatKey {
  const stats: StatKey[] = ['strength', 'dexterity', 'vitality', 'energy', 'life', 'mana', 'magicFind', 'attackPower', 'defense']
  return stats[stableNumber(seed) % stats.length]!
}

function stableNumber(seed: string): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = ((hash * 31) + seed.charCodeAt(index)) >>> 0
  return hash
}

function domainError(message: string): EquipmentV2Error {
  return new EquipmentV2Error(message)
}
