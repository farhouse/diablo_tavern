import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  createBuildEnvironment,
  createPreviewEnvironment,
  runResponsivePreview,
  terminateChildTree
} from '../scripts/run-responsive-preview.mjs'

describe('responsive E2E preview launcher', () => {
  it('builds HEAD and previews with a deliberately different runtime SHA', () => {
    const baseEnvironment = { EXISTING_VALUE: 'preserved' }
    const expectedSha = 'expected-head-sha'

    const buildEnvironment = createBuildEnvironment(baseEnvironment, expectedSha)
    const previewEnvironment = createPreviewEnvironment(baseEnvironment, expectedSha)

    expect(buildEnvironment).toMatchObject({
      EXISTING_VALUE: 'preserved',
      NUXT_PUBLIC_BUILD_SHA: expectedSha
    })
    expect(previewEnvironment).toMatchObject({
      EXISTING_VALUE: 'preserved',
      NUXT_PUBLIC_BUILD_SHA: expect.stringContaining('runtime-override')
    })
    expect(previewEnvironment.NUXT_PUBLIC_BUILD_SHA).not.toBe(expectedSha)
  })

  it('signals the complete POSIX process group and waits for its exit', async () => {
    const child = createChild(8123)
    let groupRunning = true
    const killProcessGroup = vi.fn((_pid, signal) => {
      if (signal === 0 && !groupRunning) throw processMissingError()
      if (signal === 'SIGTERM') {
        groupRunning = false
        completeChild(child, null, 'SIGTERM')
      }
    })

    await expect(terminateChildTree(child, 'SIGTERM', {
      platform: 'darwin',
      timeoutMs: 10,
      killProcessGroup
    })).resolves.toBe(true)
    expect(killProcessGroup).toHaveBeenCalledWith(-8123, 'SIGTERM')
    expect(killProcessGroup).toHaveBeenCalledWith(-8123, 0)
  })

  it('escalates when descendants survive after the POSIX group leader exits', async () => {
    const child = createChild(9123)
    let groupRunning = true
    const killProcessGroup = vi.fn((_pid, signal) => {
      if (signal === 0 && !groupRunning) throw processMissingError()
      if (signal === 'SIGINT') completeChild(child, null, 'SIGINT')
      if (signal === 'SIGKILL') {
        groupRunning = false
      }
    })

    await expect(terminateChildTree(child, 'SIGINT', {
      platform: 'linux',
      timeoutMs: 1,
      killProcessGroup
    })).resolves.toBe(true)
    const deliveredSignals = killProcessGroup.mock.calls
      .map(([, signal]) => signal)
      .filter(signal => signal !== 0)
    expect(deliveredSignals).toEqual(['SIGINT', 'SIGKILL'])
  })

  it('uses taskkill for a complete Windows child tree', async () => {
    const child = createChild(7123)
    const taskkill = vi.fn(async (_pid, force) => {
      if (!force) {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
      }
      return true
    })

    await expect(terminateChildTree(child, 'SIGTERM', {
      platform: 'win32',
      timeoutMs: 10,
      taskkill
    })).resolves.toBe(true)
    expect(taskkill).toHaveBeenCalledWith(7123, false, 10)
  })

  it('bounds Windows graceful cleanup before forcing the tree', async () => {
    const child = createChild(6123)
    const taskkill = vi.fn(async (_pid, force) => {
      if (force) completeChild(child, null, 'SIGKILL')
      return force
    })

    await expect(terminateChildTree(child, 'SIGTERM', {
      platform: 'win32',
      timeoutMs: 1,
      taskkill
    })).resolves.toBe(true)
    expect(taskkill.mock.calls).toEqual([
      [6123, false, 1],
      [6123, true, 1]
    ])
  })

  it('sequences build before preview and removes lifecycle listeners', async () => {
    const build = createChild(5001)
    const preview = createChild(5002)
    const processTarget = createProcessTarget()
    const spawnNode = vi.fn()
      .mockReturnValueOnce(build)
      .mockReturnValueOnce(preview)
    const terminateTree = vi.fn(async () => true)
    const run = runResponsivePreview(launcherEnvironment, { processTarget, spawnNode, terminateTree })

    expect(spawnNode).toHaveBeenCalledTimes(1)
    completeChild(build, 0)
    await vi.waitFor(() => expect(spawnNode).toHaveBeenCalledTimes(2))
    completeChild(preview, 0)
    await run

    expect(spawnNode.mock.calls[0]![1].NUXT_PUBLIC_BUILD_SHA).toBe('expected-head-sha')
    expect(spawnNode.mock.calls[1]![1].NUXT_PUBLIC_BUILD_SHA).toContain('runtime-override')
    expect(terminateTree).toHaveBeenCalledWith(preview, 'SIGTERM')
    expect(processTarget.listenerCount('SIGINT')).toBe(0)
    expect(processTarget.listenerCount('SIGTERM')).toBe(0)
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const)('forwards %s to the active build and does not start preview', async (signal, exitCode) => {
    const build = createChild(4001)
    const processTarget = createProcessTarget()
    const spawnNode = vi.fn(() => build)
    const terminateTree = vi.fn(async (child, receivedSignal) => {
      completeChild(child, null, receivedSignal)
      return true
    })
    const run = runResponsivePreview(launcherEnvironment, { processTarget, spawnNode, terminateTree })

    processTarget.emit(signal)
    await run

    expect(terminateTree).toHaveBeenCalledWith(build, signal)
    expect(spawnNode).toHaveBeenCalledTimes(1)
    expect(processTarget.exitCode).toBe(exitCode)
    expect(processTarget.listenerCount(signal)).toBe(0)
  })

  it('does not start preview after a failed build and removes listeners', async () => {
    const build = createChild(3001)
    const processTarget = createProcessTarget()
    const spawnNode = vi.fn(() => build)
    const terminateTree = vi.fn(async () => true)
    const run = runResponsivePreview(launcherEnvironment, { processTarget, spawnNode, terminateTree })

    completeChild(build, 2)

    await expect(run).rejects.toThrow('build failed with exit code 2')
    expect(spawnNode).toHaveBeenCalledTimes(1)
    expect(processTarget.listenerCount('SIGINT')).toBe(0)
    expect(processTarget.listenerCount('SIGTERM')).toBe(0)
  })
})

const launcherEnvironment = {
  PLAYWRIGHT_EXPECTED_SHA: 'expected-head-sha',
  npm_execpath: '/portable/pnpm.cjs'
}

function createChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  })
}

function completeChild(child: ReturnType<typeof createChild>, code: number | null, signal: NodeJS.Signals | null = null) {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
}

function createProcessTarget() {
  return Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined })
}

function processMissingError() {
  return Object.assign(new Error('process group not found'), { code: 'ESRCH' })
}
