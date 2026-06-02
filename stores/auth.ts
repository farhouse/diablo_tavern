import { defineStore } from 'pinia'
import type { PublicUser } from '~/types/game'

interface AuthResponse {
  user: PublicUser
  accessToken: string
  refreshToken: string
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as PublicUser | null,
    accessToken: '',
    refreshToken: '',
    ready: false,
    error: ''
  }),
  getters: {
    loggedIn: (state) => Boolean(state.accessToken && state.user)
  },
  actions: {
    hydrate() {
      if (import.meta.server || this.ready) return
      this.accessToken = localStorage.getItem('accessToken') || ''
      this.refreshToken = localStorage.getItem('refreshToken') || ''
      const storedUser = localStorage.getItem('user')
      this.user = storedUser ? JSON.parse(storedUser) : null
      this.ready = true
    },
    async login(email: string, password: string) {
      const response = await $fetch<AuthResponse>('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      this.setSession(response)
    },
    async register(email: string, password: string) {
      const response = await $fetch<AuthResponse>('/api/auth/register', {
        method: 'POST',
        body: { email, password }
      })
      this.setSession(response)
    },
    async refresh() {
      if (!this.refreshToken) return false
      try {
        const response = await $fetch<AuthResponse>('/api/auth/refresh', {
          method: 'POST',
          body: { refreshToken: this.refreshToken }
        })
        this.setSession(response)
        return true
      } catch {
        this.logout()
        return false
      }
    },
    logout() {
      this.user = null
      this.accessToken = ''
      this.refreshToken = ''
      if (import.meta.client) {
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
        localStorage.removeItem('user')
      }
    },
    setSession(response: AuthResponse) {
      this.user = response.user
      this.accessToken = response.accessToken
      this.refreshToken = response.refreshToken
      if (import.meta.client) {
        localStorage.setItem('accessToken', response.accessToken)
        localStorage.setItem('refreshToken', response.refreshToken)
        localStorage.setItem('user', JSON.stringify(response.user))
      }
    }
  }
})
