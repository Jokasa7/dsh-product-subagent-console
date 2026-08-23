import { basename, extname, relative } from 'node:path'
import { readFileSync } from 'node:fs'

const textExtensions = new Set(['.d.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml'])
const textBasenames = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'NOTICE'])

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

const repositoryRules = [
  [
    'a temporary attachment reference',
    /(?:pasted[-_]text\.[a-z0-9]+|(?:^|[-_])clipboard[-_][0-9a-f-]{16,}|(?:^|[\\/])\.[^\\/]+[\\/]attachments[\\/])/i,
  ],
  ['a non-project context export', /(?:^|\n)\s*(?:##\s+(?:my|user)\s+request\s*:|<[a-z][a-z0-9_-]*(?:context|plugins)\b)/im],
  ['an unresolved development marker', /(?:^|\W)(?:TODO|FIXME|HACK|WIP)(?:\W|$)/m],
  ['a private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['a credential-shaped token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{32,})/],
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

export function assertRepositoryTextFile(root, file) {
  assertPublicTextFile(root, file)
  const source = readFileSync(file, 'utf8')
  for (const [label, pattern] of repositoryRules) {
    const match = pattern.exec(source)
    if (match !== null) {
      throw new Error(`${relative(root, file)} contains ${label} on line ${lineAt(source, match.index)}`)
    }
  }
}

/** Reject camera/application metadata while allowing the deterministic JFIF marker. */
export function assertPublicJpeg(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`${file} is not a JPEG file`)
  }
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]
    offset += 2
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) throw new Error(`${file} contains a truncated JPEG marker`)
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) {
      throw new Error(`${file} contains an invalid JPEG marker length`)
    }
    if (marker === 0xe1 || marker === 0xfe) {
      throw new Error(`${file} contains disallowed EXIF/XMP/comment metadata`)
    }
    offset += length
  }
}
