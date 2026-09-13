import { validateDatabaseConfig } from '~/server/utils/db'
import { resolveServerRuntimeConfig } from '~/server/utils/runtime-config'

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  validateRuntimeConfig(config, process.env)
})

export function validateRuntimeConfig(
  config: { mongoUri: unknown; mongoDbName: unknown; jwtSecret: unknown; inviteCode?: unknown },
  environment: NodeJS.ProcessEnv
): void {
  if (environment.NODE_ENV === 'production' && (!environment.MONGO_URI || !environment.MONGO_DB_NAME)) {
    throw new Error('MONGO_URI and MONGO_DB_NAME must be explicitly configured in production')
  }
  const resolved = resolveServerRuntimeConfig(config, environment)
  validateDatabaseConfig(resolved)
  if (resolved.jwtSecret.length < 16) {
    throw new Error('JWT_SECRET must contain at least 16 characters')
  }
  if (environment.NODE_ENV === 'production' && resolved.jwtSecret === 'dev-secret-change-me') {
    throw new Error('JWT_SECRET must be changed in production')
  }
}
