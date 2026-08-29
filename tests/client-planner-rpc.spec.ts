// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ProductSubagentWorkbenchInjected,
} from '../src/client/index.js'
import { plannerRpcReasonSchema, type AgentPlanContent } from '../src/plan-types.js'
import { SubagentWorkbenchView } from '../src/client/SubagentWorkbenchView.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutline16: () => null,
  IconBranchOutline16: () => null,
  IconCloseOutline16: () => null,
  IconRefreshOutline14: () => null,
  StateDot: () => null,
}))

const PLAN_ID = '49ad5827-cf2c-4a38-a997-47b6f25b07d1'
const HOST_ID = '81d7cb39-bcca-4a51-899d-622da8593645'
const EXECUTION_ID = 'dd4c11d4-4949-4d27-b58c-af35afce42c2'
const GRANT_ID = '8c912da8-78e8-4aa8-90d1-e66aee8ac231'
const PLAN_CONTENT: AgentPlanContent = {
  title: 'Review release',
  objective: 'Review the release in parallel.',
  successCriteria: ['Report is complete.'],
  recommendation: {
    useMultiAgent: true,
    rationale: 'Independent checks can run in parallel.',
    userOverride: false,
  },
  pattern: 'parallel-fanout-fanin',
  optimizationTarget: 'balanced',
  backendPreference: 'workflow',
  budget: {
    maxAgents: 2,
    maxConcurrent: 2,
    planTimeoutMs: 300_000,
  },
  roles: [{
    roleId: 'reviewer',
    name: 'Reviewer',
    responsibility: 'Review one bounded area.',
    boundaries: [],
    transportProvider: 'native',
    contextMode: 'fresh',
    toolPolicy: { mode: 'inherit' },
  }],
  tasks: [{
    taskId: 'review',
    title: 'Review',
    brief: 'Inspect the release.',
    roleId: 'reviewer',
    dependsOn: [],
    expectedOutput: { description: 'A concise report.' },
    completionCriteria: ['Report findings.'],
    resourceClaims: [],
    risk: 'low',
    approvalRequired: false,
  }],
}

const PLAN_REVISION = {
  ...PLAN_CONTENT,
  schemaVersion: 1,
  planId: PLAN_ID,
  parentSessionId: 'parent',
  revision: 1,
  state: 'draft',
  createdAt: 1,
  updatedAt: 1,
} as const

const PLAN_SNAPSHOT = {
  schemaVersion: 1,
  hostInstanceId: HOST_ID,
  hostStartedAt: 1,
  revision: 1,
  capturedAt: 2,
  durability: 'host-only',
  plans: [PLAN_REVISION],
} as const

const CAPABILITIES = {
  schemaVersion: 1,
  capturedAt: 1,
  digest: 'enforced-digest',
  catalogDigest: 'catalog-digest',
  scopeStatus: 'available',
  adapters: { workflow: true, agentTeam: false },
  transportProviders: [{
    name: 'native',
    inheritsParentContext: false,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
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
    requests: 'unsupported',
    tokens: 'unsupported',
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
  limits: { maxAgents: 32, maxConcurrent: 4 },
  experimentalAgentTeam: false,
} as const

const PREFLIGHT = {
  planId: PLAN_ID,
  revision: 1,
  capabilityDigest: 'enforced-digest',
  resolvedBackend: 'workflow',
  valid: true,
  diagnostics: [],
  parallelWaves: [['review']],
} as const

const EXECUTION_SNAPSHOT = {
  schemaVersion: 1,
  hostInstanceId: HOST_ID,
  hostStartedAt: 1,
  revision: 2,
  capturedAt: 3,
  durability: 'host-only',
  executions: [{
    executionId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 1,
    parentSessionId: 'parent',
    backend: 'workflow',
    capabilityDigest: 'enforced-digest',
    status: 'running',
    cancellationRequested: false,
    createdAt: 1,
    startedAt: 2,
    bindings: [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'review',
      attemptId: '6a7d3945-30dd-441c-a8bf-150b7969866c',
      attemptNumber: 1,
      status: 'running',
      workflowSeq: 0,
      childId: 'child-1',
      startedAt: 2,
    }],
  }],
} as const

function bench(options: {
  readonly capabilities?: unknown
  readonly executeToolName?: string
} = {}) {
  const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  const call = vi.fn(async (
    _channel: string,
    endpoint: string,
    _payload: unknown,
    _signal: AbortSignal,
  ): Promise<{ ok: true; value: unknown }> => {
    switch (endpoint) {
      case 'planner.list':
      case 'planner.watch': return { ok: true, value: PLAN_SNAPSHOT }
      case 'planner.save':
      case 'planner.approve': return { ok: true, value: PLAN_REVISION }
      case 'planner.capabilities': return { ok: true, value: options.capabilities ?? CAPABILITIES }
      case 'planner.preflight': return { ok: true, value: PREFLIGHT }
      case 'planner.executions.list':
      case 'planner.executions.watch': return { ok: true, value: EXECUTION_SNAPSHOT }
      case 'planner.executions.cancel': return { ok: true, value: { status: 'requested' } }
      case 'planner.executions.grant': return {
        ok: true,
        value: {
          grantId: GRANT_ID,
          parentSessionId: 'parent',
          planId: PLAN_ID,
          revision: 1,
          capabilityDigest: 'enforced-digest',
          executeToolName: options.executeToolName ?? 'execute_subagent_plan',
          expiresAt: Date.now() + 60_000,
        },
      }
      default: throw new Error(`unexpected endpoint: ${endpoint}`)
    }
  })
  let entry: { options: Record<string, unknown>; component: unknown } | undefined
  const ctx = {
    get(name: string) {
      if (name === 'connection') return { rpc: { call } }
      if (name === 'sessions') return {
        binding: vi.fn(() => ({ session: { prompt } })),
      }
      throw new Error(`unexpected service: ${name}`)
    },
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (() => 'Subagents')),
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
  apply(ctx as never)
  expect(entry?.component).toBe(SubagentWorkbenchView)
  const injected = (entry?.options.inject as unknown as (
    id: SessionId,
  ) => ProductSubagentWorkbenchInjected)('parent' as SessionId)
  return { call, injected, prompt }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('browser planner RPC injection', () => {
  it('validates every planner response and preserves cursors and cancellation', async () => {
    const { call, injected } = bench()
    const signal = new AbortController().signal

    await expect(injected.listPlans(['parent' as SessionId], signal)).resolves.toEqual(PLAN_SNAPSHOT)
    await expect(injected.watchPlans(
      ['parent' as SessionId],
      HOST_ID,
      1,
      signal,
    )).resolves.toEqual(PLAN_SNAPSHOT)
    await expect(injected.savePlan({
      parentSessionId: 'parent',
      expectedRevision: 0,
      content: PLAN_CONTENT,
    }, signal)).resolves.toEqual(PLAN_REVISION)
    await expect(injected.getExecutionCapabilities('parent' as SessionId, signal))
      .resolves.toEqual(CAPABILITIES)
    await expect(injected.preflightPlan({
      parentSessionId: 'parent',
      planId: PLAN_ID,
      revision: 1,
    }, signal))
      .resolves.toEqual(PREFLIGHT)
    await expect(injected.approvePlan({
      parentSessionId: 'parent',
      planId: PLAN_ID,
      revision: 1,
      capabilityDigest: 'enforced-digest',
      acceptedWarningIds: [],
    }, signal)).resolves.toEqual(PLAN_REVISION)
    await expect(injected.listPlanExecutions(['parent' as SessionId], signal))
      .resolves.toEqual(EXECUTION_SNAPSHOT)
    await expect(injected.watchPlanExecutions(
      ['parent' as SessionId],
      HOST_ID,
      2,
      signal,
    )).resolves.toEqual(EXECUTION_SNAPSHOT)
    expect(call).toHaveBeenNthCalledWith(
      2,
      '/product-subagent-console',
      'planner.watch',
      {
        parentSessionIds: ['parent'],
        hostInstanceId: HOST_ID,
        afterRevision: 1,
        timeoutMs: 25_000,
      },
      signal,
    )
    expect(call.mock.calls.every(args => args[3] === signal)).toBe(true)
  })

  it('queues plan generation as a visible prompt on the current session', async () => {
    const { injected, prompt } = bench()
    const signal = new AbortController().signal

    await injected.requestPlanDesign('parent' as SessionId, '检查发布质量', signal)

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(
      [{
        type: 'text',
        text: expect.stringContaining('目标：检查发布质量'),
      }],
      'queue',
      signal,
    )
    expect(prompt.mock.calls[0]?.[0]?.[0]?.text).toContain('design_subagent_plan')
    expect(prompt.mock.calls[0]?.[0]?.[0]?.text).toContain('不要启动任何子代理')
  })

  it('queues exact approved-plan execution as a visible prompt', async () => {
    const { injected, prompt } = bench()
    const signal = new AbortController().signal

    await injected.requestPlanExecution('parent' as SessionId, {
      parentSessionId: 'parent',
      planId: PLAN_ID,
      revision: 1,
    }, signal)

    expect(prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: expect.stringContaining('execute_subagent_plan') }],
      'queue',
      signal,
    )
    const text = prompt.mock.calls[0]?.[0]?.[0]?.text
    expect(text).toContain(`plan_id=${PLAN_ID}`)
    expect(text).toContain('revision=1')
    expect(text).toContain('不要改用其他修订')
  })

  it('uses configured planner tool names in both visible prompts', async () => {
    const customCapabilities = {
      ...CAPABILITIES,
      tools: ['compose_agent_work', 'run_agent_work'],
      plannerTools: {
        design: ['compose_agent_work'],
        execute: ['run_agent_work'],
      },
    }
    const { injected, prompt } = bench({
      capabilities: customCapabilities,
      executeToolName: 'run_agent_work',
    })
    const signal = new AbortController().signal

    await injected.requestPlanDesign('parent' as SessionId, '检查发布质量', signal)
    expect(prompt.mock.calls[0]?.[0]?.[0]?.text).toContain('compose_agent_work')
    prompt.mockClear()
    await injected.requestPlanExecution('parent' as SessionId, {
      parentSessionId: 'parent',
      planId: PLAN_ID,
      revision: 1,
    }, signal)
    expect(prompt.mock.calls[0]?.[0]?.[0]?.text).toContain('run_agent_work')
  })

  it('rejects cross-session visible planner requests', async () => {
    const { injected, prompt } = bench()
    const signal = new AbortController().signal

    await expect(injected.requestPlanDesign('other' as SessionId, '目标', signal))
      .rejects.toThrow('does not match current session')
    await expect(injected.requestPlanExecution('parent' as SessionId, {
      parentSessionId: 'other',
      planId: PLAN_ID,
      revision: 1,
    }, signal)).rejects.toThrow('does not belong to current session')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('never queues a late prompt after its preceding RPC is aborted', async () => {
    const { call, injected, prompt } = bench()

    const designRpc = deferred<{ ok: true; value: unknown }>()
    call.mockImplementationOnce(async () => designRpc.promise)
    const designController = new AbortController()
    const design = injected.requestPlanDesign('parent' as SessionId, '检查发布质量', designController.signal)
    designController.abort()
    designRpc.resolve({ ok: true, value: CAPABILITIES })
    await expect(design).rejects.toMatchObject({ name: 'AbortError' })
    expect(prompt).not.toHaveBeenCalled()

    const executionRpc = deferred<{ ok: true; value: unknown }>()
    call.mockImplementationOnce(async () => executionRpc.promise)
    const executionController = new AbortController()
    const execution = injected.requestPlanExecution('parent' as SessionId, {
      parentSessionId: 'parent', planId: PLAN_ID, revision: 1,
    }, executionController.signal)
    executionController.abort()
    executionRpc.resolve({
      ok: true,
      value: {
        grantId: GRANT_ID,
        parentSessionId: 'parent',
        planId: PLAN_ID,
        revision: 1,
        capabilityDigest: 'enforced-digest',
        executeToolName: 'execute_subagent_plan',
        expiresAt: Date.now() + 60_000,
      },
    })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    expect(prompt).not.toHaveBeenCalled()

    const inspectRpc = deferred<{ ok: true; value: unknown }>()
    call.mockImplementationOnce(async () => inspectRpc.promise)
    const inspectController = new AbortController()
    const ask = injected.askRun('parent' as SessionId, {
      parentSessionId: 'parent', runId: EXECUTION_ID, kind: 'summary',
    }, 'What happened?', inspectController.signal)
    inspectController.abort()
    inspectRpc.resolve({
      ok: true,
      value: {
        schemaVersion: 1,
        queryId: `sha256:${'a'.repeat(64)}`,
        parentSessionId: 'parent',
        runId: EXECUTION_ID,
        kind: 'summary',
        throughCursor: 0,
        state: 'unknown',
        answerCode: 'insufficient-evidence',
        facts: [],
        hypotheses: [],
      },
    })
    await expect(ask).rejects.toMatchObject({ name: 'AbortError' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('rejects an invalid planner payload at the client boundary', async () => {
    const { call, injected } = bench()
    call.mockResolvedValueOnce({ ok: true, value: { schemaVersion: 999 } })

    await expect(injected.listPlans(
      ['parent' as SessionId],
      new AbortController().signal,
    )).rejects.toThrow()
  })

  it('preserves only allowlisted planner reasons without exposing Host messages', async () => {
    const { call, injected } = bench()
    const signal = new AbortController().signal
    for (const reason of plannerRpcReasonSchema.options) {
      call.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'command-error',
          message: `[${reason}] sensitive Host detail`,
          details: {},
        },
      } as never)

      const known = await injected.requestPlanExecution('parent' as SessionId, {
        parentSessionId: 'parent',
        planId: PLAN_ID,
        revision: 1,
      }, signal).catch((error: unknown) => error)
      expect(known).toBeInstanceOf(Error)
      expect((known as Error).message).toBe(`product-subagent-console RPC failed: ${reason}`)
      expect((known as Error).message).not.toContain('sensitive Host detail')
    }

    call.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'command-error',
        message: '[untrusted-reason] another sensitive Host detail',
        details: {},
      },
    } as never)
    const unknown = await injected.requestPlanExecution('parent' as SessionId, {
      parentSessionId: 'parent',
      planId: PLAN_ID,
      revision: 1,
    }, signal).catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(Error)
    expect((unknown as Error).message).toBe('product-subagent-console RPC failed: command-error')
    expect((unknown as Error).message).not.toContain('another sensitive Host detail')
  })
})
