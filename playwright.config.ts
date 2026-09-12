import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const buildSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const baseURL = 'http://127.0.0.1:3105'

process.env.PLAYWRIGHT_EXPECTED_SHA = buildSha

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.pw.ts',
  fullyParallel: false,
  timeout: 30_000,
  webServer: {
    command: 'node scripts/run-responsive-preview.mjs',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '3105',
      PLAYWRIGHT_EXPECTED_SHA: buildSha
    },
    reuseExistingServer: false,
    timeout: 180_000,
    url: `${baseURL}/api/build-info`
  },
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined
  }
})
