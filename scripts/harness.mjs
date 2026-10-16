import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const engine = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../deepseek-harness/package.json', import.meta.url), 'utf8'))
const upstream = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))
const [action, ...extra] = process.argv.slice(2)
const toolchainBin = fileURLToPath(new URL('../node_modules/.toolchain/node_modules/.bin/', import.meta.url))
const localNode = `${toolchainBin}/node`
if (existsSync(localNode)) process.env.PATH = `${toolchainBin}${delimiter}${process.env.PATH ?? ''}`

async function run(command, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let output = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`))
    })
  })
}

try {
  if (action === 'check') {
    const commit = await run('git', ['rev-parse', 'HEAD'], engine, true)
    const status = await run('git', ['status', '--porcelain'], engine, true)
    const remote = await run('git', ['remote', 'get-url', 'origin'], engine, true)
    if (commit !== upstream.commit || manifest.version !== upstream.version || status || remote !== upstream.repository) {
      throw new Error('Official engine must be clean and match upstream.json (commit, version, and repository).')
    }
    const product = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (product.packageManager !== manifest.packageManager) throw new Error('Package manager differs from the official engine.')
    for (const script of Object.values(product.scripts)) {
      const prefix = 'node scripts/harness.mjs '
      if (!script.startsWith(prefix)) continue
      const target = script.slice(prefix.length)
      if (!['check', 'install'].includes(target) && !manifest.scripts[target]) throw new Error(`Missing upstream script: ${target}`)
    }
    const pin = await run('git', ['ls-files', '--stage', '--', 'deepseek-harness'], root, true)
    if (!pin.startsWith('160000 ')) throw new Error('deepseek-harness must remain a Git submodule.')
    console.log(`Official Harness ${upstream.version} at ${commit}; clean checkout, valid desktop entry points.`)
  } else if (action === 'install' || Object.hasOwn(manifest.scripts, action ?? '')) {
    const args = action === 'install' ? ['pnpm', 'install', '--frozen-lockfile', ...extra] : ['pnpm', 'run', action, ...extra]
    const localCorepack = fileURLToPath(new URL('../node_modules/.toolchain/node_modules/corepack/dist/corepack.js', import.meta.url))
    if (existsSync(localCorepack)) await run(existsSync(localNode) ? localNode : process.execPath, [localCorepack, ...args], engine)
    else await run('corepack', args, engine)
  } else {
    throw new Error('Use npm run setup/build/dev/start/check or a documented packaging command.')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
