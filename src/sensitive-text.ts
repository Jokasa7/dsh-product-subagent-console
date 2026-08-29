const LOCAL_POSIX_ROOTS = 'Users|home|root|etc|var|tmp|mnt|opt|workspace|srv|usr|private|Volumes|dev|secret|run|nix|work|code|proc|sys'
const AMBIGUOUS_POSIX_ROOTS = 'app|data|project'
const LOCAL_PATH_BODY = String.raw`(?:[^\s<>"'\x60,;(){}\[\]=]+|[ \t]+(?=[^\\/\r\n<>"'\x60,;(){}\[\]=]*[\\/]))*`

function credentialPattern(global: boolean): RegExp {
  return new RegExp([
    String.raw`\b(?:sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{8,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,})\b`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`,
    String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*`,
    String.raw`-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----`,
    String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/[^/\s:@]+:[^@\s/]+@`,
    String.raw`\b(?:[A-Za-z0-9]+[_-])*(?:api[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|secret[\s_-]?access[\s_-]?key|password|credential|secret|token)\b(?:\\?["'])?\s*[:=]\s*(?:\\?"(?:\\.|[^"\\])*\\?"|\\?'(?:\\.|[^'\\])*\\?'|[^\s,"'<>}\]]+)`,
  ].join('|'), global ? 'giu' : 'iu')
}

function privateKeyBlockPattern(global: boolean): RegExp {
  return new RegExp(
    String.raw`-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)`,
    global ? 'giu' : 'iu',
  )
}

function windowsPathPattern(global: boolean): RegExp {
  return new RegExp(
    String.raw`(^|[\s"'(\[=:;\x60])(?:[A-Za-z]:[\\/]|\\\\)${LOCAL_PATH_BODY}`,
    global ? 'gium' : 'ium',
  )
}

function posixPathPattern(global: boolean): RegExp {
  return new RegExp(
    String.raw`(^|[\s"'(\[=:;\x60])(?:\/(?:${LOCAL_POSIX_ROOTS})(?:\/${LOCAL_PATH_BODY})?|\/(?:${AMBIGUOUS_POSIX_ROOTS})\/(?=[^\s<>"'\x60,;(){}\[\]=]*(?:\/|\.[A-Za-z0-9]))${LOCAL_PATH_BODY})`,
    global ? 'gum' : 'um',
  )
}

function fileUrlPathPattern(global: boolean): RegExp {
  return new RegExp(
    String.raw`\bfile:\/{2,3}(?:[A-Za-z]:[\\/]|(?:(?:${LOCAL_POSIX_ROOTS})|(?:${AMBIGUOUS_POSIX_ROOTS}))(?=\/|[\s<>"'\x60,;)}\]]|$))${LOCAL_PATH_BODY}`,
    global ? 'giu' : 'iu',
  )
}

function withoutHttpRoutes(value: string): string {
  return value.replace(
    /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*/gu,
    '',
  )
}

/** Return true when shareable user-authored text contains a recognizable credential or local absolute path. */
export function containsSensitiveText(value: string): boolean {
  const pathCandidate = withoutHttpRoutes(value)
  return privateKeyBlockPattern(false).test(value)
    || credentialPattern(false).test(value)
    || windowsPathPattern(false).test(pathCandidate)
    || posixPathPattern(false).test(pathCandidate)
    || fileUrlPathPattern(false).test(pathCandidate)
}

/** Recursively inspect string leaves so JSON escaping cannot hide sensitive content. */
export function containsSensitiveValue(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return containsSensitiveText(value)
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => containsSensitiveValue(item, seen))
  return Object.entries(value).some(([key, item]) => {
    if (sensitiveFieldName(key) && containsSensitiveFieldValue(item)) return true
    return containsSensitiveValue(item, seen)
  })
}

function sensitiveFieldName(value: string): boolean {
  return /^(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?access[_-]?key|password|credential|secret|token)$/iu.test(value)
}

function containsSensitiveFieldValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return false
  if (Array.isArray(value)) return value.some(item => typeof item === 'string' && item.trim().length > 0)
  if (typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => (
    /^(?:default|const|example|examples|enum|value)$/iu.test(key)
    && containsSensitiveFieldValue(item)
  ))
}

/** Redact recognizable credentials and local absolute paths while preserving surrounding prose. */
export function redactSensitiveText(value: string): string {
  const pathCandidate = withoutHttpRoutes(value)
  const hasCredential = privateKeyBlockPattern(false).test(value) || credentialPattern(false).test(value)
  const hasPath = windowsPathPattern(false).test(pathCandidate)
    || posixPathPattern(false).test(pathCandidate)
    || fileUrlPathPattern(false).test(pathCandidate)
  if (!hasCredential && !hasPath) return value
  return [
    ...(hasCredential ? ['[redacted credential]'] : []),
    ...(hasPath ? ['[redacted path]'] : []),
  ].join(' ')
}
