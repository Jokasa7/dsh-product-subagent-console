// @vitest-environment jsdom
import { createElement, useState } from 'react'
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
  AgentPlanWorkbench: ({ sessionId: owner }: { readonly sessionId: SessionId }) => {
    const [value, setValue] = useState('')
    return createElement('div', { 'data-testid': 'planner-mode' },
      createElement('span', {}, String(owner)),
      createElement('input', {
        'aria-label': 'draft-value',
        value,
        onChange: (event: { currentTarget: { value: string } }) => { setValue(event.currentTarget.value) },
      }))
  },
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

function emptySessionState(owner = sessionId): SessionListState {
  return {
    ids: [owner],
    byId: {
      [owner]: {
        id: owner,
        displayTitle: 'Parent',
        running: true,
        blank: false,
        updatedAt: 1,
        projectionValues: {},
      },
    },
    current: owner,
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

function props(owner = sessionId): SubagentWorkbenchProps {
  const sessions = emptySessionState(owner)
  const useSessions: SubagentWorkbenchProps['useSessions'] = selector => selector(sessions)
  return {
    sessionId: owner,
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

  it('preserves a draft between modes but resets it when the owning Session changes', async () => {
    const first = props()
    const view = render(createElement(SubagentWorkbenchView, first))
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }))
    const input = await screen.findByLabelText('draft-value') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'session A draft' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }))
    expect((screen.getByLabelText('draft-value') as HTMLInputElement).value).toBe('session A draft')

    const secondId = 'parent-b' as SessionId
    view.rerender(createElement(SubagentWorkbenchView, props(secondId)))
    expect((await screen.findByLabelText('draft-value') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(String(secondId))).toBeTruthy()
  })

  it('aborts hidden mode watchers and keeps generated DOM ids unique', async () => {
    const first = props()
    const second = props('parent-b' as SessionId)
    const view = render(createElement('div', {},
      createElement(SubagentWorkbenchView, first),
      createElement(SubagentWorkbenchView, second),
    ))
    await waitFor(() => { expect(first.watchSessions).toHaveBeenCalled() })
    const runtimeSignal = (first.watchSessions as unknown as {
      readonly mock: { readonly calls: readonly (readonly unknown[])[] }
    }).mock.calls[0]?.[3] as AbortSignal
    const firstWorkbench = view.container.querySelectorAll('[data-subagent-workbench]')[0]
    const firstTabs = firstWorkbench?.querySelectorAll<HTMLElement>('[role="tab"]')
    fireEvent.click(firstTabs?.[1] as HTMLElement)
    await waitFor(() => { expect(runtimeSignal.aborted).toBe(true) })

    const ids = [...view.container.querySelectorAll<HTMLElement>('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const element of view.container.querySelectorAll<HTMLElement>('[aria-controls], [aria-labelledby]')) {
      const reference = element.getAttribute('aria-controls') ?? element.getAttribute('aria-labelledby')
      if (reference !== null) expect(document.getElementById(reference)).toBeTruthy()
    }
  })

  it('contains a rejected native refresh and allows an explicit retry', async () => {
    const injected = props()
    const refreshNative = vi.fn(async () => { throw new Error('refresh unavailable') })
    const view = render(createElement(SubagentWorkbenchView, { ...injected, refreshNative }))
    await waitFor(() => { expect(refreshNative).toHaveBeenCalledOnce() })

    fireEvent.click(view.getByRole('button', { name: 'Refresh subagents' }))
    await waitFor(() => { expect(refreshNative.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })
})
