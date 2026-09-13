import { validateDatabaseConfig } from '~/server/utils/db'

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  validateDatabaseConfig(config)
  if (typeof config.jwtSecret !== 'string' || config.jwtSecret.length < 16) {
    throw new Error('JWT_SECRET must contain at least 16 characters')
  }
  if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'dev-secret-change-me') {
    throw new Error('JWT_SECRET must be changed in production')
  }
})
