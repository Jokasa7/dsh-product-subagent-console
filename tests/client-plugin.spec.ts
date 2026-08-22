// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.js'
import { NS } from '../src/client/locales.js'
import {
  SubagentWorkbenchView, type SubagentWorkbenchInjected,
} from '../src/client/SubagentWorkbenchView.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutline16: () => null,
  IconBranchOutline16: () => null,
  IconCloseOutline16: () => null,
  IconRefreshOutline14: () => null,
  StateDot: () => null,
}))

const EMPTY = {
  schemaVersion: 1,
  hostInstanceId: '81d7cb39-bcca-4a51-899d-622da8593645',
  hostStartedAt: 1,
  revision: 0,
  capturedAt: 1,
  capabilities: {
    publishedLifecycle: true,
    startupLifecycle: 'owned-tool-only',
    liveProgress: false,
    browserCancellation: false,
    durableHistory: false,
  },
  diagnostics: { droppedActiveRuns: 0 },
  attempts: [],
  runs: [],
} as const

function bench() {
  const call = vi.fn().mockResolvedValue({ ok: true, value: EMPTY })
  const sessions = {
    openSubagent: vi.fn(),
    refreshSubagents: vi.fn(async () => {}),
  }
  let entry: {
    options: Record<string, unknown>
    component: unknown
  } | undefined
  const ctx = {
    get(name: string) {
      if (name === 'connection') return { rpc: { call } }
      if (name === 'sessions') return sessions
      throw new Error(`unexpected service: ${name}`)
    },
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => ((key: string) => key === 'tab' ? '子代理' : key)),
    },
    effect(effect: () => unknown) { return effect() },
    slots: {
      inject(_name: string, mount: () => unknown) { return mount() },
      register(options: Record<string, unknown>, component: unknown) {
        entry = { options, component }
        return () => { entry = undefined }
      },
    },
  }
  return { call, ctx, entry: () => entry, sessions }
}

describe('browser client registration', () => {
  it('declares only the services needed by the read-only conversation view', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'sessions'])
  })

  it('registers the localized third tab and one batched RPC reader', async () => {
    const b = bench()
    apply(b.ctx as never)
    const entry = b.entry()!
    expect(entry.component).toBe(SubagentWorkbenchView)
    expect(entry.options).toMatchObject({ id: 'subagents', order: 20 })
    expect(entry.options.locale).toBe(NS)
    expect((entry.options.label as () => string)()).toBe('子代理')

    const injected = (entry.options.inject as unknown as (
      id: SessionId,
    ) => SubagentWorkbenchInjected)('parent' as SessionId)
    const controller = new AbortController()
    await expect(injected.listSessions(
      ['parent' as SessionId, 'child' as SessionId],
      controller.signal,
    )).resolves.toEqual(EMPTY)
    expect(b.call).toHaveBeenCalledWith(
      '/product-subagent-console',
      'list-sessions',
      { parentSessionIds: ['parent', 'child'] },
      controller.signal,
    )

    await injected.refreshNative('parent' as SessionId)
    injected.openChild({
      parentSessionId: 'parent' as SessionId,
      childSessionId: 'child' as SessionId,
      mode: 'one-shot',
    })
    expect(b.sessions.refreshSubagents).toHaveBeenCalledWith('parent')
    expect(b.sessions.openSubagent).toHaveBeenCalledOnce()

    b.call.mockResolvedValueOnce({ ok: false, error: { code: 'PRIVATE', message: 'secret' } })
    await expect(injected.listSessions(['parent' as SessionId], controller.signal))
      .rejects.toThrow('product-subagent-console RPC failed: PRIVATE')
  })
})
