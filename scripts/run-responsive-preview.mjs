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

export function collectWindowsDescendantPids(rootPid, treeIdentity, processes) {
  const rootExitedAt = treeIdentity.exitedAt ?? Number.POSITIVE_INFINITY
  const childrenByParent = new Map()
  for (const processInfo of processes) {
    const pid = Number(processInfo.ProcessId)
    const parentPid = Number(processInfo.ParentProcessId)
    const createdAt = Number(processInfo.CreatedAt)
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isFinite(createdAt)) continue
    const children = childrenByParent.get(parentPid) ?? []
    children.push({ pid, createdAt })
    childrenByParent.set(parentPid, children)
  }

  const descendants = []
  const visited = new Set([rootPid])
  const pendingParents = [{ pid: rootPid, createdAt: treeIdentity.startedAt, isRoot: true }]
  for (const parent of pendingParents) {
    for (const childProcess of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(childProcess.pid)) continue
      if (childProcess.createdAt < parent.createdAt) continue
      if (parent.isRoot && childProcess.createdAt > rootExitedAt) continue
      visited.add(childProcess.pid)
      descendants.push(childProcess.pid)
      pendingParents.push({ ...childProcess, isRoot: false })
    }
  }
  return descendants
}

function listWindowsDescendantPids(rootPid, treeIdentity, timeoutMs) {
  if (timeoutMs <= 0) return Promise.resolve(null)

  return new Promise((resolveDescendants) => {
    const query = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreatedAt';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress"
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let output = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveDescendants(result)
    }
    const timer = setTimeout(() => {
      query.kill('SIGKILL')
      finish(null)
    }, timeoutMs)

    query.stdout?.setEncoding('utf8')
    query.stdout?.on('data', chunk => {
      output += chunk
    })
    query.once('error', () => finish(null))
    query.once('exit', code => {
      if (code !== 0) return finish(null)
      try {
        const parsed = JSON.parse(output || '[]')
        const processes = Array.isArray(parsed) ? parsed : [parsed]
        finish(collectWindowsDescendantPids(rootPid, treeIdentity, processes))
      } catch {
        finish(null)
      }
    })
  })
}

async function terminateWindowsTree(child, treePid, force, deadline, now, taskkill, findDescendants) {
  const treeIdentity = child.treeIdentity ?? {
    pid: treePid,
    startedAt: 0,
    exitedAt: child.exitCode !== null || child.signalCode !== null ? now() : undefined
  }
  const descendants = await findDescendants(
    treePid,
    treeIdentity,
    remainingTime(deadline, now)
  )
  const rootBudget = remainingTime(deadline, now)
  if (rootBudget === 0) return false

  const rootStopped = await taskkill(treePid, force, rootBudget)
  if (rootStopped) return true
  if (descendants === null) return false

  const leaderExited = child.exitCode !== null || child.signalCode !== null
  const failedDescendants = []
  for (const descendantPid of descendants.reverse()) {
    const descendantBudget = remainingTime(deadline, now)
    if (descendantBudget === 0) return false
    if (!await taskkill(descendantPid, force, descendantBudget)) failedDescendants.push(descendantPid)
  }
  if (!leaderExited) return false
  if (failedDescendants.length === 0) return true

  const remainingDescendants = await findDescendants(
    treePid,
    treeIdentity,
    remainingTime(deadline, now)
  )
  return remainingDescendants !== null && remainingDescendants.length === 0
}

export async function terminateChildTree(child, signal, options = {}) {
  const treePid = child?.pid
  if (!treePid) return true

  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const killProcessGroup = options.killProcessGroup ?? process.kill
  const taskkill = options.taskkill ?? runTaskkill
  const findWindowsDescendants = options.findWindowsDescendants ?? listWindowsDescendantPids
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const gracefulDeadline = startedAt + Math.ceil(timeoutMs / 2)
  const shutdownDeadline = startedAt + timeoutMs

  if (platform === 'win32') {
    const gracefulResult = await terminateWindowsTree(
      child,
      treePid,
      false,
      gracefulDeadline,
      now,
      taskkill,
      findWindowsDescendants
    )
    if (gracefulResult) return true

    return terminateWindowsTree(
      child,
      treePid,
      true,
      shutdownDeadline,
      now,
      taskkill,
      findWindowsDescendants
    )
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

function spawnNode(args, environment) {
  const startedAt = Date.now()
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
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
