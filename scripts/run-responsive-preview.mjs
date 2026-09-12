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

function remainingTime(deadline, now) {
  return Math.max(0, deadline - now())
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

async function waitForProcessGroupExit(pid, timeoutMs, killProcessGroup, now) {
  const deadline = now() + timeoutMs
  while (processGroupIsRunning(pid, killProcessGroup)) {
    if (now() >= deadline) return false
    await delay(Math.min(25, Math.max(1, deadline - now())))
  }
  return true
}

function waitForWindowsExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  if (timeoutMs <= 0) return Promise.resolve(false)

  return new Promise((resolveExit) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      resolveExit(result)
    }
    const onExit = () => finish(true)
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)

    child.once('exit', onExit)
    child.once('error', onError)
  })
}

export async function terminateChildTree(child, signal, options = {}) {
  const treePid = child?.pid
  if (!treePid) return true

  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const killProcessGroup = options.killProcessGroup ?? process.kill
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const gracefulDeadline = startedAt + Math.ceil(timeoutMs / 2)
  const shutdownDeadline = startedAt + timeoutMs

  if (platform === 'win32') {
    // On Windows child is the Job Object supervisor, not the workload leader.
    // ChildProcess.kill uses the already-open process handle, so no PID lookup or
    // descendant reconstruction can race PID reuse. Closing the supervisor kills
    // every process assigned to its KILL_ON_JOB_CLOSE job.
    if (child.exitCode !== null || child.signalCode !== null) return true
    const waitForExit = options.waitForWindowsExit ?? waitForWindowsExit
    const exitResult = waitForExit(child, remainingTime(shutdownDeadline, now))
    if (child.exitCode !== null || child.signalCode !== null) return true
    try {
      child.kill()
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) return true
    }
    return exitResult
  }

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
  if (await waitForProcessGroupExit(treePid, remainingTime(gracefulDeadline, now), killProcessGroup, now)) return true

  sendSignal(true)
  return waitForProcessGroupExit(treePid, remainingTime(shutdownDeadline, now), killProcessGroup, now)
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
    const onExit = (code, signal) => {
      if (child.treeIdentity) child.treeIdentity.exitedAt ??= Date.now()
      finish(resolveChild, { type: 'exit', code, signal })
    }

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
  const startedAt = Date.now()
  const windowsJobRunner = options.windowsJobRunner ?? resolve('scripts/windows-job-runner.ps1')
  const command = platform === 'win32'
    ? ['powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowsJobRunner
      ]]
    : [process.execPath, args]
  const childEnvironment = platform === 'win32'
    ? { ...environment, RESPONSIVE_JOB_COMMAND: JSON.stringify([process.execPath, ...args]) }
    : environment
  const child = spawnProcess(command[0], command[1], {
    env: childEnvironment,
    stdio: 'inherit',
    detached: platform !== 'win32',
    windowsHide: true
  })
  child.treeIdentity = { pid: child.pid, startedAt }
  return child
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
