import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { assertPublicJpeg, assertPublicTextFile, isPublicTextPath } from './public-text-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-product-subagent-console') {
  throw new Error(`refusing to inspect an unexpected package: ${String(manifest.name)}`)
}

const npmExecPath = process.env.npm_execpath
if (npmExecPath === undefined || !npmExecPath.toLowerCase().includes('pnpm')) {
  throw new Error('verify-pack must run through pnpm so the pinned package manager is used')
}

const packDirectory = mkdtempSync(join(tmpdir(), 'dsh-product-subagent-console-pack-'))
let report
let compressedSize
try {
  const packed = spawnSync(
    process.execPath,
    [
      npmExecPath,
      'pack',
      '--json',
      '--pack-destination',
      packDirectory,
      '--config.ignore-scripts=true',
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
  if (packed.error !== undefined) throw packed.error
  if (packed.status !== 0) {
    throw new Error(`pnpm pack failed (${packed.status}): ${packed.stderr.trim()}`)
  }
  try {
    report = JSON.parse(packed.stdout)
  } catch (error) {
    throw new Error(`pnpm pack did not return valid JSON: ${packed.stdout.slice(0, 500)}`, { cause: error })
  }
  const reportEntry = Array.isArray(report) ? report[0] : report
  if (reportEntry === undefined || typeof reportEntry.filename !== 'string') {
    throw new Error('pnpm pack JSON did not identify the tarball')
  }
  const tarball = resolve(packDirectory, basename(reportEntry.filename))
  const fromPackDirectory = relative(packDirectory, tarball)
  if (isAbsolute(fromPackDirectory) || fromPackDirectory.startsWith('..')) {
    throw new Error(`pnpm pack returned an external tarball path: ${reportEntry.filename}`)
  }
  compressedSize = statSync(tarball).size
} finally {
  rmSync(packDirectory, { recursive: true, force: true, maxRetries: 3 })
}
const entry = Array.isArray(report) ? report[0] : report
if (entry === undefined || !Array.isArray(entry.files)) {
  throw new Error('pnpm pack JSON did not contain a file inventory')
}

const paths = entry.files.map(file => String(file.path).replaceAll('\\', '/'))
const normalized = paths.map(path => path.startsWith('package/') ? path.slice('package/'.length) : path)
const caseFolded = normalized.map(path => path.toLowerCase())
if (new Set(caseFolded).size !== caseFolded.length) {
  throw new Error('tarball contains duplicate paths after case folding')
}
if (normalized.some(path => path === '' || path.startsWith('/') || path.includes('\\'))) {
  throw new Error('tarball contains a non-canonical path')
}

// Every relative runtime import in the packed JavaScript must remain inside the
// tarball. This catches generated shared chunks that are present in lib/ after
// build but accidentally omitted by package.json's files allowlist.
const packedPaths = new Set(normalized)
for (const importerPath of normalized.filter(path => /^lib\/.*\.m?js$/.test(path))) {
  const source = readFileSync(resolve(root, importerPath), 'utf8')
  for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
    if (specifier === undefined || !specifier.startsWith('.')) continue
    const importer = resolve(root, importerPath)
    const candidate = resolve(dirname(importer), specifier)
    const candidates = [candidate, `${candidate}.js`, `${candidate}.mjs`, resolve(candidate, 'index.js')]
    const target = candidates.find(file => {
      const path = relative(root, file).replaceAll('\\', '/')
      return packedPaths.has(path)
    })
    if (target === undefined) {
      throw new Error(`tarball omits runtime import ${specifier} from ${importerPath}`)
    }
  }
}

const required = [
  'package.json',
  'lib/index.js',
  'lib/tool.js',
  'lib/invariant.js',
  'lib/planner.js',
  'lib/plan-tool.js',
  'lib/types.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'lib/types/tool.d.ts',
  'lib/types/invariant.d.ts',
  'lib/types/planner.d.ts',
  'lib/types/plan-tool.d.ts',
  'lib/types/types.d.ts',
  'lib/types/client/index.d.ts',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'docs/getting-started.md',
  'docs/getting-started.zh.md',
  'docs/agent-planner.md',
  'docs/agent-planner.zh.md',
  'docs/troubleshooting.md',
  'docs/troubleshooting.zh.md',
  'docs/assets/agent-runtime-en.jpg',
  'docs/assets/agent-plan-en.jpg',
  'docs/assets/agent-compare-en.jpg',
  'docs/assets/agent-runtime-zh.jpg',
  'docs/assets/agent-plan-zh.jpg',
  'docs/assets/agent-compare-zh.jpg',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
]
for (const path of required) {
  if (!normalized.includes(path)) throw new Error(`tarball is missing required file: ${path}`)
}

const allowedRootFiles = new Set([
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
])
for (const path of normalized) {
  const absolute = resolve(root, path)
  const fromRoot = relative(root, absolute)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
    throw new Error(`tarball path escapes the package root: ${path}`)
  }
  const allowed = allowedRootFiles.has(path)
    || path.startsWith('lib/')
    || /^docs\/assets\/agent-(?:runtime|plan|compare)-(?:en|zh)\.jpg$/.test(path)
    || /^(?:docs\/(?:agent-planner|getting-started|troubleshooting)(?:\.zh)?\.md)$/.test(path)
  if (!allowed) throw new Error(`tarball contains a non-publishable path: ${path}`)
  if (path.endsWith('.map')) throw new Error(`tarball contains a source map: ${path}`)
  if (/(?:^|\/)(?:\.env(?:\.|$)|src|tests?|scripts|node_modules)(?:\/|$)/i.test(path)) {
    throw new Error(`tarball contains development or sensitive material: ${path}`)
  }
}

for (const path of normalized) {
  if (isPublicTextPath(path)) assertPublicTextFile(root, resolve(root, path))
}

if (compressedSize > 2_000_000) {
  throw new Error(`tarball exceeds the 2 MB compressed safety budget: ${compressedSize}`)
}

for (const asset of [
  'docs/assets/agent-runtime-en.jpg',
  'docs/assets/agent-plan-en.jpg',
  'docs/assets/agent-compare-en.jpg',
  'docs/assets/agent-runtime-zh.jpg',
  'docs/assets/agent-plan-zh.jpg',
  'docs/assets/agent-compare-zh.jpg',
]) {
  assertPublicJpeg(resolve(root, asset))
}

const publishedManifest = entry.files.find(file => {
  const path = String(file.path).replaceAll('\\', '/')
  return path === 'package.json' || path === 'package/package.json'
})
if (publishedManifest === undefined) throw new Error('tarball inventory omitted package.json')

for (const field of ['main', 'types']) {
  const target = manifest[field]
  if (typeof target === 'string' && !normalized.includes(target.replace(/^\.\//, ''))) {
    throw new Error(`tarball does not close package.json ${field}: ${target}`)
  }
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(exportTargets)
}
for (const target of exportTargets(manifest.exports)) {
  if (!target.startsWith('./')) continue
  if (!normalized.includes(target.slice(2))) {
    throw new Error(`tarball does not close package.json exports target: ${target}`)
  }
}

process.stdout.write(`${manifest.name}@${manifest.version}: ${normalized.length} files, ${compressedSize} bytes\n`)
