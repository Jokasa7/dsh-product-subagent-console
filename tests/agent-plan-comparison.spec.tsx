// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentPlanRevision, CancelPlanExecutionResult, PlanExecution,
  PlanExecutionRepositorySnapshot, PlanRunBinding,
} from '../src/plan-types.js'
import {
  AGENT_PLAN_COMPARISON_COPY_EN,
  AgentPlanComparison,
  type AgentPlanComparisonActions,
} from '../src/client/AgentPlanComparison.js'
import {
  buildPlanComparisonGraph, comparisonAttemptNodeId, comparisonTaskNodeId,
  executionNodeId, findExecutionPlanRevision, layoutPlanComparisonGraph,
} from '../src/client/plan-comparison-model.js'

vi.mock('../src/client/AgentPlanComparisonCanvas.js', () => ({
  AgentPlanComparisonCanvas: ({ execution, plan, onSelect }: {
    readonly execution: PlanExecution
    readonly plan?: AgentPlanRevision
    readonly onSelect: (nodeId: string) => void
  }) => createElement('div', { 'data-testid': 'comparison-canvas' },
    createElement('button', {
      type: 'button',
      onClick: () => { onSelect(`execution:${execution.executionId}`) },
    }, 'select-execution'),
    ...(plan?.tasks.map(task => createElement('button', {
      key: task.taskId,
      type: 'button',
      onClick: () => { onSelect(`plan-task:${task.taskId}`) },
    }, `select-task-${task.taskId}`)) ?? []),
    ...execution.bindings.map(binding => createElement('button', {
      key: binding.attemptId,
      type: 'button',
      onClick: () => { onSelect(`attempt:${binding.attemptId}`) },
    }, `select-attempt-${binding.attemptNumber}`)),
  ),
}))

afterEach(() => { cleanup() })

const sessionId = 'parent-session' as SessionId
const planId = 'df21e108-191d-4b1c-8e25-b2a8a64450a3'
const executionId = '856bcae4-0f32-4461-820b-dfde09415d64'
const attemptOne = '05730562-eb6d-4367-8fbd-8a0bb87f6b8e'
const attemptTwo = 'b1a4389c-c28a-432b-a640-1ab85d847b43'

function plan(): AgentPlanRevision {
  return {
    schemaVersion: 1,
    planId,
    parentSessionId: String(sessionId),
    revision: 3,
    state: 'approved',
    createdAt: 900,
    updatedAt: 1_000,
    capabilityDigest: 'capability-one',
    acceptedWarningCodes: [],
    title: 'Release review',
    objective: 'Review the release and merge evidence.',
    successCriteria: ['Every finding is evidenced'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'Independent surfaces can run in parallel.',
      userOverride: false,
    },
    pattern: 'parallel-fanout-fanin',
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 3, maxConcurrent: 2, planTimeoutMs: 600_000 },
    roles: [{
      roleId: 'reviewer',
      name: 'Reviewer',
      responsibility: 'Review one surface.',
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
    }, {
      taskId: 'merge',
      title: 'Merge evidence',
      brief: 'Combine all findings.',
      roleId: 'reviewer',
      dependsOn: [{ taskId: 'frontend', mode: 'context' }],
      expectedOutput: { description: 'Release report' },
      completionCriteria: ['Report includes frontend findings'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

function binding(overrides: Partial<PlanRunBinding> = {}): PlanRunBinding {
  return {
    planId,
    planRevision: 3,
    executionId,
    taskId: 'frontend',
    attemptId: attemptOne,
    attemptNumber: 1,
    status: 'running',
    childId: 'child-frontend',
    startedAt: 1_100,
    ...overrides,
  }
}

function execution(bindings: readonly PlanRunBinding[] = [binding()]): PlanExecution {
  return {
    executionId,
    planId,
    planRevision: 3,
    parentSessionId: String(sessionId),
    backend: 'workflow',
    capabilityDigest: 'capability-one',
    status: 'running',
    cancellationRequested: false,
    createdAt: 1_000,
    startedAt: 1_050,
    bindings: [...bindings],
  }
}

function snapshot(value = execution()): PlanExecutionRepositorySnapshot {
  return {
    schemaVersion: 1,
    hostInstanceId: '8c98c5db-c1b2-475e-8e4c-9ac7a5062f99',
    hostStartedAt: 800,
    revision: 4,
    capturedAt: 1_200,
    durability: 'host-only',
    executions: [value],
  }
}

function actions(): AgentPlanComparisonActions {
  const cancelled: CancelPlanExecutionResult = { status: 'requested' }
  return {
    requestExecution: vi.fn(async () => {}),
    cancelExecution: vi.fn(async () => cancelled),
  }
}

describe('plan comparison authority model', () => {
  it('maps only bindings with exact execution and plan identity', () => {
    const validRetry = binding({
      attemptId: attemptTwo,
      attemptNumber: 2,
      retryOf: attemptOne,
      status: 'completed',
      finishedAt: 1_800,
    })
    const wrongExecution = binding({
      executionId: 'c9f44880-8a1b-480a-83ef-679b7ffcb27f',
      attemptId: '8947df09-bcc0-4a20-be28-d16132138a6e',
    })
    const unresolved = binding({
      taskId: 'unknown-task',
      attemptId: '4ec06478-e22a-43d3-8f7b-eb61d18004af',
      attemptNumber: 1,
    })
    const run = execution([binding(), validRetry, wrongExecution, unresolved])
    const exactPlan = findExecutionPlanRevision([plan()], run)
    const graph = buildPlanComparisonGraph(run, exactPlan)

    expect(graph.droppedBindings).toBe(1)
    expect(graph.nodes.map(node => node.id)).not.toContain(comparisonAttemptNodeId(wrongExecution.attemptId))
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: comparisonTaskNodeId('frontend'), kind: 'plan-task' }),
      expect.objectContaining({ id: comparisonAttemptNodeId(attemptOne), kind: 'attempt' }),
      expect.objectContaining({ id: comparisonAttemptNodeId(unresolved.attemptId), kind: 'unresolved-attempt' }),
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: comparisonTaskNodeId('frontend'),
        target: comparisonAttemptNodeId(attemptOne),
        mode: 'binding',
      }),
      expect.objectContaining({
        source: comparisonAttemptNodeId(attemptOne),
        target: comparisonAttemptNodeId(attemptTwo),
        mode: 'retry',
      }),
      expect.objectContaining({
        source: executionNodeId(executionId),
        target: comparisonAttemptNodeId(unresolved.attemptId),
        mode: 'unresolved',
      }),
    ]))
    expect(layoutPlanComparisonGraph(graph)).toEqual(layoutPlanComparisonGraph(graph))
  })

  it('never substitutes another revision when the exact revision is missing', () => {
    const other = { ...plan(), revision: 4 }
    expect(findExecutionPlanRevision([other], execution())).toBeUndefined()
  })
})

describe('Agent plan comparison controls', () => {
  it('renders the English title, request action, and empty state', () => {
    const emptySnapshot: PlanExecutionRepositorySnapshot = {
      ...snapshot(),
      executions: [],
    }

    render(createElement(AgentPlanComparison, {
      sessionId,
      plans: [plan()],
      executionSnapshot: emptySnapshot,
      actions: actions(),
      copy: AGENT_PLAN_COMPARISON_COPY_EN,
    }))

    expect(screen.getByRole('heading', { name: 'Plan / actual comparison' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Request execution' })).toBeTruthy()
    expect(screen.getByText('No execution history yet')).toBeTruthy()
  })

  it('requests the selected approved revision and cancels the exact active execution', async () => {
    const callbacks = actions()
    render(createElement(AgentPlanComparison, {
      sessionId,
      plans: [plan()],
      executionSnapshot: snapshot(),
      actions: callbacks,
    }))

    const request = await screen.findByRole('button', { name: '请求执行' })
    await waitFor(() => { expect((request as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(request)
    await waitFor(() => {
      expect(callbacks.requestExecution).toHaveBeenCalledWith({
        parentSessionId: String(sessionId), planId, revision: 3,
      }, expect.any(AbortSignal))
    })

    fireEvent.click(screen.getByRole('button', { name: '取消执行' }))
    await waitFor(() => {
      expect(callbacks.cancelExecution).toHaveBeenCalledWith({
        parentSessionId: String(sessionId), executionId,
      }, expect.any(AbortSignal))
    })
    expect(await screen.findByText(/最终状态以运行快照为准/u)).toBeTruthy()
  })

  it('shows authoritative attempt status, child id, and timing after node selection', async () => {
    render(createElement(AgentPlanComparison, {
      sessionId,
      plans: [plan()],
      executionSnapshot: snapshot(),
      actions: actions(),
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'select-attempt-1' }))

    expect(screen.getByText('child-frontend')).toBeTruthy()
    expect(screen.getAllByText('running').length).toBeGreaterThan(0)
    expect(screen.getByText(attemptOne)).toBeTruthy()
  })

  it('keeps attempts unresolved when the exact plan revision is unavailable', async () => {
    render(createElement(AgentPlanComparison, {
      sessionId,
      plans: [{ ...plan(), revision: 4 }],
      executionSnapshot: snapshot(),
      actions: actions(),
    }))
    expect(await screen.findByText(/不会自动匹配其他修订/u)).toBeTruthy()
  })
})
