import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Local launch settings contain machine-specific environment, never committed credentials.
const root = fileURLToPath(new URL('../', import.meta.url))
const settingsPath = `${root}.local/web/launch.json`
if (!existsSync(settingsPath)) {
  console.error('Missing .local/web/launch.json; see README for local Web configuration.')
  process.exit(1)
}
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
const child = spawn(process.execPath, [
  `${root}scripts/harness.mjs`, 'start:web',
  '--patch', `${root}.local/web/router.overlay.yml`,
  '--no-open', '--port', '3080', ...process.argv.slice(2),
], {
  cwd: root,
  env: { ...process.env, ...settings.env, DSH_HOME: `${root}.local/web/home` },
  stdio: 'inherit',
})
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
