// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentWorkbenchProps } from '../src/client/SubagentWorkbenchView.js'
import { en, type ProductSubagentsLocaleKey } from '../src/client/locales.js'

vi.mock('../src/client/SubagentTaskCanvas.js', () => ({
  SubagentTaskCanvas: () => createElement('div', { 'data-testid': 'runtime-canvas' }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutline16: () => null,
  IconBranchOutline16: () => null,
  IconCloseOutline16: () => null,
  IconRefreshOutline14: () => null,
  StateDot: () => null,
}))

vi.mock('../src/client/AgentPlanWorkbench.js', () => ({
  AGENT_PLAN_WORKBENCH_COPY_EN: {},
  AGENT_PLAN_WORKBENCH_COPY_ZH: {},
  AgentPlanWorkbench: () => createElement('div', { 'data-testid': 'planner-mode' }, 'Planner mode'),
}))

vi.mock('../src/client/AgentPlanComparison.js', () => ({
  AGENT_PLAN_COMPARISON_COPY_EN: {},
  AGENT_PLAN_COMPARISON_COPY_ZH: {},
  AgentPlanComparison: ({ plans, executionSnapshot }: {
    readonly plans: readonly unknown[]
    readonly executionSnapshot: { readonly executions: readonly unknown[] }
  }) => createElement(
    'div',
    { 'data-testid': 'compare-mode' },
    `${String(plans.length)} plans / ${String(executionSnapshot.executions.length)} executions`,
  ),
}))

import { SubagentWorkbenchView } from '../src/client/SubagentWorkbenchView.js'

afterEach(() => { cleanup() })

const sessionId = 'parent' as SessionId
const hostInstanceId = '8c98c5db-c1b2-475e-8e4c-9ac7a5062f99'

function translate(key: ProductSubagentsLocaleKey, values?: Record<string, unknown>): string {
  let value = en[key]
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function emptySessionState(): SessionListState {
  return {
    ids: [sessionId],
    byId: {
      [sessionId]: {
        id: sessionId,
        displayTitle: 'Parent',
        running: true,
        blank: false,
        updatedAt: 1,
        projectionValues: {},
      },
    },
    current: sessionId,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function props(): SubagentWorkbenchProps {
  const sessions = emptySessionState()
  const useSessions: SubagentWorkbenchProps['useSessions'] = selector => selector(sessions)
  return {
    sessionId,
    t: translate as SubagentWorkbenchProps['t'],
    useSessions,
    listSessions: vi.fn(async () => ({
      schemaVersion: 1,
      hostInstanceId,
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
    })),
    watchSessions: vi.fn(async (_ids, _host, _revision, signal) => waitForAbort(signal)),
    openChild: vi.fn(),
    refreshNative: vi.fn(async () => {}),
    listPlans: vi.fn(async () => ({
      schemaVersion: 1,
      hostInstanceId,
      hostStartedAt: 1,
      revision: 0,
      capturedAt: 1,
      durability: 'host-only',
      plans: [],
    })),
    watchPlans: vi.fn(async (_ids, _host, _revision, signal) => waitForAbort(signal)),
    savePlan: vi.fn(),
    preflightPlan: vi.fn(),
    approvePlan: vi.fn(),
    requestPlanDesign: vi.fn(),
    getExecutionCapabilities: vi.fn(),
    listPlanExecutions: vi.fn(async () => ({
      schemaVersion: 1,
      hostInstanceId,
      hostStartedAt: 1,
      revision: 0,
      capturedAt: 1,
      durability: 'host-only',
      executions: [],
    })),
    watchPlanExecutions: vi.fn(async (_ids, _host, _revision, signal) => waitForAbort(signal)),
    cancelPlanExecution: vi.fn(),
    requestPlanExecution: vi.fn(),
  } as unknown as SubagentWorkbenchProps
}

describe('three-mode conversation workbench', () => {
  it('switches Runtime, Plan, and Compare as accessible tabs', async () => {
    const injected = props()
    render(createElement(SubagentWorkbenchView, injected))

    const runtime = screen.getByRole('tab', { name: 'Runtime' })
    const planner = screen.getByRole('tab', { name: 'Plan' })
    const compare = screen.getByRole('tab', { name: 'Compare' })
    expect(runtime.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('runtime-canvas')).toBeTruthy()

    fireEvent.click(planner)
    expect(planner.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('planner-mode')).toBeTruthy()

    fireEvent.keyDown(planner, { key: 'ArrowRight' })
    expect(compare.getAttribute('aria-selected')).toBe('true')
    await waitFor(() => {
      expect(screen.getByTestId('compare-mode').textContent).toBe('0 plans / 0 executions')
    })
    expect(injected.listPlans).toHaveBeenCalledWith([sessionId], expect.any(AbortSignal))
    expect(injected.listPlanExecutions).toHaveBeenCalledWith([sessionId], expect.any(AbortSignal))
  })
})
