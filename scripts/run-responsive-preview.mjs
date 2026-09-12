import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const RUNTIME_SHA_PREFIX = 'runtime-override-'

export function createBuildEnvironment(baseEnvironment, expectedSha) {
  return {
    ...baseEnvironment,
    NUXT_PUBLIC_BUILD_SHA: expectedSha
  }
}

export function createPreviewEnvironment(baseEnvironment, expectedSha) {
  return {
    ...baseEnvironment,
    NUXT_PUBLIC_BUILD_SHA: `${RUNTIME_SHA_PREFIX}${expectedSha}`
  }
}

export function stopChild(child, signal) {
  if (!child || child.killed) return false

  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild)
    child.once('exit', (code, signal) => resolveChild({ code, signal }))
  })
}

function spawnNode(args, environment) {
  return spawn(process.execPath, args, {
    env: environment,
    stdio: 'inherit',
    windowsHide: true
  })
}

export async function runResponsivePreview(environment = process.env) {
  const expectedSha = environment.PLAYWRIGHT_EXPECTED_SHA
  const packageManagerCli = environment.npm_execpath

  if (!expectedSha) {
    throw new Error('PLAYWRIGHT_EXPECTED_SHA is required.')
  }
  if (!packageManagerCli) {
    throw new Error('Run this launcher through pnpm so npm_execpath is available.')
  }

  let activeChild
  let shutdownSignal

  const forwardSignal = (signal) => {
    shutdownSignal = signal
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    stopChild(activeChild, signal)
  }
  const forwardSigint = () => forwardSignal('SIGINT')
  const forwardSigterm = () => forwardSignal('SIGTERM')
  const cleanup = () => stopChild(activeChild, 'SIGTERM')

  process.once('SIGINT', forwardSigint)
  process.once('SIGTERM', forwardSigterm)
  process.once('exit', cleanup)

  try {
    activeChild = spawnNode(
      [packageManagerCli, 'build'],
      createBuildEnvironment(environment, expectedSha)
    )
    const buildResult = await waitForChild(activeChild)
    if (shutdownSignal) return
    if (buildResult.code !== 0) {
      throw new Error(`Responsive E2E build failed with exit code ${buildResult.code ?? 'unknown'}.`)
    }

    activeChild = spawnNode(
      [resolve('.output/server/index.mjs')],
      createPreviewEnvironment(environment, expectedSha)
    )
    const previewResult = await waitForChild(activeChild)
    if (!shutdownSignal && previewResult.code !== 0) {
      throw new Error(`Responsive E2E preview exited with code ${previewResult.code ?? 'unknown'}.`)
    }
  } finally {
    process.removeListener('SIGINT', forwardSigint)
    process.removeListener('SIGTERM', forwardSigterm)
    process.removeListener('exit', cleanup)
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isEntrypoint) {
  runResponsivePreview().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
