import { spawn } from 'node:child_process'
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

function childIsRunning(child) {
  return Boolean(child?.pid && child.exitCode === null && child.signalCode === null)
}

function waitForExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve(true)

  return new Promise((resolveExit) => {
    const finish = (exited) => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolveExit(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)

    child.once('exit', onExit)
  })
}

function runTaskkill(pid, force) {
  return new Promise((resolveTaskkill) => {
    const args = ['/pid', String(pid), '/t']
    if (force) args.push('/f')

    const taskkill = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      windowsHide: true
    })
    taskkill.once('error', () => resolveTaskkill(false))
    taskkill.once('exit', code => resolveTaskkill(code === 0))
  })
}

export async function terminateChildTree(child, signal, options = {}) {
  if (!childIsRunning(child)) return true

  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const killProcessGroup = options.killProcessGroup ?? process.kill
  const taskkill = options.taskkill ?? runTaskkill

  const sendSignal = async (force) => {
    try {
      if (platform === 'win32') return await taskkill(child.pid, force)

      killProcessGroup(-child.pid, force ? 'SIGKILL' : signal)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true
      return false
    }
  }

  await sendSignal(false)
  if (await waitForExit(child, timeoutMs)) return true

  await sendSignal(true)
  return waitForExit(child, timeoutMs)
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
    detached: process.platform !== 'win32',
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
  let shutdownPromise

  const forwardSignal = (signal) => {
    shutdownSignal = signal
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    shutdownPromise ??= terminateChildTree(activeChild, signal)
  }
  const forwardSigint = () => forwardSignal('SIGINT')
  const forwardSigterm = () => forwardSignal('SIGTERM')

  process.once('SIGINT', forwardSigint)
  process.once('SIGTERM', forwardSigterm)

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
    await (shutdownPromise ?? terminateChildTree(activeChild, 'SIGTERM'))
    process.removeListener('SIGINT', forwardSigint)
    process.removeListener('SIGTERM', forwardSigterm)
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isEntrypoint) {
  runResponsivePreview().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
