import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPublicTextFile, isPublicTextPath } from './public-text-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libRoot = resolve(root, 'lib')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const versionSource = readFileSync(resolve(root, 'src/version.ts'), 'utf8')
const productVersion = versionSource.match(/PRODUCT_VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1]

if (manifest.name !== 'dsh-product-subagent-console') {
  throw new Error(`refusing to verify an unexpected package: ${String(manifest.name)}`)
}
if (productVersion === undefined || productVersion !== manifest.version) {
  throw new Error(`package version ${String(manifest.version)} does not match PRODUCT_VERSION ${String(productVersion)}`)
}

const required = [
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
]
for (const relative of required) {
  const file = resolve(root, relative)
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`missing distribution artifact: ${relative}`)
  }
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function isInside(directory, candidate) {
  const path = relative(directory, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function resolveRuntimeImport(importer, specifier) {
  const candidate = resolve(dirname(importer), specifier)
  if (!isInside(libRoot, candidate)) {
    throw new Error(`${relative(root, importer)} imports outside lib: ${specifier}`)
  }
  const candidates = [candidate, `${candidate}.js`, resolve(candidate, 'index.js')]
  const match = candidates.find(file => existsSync(file) && statSync(file).isFile())
  if (match === undefined) {
    throw new Error(`${relative(root, importer)} has an unpacked runtime import: ${specifier}`)
  }
}

const jsFiles = filesUnder(libRoot).filter(file => file.endsWith('.js') || file.endsWith('.mjs'))
const publicTextFiles = filesUnder(libRoot).filter(isPublicTextPath)
for (const file of [
  ...publicTextFiles,
  resolve(root, 'package.json'),
  resolve(root, 'cordis.patch.yml'),
]) {
  assertPublicTextFile(root, file)
}
const runtimeDependencies = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])
function packageName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('sourceMappingURL=')) {
    throw new Error(`${relative(root, file)} references a source map`)
  }
  if (/\b(?:workspace:|file:|link:)/.test(source)) {
    throw new Error(`${relative(root, file)} contains a workspace-local dependency specifier`)
  }
  const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)
  for (const [, specifier] of imports) {
    if (specifier?.startsWith('.')) {
      resolveRuntimeImport(file, specifier)
      continue
    }
    if (
      specifier !== undefined
      && file !== resolve(root, 'lib/client.js')
      && !specifier.startsWith('node:')
      && !isBuiltin(specifier)
      && !runtimeDependencies.has(packageName(specifier))
    ) {
      throw new Error(`${relative(root, file)} imports an undeclared runtime package: ${specifier}`)
    }
  }
}

const clientPath = resolve(root, 'lib/client.js')
const client = readFileSync(clientPath, 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('lib/client.js is not a DSH lazy-CJS module')
}
if (statSync(clientPath).size > 1_500_000) {
  throw new Error(`lib/client.js exceeds the 1.5 MB uncompressed safety budget: ${statSync(clientPath).size}`)
}

const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])
for (const [, specifier] of client.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
  if (specifier === undefined || specifier.startsWith('.')) continue
  if (specifier.startsWith('node:') || isBuiltin(specifier)) {
    throw new Error(`browser client imports a Node.js builtin: ${specifier}`)
  }
  if (!clientExternals.has(specifier)) {
    throw new Error(`browser client has an undeclared external dependency: ${specifier}`)
  }
}
for (const forbidden of [
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bprocess\.(?:cwd|env|platform|versions)\b/,
  /\bBuffer\.(?:from|alloc|allocUnsafe|isBuffer)\b/,
]) {
  if (forbidden.test(client)) {
    throw new Error(`browser client contains a Node.js runtime reference: ${String(forbidden)}`)
  }
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(exportTargets)
}

const publishedTargets = new Set([
  manifest.main,
  manifest.types,
  ...exportTargets(manifest.exports),
  manifest.dsh?.bundle?.patch,
].filter(value => typeof value === 'string' && value.startsWith('./')))
for (const target of publishedTargets) {
  const file = resolve(root, target)
  if (!isInside(root, file) || !existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`package metadata points at a missing or external file: ${target}`)
  }
}

const manifestText = JSON.stringify(manifest)
if (/\b(?:workspace:|file:|link:)/.test(manifestText)) {
  throw new Error('package.json contains a workspace-local dependency specifier')
}
