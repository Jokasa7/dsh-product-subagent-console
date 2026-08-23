import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type {
  ConnectionRpcHandler,
  HostConnectionRpc,
} from '@deepseek-ai/dsh-client-connection'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkflowEngine, {
  WorkflowRunId,
  type WorkflowAgentEndInfo,
  type WorkflowAgentInfo,
  type WorkflowResult,
  type WorkflowRun,
  type WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import ProductSubagentConsoleService from '../src/index.js'
import * as ProductSubagentPlanTool from '../src/plan-tool.js'
import {
  APPROVE_PLAN_ENDPOINT,
  CANCEL_PLAN_EXECUTION_ENDPOINT,
  LIST_PLAN_EXECUTIONS_ENDPOINT,
  PREFLIGHT_PLAN_ENDPOINT,
  WATCH_PLAN_EXECUTIONS_ENDPOINT,
  executionCapabilitySnapshotSchema,
  planExecutionRepositorySnapshotSchema,
  planPreflightResultSchema,
  type AgentPlanContent,
  type AgentPlanRevision,
  type PlanExecutionRepositorySnapshot,
} from '../src/plan-types.js'
import type { WorkflowPlanArgs } from '../src/workflow-adapter.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

class FakeSystemPromptService extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  tools(_render: unknown): () => void { return () => {} }
  section(_section: unknown): () => void { return () => {} }
}

class CapturingConnectionService extends Service {
  handler: ConnectionRpcHandler | undefined

  constructor(ctx: Context) { super(ctx, 'connection') }

  readonly rpc: HostConnectionRpc = {
    handle: (_channel, handler) => {
      this.handler = handler
      return async () => { if (this.handler === handler) this.handler = undefined }
    },
    intercept: () => { throw new Error('not used by this fixture') },
  }

  async call(endpoint: string, payload: unknown, signal = new AbortController().signal) {
    if (this.handler === undefined) throw new Error('RPC handler is not mounted')
    return this.handler(endpoint, payload, signal)
  }
}

class FixtureProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly inheritsParentContext = false
  readonly capabilities = NO_START_CAPABILITIES

  async start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    throw new Error('the fake Workflow engine must not call the transport provider')
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void

  constructor() {
    let settle!: (value: T) => void
    this.promise = new Promise<T>((resolve) => { settle = resolve })
    this.resolve = settle
  }
}

interface ControlledWorkflowRun extends WorkflowRun {
  readonly request: WorkflowStartRequest
  readonly deferred: Deferred<WorkflowResult>
  readonly cancel: ReturnType<typeof vi.fn<(reason?: string) => void>>
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

class ControlledWorkflowEngine extends WorkflowEngine {
  readonly runs: ControlledWorkflowRun[] = []

  start(request: WorkflowStartRequest): WorkflowRun {
    const index = this.runs.length + 1
    const deferred = new Deferred<WorkflowResult>()
    const run: ControlledWorkflowRun = {
      id: WorkflowRunId(`00000000-0000-4000-9000-${String(index).padStart(12, '0')}`),
      meta: request.meta,
      request,
      deferred,
      result: deferred.promise,
      cancel: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    this.runs.push(run)
    return run
  }

  emitAgentStart(index: number, taskId: string, childId: string): void {
    const run = this.requiredRun(index)
    const args = run.request.args as WorkflowPlanArgs
    const agent: WorkflowAgentInfo = {
      seq: 1,
      label: this.requiredLabel(args, taskId),
      childId: SessionId(childId),
    }
    this.emitWorkflowEvent('workflow/agent-start', { id: run.id, meta: run.meta }, agent)
  }

  emitAgentEnd(index: number, taskId: string, childId: string, outcome: WorkflowAgentEndInfo['outcome']): void {
    const run = this.requiredRun(index)
    const args = run.request.args as WorkflowPlanArgs
    const agent: WorkflowAgentEndInfo = {
      seq: 1,
      label: this.requiredLabel(args, taskId),
      childId: SessionId(childId),
      outcome,
    }
    this.emitWorkflowEvent('workflow/agent-end', { id: run.id, meta: run.meta }, agent)
  }

  complete(index: number): void {
    const run = this.requiredRun(index)
    const args = run.request.args as WorkflowPlanArgs
    run.deferred.resolve({
      value: {
        schemaVersion: 1,
        tasks: args.tasks.map(task => ({ taskId: task.taskId, status: 'completed' })),
      },
      stopReason: 'completed',
      agentsStarted: args.tasks.length,
    })
  }

  cancelResult(index: number): void {
    const run = this.requiredRun(index)
    run.deferred.resolve({
      value: null,
      stopReason: 'cancelled',
      error: 'workflow run cancelled by test',
      agentsStarted: 0,
    })
  }

  private requiredRun(index: number): ControlledWorkflowRun {
    const run = this.runs[index]
    if (run === undefined) throw new Error(`missing Workflow run ${String(index)}`)
    return run
  }

  private requiredLabel(args: WorkflowPlanArgs, taskId: string): string {
    const label = args.labels[taskId]
    if (label === undefined) throw new Error(`missing Workflow label for ${taskId}`)
    return label
  }
}

function parent(id = 'plan-parent'): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, session: { id: sessionId } } as Agent
}

function planContent(objective = 'Inspect two areas and synthesize the factual result.'): AgentPlanContent {
  return {
    title: 'Approved execution fixture',
    objective,
    successCriteria: ['Both inspections are represented in the synthesis.'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'The two inspections can run independently.',
      singleAgentAlternative: 'Inspect both areas sequentially.',
      userOverride: false,
    },
    pattern: 'parallel-fanout-fanin',
    optimizationTarget: 'latency',
    backendPreference: 'workflow',
    budget: { maxAgents: 3, maxConcurrent: 2, planTimeoutMs: 60_000 },
    roles: [{
      roleId: 'worker',
      name: 'Worker',
      responsibility: 'Complete one bounded inspection.',
      boundaries: [],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'left',
      title: 'Inspect left',
      brief: 'Inspect the left area.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'Left findings.' },
      completionCriteria: ['Findings are factual.'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'right',
      title: 'Inspect right',
      brief: 'Inspect the right area.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'Right findings.' },
      completionCriteria: ['Findings are factual.'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'synthesis',
      title: 'Synthesize',
      brief: 'Synthesize both findings.',
      roleId: 'worker',
      dependsOn: [
        { taskId: 'left', mode: 'context' },
        { taskId: 'right', mode: 'context' },
      ],
      expectedOutput: { description: 'Combined result.' },
      completionCriteria: ['Both inputs are represented.'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

interface Fixture {
  readonly ctx: Context
  readonly service: ProductSubagentConsoleService
  readonly connection: CapturingConnectionService
  readonly workflow: ControlledWorkflowEngine
  readonly workflowFiber: ReturnType<Context['plugin']>
}

async function harness(planTools: { readonly toolName?: string; readonly executeToolName?: string } = {}): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry).await()
  await ctx.plugin(FakeSystemPromptService).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(SubagentRuntime).await()
  await ctx.plugin(CapturingConnectionService).await()
  const workflowFiber = ctx.plugin(ControlledWorkflowEngine)
  await workflowFiber.await()
  await ctx.plugin(ProductSubagentConsoleService).await()
  ctx.agents.register(parent())
  ctx.subagents.registerProvider(new FixtureProvider())
  await ctx.plugin(ProductSubagentPlanTool, planTools).await()
  return {
    ctx,
    service: ctx.productSubagentConsole,
    connection: ctx.get('connection') as unknown as CapturingConnectionService,
    workflow: ctx.workflowEngine as ControlledWorkflowEngine,
    workflowFiber,
  }
}

async function approve(
  fixture: Fixture,
  content: AgentPlanContent = planContent(),
  parentSessionId = 'plan-parent',
): Promise<AgentPlanRevision> {
  const draft = fixture.service.savePlanDraft({ parentSessionId, content, expectedRevision: 0 })
  const capabilities = executionCapabilitySnapshotSchema.parse(
    await fixture.service.executionCapabilities(parentSessionId),
  )
  expect(capabilities.adapters.workflow).toBe(true)
  const preflightResponse = await fixture.connection.call(PREFLIGHT_PLAN_ENDPOINT, {
    parentSessionId,
    planId: draft.planId,
    revision: draft.revision,
  })
  if (!preflightResponse.ok) throw new Error(`preflight failed: ${preflightResponse.error.message}`)
  const preflight = planPreflightResultSchema.parse(preflightResponse.value)
  expect(preflight.valid).toBe(true)
  const acceptedWarningIds = preflight.diagnostics
    .filter(item => item.severity === 'warning')
    .map(item => item.diagnosticId)
  const approvedResponse = await fixture.connection.call(APPROVE_PLAN_ENDPOINT, {
    parentSessionId,
    planId: draft.planId,
    revision: draft.revision,
    capabilityDigest: capabilities.digest,
    acceptedWarningIds,
  })
  if (!approvedResponse.ok) throw new Error(`approval failed: ${approvedResponse.error.message}`)
  return approvedResponse.value as AgentPlanRevision
}

function executePlan(
  fixture: Fixture,
  planId: string,
  revision: number,
  grantId: string,
  parentSessionId = 'plan-parent',
) {
  return fixture.ctx.tools.execute({
    callId: CallId(`execute-${String(revision)}`),
    name: 'execute_subagent_plan',
    arguments: { plan_id: planId, revision, grant_id: grantId },
    agent: parent(parentSessionId),
    signal: new AbortController().signal,
  })
}

async function executeWithGrant(
  fixture: Fixture,
  planId: string,
  revision: number,
  parentSessionId = 'plan-parent',
) {
  const grant = await fixture.service.issuePlanExecutionGrant(parentSessionId, planId, revision)
  return executePlan(fixture, planId, revision, grant.grantId, parentSessionId)
}

async function executionList(
  fixture: Fixture,
  parentSessionIds: readonly string[],
): Promise<PlanExecutionRepositorySnapshot> {
  const response = await fixture.connection.call(LIST_PLAN_EXECUTIONS_ENDPOINT, { parentSessionIds })
  if (!response.ok) throw new Error(response.error.message)
  return planExecutionRepositorySnapshotSchema.parse(response.value)
}

describe('approved Agent plan Host/tool execution chain', () => {
  it('rejects drafts and mismatched revisions, then executes only the exact approved revision', async () => {
    const fixture = await harness()
    const draft = fixture.service.savePlanDraft({
      parentSessionId: 'plan-parent',
      content: planContent(),
      expectedRevision: 0,
    })

    await expect(fixture.service.issuePlanExecutionGrant(
      'plan-parent', draft.planId, draft.revision,
    )).rejects.toThrow('only an approved Agent plan revision can receive an execution grant')
    expect(fixture.workflow.runs).toHaveLength(0)

    const capabilities = await fixture.service.executionCapabilities('plan-parent')
    const preflightResponse = await fixture.connection.call(PREFLIGHT_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: draft.planId,
      revision: draft.revision,
    })
    if (!preflightResponse.ok) throw new Error(preflightResponse.error.message)
    const preflight = planPreflightResultSchema.parse(preflightResponse.value)
    const approvedResponse = await fixture.connection.call(APPROVE_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: draft.planId,
      revision: draft.revision,
      capabilityDigest: capabilities.digest,
      acceptedWarningIds: preflight.diagnostics.filter(item => item.severity === 'warning').map(item => item.diagnosticId),
    })
    expect(approvedResponse).toMatchObject({ ok: true })

    const second = fixture.service.savePlanDraft({
      parentSessionId: 'plan-parent',
      planId: draft.planId,
      expectedRevision: draft.revision,
      content: planContent('A newer draft that must not run when revision one is requested.'),
    })
    expect(second.revision).toBe(2)
    const mismatchedGrant = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', draft.planId, draft.revision,
    )
    await expect(executePlan(
      fixture, draft.planId, second.revision, mismatchedGrant.grantId,
    )).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('does not match this plan revision') },
    })
    expect(fixture.workflow.runs).toHaveLength(0)

    const exact = executeWithGrant(fixture, draft.planId, draft.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const args = fixture.workflow.runs[0]?.request.args as WorkflowPlanArgs
    expect(args.objective).toBe(planContent().objective)
    fixture.workflow.complete(0)
    await expect(exact).resolves.toMatchObject({
      isError: false,
      value: {
        planId: draft.planId,
        revision: 1,
        status: 'succeeded',
        completed: 3,
      },
    })
  })

  it('rejects execution when the optional Workflow adapter is unavailable', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const grant = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )
    await fixture.workflowFiber.dispose()
    await expect(executePlan(
      fixture, approved.planId, approved.revision, grant.grantId,
    )).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('Workflow execution is unavailable') },
    })
    expect(fixture.workflow.runs).toHaveLength(0)
  })

  it('lists and long-polls session-isolated execution snapshots', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const running = executeWithGrant(fixture, approved.planId, approved.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })

    const initial = await executionList(fixture, ['plan-parent'])
    expect(initial.executions).toEqual([
      expect.objectContaining({
        planId: approved.planId,
        planRevision: approved.revision,
        parentSessionId: 'plan-parent',
        status: 'running',
      }),
    ])
    expect((await executionList(fixture, ['other-parent'])).executions).toEqual([])

    let watchSettled = false
    const watch = fixture.connection.call(WATCH_PLAN_EXECUTIONS_ENDPOINT, {
      parentSessionIds: ['plan-parent'],
      hostInstanceId: initial.hostInstanceId,
      afterRevision: initial.revision,
      timeoutMs: 30_000,
    }).then((value) => {
      watchSettled = true
      return value
    })
    await Promise.resolve()
    expect(watchSettled).toBe(false)

    fixture.workflow.emitAgentStart(0, 'left', 'child-left')
    const watched = await watch
    if (!watched.ok) throw new Error(watched.error.message)
    const snapshot = planExecutionRepositorySnapshotSchema.parse(watched.value)
    expect(snapshot.revision).toBeGreaterThan(initial.revision)
    expect(snapshot.executions[0]?.bindings).toContainEqual(expect.objectContaining({
      taskId: 'left',
      status: 'running',
      childId: 'child-left',
      workflowSeq: 1,
    }))

    fixture.workflow.emitAgentEnd(0, 'left', 'child-left', 'completed')
    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false })
    const terminal = await executionList(fixture, ['plan-parent'])
    expect(terminal.executions[0]?.status).toBe('succeeded')
  })

  it('routes cancellation by parent Session and reports terminal cancellation', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const running = executeWithGrant(fixture, approved.planId, approved.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const listed = await executionList(fixture, ['plan-parent'])
    const executionId = listed.executions[0]?.executionId
    if (executionId === undefined) throw new Error('fixture execution missing')

    await expect(fixture.connection.call(CANCEL_PLAN_EXECUTION_ENDPOINT, {
      parentSessionId: 'other-parent',
      executionId,
      reason: 'wrong owner',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'command-error', message: expect.stringContaining('[forbidden]') },
    })
    expect(fixture.workflow.runs[0]?.cancel).not.toHaveBeenCalled()

    await expect(fixture.connection.call(CANCEL_PLAN_EXECUTION_ENDPOINT, {
      parentSessionId: 'plan-parent',
      executionId,
      reason: 'user requested stop',
    })).resolves.toEqual({ ok: true, value: { status: 'requested' } })
    expect(fixture.workflow.runs[0]?.cancel).toHaveBeenCalledWith('user requested stop')

    fixture.workflow.cancelResult(0)
    await expect(running).resolves.toMatchObject({
      isError: false,
      value: { status: 'cancelled' },
    })
    await expect(fixture.connection.call(CANCEL_PLAN_EXECUTION_ENDPOINT, {
      parentSessionId: 'plan-parent',
      executionId,
    })).resolves.toEqual({ ok: true, value: { status: 'already-terminal' } })
  })

  it('reuses one queued grant for duplicate requests and consumes it exactly once', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const first = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )
    const repeated = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )
    expect(repeated).toEqual(first)

    const running = executePlan(fixture, approved.planId, approved.revision, first.grantId)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    await expect(executePlan(
      fixture, approved.planId, approved.revision, repeated.grantId,
    )).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('valid execution grant is required') },
    })
    await expect(fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )).rejects.toThrow('already has an active execution')
    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false })
  })

  it('keeps a user grant valid behind a multi-minute conversation queue and still expires it later', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const base = 10_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(base)
    try {
      const queuedGrant = await fixture.service.issuePlanExecutionGrant(
        'plan-parent', approved.planId, approved.revision,
      )
      now.mockReturnValue(base + 3 * 60_000)
      const running = executePlan(
        fixture, approved.planId, approved.revision, queuedGrant.grantId,
      )
      await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
      fixture.workflow.complete(0)
      await expect(running).resolves.toMatchObject({ isError: false })

      const expiringGrant = await fixture.service.issuePlanExecutionGrant(
        'plan-parent', approved.planId, approved.revision,
      )
      now.mockReturnValue(expiringGrant.expiresAt + 1)
      await expect(executePlan(
        fixture, approved.planId, approved.revision, expiringGrant.grantId,
      )).resolves.toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('valid execution grant is required') },
      })
    } finally {
      now.mockRestore()
    }
  })

  it('advertises and grants the exact configured planner tool names', async () => {
    const fixture = await harness({
      toolName: 'compose_agent_work',
      executeToolName: 'run_agent_work',
    })
    const approved = await approve(fixture)
    const capabilities = await fixture.service.executionCapabilities('plan-parent')
    expect(capabilities.plannerTools).toEqual({
      design: ['compose_agent_work'],
      execute: ['run_agent_work'],
    })
    expect(capabilities.tools).toEqual(expect.arrayContaining(['compose_agent_work', 'run_agent_work']))
    await expect(fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )).resolves.toMatchObject({ executeToolName: 'run_agent_work' })
  })
})
