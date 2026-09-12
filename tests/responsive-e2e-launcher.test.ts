import { describe, expect, it, vi } from 'vitest'

import {
  createBuildEnvironment,
  createPreviewEnvironment,
  stopChild
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

  it('forwards shutdown signals only to a live child process', () => {
    const kill = vi.fn(() => true)

    expect(stopChild({ killed: false, kill }, 'SIGTERM')).toBe(true)
    expect(kill).toHaveBeenCalledWith('SIGTERM')

    kill.mockClear()
    expect(stopChild({ killed: true, kill }, 'SIGINT')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
