export default defineNuxtConfig({
  compatibilityDate: '2026-06-01',
  modules: ['@pinia/nuxt', '@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
    mongoDbName: process.env.MONGO_DB_NAME || 'diablo_management',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    inviteCode: process.env.INVITE_CODE || '',
    public: {
      appName: 'Guild Manager ARPG',
      buildSha: process.env.NUXT_PUBLIC_BUILD_SHA || 'development'
    }
  },
  typescript: {
    strict: true
  }
})
