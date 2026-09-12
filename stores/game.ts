import { defineStore } from 'pinia'
import type { SaveGame, CaravanUpgradeId } from '~/types/game'
import { useAuthStore } from '~/stores/auth'

export const useGameStore = defineStore('game', {
  state: () => ({
    save: null as SaveGame | null,
    loading: false,
    error: '',
    visitorMutations: {} as Record<string, boolean>,
    visitorRequestIds: {} as Record<string, string>,
    saveMutations: {} as Record<string, boolean>,
    saveRequestIds: {} as Record<string, string>
  }),
  actions: {
    applySave(save: SaveGame) {
      if (!this.save || save.revision >= this.save.revision) this.save = save
    },
    async load() {
      this.loading = true
      this.error = ''
      try {
        const save = await this.api<SaveGame>('/api/savegame')
        this.applySave(save)
      } catch (error) {
        this.error = errorMessage(error)
      } finally {
        this.loading = false
      }
    },
    async reset() {
      await this.runSaveMutation('save:reset', '/api/savegame/reset')
    },
    async identify(itemId: string) {
      await this.runSaveMutation(`identify:${itemId}`, `/api/items/${itemId}/identify`)
    },
    async salvage(itemId: string) {
      await this.runSaveMutation(`salvage:${itemId}`, `/api/items/${itemId}/salvage`)
    },
    async buyFromVisitor(visitorId: string, offerId: string) {
      await this.runVisitorMutation('buy', visitorId, offerId, { offerId })
    },
    async sellToVisitor(visitorId: string, itemId: string) {
      await this.runVisitorMutation('sell', visitorId, itemId, { itemId })
    },
    async commissionVisitor(visitorId: string, optionId: 'safe' | 'risky') {
      await this.runVisitorMutation('commission', visitorId, optionId, { optionId })
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
      if (this.visitorMutations[key] || this.isVisitorMutationPending(visitorId)) return
      const requestId = this.visitorRequestIds[key] || createRequestId()
      this.visitorRequestIds[key] = requestId
      this.visitorMutations[key] = true
      this.error = ''
      try {
        const save = await this.api<SaveGame>(`/api/visitors/${visitorId}/${operation}`, {
          method: 'POST',
          body: { requestId, ...body }
        })
        this.applySave(save)
        delete this.visitorRequestIds[key]
      } finally {
        delete this.visitorMutations[key]
      }
    },
    async upgradeCaravan(upgradeId: CaravanUpgradeId) {
      await this.runSaveMutation(`upgrade:${upgradeId}`, '/api/caravan/upgrade', { upgradeId })
    },
    async startAppraisal(itemId: string) {
      await this.runSaveMutation(`appraise:${itemId}`, '/api/appraiser/start', { itemId })
    },
    async completeAppraisal() {
      await this.runSaveMutation('appraise:complete', '/api/appraiser/complete')
    },
    async runSaveMutation(key: string, url: string, body: Record<string, string> = {}) {
      if (this.saveMutations[key]) return
      const requestId = this.saveRequestIds[key] || createRequestId()
      this.saveRequestIds[key] = requestId
      this.saveMutations[key] = true
      this.error = ''
      try {
        this.applySave(await this.api<SaveGame>(url, { method: 'POST', body: { requestId, ...body } }))
        delete this.saveRequestIds[key]
      } finally {
        delete this.saveMutations[key]
      }
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
