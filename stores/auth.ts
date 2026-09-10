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
      if (this.ready) return
      const accessTokenCookie = useCookie<string>('accessToken')
      const refreshTokenCookie = useCookie<string>('refreshToken')
      const userCookie = useCookie<PublicUser | null>('user')

      this.accessToken = accessTokenCookie.value || ''
      this.refreshToken = refreshTokenCookie.value || ''
      this.user = userCookie.value || null

      if (import.meta.client) {
        this.accessToken ||= localStorage.getItem('accessToken') || ''
        this.refreshToken ||= localStorage.getItem('refreshToken') || ''
        const storedUser = localStorage.getItem('user')
        this.user ||= storedUser ? JSON.parse(storedUser) : null
      }
      this.ready = true
    },
    async login(email: string, password: string) {
      const response = await $fetch<AuthResponse>('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      this.setSession(response)
    },
    async register(email: string, password: string, inviteCode?: string) {
      const body: Record<string, string> = { email, password }
      if (inviteCode) body.inviteCode = inviteCode
      const response = await $fetch<AuthResponse>('/api/auth/register', {
        method: 'POST',
        body
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
      const accessTokenCookie = useCookie<string | null>('accessToken')
      const refreshTokenCookie = useCookie<string | null>('refreshToken')
      const userCookie = useCookie<PublicUser | null>('user')
      accessTokenCookie.value = null
      refreshTokenCookie.value = null
      userCookie.value = null
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
      this.ready = true
      const accessTokenCookie = useCookie<string>('accessToken', { sameSite: 'lax', maxAge: 60 * 20 })
      const refreshTokenCookie = useCookie<string>('refreshToken', { sameSite: 'lax', maxAge: 60 * 60 * 24 * 14 })
      const userCookie = useCookie<PublicUser>('user', { sameSite: 'lax', maxAge: 60 * 60 * 24 * 14 })
      accessTokenCookie.value = response.accessToken
      refreshTokenCookie.value = response.refreshToken
      userCookie.value = response.user
      if (import.meta.client) {
        localStorage.setItem('accessToken', response.accessToken)
        localStorage.setItem('refreshToken', response.refreshToken)
        localStorage.setItem('user', JSON.stringify(response.user))
      }
    }
  }
})
