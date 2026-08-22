// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleSnapshot } from '../src/types.js'
import {
  SubagentWorkbenchView, type SubagentWorkbenchProps,
} from '../src/client/SubagentWorkbenchView.js'
import { en, type ProductSubagentsLocaleKey } from '../src/client/locales.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutline16: () => null,
  IconBranchOutline16: () => null,
  IconCloseOutline16: () => null,
  IconRefreshOutline14: () => null,
  StateDot: ({ state }: { readonly state: string }) => createElement('span', { 'data-state': state }),
}))

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const parent = 'parent' as SessionId
const nativeChild = 'native-child' as SessionId

function translate(key: ProductSubagentsLocaleKey, values?: Record<string, unknown>): string {
  let value = en[key]
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

const t = translate as SubagentWorkbenchProps['t']

function sessionState(): SessionListState {
  return {
    ids: [parent, nativeChild],
    byId: {
      [parent]: {
        id: parent,
        displayTitle: 'Parent conversation',
        running: true,
        blank: false,
        updatedAt: 1,
        projectionValues: {},
      },
      [nativeChild]: {
        id: nativeChild,
        displayTitle: 'Native child',
        parentId: parent,
        origin: 'subagent',
        running: true,
        blank: false,
        updatedAt: 2,
        projectionValues: {
          subagentTiming: {
            settledMs: 2_000,
            active: { since: 1_000, through: 2_000 },
          },
        },
      },
    },
    current: parent,
    phase: 'ready',
    subagentsByParent: {
      [parent]: {
        state: 'ready',
        error: null,
        parentAvailable: true,
        entries: [{
          kind: 'child',
          id: nativeChild,
          activity: 'running',
          hasChildren: false,
          mode: 'continuable',
          label: 'Native task',
        }],
      },
    },
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function activeSnapshot(): ConsoleSnapshot {
  return {
    schemaVersion: 1,
    hostInstanceId: '81d7cb39-bcca-4a51-899d-622da8593645',
    hostStartedAt: 1_000,
    revision: 1,
    capturedAt: 6_000,
    capabilities: {
      publishedLifecycle: true,
      startupLifecycle: 'owned-tool-only',
      liveProgress: false,
      browserCancellation: false,
      durableHistory: false,
    },
    diagnostics: { droppedActiveRuns: 0 },
    attempts: [],
    runs: [{
      runId: 'external-active',
      parentSessionId: String(parent),
      childId: 'codex-child',
      callId: 'call-active',
      toolName: 'subagent_codex',
      label: 'Review module status',
      providerName: 'codex-safe',
      providerMismatch: false,
      source: 'observed-tool',
      local: false,
      state: 'active',
      startedAt: 1_000,
    }],
  }
}

describe('workbench disconnected rendering', () => {
  it('freezes stale plugin activity while keeping native activity factual', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const state = sessionState()
    const listSessions = vi.fn()
      .mockResolvedValueOnce(activeSnapshot())
      .mockRejectedValue(new Error('private transport detail'))
    const view = render(createElement(SubagentWorkbenchView, {
      sessionId: parent,
      t,
      useSessions: selector => selector(state),
      listSessions,
      openChild: vi.fn(),
      refreshNative: vi.fn(async () => {}),
    } as SubagentWorkbenchProps))

    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      if (listSessions.mock.calls.length < 2) {
        await act(async () => {
          vi.advanceTimersByTime(1_000)
          await Promise.resolve()
          await Promise.resolve()
        })
      }

      expect(screen.getByRole('alert').textContent).not.toContain('private transport detail')
      expect(screen.getByText('Disconnected (state unconfirmed) · 5s')).toBeTruthy()
      expect(screen.getByText(/^Running · /).closest('[data-kind="native"]')).toBeTruthy()

      await act(async () => {
        vi.advanceTimersByTime(10_000)
        await Promise.resolve()
      })
      expect(screen.getByText('Disconnected (state unconfirmed) · 5s')).toBeTruthy()
      expect(view.container.querySelector(
        '[data-canvas-node-id="run:external-active"] [data-state="warning"]',
      )).toBeTruthy()
      expect(view.container.querySelector(
        '[data-canvas-node-id="session:native-child"] [data-state="ongoing"]',
      )).toBeTruthy()
    } finally {
      view.unmount()
    }
  })
})
