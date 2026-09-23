import { describe, expect, it, vi } from 'vitest'
import { resolveV2E2EEnvironment, runV2E2E } from '../scripts/run-v2-e2e-isolated.mjs'

describe('isolated V2 E2E launcher', () => {
  it('fails without an explicit isolated database', () => {
    expect(() => resolveV2E2EEnvironment({ MONGO_TEST_URI: 'mongodb://127.0.0.1:27017' }))
      .toThrow('MONGO_DB_NAME')
    expect(() => resolveV2E2EEnvironment({ MONGO_TEST_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'diablo_management' }))
      .toThrow('different from diablo_management')
  })

  it('maps the isolated test URI to Nuxt and preserves the DB name', () => {
    expect(resolveV2E2EEnvironment({
      MONGO_TEST_URI: ' mongodb://127.0.0.1:27017 ',
      MONGO_DB_NAME: 'diablo_management_alta58_review'
    })).toMatchObject({
      MONGO_TEST_URI: 'mongodb://127.0.0.1:27017',
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      MONGO_DB_NAME: 'diablo_management_alta58_review'
    })
  })

  it('runs only the dedicated V2 spec with the mapped environment', () => {
    const run = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      status: 0,
      signal: null,
      error: undefined
    })) as unknown as Parameters<typeof runV2E2E>[1]
    expect(runV2E2E({
      MONGO_TEST_URI: 'mongodb://127.0.0.1:27017',
      MONGO_DB_NAME: 'diablo_management_alta58_review'
    }, run, [])).toBe(0)
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/^playwright(?:\.cmd)?$/),
      ['test', '--config', 'playwright.config.ts', 'tests/e2e/visitors-v2.pw.ts'],
      expect.objectContaining({
        env: expect.objectContaining({
          MONGO_TEST_URI: 'mongodb://127.0.0.1:27017',
          MONGO_URI: 'mongodb://127.0.0.1:27017',
          MONGO_DB_NAME: 'diablo_management_alta58_review'
        })
      })
    )
  })
})
