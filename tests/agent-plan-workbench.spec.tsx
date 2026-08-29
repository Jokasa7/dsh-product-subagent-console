// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentPlanRevision, ExecutionCapabilitySnapshot, PlanPreflightResult, PlanRepositorySnapshot,
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

function capabilities(): ExecutionCapabilitySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: 1_000,
    digest: 'capability-one',
    catalogDigest: 'catalog-one',
    scopeStatus: 'available',
    adapters: { workflow: true, agentTeam: false },
    transportProviders: [{
      name: 'codex',
      inheritsParentContext: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
      continuable: false,
      modelRouting: 'unsupported',
      maxTokens: 'unsupported',
    }],
    llmRoutes: [],
    agentPresets: [],
    tools: ['design_subagent_plan', 'execute_subagent_plan'],
    plannerTools: {
      design: ['design_subagent_plan'],
      execute: ['execute_subagent_plan'],
    },
    budgetSupport: {
      maxAgents: 'enforced',
      maxConcurrent: 'enforced',
      planTimeout: 'enforced',
      requests: 'advisory',
      tokens: 'advisory',
      cost: 'unsupported',
    },
    contractSupport: {
      reasoningEffort: 'unsupported',
      verifiers: {
        lifecycle: 'enforced',
        schema: 'unsupported',
        test: 'unsupported',
        manual: 'unsupported',
      },
    },
    limits: { maxAgents: 32, maxConcurrent: 16 },
    experimentalAgentTeam: false,
  }
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
    getExecutionCapabilities: vi.fn(async () => capabilities()),
    requestPlanDesign: vi.fn(async () => {}),
    requestPlanExecution: vi.fn(async request => ({
      grantId: '00000000-0000-4000-8000-000000000123',
      parentSessionId: request.parentSessionId,
      planId: request.planId,
      revision: request.revision,
      capabilityDigest: 'capability-one',
      executeToolName: 'execute_subagent_plan',
      expiresAt: 60_000,
    })),
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

  it('locks draft fields and ignores a late successful save after Plan becomes inactive', async () => {
    let requestSignal: AbortSignal | undefined
    let resolveSave: ((value: AgentPlanRevision) => void) | undefined
    const actions = injected({
      savePlan: vi.fn((_request, signal) => {
        requestSignal = signal
        return new Promise<AgentPlanRevision>((resolve) => {
          resolveSave = resolve
        })
      }),
    })
    const view = render(createElement(AgentPlanWorkbench, { sessionId, injected: actions, active: true }))
    await screen.findByDisplayValue('Release review')
    fireEvent.click(screen.getByRole('button', { name: 'select-frontend' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Deferred review' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => { expect(actions.savePlan).toHaveBeenCalledOnce() })
    expect((screen.getByLabelText('任务名称') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '正在保存…' }) as HTMLButtonElement).disabled).toBe(true)

    view.rerender(createElement(AgentPlanWorkbench, { sessionId, injected: actions, active: false }))
    await waitFor(() => { expect(requestSignal?.aborted).toBe(true) })
    await act(async () => {
      resolveSave?.({ ...revision(), revision: 2, updatedAt: 2_000 })
      await Promise.resolve()
    })
    expect(screen.queryByText('已保存修订 2。')).toBeNull()
  })

  it('shows optional whole-plan budgets and lets users clear an unsupported retained value', async () => {
    const stored = revision()
    stored.budget = {
      ...stored.budget,
      maxRequests: 20,
      maxTokens: 40_000,
      maxCostUsd: 5,
    }
    const actions = injected({ listPlans: vi.fn(async () => snapshot(stored)) })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    expect((screen.getByLabelText('最多请求') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('最多 Tokens') as HTMLInputElement).value).toBe('40000')
    const cost = screen.getByLabelText('最高成本（USD）') as HTMLInputElement
    expect(cost.value).toBe('5')
    expect(cost.disabled).toBe(false)
    fireEvent.change(cost, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => {
      expect(actions.savePlan).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.objectContaining({
          budget: expect.not.objectContaining({ maxCostUsd: expect.anything() }),
        }),
      }), expect.any(AbortSignal))
    })
  })

  it.each([
    ['revision-conflict', '方案已被其他更新改动'],
    ['not-found', '该方案已不存在'],
    ['stale-capabilities', '创建新修订'],
  ])('maps stable planner reason %s to actionable plan feedback', async (reason, expected) => {
    const actions = injected({
      savePlan: vi.fn(async () => {
        throw new Error(`product-subagent-console RPC failed: ${reason}`)
      }),
    })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.click(screen.getByRole('button', { name: 'select-frontend' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Updated review' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    expect((await screen.findByRole('alert')).textContent).toContain(expected)
  })

  it('requires explicit warning acceptance before approval', async () => {
    const result: PlanPreflightResult = {
      planId,
      revision: 1,
      capabilityDigest: 'capability-one',
      resolvedBackend: 'workflow',
      valid: true,
      diagnostics: [{
        diagnosticId: 'advisory-model:frontend',
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
    const acceptWarning = await screen.findByRole('checkbox', { name: '我已阅读并接受此警告' })
    const approve = screen.getByRole('button', { name: '批准此修订' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(acceptWarning)
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(approve)

    await waitFor(() => {
      expect(actions.approvePlan).toHaveBeenCalledWith({
        parentSessionId: String(sessionId),
        planId,
        revision: 1,
        capabilityDigest: 'capability-one',
        acceptedWarningIds: ['advisory-model:frontend'],
      }, expect.any(AbortSignal))
    })
  })

  it('requires a second explicit click before sending an approved revision for execution', async () => {
    const approved = revision('approved')
    const actions = injected({ listPlans: vi.fn(async () => snapshot(approved)) })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.click(screen.getByRole('button', { name: '检查执行请求' }))
    expect(actions.requestPlanExecution).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('一次性授权')

    fireEvent.click(screen.getByRole('button', { name: '确认并发送执行请求' }))
    await waitFor(() => {
      expect(actions.requestPlanExecution).toHaveBeenCalledWith(sessionId, {
        parentSessionId: String(sessionId),
        planId,
        revision: 1,
      }, expect.any(AbortSignal))
    })
    expect(await screen.findByText(/执行请求已发送到当前对话/u)).toBeTruthy()
    const pending = screen.getByRole('button', { name: '执行请求已发送' }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    fireEvent.click(pending)
    expect(actions.requestPlanExecution).toHaveBeenCalledOnce()
  })

  it('requires a new confirmation when a watched approved revision replaces the reviewed target', async () => {
    const approved = revision('approved')
    const next = { ...approved, revision: 2, updatedAt: 2_000 }
    let resolveUpdate: ((value: PlanRepositorySnapshot) => void) | undefined
    let watchCount = 0
    const actions = injected({
      listPlans: vi.fn(async () => snapshot(approved)),
      watchPlans: vi.fn((_ids, _host, _revision, signal) => {
        watchCount += 1
        if (watchCount === 1) {
          return new Promise<PlanRepositorySnapshot>(resolve => { resolveUpdate = resolve })
        }
        return pendingWatch(signal)
      }),
    })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')
    fireEvent.click(screen.getByRole('button', { name: '检查执行请求' }))
    expect(screen.getByRole('button', { name: '确认并发送执行请求' })).toBeTruthy()

    await act(async () => {
      resolveUpdate?.({ ...snapshot(next), revision: 2, capturedAt: 2_100 })
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByRole('option', { name: /r2/u })).toBeTruthy() })
    const review = screen.getByRole('button', { name: '检查执行请求' })
    fireEvent.click(review)
    expect(actions.requestPlanExecution).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认并发送执行请求' })).toBeTruthy()
  })

  it('clears staged execution confirmation when Plan is hidden and disables stale execution on watch failure', async () => {
    const approved = revision('approved')
    const actions = injected({ listPlans: vi.fn(async () => snapshot(approved)) })
    const view = render(createElement(AgentPlanWorkbench, { sessionId, injected: actions, active: true }))
    await screen.findByDisplayValue('Release review')
    fireEvent.click(screen.getByRole('button', { name: '检查执行请求' }))
    expect(screen.getByRole('button', { name: '确认并发送执行请求' })).toBeTruthy()

    view.rerender(createElement(AgentPlanWorkbench, { sessionId, injected: actions, active: false }))
    view.rerender(createElement(AgentPlanWorkbench, { sessionId, injected: actions, active: true }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '检查执行请求' })).toBeTruthy() })

    const disconnected = injected({
      listPlans: vi.fn(async () => snapshot(approved)),
      watchPlans: vi.fn(async () => { throw new Error('disconnected') }),
    })
    view.unmount()
    render(createElement(AgentPlanWorkbench, { sessionId, injected: disconnected, active: true }))
    await screen.findByText('与方案服务的连接已中断；当前内容可能不是最新状态。')
    expect((screen.getByRole('button', { name: '检查执行请求' }) as HTMLButtonElement).disabled).toBe(true)
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

  it('uses the real configured Provider for a manual executable draft', async () => {
    const available = capabilities()
    available.transportProviders = [{
      ...available.transportProviders[0]!,
      name: 'fork-provider',
      inheritsParentContext: true,
    }]
    const actions = injected({
      getExecutionCapabilities: vi.fn(async () => available),
    })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')

    fireEvent.change(screen.getByPlaceholderText(/并行检查前端/u), {
      target: { value: '验证真实 Provider' },
    })
    fireEvent.click(screen.getByRole('button', { name: '手动新建' }))
    expect((await screen.findAllByDisplayValue('验证真实 Provider')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => {
      expect(actions.savePlan).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.objectContaining({
          roles: [expect.objectContaining({
            transportProvider: 'fork-provider',
            contextMode: 'fork',
          })],
        }),
      }), expect.any(AbortSignal))
    })
  })

  it('refuses to invent a Provider when a profile has none', async () => {
    const emptySnapshot: PlanRepositorySnapshot = { ...snapshot(), plans: [] }
    const unavailable = capabilities()
    unavailable.transportProviders = []
    const actions = injected({
      listPlans: vi.fn(async () => emptySnapshot),
      getExecutionCapabilities: vi.fn(async () => unavailable),
    })
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByText('还没有 Agent 方案')

    fireEvent.click(screen.getByRole('button', { name: '手动新建' }))

    expect((await screen.findByRole('alert')).textContent).toContain('没有可用的子代理 Provider')
    expect(screen.getByText('还没有 Agent 方案')).toBeTruthy()
  })

  it('preserves multiline whitespace while typing and normalizes it only when saving', async () => {
    const actions = injected()
    render(createElement(AgentPlanWorkbench, { sessionId, injected: actions }))
    await screen.findByDisplayValue('Release review')
    fireEvent.click(screen.getByRole('button', { name: 'select-frontend' }))
    const criteria = await screen.findByLabelText('完成标准') as HTMLTextAreaElement

    fireEvent.change(criteria, { target: { value: '  first item\nsecond item  ' } })
    expect(criteria.value).toBe('  first item\nsecond item  ')
    fireEvent.click(screen.getByRole('button', { name: '保存草案' }))

    await waitFor(() => {
      expect(actions.savePlan).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.objectContaining({
          tasks: [expect.objectContaining({ completionCriteria: ['first item', 'second item'] })],
        }),
      }), expect.any(AbortSignal))
    })
  })

  it('keeps role editors open when a plan has more than three roles', async () => {
    const stored = revision()
    stored.roles = Array.from({ length: 4 }, (_, index) => ({
      ...stored.roles[0]!,
      roleId: `reviewer-${String(index + 1)}`,
      name: `Reviewer ${String(index + 1)}`,
    }))
    stored.tasks[0] = { ...stored.tasks[0]!, roleId: stored.roles[0]!.roleId }
    const view = render(createElement(AgentPlanWorkbench, {
      sessionId,
      injected: injected({ listPlans: vi.fn(async () => snapshot(stored)) }),
    }))
    await screen.findByDisplayValue('Release review')

    await waitFor(() => {
      const cards = [...view.container.querySelectorAll('details')]
      expect(cards).toHaveLength(4)
      expect(cards.every(card => card.open)).toBe(true)
    })
  })

  it('disables unsupported composition controls for new values', async () => {
    render(createElement(AgentPlanWorkbench, { sessionId, injected: injected() }))
    await screen.findByDisplayValue('Release review')
    expect((await screen.findByLabelText('模型 Provider') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('模型') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Agent 预设') as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'select-frontend' }))
    expect((screen.getByLabelText('此任务执行前需要批准') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('最多 Tokens') as HTMLInputElement).disabled).toBe(true)
  })
})
