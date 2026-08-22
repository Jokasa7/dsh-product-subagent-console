// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentPlanRevision, PlanPreflightResult, PlanRepositorySnapshot,
} from '../src/plan-types.js'
import {
  AGENT_PLAN_WORKBENCH_COPY_EN,
  AgentPlanWorkbench,
  type AgentPlanWorkbenchInjected,
} from '../src/client/AgentPlanWorkbench.js'

vi.mock('../src/client/AgentPlanCanvas.js', () => ({
  AgentPlanCanvas: ({ content, onSelect }: {
    readonly content: AgentPlanRevision
    readonly onSelect: (selection: string) => void
  }) => createElement('div', { 'data-testid': 'plan-canvas' },
    createElement('button', { type: 'button', onClick: () => { onSelect('root') } }, 'select-root'),
    ...content.tasks.map(task => createElement(
      'button',
      { key: task.taskId, type: 'button', onClick: () => { onSelect(task.taskId) } },
      `select-${task.taskId}`,
    )),
  ),
}))

afterEach(() => { cleanup() })

const sessionId = 'parent-session' as SessionId
const planId = 'd8e6c370-aa42-4ad7-b3e4-cd7024f08e50'

function revision(state: 'draft' | 'approved' = 'draft'): AgentPlanRevision {
  return {
    schemaVersion: 1,
    planId,
    parentSessionId: String(sessionId),
    revision: 1,
    state,
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Release review',
    objective: 'Review the release.',
    successCriteria: ['Findings are evidenced'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'Independent surfaces can be reviewed in parallel.',
      userOverride: false,
    },
    pattern: 'manager-workers',
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 3, maxConcurrent: 2, planTimeoutMs: 600_000 },
    roles: [{
      roleId: 'reviewer',
      name: 'Reviewer',
      responsibility: 'Review the assigned surface.',
      boundaries: [],
      transportProvider: 'codex',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'frontend',
      title: 'Review frontend',
      brief: 'Inspect the frontend.',
      roleId: 'reviewer',
      dependsOn: [],
      expectedOutput: { description: 'Frontend findings' },
      completionCriteria: ['Findings cite files'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

function snapshot(plan = revision()): PlanRepositorySnapshot {
  return {
    schemaVersion: 1,
    hostInstanceId: 'ff85c315-1f1c-484c-b81c-b2e6046e3454',
    hostStartedAt: 900,
    revision: 1,
    capturedAt: 1_100,
    durability: 'host-only',
    plans: [plan],
  }
}

function pendingWatch(signal: AbortSignal): Promise<PlanRepositorySnapshot> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

function injected(overrides: Partial<AgentPlanWorkbenchInjected> = {}): AgentPlanWorkbenchInjected {
  const defaultPreflight: PlanPreflightResult = {
    planId,
    revision: 1,
    capabilityDigest: 'capability-one',
    resolvedBackend: 'workflow',
    valid: true,
    diagnostics: [],
    parallelWaves: [['frontend']],
  }
  return {
    listPlans: vi.fn(async () => snapshot()),
    watchPlans: vi.fn((_ids, _host, _revision, signal) => pendingWatch(signal)),
    savePlan: vi.fn(async request => ({
      ...revision(),
      ...request.content,
      planId: request.planId ?? planId,
      revision: request.expectedRevision + 1,
      updatedAt: 2_000,
    })),
    preflightPlan: vi.fn(async () => defaultPreflight),
    approvePlan: vi.fn(async () => revision('approved')),
    requestPlanDesign: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('Agent plan workbench', () => {
  it('renders the English title, primary action, and empty state', async () => {
    const emptySnapshot: PlanRepositorySnapshot = {
      ...snapshot(),
      plans: [],
    }
    const actions = injected({ listPlans: vi.fn(async () => emptySnapshot) })

    render(createElement(AgentPlanWorkbench, {
      sessionId,
      injected: actions,
      copy: AGENT_PLAN_WORKBENCH_COPY_EN,
    }))

    expect(await screen.findByRole('heading', {
      name: 'Design an Agent plan in this conversation',
    })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Generate plan' })).toBeTruthy()
    expect(screen.getByText('No Agent plan yet')).toBeTruthy()
  })

  it('sends the goal through the injected visible-conversation action', async () => {
    const actions = injected()
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.change(screen.getByPlaceholderText(/并行检查前端/u), {
      target: { value: '并行审查三个模块' },
    })
    fireEvent.click(screen.getByRole('button', { name: '生成方案' }))

    await waitFor(() => {
      expect(actions.requestPlanDesign).toHaveBeenCalledWith(
        sessionId,
        '并行审查三个模块',
        expect.any(AbortSignal),
      )
    })
    expect(await screen.findByText(/已把方案设计请求发送到当前对话/u)).toBeTruthy()
  })

  it('edits a task and saves with the exact selected revision as CAS', async () => {
    const actions = injected()
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.click(screen.getByRole('button', { name: 'select-frontend' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Review web client' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => {
      expect(actions.savePlan).toHaveBeenCalledWith(expect.objectContaining({
        parentSessionId: String(sessionId),
        planId,
        expectedRevision: 1,
        content: expect.objectContaining({
          tasks: [expect.objectContaining({ title: 'Review web client' })],
        }),
      }), expect.any(AbortSignal))
    })
    expect(await screen.findByText('已保存修订 2。')).toBeTruthy()
  })

  it('requires explicit warning acceptance before approval', async () => {
    const result: PlanPreflightResult = {
      planId,
      revision: 1,
      capabilityDigest: 'capability-one',
      resolvedBackend: 'workflow',
      valid: true,
      diagnostics: [{
        severity: 'warning',
        code: 'advisory-model',
        message: 'Model availability is advisory.',
        nodeIds: ['frontend'],
      }],
      parallelWaves: [['frontend']],
    }
    const actions = injected({ preflightPlan: vi.fn(async () => result) })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.click(screen.getByRole('button', { name: '运行预检' }))
    const approve = await screen.findByRole('button', { name: '批准此修订' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('我已阅读并接受此警告'))
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(approve)

    await waitFor(() => {
      expect(actions.approvePlan).toHaveBeenCalledWith({
        parentSessionId: String(sessionId),
        planId,
        revision: 1,
        capabilityDigest: 'capability-one',
        acceptedWarningCodes: ['advisory-model'],
      }, expect.any(AbortSignal))
    })
  })

  it('adds, removes, and edits task dependencies through the selected-card inspector', async () => {
    const stored = revision()
    stored.tasks.push({
      taskId: 'backend',
      title: 'Review backend',
      brief: 'Inspect the backend.',
      roleId: 'reviewer',
      dependsOn: [],
      expectedOutput: { description: 'Backend findings' },
      completionCriteria: ['Findings cite files'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    })
    const actions = injected({ listPlans: vi.fn(async () => snapshot(stored)) })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.click(screen.getByRole('button', { name: 'select-backend' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Review frontend/u }))
    fireEvent.change(screen.getByLabelText('Review frontend 的依赖类型'), {
      target: { value: 'context' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => {
      expect(actions.savePlan).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.objectContaining({
          tasks: expect.arrayContaining([expect.objectContaining({
            taskId: 'backend',
            dependsOn: [{ taskId: 'frontend', mode: 'context' }],
          })]),
        }),
      }), expect.any(AbortSignal))
    })

    fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
    expect(screen.getByRole('button', { name: 'select-task-3' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
    expect(screen.queryByRole('button', { name: 'select-task-3' })).toBeNull()
  })

  it('keeps a manually-created unsaved draft selected when saved plans already exist', async () => {
    const actions = injected()
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.change(screen.getByPlaceholderText(/并行检查前端/u), {
      target: { value: '建立全新的人工方案' },
    })
    fireEvent.click(screen.getByRole('button', { name: '手动新建' }))

    expect((await screen.findAllByDisplayValue('建立全新的人工方案')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('未保存草案').length).toBe(2)
  })
})
