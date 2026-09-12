import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const RUNTIME_SHA_PREFIX = 'runtime-override-'
const SHUTDOWN_TIMEOUT_MS = 5_000

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

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function assertPosixPlatform(platform) {
  if (platform === 'win32') {
    throw new Error('test:e2e:responsive is supported only on POSIX platforms; Windows is not supported.')
  }
}

export function resolveResponsiveBuildSha(platform, readHeadSha) {
  assertPosixPlatform(platform)
  return readHeadSha().trim()
}

function processGroupIsRunning(pid, killProcessGroup) {
  try {
    killProcessGroup(-pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false
    return true
  }
}

export async function waitForProcessGroupExit(pid, deadline, killProcessGroup, now, wait) {
  while (processGroupIsRunning(pid, killProcessGroup)) {
    const remainingMs = deadline - now()
    if (remainingMs <= 0) return false
    await wait(Math.min(25, remainingMs))
  }
  return true
}

export async function terminateChildTree(child, signal, options = {}) {
  const treePid = child?.pid
  if (!treePid) return true

  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const killProcessGroup = options.killProcessGroup ?? process.kill
  const now = options.now ?? (() => performance.now())
  const wait = options.wait ?? delay
  assertPosixPlatform(platform)
  const startedAt = now()
  const gracefulDeadline = startedAt + Math.ceil(timeoutMs / 2)
  const shutdownDeadline = startedAt + timeoutMs

  const sendSignal = (force) => {
    try {
      killProcessGroup(-treePid, force ? 'SIGKILL' : signal)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true
      return false
    }
  }

  sendSignal(false)
  if (await waitForProcessGroupExit(treePid, gracefulDeadline, killProcessGroup, now, wait)) return true

  sendSignal(true)
  return waitForProcessGroupExit(treePid, shutdownDeadline, killProcessGroup, now, wait)
}

function waitForChild(child, shutdownResult) {
  return new Promise((resolveChild, rejectChild) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      callback(value)
    }
    const onError = error => finish(rejectChild, error)
    const onExit = (code, signal) => finish(resolveChild, { type: 'exit', code, signal })

    child.once('error', onError)
    child.once('exit', onExit)
    shutdownResult.then(
      cleaned => finish(resolveChild, { type: 'shutdown', cleaned }),
      error => finish(rejectChild, error)
    )
  })
}

export function spawnNode(args, environment, options = {}) {
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawnProcess ?? spawn
  assertPosixPlatform(platform)
  const child = spawnProcess(process.execPath, args, {
    env: environment,
    stdio: 'inherit',
    detached: true,
    windowsHide: true
  })
  return child
}

export async function runResponsivePreview(environment = process.env, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const expectedSha = environment.PLAYWRIGHT_EXPECTED_SHA
  const packageManagerCli = environment.npm_execpath
  const processTarget = dependencies.processTarget ?? process
  const startNode = dependencies.spawnNode ?? spawnNode
  const terminateTree = dependencies.terminateTree ?? terminateChildTree

  assertPosixPlatform(platform)

  if (!expectedSha) {
    throw new Error('PLAYWRIGHT_EXPECTED_SHA is required.')
  }
  if (!packageManagerCli) {
    throw new Error('Run this launcher through pnpm so npm_execpath is available.')
  }

  let activeChild
  let shutdownSignal
  let shutdownPromise
  let resolveShutdown
  const shutdownResult = new Promise(resolve => {
    resolveShutdown = resolve
  })

  const forwardSignal = (signal) => {
    shutdownSignal = signal
    processTarget.exitCode = signal === 'SIGINT' ? 130 : 143
    shutdownPromise ??= terminateTree(activeChild, signal)
    resolveShutdown(shutdownPromise)
  }
  const forwardSigint = () => forwardSignal('SIGINT')
  const forwardSigterm = () => forwardSignal('SIGTERM')

  processTarget.once('SIGINT', forwardSigint)
  processTarget.once('SIGTERM', forwardSigterm)

  try {
    activeChild = startNode(
      [packageManagerCli, 'build'],
      createBuildEnvironment(environment, expectedSha)
    )
    const buildResult = await waitForChild(activeChild, shutdownResult)
    if (shutdownSignal || buildResult.type === 'shutdown') return
    if (buildResult.code !== 0) {
      throw new Error(`Responsive E2E build failed with exit code ${buildResult.code ?? 'unknown'}.`)
    }

    activeChild = startNode(
      [resolve('.output/server/index.mjs')],
      createPreviewEnvironment(environment, expectedSha)
    )
    const previewResult = await waitForChild(activeChild, shutdownResult)
    if (shutdownSignal || previewResult.type === 'shutdown') return
    if (previewResult.code !== 0) {
      throw new Error(`Responsive E2E preview exited with code ${previewResult.code ?? 'unknown'}.`)
    }
  } finally {
    shutdownPromise ??= terminateTree(activeChild, 'SIGTERM')
    let cleaned
    try {
      cleaned = await shutdownPromise
    } finally {
      processTarget.removeListener('SIGINT', forwardSigint)
      processTarget.removeListener('SIGTERM', forwardSigterm)
    }
    if (!cleaned) throw new Error('Responsive E2E process tree did not stop cleanly.')
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isEntrypoint) {
  runResponsivePreview().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
