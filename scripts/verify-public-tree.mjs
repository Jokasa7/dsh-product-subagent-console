import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPublicJpeg,
  assertPublicTextFile,
  assertRepositoryTextFile,
  isPublicTextPath,
} from './public-text-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})
if (listed.error !== undefined) throw listed.error
if (listed.status !== 0) throw new Error(`git ls-files failed (${String(listed.status)}): ${listed.stderr.trim()}`)

const paths = listed.stdout.split('\0')
  .filter(Boolean)
  .map(path => path.replaceAll('\\', '/'))
  .filter(path => existsSync(resolve(root, path)))
const forbiddenPaths = [
  /(?:^|\/)\.ai(?:\/|$)/i,
  /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i,
  /(?:^|\/)(?:work|outputs?|release|artifacts?)(?:\/|$)/i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)(?:design|dev|private)-notes?\.md$/i,
  /(?:^|\/)(?:pasted[-_]text[^/]*|(?:[^/]+[-_])?clipboard[-_][0-9a-f-]{16,}[^/]*)/i,
  /\.(?:log|tgz|zip)$/i,
]
const policySourcePaths = new Set([
  'scripts/public-text-policy.mjs',
  'scripts/verify-public-tree.mjs',
])

for (const path of paths) {
  if (forbiddenPaths.some(pattern => pattern.test(path))) {
    throw new Error(`tracked public tree contains a forbidden path: ${path}`)
  }
  const absolute = resolve(root, path)
  const fromRoot = relative(root, absolute)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
    throw new Error(`tracked path escapes the repository root: ${path}`)
  }
  if (isPublicTextPath(path) || ['.ts', '.tsx', '.css', '.mjs'].includes(extname(path))) {
    if (policySourcePaths.has(path)) assertPublicTextFile(root, absolute)
    else assertRepositoryTextFile(root, absolute)
  } else if (/\.jpe?g$/i.test(path)) {
    assertPublicJpeg(absolute)
  } else {
    throw new Error(`tracked public tree contains an unreviewed file type: ${path}`)
  }
}

for (const path of paths.filter(path => path.endsWith('.md'))) {
  const source = readFileSync(resolve(root, path), 'utf8')
  for (const match of source.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const raw = match[1]?.trim()
    if (raw === undefined || raw.length === 0 || /^(?:https?:|mailto:|#)/i.test(raw)) continue
    const target = decodeURIComponent(raw.split('#', 1)[0]?.split('?', 1)[0] ?? '')
    if (target.length === 0) continue
    const absolute = resolve(root, dirname(path), target)
    const fromRoot = relative(root, absolute)
    if (isAbsolute(target) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
      throw new Error(`${path} contains an external local Markdown path: ${raw}`)
    }
    try {
      readFileSync(absolute)
    } catch {
      throw new Error(`${path} contains a broken relative Markdown link: ${raw}`)
    }
  }
}

process.stdout.write(`public tree verified: ${String(paths.length)} tracked and unignored files\n`)
