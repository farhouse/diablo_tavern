import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { spawnNode, terminateChildTree } from '../scripts/run-responsive-preview.mjs'

const windowsOnly = process.platform === 'win32' ? describe : describe.skip

windowsOnly('Windows Job Object launcher integration', () => {
  it('kills a grandchild after its workload leader and intermediate parent exited', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'responsive-windows-job-'))
    const markerPath = join(directory, 'grandchild.pid')
    const fixturePath = resolve('tests/fixtures/windows-job-grandchild.mjs')
    const supervisor = spawnNode([fixturePath, 'root', markerPath], process.env)
    let grandchildPid: number | undefined

    try {
      grandchildPid = Number(await waitForFile(markerPath, 5_000))
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(supervisor.exitCode).toBeNull()
      expect(processIsRunning(grandchildPid)).toBe(true)

      await expect(terminateChildTree(supervisor, 'SIGTERM', {
        timeoutMs: 5_000
      })).resolves.toBe(true)
      await expect(waitForCondition(() => !processIsRunning(grandchildPid!), 5_000)).resolves.toBe(true)
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill()
      if (grandchildPid && processIsRunning(grandchildPid)) process.kill(grandchildPid)
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})

async function waitForFile(path: string, timeoutMs: number) {
  let contents: string | undefined
  await waitForCondition(async () => {
    try {
      contents = await readFile(path, 'utf8')
      return true
    } catch {
      return false
    }
  }, timeoutMs)
  return contents!
}

async function waitForCondition(condition: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms.`)
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}
