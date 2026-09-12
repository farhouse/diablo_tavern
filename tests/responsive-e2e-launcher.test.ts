import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  createBuildEnvironment,
  createPreviewEnvironment,
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
    const killProcessGroup = vi.fn(() => {
      child.signalCode = 'SIGTERM'
      child.emit('exit', null, 'SIGTERM')
    })

    await expect(terminateChildTree(child, 'SIGTERM', {
      platform: 'darwin',
      timeoutMs: 10,
      killProcessGroup
    })).resolves.toBe(true)
    expect(killProcessGroup).toHaveBeenCalledWith(-8123, 'SIGTERM')
  })

  it('escalates cleanup when the process tree ignores graceful shutdown', async () => {
    const child = createChild(9123)
    const killProcessGroup = vi.fn((_pid, signal) => {
      if (signal === 'SIGKILL') {
        child.signalCode = 'SIGKILL'
        child.emit('exit', null, 'SIGKILL')
      }
    })

    await expect(terminateChildTree(child, 'SIGINT', {
      platform: 'linux',
      timeoutMs: 1,
      killProcessGroup
    })).resolves.toBe(true)
    expect(killProcessGroup).toHaveBeenNthCalledWith(1, -9123, 'SIGINT')
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, -9123, 'SIGKILL')
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
    expect(taskkill).toHaveBeenCalledWith(7123, false)
  })
})

function createChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  })
}
