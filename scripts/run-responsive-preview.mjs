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

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
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

async function waitForProcessGroupExit(pid, timeoutMs, killProcessGroup) {
  const deadline = Date.now() + timeoutMs
  while (processGroupIsRunning(pid, killProcessGroup)) {
    if (Date.now() >= deadline) return false
    await delay(Math.min(25, Math.max(1, deadline - Date.now())))
  }
  return true
}

function runTaskkill(pid, force, timeoutMs) {
  return new Promise((resolveTaskkill) => {
    const args = ['/pid', String(pid), '/t']
    if (force) args.push('/f')

    const taskkill = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      windowsHide: true
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveTaskkill(result)
    }
    const timer = setTimeout(() => {
      taskkill.kill('SIGKILL')
      finish(false)
    }, timeoutMs)

    taskkill.once('error', () => finish(false))
    taskkill.once('exit', code => finish(code === 0))
  })
}

export async function terminateChildTree(child, signal, options = {}) {
  if (!childIsRunning(child)) return true

  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const killProcessGroup = options.killProcessGroup ?? process.kill
  const taskkill = options.taskkill ?? runTaskkill

  if (platform === 'win32') {
    const gracefulResult = await taskkill(child.pid, false, timeoutMs)
    if (gracefulResult && await waitForExit(child, timeoutMs)) return true

    const forcedResult = await taskkill(child.pid, true, timeoutMs)
    return forcedResult && await waitForExit(child, timeoutMs)
  }

  const sendSignal = (force) => {
    try {
      killProcessGroup(-child.pid, force ? 'SIGKILL' : signal)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true
      return false
    }
  }

  sendSignal(false)
  if (await waitForProcessGroupExit(child.pid, timeoutMs, killProcessGroup)) return true

  sendSignal(true)
  return waitForProcessGroupExit(child.pid, timeoutMs, killProcessGroup)
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

export async function runResponsivePreview(environment = process.env, dependencies = {}) {
  const expectedSha = environment.PLAYWRIGHT_EXPECTED_SHA
  const packageManagerCli = environment.npm_execpath
  const processTarget = dependencies.processTarget ?? process
  const startNode = dependencies.spawnNode ?? spawnNode
  const terminateTree = dependencies.terminateTree ?? terminateChildTree

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
    processTarget.exitCode = signal === 'SIGINT' ? 130 : 143
    shutdownPromise ??= terminateTree(activeChild, signal)
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
    const buildResult = await waitForChild(activeChild)
    if (shutdownSignal) return
    if (buildResult.code !== 0) {
      throw new Error(`Responsive E2E build failed with exit code ${buildResult.code ?? 'unknown'}.`)
    }

    activeChild = startNode(
      [resolve('.output/server/index.mjs')],
      createPreviewEnvironment(environment, expectedSha)
    )
    const previewResult = await waitForChild(activeChild)
    if (!shutdownSignal && previewResult.code !== 0) {
      throw new Error(`Responsive E2E preview exited with code ${previewResult.code ?? 'unknown'}.`)
    }
  } finally {
    const cleaned = await (shutdownPromise ?? terminateTree(activeChild, 'SIGTERM'))
    processTarget.removeListener('SIGINT', forwardSigint)
    processTarget.removeListener('SIGTERM', forwardSigterm)
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
