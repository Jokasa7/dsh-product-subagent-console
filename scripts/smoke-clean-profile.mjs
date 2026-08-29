import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-product-subagent-console'
const expectedDshVersion = '0.1.1-rc.2'
const tempPrefix = 'dsh-product-subagent-console-smoke-'
const outputLimit = 2 * 1024 * 1024

function parseArguments(argv) {
  let packagePath
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument !== '--package') throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error('--package requires a path')
    packagePath = resolve(root, value)
    index += 1
  }
  return { packagePath }
}

function appendBounded(current, chunk) {
  const next = current + String(chunk)
  return next.length <= outputLimit ? next : next.slice(next.length - outputLimit)
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: outputLimit,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `command failed (${String(result.status)}): ${command} ${args.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'))
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function runPnpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath !== undefined && existsSync(npmExecPath)) {
    return commandResult(process.execPath, [npmExecPath, ...args], options)
  }
  return commandResult(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options)
}

function resolveDshBin() {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = require(manifestPath)
  assert.equal(manifest.version, expectedDshVersion, 'the smoke must use the supported DSH version')
  assert.equal(typeof manifest.bin?.dsh, 'string', 'the DSH package must expose bin.dsh')
  return resolve(dirname(manifestPath), manifest.bin.dsh)
}

function smokeEnvironment(home, agentsHome, inherited = {}) {
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'dsh-loader-smoke-no-network',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

function installEnvironment(home, agentsHome) {
  return smokeEnvironment(home, agentsHome, process.env)
}

function runtimeEnvironment(home, agentsHome) {
  const allowed = new Set([
    'COLORTERM', 'COMSPEC', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'WINDIR',
  ])
  const inherited = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && allowed.has(key.toUpperCase()),
  ))
  return smokeEnvironment(home, agentsHome, inherited)
}

async function waitForWebUrl(child, state, timeoutMs = 60_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const match = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+))\r?$/mu.exec(state.stdout)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const port = Number(match[2])
      assert.equal(Number.isInteger(port) && port >= 1 && port <= 65_535, true, 'dsh web returned an invalid port')
      assert.doesNotMatch(`${state.stdout}\n${state.stderr}`, /opening the default browser/u)
      return match[1]
    }
    if (child.exitCode !== null) {
      throw new Error(`dsh web exited before startup (${String(child.exitCode)})\n${state.stdout}\n${state.stderr}`)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for dsh web\n${state.stdout}\n${state.stderr}`)
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    if (result.status !== 0 && child.exitCode === null) child.kill('SIGTERM')
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 10_000)),
  ])
  if (stopped) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  } else if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
  await Promise.race([
    exited,
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
}

async function safeRemoveTemp(path) {
  const resolvedTemp = resolve(tmpdir())
  const resolvedPath = resolve(path)
  assert.equal(basename(resolvedPath).startsWith(tempPrefix), true, 'refusing to remove an unexpected directory')
  assert.equal(resolvedPath.startsWith(`${resolvedTemp}${sep}`), true, 'temporary directory escaped the OS temp root')
  await rm(resolvedPath, { recursive: true, force: true, maxRetries: 3 })
}

async function packCurrentSource(destination) {
  runPnpm(['run', 'build:artifacts'])
  runPnpm([
    'pack',
    '--pack-destination', destination,
    '--config.ignore-scripts=true',
  ])
  const packages = (await readdir(destination)).filter(name => name.endsWith('.tgz'))
  assert.deepEqual(packages.length, 1, `expected one package, found ${String(packages.length)}`)
  return join(destination, packages[0])
}

async function validateSuppliedPackage(path) {
  assert.equal(existsSync(path), true, `package does not exist: ${path}`)
  const archive = await realpath(path)
  const releaseRoot = resolve(root, 'release')
  const fromRelease = relative(releaseRoot, archive)
  assert.equal(
    isAbsolute(fromRelease) || fromRelease === '..' || fromRelease.startsWith(`..${sep}`),
    false,
    'a supplied smoke package must be inside this repository release directory',
  )
  assert.match(
    basename(archive),
    /^dsh-product-subagent-console-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\.tgz$/u,
    'the supplied smoke package has an unexpected filename',
  )
  return archive
}

async function validateInstalledProfile(home, sourceRoot) {
  const profileDir = join(home, 'profiles', 'web')
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  const dependency = manifest.dependencies?.[packageName]
  assert.equal(typeof dependency, 'string', 'profile manifest is missing the plugin dependency')
  assert.match(dependency, /\.tgz(?:$|#)/u, 'profile dependency must point to a packed tarball')
  assert.deepEqual(manifest.dsh?.profile?.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    packageName,
  ], 'the clean Web profile has an unexpected bundle stack')

  const installedPath = await realpath(join(profileDir, 'node_modules', packageName))
  const installedRelative = relative(await realpath(profileDir), installedPath)
  assert.equal(installedRelative.startsWith('..') || isAbsolute(installedRelative), false, 'installed plugin escaped the clean profile')
  assert.notEqual(await realpath(sourceRoot), installedPath, 'the smoke must not install a source checkout link')
  const installedManifest = JSON.parse(await readFile(join(installedPath, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, packageName)
  assert.equal(installedManifest.dsh?.bundle?.patch, './cordis.patch.yml')
  for (const path of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.equal(existsSync(join(installedPath, path)), true, `packed plugin is missing ${path}`)
  }
  const workspace = await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /^nodeLinker:\s*hoisted\s*$/mu)
  assert.match(workspace, /^autoInstallPeers:\s*false\s*$/mu)
  return profileDir
}

function dumpRow(text, id) {
  const marker = `- id: ${id}`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `dump is missing ${id}`)
  const tail = text.slice(start + marker.length)
  const next = tail.search(/\n(?=(?:- id: |# == ))/u)
  return marker + (next === -1 ? tail : tail.slice(0, next))
}

async function launchSmokeBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    if (
      process.platform !== 'win32'
      || !(error instanceof Error)
      || !error.message.includes('Executable doesn\'t exist')
    ) throw error

    const fallbackErrors = []
    for (const channel of ['chrome', 'msedge']) {
      try {
        return await chromium.launch({ headless: true, channel })
      } catch (fallbackError) {
        fallbackErrors.push(`${channel}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
      }
    }
    throw new Error(`no supported smoke-test browser is available\n${fallbackErrors.join('\n')}`, { cause: error })
  }
}

async function validateBrowser(webUrl) {
  const origin = new URL(webUrl).origin
  const externalRequests = []
  const consoleErrors = []
  const pageErrors = []
  let pluginAsset
  const browser = await launchSmokeBrowser()
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url())
      if ((requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') && requestUrl.origin !== origin) {
        externalRequests.push(requestUrl.href)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    const page = await context.newPage()
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => { pageErrors.push(error.message) })
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname === `/plugins/${packageName}/client.js`) {
        pluginAsset = {
          status: response.status(),
          contentType: response.headers()['content-type'] ?? '',
          url: response.url(),
        }
      }
    })

    await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForFunction(() => document.querySelector('[data-dsh-boot]') === null, undefined, { timeout: 45_000 })
    const bootEntries = await page.evaluate(() => {
      const boot = globalThis.__DSH_BOOT__
      return typeof boot === 'object' && boot !== null && Array.isArray(boot.entries)
        ? boot.entries
        : []
    })
    assert.equal(
      bootEntries.some(entry => JSON.stringify(entry).includes(packageName)),
      true,
      'window.__DSH_BOOT__.entries is missing the plugin',
    )
    assert.notEqual(pluginAsset, undefined, 'the browser did not request the plugin client bundle')
    assert.equal(pluginAsset.status, 200, 'the plugin client bundle did not return HTTP 200')
    assert.match(pluginAsset.contentType, /(?:java|ecma)script/iu, 'the plugin bundle has an unexpected Content-Type')
    assert.deepEqual(externalRequests, [], 'the Loader smoke attempted an external browser request')
    assert.deepEqual(pageErrors, [], 'the page emitted an uncaught error')
    assert.deepEqual(consoleErrors, [], 'the page emitted a console error')
    await context.close()
    return { pluginAssetUrl: pluginAsset.url, bootEntries: bootEntries.length }
  } finally {
    await browser.close()
  }
}

const { packagePath: suppliedPackage } = parseArguments(process.argv.slice(2))
const tempRoot = await mkdtemp(join(tmpdir(), tempPrefix))
const packageDir = join(tempRoot, 'package')
const home = join(tempRoot, 'home')
const agentsHome = join(tempRoot, 'agents')
const neutralCwd = join(tempRoot, 'cwd')
await Promise.all([mkdir(packageDir), mkdir(agentsHome), mkdir(neutralCwd)])

let webProcess
try {
  const archive = suppliedPackage === undefined
    ? await packCurrentSource(packageDir)
    : await validateSuppliedPackage(suppliedPackage)
  assert.equal(existsSync(archive), true, `package does not exist: ${archive}`)
  assert.equal(archive.endsWith('.tgz'), true, 'the smoke package must be a .tgz archive')

  const dshBin = resolveDshBin()
  const installEnv = installEnvironment(home, agentsHome)
  const runtimeEnv = runtimeEnvironment(home, agentsHome)
  const version = commandResult(process.execPath, [dshBin, '--version'], {
    cwd: neutralCwd,
    env: runtimeEnv,
  }).trim()
  assert.equal(version, expectedDshVersion)

  commandResult(process.execPath, [
    dshBin,
    'plugin', '--profile', 'web',
    'add', '--ignore-scripts', '--reporter=append-only', archive,
  ], { cwd: neutralCwd, env: installEnv })
  await validateInstalledProfile(home, root)

  const dump = commandResult(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], {
    cwd: neutralCwd,
    env: runtimeEnv,
  })
  assert.match(dump, /^# == dsh-product-subagent-console\r?$/mu)
  const consoleRow = dumpRow(dump, 'product-subagent-console')
  assert.match(consoleRow, /^  name: dsh-product-subagent-console\r?$/mu)
  const workerRow = dumpRow(dump, 'workflow-worker-thread')
  assert.match(workerRow, /^  name: ['"]?@deepseek-ai\/dsh-workflow-worker-thread['"]?\r?$/mu)
  assert.match(workerRow, /^  disabled: false\r?$/mu)
  assert.match(workerRow, /^    provider: spawn\r?$/mu)

  const state = { stdout: '', stderr: '' }
  webProcess = spawn(process.execPath, [
    dshBin,
    'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], {
    cwd: neutralCwd,
    env: runtimeEnv,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  webProcess.stdout?.on('data', chunk => { state.stdout = appendBounded(state.stdout, chunk) })
  webProcess.stderr?.on('data', chunk => { state.stderr = appendBounded(state.stderr, chunk) })
  const webUrl = await waitForWebUrl(webProcess, state)
  const browserEvidence = await validateBrowser(webUrl)
  process.stdout.write(`${JSON.stringify({
    dshVersion: version,
    package: basename(archive),
    profile: 'web',
    webOrigin: new URL(webUrl).origin,
    ...browserEvidence,
  })}\n`)
} finally {
  if (webProcess !== undefined) await stopProcess(webProcess)
  await safeRemoveTemp(tempRoot)
}
