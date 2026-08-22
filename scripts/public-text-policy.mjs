import { basename, extname, relative } from 'node:path'
import { readFileSync } from 'node:fs'

const textExtensions = new Set(['.d.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml'])
const textBasenames = new Set(['LICENSE', 'NOTICE'])

const genericRules = [
  ['a bundler debug region', /^\s*\/\/#(?:end)?region\b/m],
  ['a Windows absolute path', /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/])/m],
  ['a UNC path', /(?:^|[\s"'(=])\\{2,}[A-Za-z0-9.$_-]+[\\/]/m],
  ['a local file URL', /file:\/{3}(?:[A-Za-z]:|home\/|Users\/|root\/)/i],
  [
    'a local or CI POSIX path',
    /(?:^|[\s"'(=])\/(?:home\/[^/\s"'<>]+|Users\/[^/\s"'<>]+|root|github\/workspace|workspace|builds|__w|runner\/_work|opt\/hostedtoolcache|tmp|private\/tmp|var\/folders)\//m,
  ],
]

export function isPublicTextPath(path) {
  const name = basename(path)
  return textBasenames.has(name) || path.endsWith('.d.ts') || textExtensions.has(extname(path))
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length
}

export function assertPublicTextFile(root, file) {
  const source = readFileSync(file, 'utf8')
  const rootVariants = new Set([
    root,
    root.replaceAll('\\', '/'),
    JSON.stringify(root).slice(1, -1),
  ])
  for (const value of rootVariants) {
    if (value.length < 3) continue
    const index = source.indexOf(value)
    if (index !== -1) {
      throw new Error(`${relative(root, file)} contains the build root on line ${lineAt(source, index)}`)
    }
  }
  for (const [label, pattern] of genericRules) {
    const match = pattern.exec(source)
    if (match !== null) {
      throw new Error(`${relative(root, file)} contains ${label} on line ${lineAt(source, match.index)}`)
    }
  }
}
