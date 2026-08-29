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
import { FoundryLedgerCapacityError } from '../src/event-ledger.js'
import { buildRecipeCandidate } from '../src/recipe.js'
import * as ProductSubagentPlanTool from '../src/plan-tool.js'
import {
  EXECUTE_CANCEL_CONTROL_ENDPOINT,
  ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT,
  foundryControlGrantSchema,
  foundrySnapshotSchema,
  INSTANTIATE_RECIPE_ENDPOINT,
  instantiateRecipeResultSchema,
} from '../src/foundry-types.js'
import {
  APPROVE_PLAN_ENDPOINT,
  CANCEL_PLAN_EXECUTION_ENDPOINT,
  ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT,
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
import { verifiedRun } from './foundry-fixtures.js'

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
  readonly planToolFiber: ReturnType<Context['plugin']>
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
  await ctx.plugin(ProductSubagentConsoleService, { foundryStorage: false }).await()
  ctx.agents.register(parent())
  ctx.subagents.registerProvider(new FixtureProvider())
  const planToolFiber = ctx.plugin(ProductSubagentPlanTool, planTools)
  await planToolFiber.await()
  return {
    ctx,
    service: ctx.productSubagentConsole,
    connection: ctx.get('connection') as unknown as CapturingConnectionService,
    workflow: ctx.workflowEngine as ControlledWorkflowEngine,
    workflowFiber,
    planToolFiber,
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
  it('refuses both grant issuance and exact execution before Workflow start when Foundry capacity is exhausted', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const foundry = (fixture.service as unknown as {
      readonly foundry: { assertCanStartExecution(requiredEventSlots?: number, requiredReceiptSlots?: number): void }
    }).foundry
    const capacity = vi.spyOn(foundry, 'assertCanStartExecution')
      .mockImplementation(() => { throw new FoundryLedgerCapacityError('event') })

    await expect(fixture.connection.call(ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: approved.planId,
      revision: approved.revision,
    })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/^\[capacity-reached\]/u) },
    })
    expect(fixture.workflow.runs).toHaveLength(0)

    capacity.mockRestore()
    const grant = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )
    vi.spyOn(foundry, 'assertCanStartExecution')
      .mockImplementation(() => { throw new FoundryLedgerCapacityError('execution') })
    await expect(executePlan(
      fixture, approved.planId, approved.revision, grant.grantId,
    )).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('execution history capacity reached') },
    })
    expect(fixture.workflow.runs).toHaveLength(0)
  })

  it('holds future execution facts against concurrent capacity checks and releases them at terminal', async () => {
    const fixture = await harness()
    const first = await approve(fixture)
    const running = executeWithGrant(fixture, first.planId, first.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const internals = fixture.service as unknown as {
      reservedExecutionFacts(): { readonly events: number; readonly receipts: number }
      readonly foundry: { assertCanStartExecution(events?: number, receipts?: number): void }
    }
    expect(internals.reservedExecutionFacts().events).toBeGreaterThan(0)

    const second = await approve(fixture, planContent('Run an independent second approved plan.'))
    const capacity = vi.spyOn(internals.foundry, 'assertCanStartExecution')
    await fixture.service.issuePlanExecutionGrant('plan-parent', second.planId, second.revision)
    const latest = capacity.mock.calls.at(-1)
    expect(latest?.[0]).toBeGreaterThan(6 + planContent().tasks.length * 10)

    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false })
    expect(internals.reservedExecutionFacts()).toEqual({ events: 0, receipts: 0 })
  })

  it('instantiates a verified Recipe only as a new draft and runs current preflight', async () => {
    const fixture = await harness()
    const runs = [verifiedRun(50), verifiedRun(51), verifiedRun(52)]
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'plan-parent', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => ({ ...run.plan, parentSessionId: 'plan-parent' })),
      executions: runs.map(run => ({ ...run.execution, parentSessionId: 'plan-parent' })),
      reports: runs.map(run => ({ ...run.report, parentSessionId: 'plan-parent' })),
      receipts: runs.map(run => ({ ...run.receipt, parentSessionId: 'plan-parent' })),
      events: runs.flatMap(run => run.events.map(event => ({ ...event, parentSessionId: 'plan-parent' }))),
    })
    vi.spyOn(fixture.service, 'previewRecipe').mockReturnValue(candidate)

    const response = await fixture.connection.call(INSTANTIATE_RECIPE_ENDPOINT, {
      parentSessionId: 'plan-parent',
      executionIds: runs.map(run => run.execution.executionId),
      candidateId: candidate.candidateId,
      objective: 'Review the current release candidate.',
    })
    if (!response.ok) throw new Error(response.error.message)
    const result = instantiateRecipeResultSchema.parse(response.value)
    expect(result.plan).toMatchObject({
      parentSessionId: 'plan-parent',
      state: 'draft',
      revision: 1,
      objective: 'Review the current release candidate.',
    })
    expect(result.preflight.planId).toBe(result.plan.planId)
    expect(fixture.service.planSnapshot(['plan-parent']).plans).toContainEqual(result.plan)
    expect(fixture.workflow.runs).toHaveLength(0)

    const before = fixture.service.planSnapshot(['plan-parent']).plans.length
    await expect(fixture.connection.call(INSTANTIATE_RECIPE_ENDPOINT, {
      parentSessionId: 'plan-parent',
      executionIds: runs.map(run => run.execution.executionId),
      candidateId: 'sha256:'.padEnd(71, '0'),
      objective: 'Must not be saved.',
    })).resolves.toMatchObject({ ok: false })
    expect(fixture.service.planSnapshot(['plan-parent']).plans).toHaveLength(before)
  })

  it('does not save a Recipe draft when capability discovery finishes after cancellation', async () => {
    const fixture = await harness()
    const runs = [verifiedRun(53), verifiedRun(54), verifiedRun(55)]
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'plan-parent', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => ({ ...run.plan, parentSessionId: 'plan-parent' })),
      executions: runs.map(run => ({ ...run.execution, parentSessionId: 'plan-parent' })),
      reports: runs.map(run => ({ ...run.report, parentSessionId: 'plan-parent' })),
      receipts: runs.map(run => ({ ...run.receipt, parentSessionId: 'plan-parent' })),
      events: runs.flatMap(run => run.events.map(event => ({ ...event, parentSessionId: 'plan-parent' }))),
    })
    const capabilities = await fixture.service.executionCapabilities('plan-parent')
    const pendingCapabilities = new Deferred<typeof capabilities>()
    vi.spyOn(fixture.service, 'previewRecipe').mockReturnValue(candidate)
    vi.spyOn(fixture.service, 'executionCapabilities').mockImplementation(async () => pendingCapabilities.promise)
    const controller = new AbortController()
    const before = fixture.service.planSnapshot(['plan-parent']).plans.length

    const result = fixture.service.instantiateRecipe({
      parentSessionId: 'plan-parent',
      executionIds: runs.map(run => run.execution.executionId),
      candidateId: candidate.candidateId,
      objective: 'This draft must not be saved after cancellation.',
    }, controller.signal)
    controller.abort()
    pendingCapabilities.resolve(capabilities)

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.service.planSnapshot(['plan-parent']).plans).toHaveLength(before)
  })

  it('does not approve, grant, or start a Workflow after cancelled capability discovery', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const capabilities = await fixture.service.executionCapabilities('plan-parent')

    const approvalDraft = fixture.service.savePlanDraft({
      parentSessionId: 'plan-parent',
      expectedRevision: 0,
      content: planContent('This revision must remain a draft after cancellation.'),
    })
    const preflightResponse = await fixture.connection.call(PREFLIGHT_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: approvalDraft.planId,
      revision: approvalDraft.revision,
    })
    if (!preflightResponse.ok) throw new Error(preflightResponse.error.message)
    const approvalPreflight = planPreflightResultSchema.parse(preflightResponse.value)
    const approvalCapabilities = new Deferred<typeof capabilities>()
    const approvalSpy = vi.spyOn(fixture.service, 'executionCapabilities')
      .mockImplementation(async () => approvalCapabilities.promise)
    const approvalController = new AbortController()
    const approval = fixture.connection.call(APPROVE_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: approvalDraft.planId,
      revision: approvalDraft.revision,
      capabilityDigest: capabilities.digest,
      acceptedWarningIds: approvalPreflight.diagnostics
        .filter(item => item.severity === 'warning')
        .map(item => item.diagnosticId),
    }, approvalController.signal)
    approvalController.abort()
    approvalCapabilities.resolve(capabilities)
    await expect(approval).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(fixture.service.planSnapshot(['plan-parent']).plans.find(
      plan => plan.planId === approvalDraft.planId && plan.revision === approvalDraft.revision,
    )?.state).toBe('draft')
    approvalSpy.mockRestore()

    const grantCapabilities = new Deferred<typeof capabilities>()
    const grantSpy = vi.spyOn(fixture.service, 'executionCapabilities')
      .mockImplementation(async () => grantCapabilities.promise)
    const grantController = new AbortController()
    const cancelledGrant = fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision, grantController.signal,
    )
    grantController.abort()
    grantCapabilities.resolve(capabilities)
    await expect(cancelledGrant).rejects.toMatchObject({ name: 'AbortError' })
    expect((fixture.service as unknown as { executionGrants: Map<string, unknown> }).executionGrants.size).toBe(0)
    grantSpy.mockRestore()

    const validGrant = await fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )
    const executionCapabilities = new Deferred<typeof capabilities>()
    const executionSpy = vi.spyOn(fixture.service, 'executionCapabilities')
      .mockImplementation(async () => executionCapabilities.promise)
    const executionController = new AbortController()
    const cancelledExecution = fixture.service.executeApprovedPlan(
      parent(), approved.planId, approved.revision, validGrant.grantId, executionController.signal,
    )
    executionController.abort()
    executionCapabilities.resolve(capabilities)
    await expect(cancelledExecution).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.workflow.runs).toHaveLength(0)
    executionSpy.mockRestore()
    await expect(fixture.service.issuePlanExecutionGrant(
      'plan-parent', approved.planId, approved.revision,
    )).resolves.toBeDefined()
  })

  it('keeps a Recipe draft when current permission preflight blocks it without approving or executing', async () => {
    const fixture = await harness()
    const runs = [verifiedRun(60), verifiedRun(61), verifiedRun(62)]
    const plans = runs.map(run => ({
      ...run.plan,
      parentSessionId: 'plan-parent',
      roles: run.plan.roles.map(role => ({
        ...role,
        toolPolicy: { mode: 'allowlist' as const, tools: ['read_file'] },
      })),
    }))
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'plan-parent', executionIds: runs.map(run => run.execution.executionId) },
      plans,
      executions: runs.map(run => ({ ...run.execution, parentSessionId: 'plan-parent' })),
      reports: runs.map(run => ({ ...run.report, parentSessionId: 'plan-parent' })),
      receipts: runs.map(run => ({ ...run.receipt, parentSessionId: 'plan-parent' })),
      events: runs.flatMap(run => run.events.map(event => ({ ...event, parentSessionId: 'plan-parent' }))),
    })
    vi.spyOn(fixture.service, 'previewRecipe').mockReturnValue(candidate)
    const result = await fixture.service.instantiateRecipe({
      parentSessionId: 'plan-parent',
      executionIds: runs.map(run => run.execution.executionId),
      candidateId: candidate.candidateId,
      objective: 'Use a restricted tool list.',
    }, new AbortController().signal)

    expect(result.plan.state).toBe('draft')
    expect(result.preflight.valid).toBe(false)
    expect(fixture.service.planSnapshot(['plan-parent']).plans).toContainEqual(result.plan)
    expect(fixture.workflow.runs).toHaveLength(0)
  })

  it('returns a stable safe RPC reason when the current preset loses the execution tool', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    await fixture.planToolFiber.dispose()

    await expect(fixture.connection.call(ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: approved.planId,
      revision: approved.revision,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'command-error',
        message: expect.stringMatching(/^\[execution-tool-unavailable\]/u),
        details: {},
      },
    })
  })

  it('recovers from changed capabilities only through a new preflighted and approved revision', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    fixture.ctx.subagents.registerProvider({
      name: 'additional-provider',
      inheritsParentContext: false,
      capabilities: NO_START_CAPABILITIES,
      async start() {
        throw new Error('the additional fixture provider must not be started')
      },
    })

    await expect(fixture.connection.call(ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: approved.planId,
      revision: approved.revision,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'command-error',
        message: expect.stringMatching(/^\[stale-capabilities\]/u),
        details: {},
      },
    })

    const next = fixture.service.savePlanDraft({
      parentSessionId: 'plan-parent',
      planId: approved.planId,
      expectedRevision: approved.revision,
      content: planContent('Revalidate the same work against the changed capability set.'),
    })
    const capabilities = await fixture.service.executionCapabilities('plan-parent')
    const preflightResponse = await fixture.connection.call(PREFLIGHT_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: next.planId,
      revision: next.revision,
    })
    if (!preflightResponse.ok) throw new Error(preflightResponse.error.message)
    const preflight = planPreflightResultSchema.parse(preflightResponse.value)
    expect(preflight.valid).toBe(true)
    const approvalResponse = await fixture.connection.call(APPROVE_PLAN_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: next.planId,
      revision: next.revision,
      capabilityDigest: capabilities.digest,
      acceptedWarningIds: preflight.diagnostics
        .filter(item => item.severity === 'warning')
        .map(item => item.diagnosticId),
    })
    expect(approvalResponse).toMatchObject({
      ok: true,
      value: { revision: next.revision, state: 'approved' },
    })
    await expect(fixture.connection.call(ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      planId: next.planId,
      revision: next.revision,
    })).resolves.toMatchObject({
      ok: true,
      value: { planId: next.planId, revision: next.revision },
    })
  })

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
    expect(args.successCriteria).toEqual(planContent().successCriteria)
    expect(args.tasks.map(task => task.brief)).toEqual(planContent().tasks.map(task => task.brief))
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
    const foundry = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['plan-parent']))
    expect(foundry.events).toContainEqual(expect.objectContaining({
      source: 'workflow-adapter',
      authority: 'adapter',
      type: 'attempt-started',
      taskId: 'left',
      configuration: {
        transportProvider: 'spawn',
        toolPolicyMode: 'inherit',
      },
    }))

    fixture.workflow.emitAgentEnd(0, 'left', 'child-left', 'completed')
    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false })
    const terminal = await executionList(fixture, ['plan-parent'])
    expect(terminal.executions[0]?.status).toBe('succeeded')
  })

  it('rejects the legacy direct-cancel RPC so browser writes cannot bypass a Foundry grant', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const running = executeWithGrant(fixture, approved.planId, approved.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const listed = await executionList(fixture, ['plan-parent'])
    const executionId = listed.executions[0]?.executionId
    if (executionId === undefined) throw new Error('fixture execution missing')

    for (const parentSessionId of ['other-parent', 'plan-parent']) {
      await expect(fixture.connection.call(CANCEL_PLAN_EXECUTION_ENDPOINT, {
        parentSessionId,
        executionId,
        reason: 'legacy direct request',
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'command-error',
          message: expect.stringContaining('[control-grant-required]'),
        },
      })
    }
    expect(fixture.workflow.runs[0]?.cancel).not.toHaveBeenCalled()
    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false, value: { status: 'succeeded' } })
  })

  it('requires an exact, expiring, single-use Foundry grant before cancelling a run', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const running = executeWithGrant(fixture, approved.planId, approved.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const before = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['plan-parent']))
    const execution = before.executions[0]
    const proposal = before.recoveryProposals[0]
    if (execution === undefined || proposal === undefined) throw new Error('fixture Foundry run missing')

    await expect(fixture.connection.call(ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      proposalId: proposal.proposalId,
      eventCursor: Math.max(0, proposal.eventCursor - 1),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'command-error', message: expect.stringContaining('[foundry-operation-failed]') },
    })
    expect(fixture.workflow.runs[0]?.cancel).not.toHaveBeenCalled()

    const grantResponse = await fixture.connection.call(ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      proposalId: proposal.proposalId,
      eventCursor: proposal.eventCursor,
    })
    if (!grantResponse.ok) throw new Error(grantResponse.error.message)
    const grant = foundryControlGrantSchema.parse(grantResponse.value)
    expect(grant).toMatchObject({
      action: 'cancel',
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      proposalId: proposal.proposalId,
    })

    await expect(fixture.connection.call(EXECUTE_CANCEL_CONTROL_ENDPOINT, {
      parentSessionId: 'different-parent',
      runId: execution.executionId,
      grantId: grant.grantId,
    })).resolves.toEqual({ ok: true, value: { status: 'stale-grant' } })
    expect(fixture.workflow.runs[0]?.cancel).not.toHaveBeenCalled()

    await expect(fixture.connection.call(EXECUTE_CANCEL_CONTROL_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      grantId: grant.grantId,
    })).resolves.toEqual({ ok: true, value: { status: 'requested' } })
    expect(fixture.workflow.runs[0]?.cancel).toHaveBeenCalledOnce()
    await expect(fixture.connection.call(EXECUTE_CANCEL_CONTROL_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      grantId: grant.grantId,
    })).resolves.toEqual({ ok: true, value: { status: 'stale-grant' } })

    const after = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['plan-parent']))
    const stoppingProposal = after.recoveryProposals.find(candidate => candidate.runId === execution.executionId)
    if (stoppingProposal === undefined) throw new Error('stopping recovery proposal missing')
    await expect(fixture.connection.call(ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      proposalId: stoppingProposal.proposalId,
      eventCursor: stoppingProposal.eventCursor,
    })).resolves.toMatchObject({ ok: false })
    expect(fixture.workflow.runs[0]?.cancel).toHaveBeenCalledOnce()

    expect(after.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'control-requested',
      'control-consumed',
      'control-result',
    ]))
    expect(JSON.stringify(after)).not.toContain(grant.grantId)
    const requestedEvent = after.events.find(event => event.type === 'control-requested')
    const consumedEvent = after.events.find(event => event.type === 'control-consumed')
    const resultEvent = after.events.find(event => event.type === 'control-result')
    expect(requestedEvent).toBeDefined()
    expect(consumedEvent?.causalParents).toEqual([requestedEvent?.eventId])
    expect(resultEvent?.causalParents).toEqual([consumedEvent?.eventId])
    expect(resultEvent).toMatchObject({
      controlAction: 'cancel',
      controlProposalId: proposal.proposalId,
      controlEventCursor: proposal.eventCursor,
      controlResult: 'requested',
    })
    fixture.workflow.cancelResult(0)
    await expect(running).resolves.toMatchObject({ isError: false, value: { status: 'cancelled' } })
  })

  it('invalidates an owner-matched cancel grant when newer run facts arrive', async () => {
    const fixture = await harness()
    const approved = await approve(fixture)
    const running = executeWithGrant(fixture, approved.planId, approved.revision)
    await vi.waitFor(() => { expect(fixture.workflow.runs).toHaveLength(1) })
    const before = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['plan-parent']))
    const execution = before.executions[0]
    const proposal = before.recoveryProposals[0]
    if (execution === undefined || proposal === undefined) throw new Error('fixture Foundry run missing')
    const granted = await fixture.connection.call(ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      proposalId: proposal.proposalId,
      eventCursor: proposal.eventCursor,
    })
    if (!granted.ok) throw new Error(granted.error.message)
    const grant = foundryControlGrantSchema.parse(granted.value)

    fixture.workflow.emitAgentStart(0, 'left', 'child-left')
    await expect(fixture.connection.call(EXECUTE_CANCEL_CONTROL_ENDPOINT, {
      parentSessionId: 'plan-parent',
      runId: execution.executionId,
      grantId: grant.grantId,
    })).resolves.toEqual({ ok: true, value: { status: 'stale-grant' } })
    expect(fixture.workflow.runs[0]?.cancel).not.toHaveBeenCalled()
    const after = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['plan-parent']))
    const requested = after.events.find(event => event.type === 'control-requested')
    const invalidated = after.events.find(event => (
      event.type === 'control-result' && event.controlResult === 'stale-state'
    ))
    expect(invalidated?.causalParents).toEqual([requested?.eventId])
    expect(JSON.stringify(after)).not.toContain(grant.grantId)

    fixture.workflow.emitAgentEnd(0, 'left', 'child-left', 'completed')
    fixture.workflow.complete(0)
    await expect(running).resolves.toMatchObject({ isError: false })
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
