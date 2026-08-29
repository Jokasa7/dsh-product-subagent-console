import { describe, expect, it } from 'vitest'
import {
  containsSensitiveText,
  containsSensitiveValue,
  redactSensitiveText,
} from '../src/sensitive-text.js'

describe('shareable text privacy scanner', () => {
  it('detects high-confidence credentials and local paths', () => {
    const dangerous = [
      ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
      ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
      ['gho', '1234567890abcdefghijklmnop'].join('_'),
      ['ghu', '1234567890abcdefghijklmnop'].join('_'),
      ['ghs', '1234567890abcdefghijklmnop'].join('_'),
      ['ghr', '1234567890abcdefghijklmnop'].join('_'),
      ['glpat', '1234567890abcdefghijklmnop'].join('-'),
      ['AIza', '1234567890abcdefghijklmnopqrstuv'].join(''),
      ['npm', '1234567890abcdefghijklmnop'].join('_'),
      ['sk', 'live', '1234567890abcdefghijklmnop'].join('_'),
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      ['postgresql://user:', 'plain-private-value', '@db.example.test/app'].join(''),
      `${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=plain-private-value`,
      ['C:', 'project', 'private.txt'].join('/'),
      ['', 'home', 'Example', 'private.txt'].join('/'),
      ['', 'run', 'secrets', 'provider-token'].join('/'),
      ['', 'nix', 'store', 'private-build-input'].join('/'),
      ['', 'app', 'config', 'credentials.json'].join('/'),
      ['', 'work', 'repository', '.env'].join('/'),
      ['', 'code', 'project', 'private.pem'].join('/'),
      ['', 'proc', 'self', 'environ'].join('/'),
      ['', 'sys', 'kernel', 'private-value'].join('/'),
      ['file:', '', '', 'secret'].join('/'),
      `Inspect ${['file:', '', '', 'secret'].join('/')}, then continue.`,
    ]
    for (const value of dangerous) {
      expect(containsSensitiveText(value)).toBe(true)
      expect(redactSensitiveText(value)).not.toContain(value)
    }
  })

  it('does not treat budgets, API routes, health routes, or schema field declarations as secrets', () => {
    for (const value of [
      'token_budget=5000',
      'token_count=12',
      '/api/v1/users',
      '/health/check',
      'GET /users/123',
      'GET /app/settings/profile',
      'POST /data/export/report',
      'PATCH /project/42/tasks',
      '/app/settings',
      '/data/export',
      '/project/42',
      'https://example.test/api/v1/users',
      'password_policy=strict',
      'api_key_required=false',
      'secret_count=0',
      'access_token_limit=100',
    ]) expect(containsSensitiveText(value)).toBe(false)

    const field = ['api', 'key'].join('_')
    expect(containsSensitiveValue({
      type: 'object', properties: { [field]: { type: 'string', description: 'Provided at runtime' } },
    })).toBe(false)
    expect(containsSensitiveValue({
      type: 'object', properties: { [field]: { type: 'string', default: 'plain-private-value' } },
    })).toBe(true)
    expect(containsSensitiveValue({ password_policy: 'strict', api_key_required: false })).toBe(false)
  })

  it('redacts complete private blocks, quoted secret phrases, and local paths containing spaces', () => {
    const privateBlock = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'private-payload-line',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n')
    const password = ['password', '"very secret phrase"'].join('=')
    const path = ['C:', 'Users', 'Example', 'Private Folder', 'secret.txt'].join('\\')
    const redacted = redactSensitiveText([privateBlock, password, path].join('\n'))

    expect(redacted).not.toContain('private-payload-line')
    expect(redacted).not.toContain('very secret phrase')
    expect(redacted).not.toContain('Private Folder')
    expect(redacted).toContain('[redacted credential]')
    expect(redacted).toContain('[redacted path]')
  })

  it('never leaves a final path segment behind when a local filename contains spaces', () => {
    for (const value of [
      ['C:', 'Users', 'Example', 'secret file.txt'].join('\\'),
      ['', 'home', 'Example', 'secret file.txt'].join('/'),
      ['file:', '', '', 'home', 'Example', 'secret file.txt'].join('/'),
    ]) {
      expect(containsSensitiveText(value)).toBe(true)
      expect(redactSensitiveText(value)).toBe('[redacted path]')
    }
  })
})
