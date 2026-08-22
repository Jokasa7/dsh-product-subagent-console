import {
  existsSync, lstatSync, readFileSync, realpathSync, rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const EXPECTED_PACKAGE = 'dsh-product-subagent-console'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = realpathSync.native(resolve(scriptDirectory, '..'))
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest.name !== EXPECTED_PACKAGE) {
  throw new Error(`refusing to clean an unexpected package: ${String(manifest.name)}`)
}

const target = resolve(root, 'lib')
const targetFromRoot = relative(root, target)
if (
  targetFromRoot !== 'lib'
  || isAbsolute(targetFromRoot)
  || targetFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  || dirname(target) !== root
  || basename(target) !== 'lib'
) {
  throw new Error(`refusing an unexpected clean target: ${target}`)
}

if (!existsSync(target)) process.exit(0)

const targetStat = lstatSync(target)
if (targetStat.isSymbolicLink()) {
  throw new Error(`refusing to recursively remove a linked path: ${target}`)
}

const realTarget = realpathSync.native(target)
if (dirname(realTarget) !== root || basename(realTarget) !== 'lib') {
  throw new Error(`refusing to clean a path outside the package root: ${realTarget}`)
}

rmSync(target, { recursive: true, force: false, maxRetries: 3 })
