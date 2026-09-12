import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(import.meta.url)
const [mode, markerPath, ...ancestorPids] = process.argv.slice(2)

if (mode === 'root') {
  spawn(process.execPath, [fixturePath, 'intermediate', markerPath, String(process.pid)], {
    stdio: 'ignore',
    windowsHide: true
  }).unref()
} else if (mode === 'intermediate') {
  spawn(process.execPath, [fixturePath, 'grandchild', markerPath, ...ancestorPids, String(process.pid)], {
    stdio: 'ignore',
    windowsHide: true
  }).unref()
} else if (mode === 'grandchild') {
  while (ancestorPids.some(pid => processIsRunning(Number(pid)))) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  writeFileSync(markerPath, String(process.pid), 'utf8')
  setInterval(() => {}, 1_000)
} else {
  throw new Error(`Unknown Windows Job Object fixture mode: ${mode}`)
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
