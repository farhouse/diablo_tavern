import { defineStore } from 'pinia'
import type { ChronicleEntry, ChronicleResponse } from '~/shared/types/v2-chronicle'
import { useAuthStore } from '~/stores/auth'

export const useChronicleV2Store = defineStore('chronicle-v2', {
  state: () => ({
    requestEpoch: Math.random(),
    latestRequest: 0,
    entries: [] as ChronicleEntry[],
    nextCursor: null as string | null,
    loadState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    errorMessage: '',
    loadMoreState: 'idle' as 'idle' | 'loading' | 'error',
    loadMoreError: ''
  }),
  getters: { hasMore: (state) => Boolean(state.nextCursor) },
  actions: {
    async load() {
      const epoch = this.requestEpoch
      const request = ++this.latestRequest
      if (this.loadMoreState === 'loading') this.loadMoreState = 'idle'
      this.loadState = 'loading'
      this.errorMessage = ''
      try {
        const response = await this.request<ChronicleResponse>('/api/v2/chronicle?limit=30')
        if (epoch !== this.requestEpoch || request < this.latestRequest) return
        this.entries = dedupe(response.entries)
        this.nextCursor = response.nextCursor
        this.loadState = 'ready'
      } catch {
        if (epoch !== this.requestEpoch || request < this.latestRequest) return
        this.loadState = 'error'
        this.errorMessage = 'No se pudo cargar la crónica. Reintentá.'
      }
    },
    async loadMore() {
      if (!this.nextCursor || this.loadMoreState === 'loading') return
      const epoch = this.requestEpoch
      const request = ++this.latestRequest
      const cursor = this.nextCursor
      if (this.loadState === 'loading') this.loadState = 'idle'
      this.loadMoreState = 'loading'
      this.loadMoreError = ''
      try {
        const response = await this.request<ChronicleResponse>(`/api/v2/chronicle?limit=30&cursor=${encodeURIComponent(cursor)}`)
        if (epoch !== this.requestEpoch || request < this.latestRequest) return
        this.entries = dedupe([...this.entries, ...response.entries])
        this.nextCursor = response.nextCursor
        this.loadMoreState = 'idle'
      } catch {
        if (epoch !== this.requestEpoch || request < this.latestRequest) return
        this.loadMoreState = 'error'
        this.loadMoreError = 'No se pudieron cargar más entradas. Tus entradas actuales siguen disponibles.'
      }
    },
    async request<T>(url: string): Promise<T> {
      const auth = useAuthStore()
      auth.hydrate()
      try {
        return await ($fetch as typeof $fetch)(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } }) as T
      } catch (error) {
        if (typeof error === 'object' && error && 'statusCode' in error && (error as { statusCode: number }).statusCode === 401 && await auth.refresh()) {
          return await ($fetch as typeof $fetch)(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } }) as T
        }
        throw error
      }
    }
  }
})

function dedupe(entries: ChronicleEntry[]) {
  return [...new Map(entries.map((entry) => [entry.eventId, entry])).values()]
}
