import { defineStore } from 'pinia'
import type { EquipmentSlot, HeroClass, Quest, SaveGame, CaravanUpgradeId } from '~/types/game'
import { useAuthStore } from '~/stores/auth'

export const useGameStore = defineStore('game', {
  state: () => ({
    save: null as SaveGame | null,
    quests: [] as Quest[],
    loading: false,
    error: '',
    visitorMutations: {} as Record<string, boolean>,
    visitorRequestIds: {} as Record<string, string>
  }),
  getters: {
    unlockedQuests: (state) =>
      state.quests.filter((quest) => state.save?.questsProgress.find((progress) => progress.questId === quest.id)?.unlocked),
    completedQuestIds: (state) =>
      new Set(state.save?.questsProgress.filter((progress) => progress.completed).map((progress) => progress.questId) || [])
  },
  actions: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        const [save, quests] = await Promise.all([this.api<SaveGame>('/api/savegame'), $fetch<Quest[]>('/api/quests')])
        this.save = save
        this.quests = quests
      } catch (error) {
        this.error = errorMessage(error)
      } finally {
        this.loading = false
      }
    },
    async reset() {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/savegame/reset', { method: 'POST' })
    },
    async hire(heroClass: HeroClass) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/heroes/hire', {
        method: 'POST',
        body: { class: heroClass }
      })
    },
    async startQuest(questId: string, heroIds: string[]) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/quests/${questId}/start`, {
        method: 'POST',
        body: { heroIds }
      })
    },
    async completeQuest() {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/quests/complete', { method: 'POST' })
    },
    async identify(itemId: string) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/items/${itemId}/identify`, { method: 'POST' })
    },
    async sell(itemId: string) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/items/${itemId}/sell`, { method: 'POST' })
    },
    async buyFromVisitor(visitorId: string, offerId: string) {
      await this.runVisitorMutation('buy', visitorId, offerId, { offerId })
    },
    async sellToVisitor(visitorId: string, itemId: string) {
      await this.runVisitorMutation('sell', visitorId, itemId, { itemId })
    },
    async commissionVisitor(visitorId: string, regionId: string) {
      await this.runVisitorMutation('commission', visitorId, regionId, { regionId })
    },
    async claimVisitor(visitorId: string) {
      await this.runVisitorMutation('claim', visitorId)
    },
    async dismissVisitor(visitorId: string) {
      await this.runVisitorMutation('dismiss', visitorId)
    },
    isVisitorMutationPending(visitorId: string): boolean {
      return Object.keys(this.visitorMutations).some((key) => key.includes(`:${visitorId}:`) && this.visitorMutations[key])
    },
    async runVisitorMutation(
      operation: 'buy' | 'sell' | 'commission' | 'claim' | 'dismiss',
      visitorId: string,
      target = '',
      body: Record<string, string> = {}
    ) {
      const key = `${operation}:${visitorId}:${target}`
      if (this.visitorMutations[key]) return
      const requestId = this.visitorRequestIds[key] || createRequestId()
      this.visitorRequestIds[key] = requestId
      this.visitorMutations[key] = true
      this.error = ''
      try {
        const save = await this.api<SaveGame>(`/api/visitors/${visitorId}/${operation}`, {
          method: 'POST',
          body: { requestId, ...body }
        })
        this.save = save
        delete this.visitorRequestIds[key]
      } finally {
        delete this.visitorMutations[key]
      }
    },
    async equip(heroId: string, itemId: string, slot?: EquipmentSlot) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/heroes/${heroId}/equip`, {
        method: 'POST',
        body: { itemId, slot }
      })
    },
    async unequip(heroId: string, slot: EquipmentSlot) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/heroes/${heroId}/unequip`, {
        method: 'POST',
        body: { slot }
      })
    },
    async recover(heroId: string) {
      this.error = ''
      this.save = await this.api<SaveGame>(`/api/heroes/${heroId}/recover`, { method: 'POST' })
    },
    async startExpedition(questId: string, heroIds: string[]) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/expeditions/start', {
        method: 'POST',
        body: { questId, heroIds }
      })
    },
    async advanceExpeditions() {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/expeditions/advance', { method: 'POST' })
    },
    async advanceExpedition(expeditionId: string) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/expeditions/advance', {
        method: 'POST',
        body: { expeditionId }
      })
    },
    async recallExpedition(expeditionId: string, usePortal = false) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/expeditions/recall', {
        method: 'POST',
        body: { expeditionId, usePortal }
      })
    },
    async upgradeCaravan(upgradeId: CaravanUpgradeId) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/caravan/upgrade', {
        method: 'POST',
        body: { upgradeId }
      })
    },
    async startAppraisal(itemId: string) {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/appraiser/start', {
        method: 'POST',
        body: { itemId }
      })
    },
    async completeAppraisal() {
      this.error = ''
      this.save = await this.api<SaveGame>('/api/appraiser/complete', { method: 'POST' })
    },
    async api<T>(url: string, options: Record<string, unknown> = {}): Promise<T> {
      const auth = useAuthStore()
      auth.hydrate()
      const fetcher = $fetch as unknown as (request: string, opts?: Record<string, unknown>) => Promise<unknown>
      try {
        return (await fetcher(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            ...((options.headers as Record<string, string>) || {})
          }
        })) as T
      } catch (error: unknown) {
        if (isFetchStatus(error, 401) && (await auth.refresh())) {
          return (await fetcher(url, {
            ...options,
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              ...((options.headers as Record<string, string>) || {})
            }
          })) as T
        }
        this.error = errorMessage(error)
        throw error
      }
    }
  }
})

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'statusMessage' in error) return String((error as { statusMessage: string }).statusMessage)
  if (error instanceof Error) return error.message
  return 'Unexpected error'
}

function isFetchStatus(error: unknown, statusCode: number): boolean {
  return Boolean(typeof error === 'object' && error && 'statusCode' in error && (error as { statusCode: number }).statusCode === statusCode)
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
