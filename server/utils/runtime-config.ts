export interface ServerRuntimeConfig {
  mongoUri: string
  mongoDbName: string
  jwtSecret: string
  inviteCode: string
}

export function resolveServerRuntimeConfig(
  config: { mongoUri?: unknown; mongoDbName?: unknown; jwtSecret?: unknown; inviteCode?: unknown },
  environment: NodeJS.ProcessEnv = process.env
): ServerRuntimeConfig {
  return {
    mongoUri: String(environment.MONGO_URI ?? config.mongoUri ?? ''),
    mongoDbName: String(environment.MONGO_DB_NAME ?? config.mongoDbName ?? ''),
    jwtSecret: String(environment.JWT_SECRET ?? config.jwtSecret ?? ''),
    inviteCode: String(environment.INVITE_CODE ?? config.inviteCode ?? '')
  }
}
