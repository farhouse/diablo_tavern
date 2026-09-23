import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function resolveV2E2EEnvironment(environment) {
  const mongoTestUri = environment.MONGO_TEST_URI?.trim()
  const mongoDbName = environment.MONGO_DB_NAME?.trim()
  if (!mongoTestUri) throw new Error('test:e2e:v2 requires MONGO_TEST_URI for an isolated Mongo instance.')
  if (!mongoDbName || mongoDbName === 'diablo_management') {
    throw new Error('test:e2e:v2 requires an explicit MONGO_DB_NAME different from diablo_management.')
  }

  return {
    ...environment,
    MONGO_TEST_URI: mongoTestUri,
    MONGO_URI: mongoTestUri,
    MONGO_DB_NAME: mongoDbName
  }
}

export function runV2E2E(environment = process.env, run = spawnSync, extraArgs = []) {
  const isolatedEnvironment = resolveV2E2EEnvironment(environment)
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
  const result = run(command, [
    'test',
    '--config',
    'playwright.config.ts',
    'tests/e2e/visitors-v2.pw.ts',
    ...extraArgs
  ], { env: isolatedEnvironment, stdio: 'inherit' })

  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runV2E2E(process.env, spawnSync, process.argv.slice(2))
}
