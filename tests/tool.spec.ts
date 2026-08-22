import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HostConnectionRpc } from '@deepseek-ai/dsh-client-connection'
import { JobId, type JobStart } from '@deepseek-ai/dsh-jobs'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ProductSubagentConsoleService, { type Config as ServiceConfig } from '../src/index.js'
import type { AgentPlanContent } from '../src/plan-types.js'
import * as ProductSubagentPlanTool from '../src/plan-tool.js'
import * as ProductSubagentTool from '../src/tool.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

class FakeSystemPromptService extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  tools(_render: unknown): () => void { return () => {} }
  section(_section: unknown): () => void { return () => {} }
}

class FakeConnectionService extends Service {
  constructor(ctx: Context) { super(ctx, 'connection') }
  readonly rpc: HostConnectionRpc = {
    handle: () => async () => {},
    intercept: () => { throw new Error('not used by this fixture') },
  }
}

interface ControlledStart {
  readonly request: ResolvedSubagentStartRequest
  readonly ready: PromiseWithResolvers<SubagentRun>
  readonly result: PromiseWithResolvers<SubagentResult>
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

class ControlledProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly starts: ControlledStart[] = []

  constructor(
    readonly name: string,
    readonly inheritsParentContext = false,
  ) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const controlled: ControlledStart = {
      request,
      ready: Promise.withResolvers<SubagentRun>(),
      result: Promise.withResolvers<SubagentResult>(),
      dispose: vi.fn(async () => {}),
    }
    this.starts.push(controlled)
    return controlled.ready.promise
  }

  publish(index = 0, childId = `owned-child-${index + 1}`): ControlledStart {
    const controlled = this.starts[index]
    if (controlled === undefined) throw new Error(`missing start ${String(index)}`)
    controlled.ready.resolve({
      id: SessionId(childId),
      localAgent: undefined,
      result: controlled.result.promise,
      dispose: controlled.dispose,
    })
    return controlled
  }
}

class FakeJobsService extends Service {
  spec: JobStart | undefined
  handle: ReturnType<JobStart['run']> | undefined

  constructor(ctx: Context) { super(ctx, 'jobs') }

  start(spec: JobStart): JobId {
    this.spec = spec
    this.handle = spec.run()
    return JobId('subagent-1')
  }
}

function parent(id = 'parent-owned'): Agent {
  return { id: SessionId(id) } as Agent
}

async function harness(config: ServiceConfig = {}, withJobs = false): Promise<{
  readonly ctx: Context
  readonly service: ProductSubagentConsoleService
  readonly jobs?: FakeJobsService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeSystemPromptService).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(SubagentRuntime).await()
  await ctx.plugin(FakeConnectionService).await()
  if (withJobs) await ctx.plugin(FakeJobsService).await()
  await ctx.plugin(ProductSubagentConsoleService, config).await()
  return {
    ctx,
    service: ctx.productSubagentConsole,
    ...withJobs ? { jobs: ctx.get('jobs') as unknown as FakeJobsService } : {},
  }
}

function execute(ctx: Context, arguments_: Record<string, unknown>, signal = new AbortController().signal) {
  return ctx.tools.execute({
    callId: CallId('owned-call'),
    name: 'board_subagent',
    arguments: arguments_,
    agent: parent(),
    signal,
  })
}

function planContent(): AgentPlanContent {
  return {
    title: 'Inspect two independent areas',
    objective: 'Inspect two independent areas and synthesize the findings.',
    successCriteria: ['Both areas are covered', 'One synthesis is produced'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'The inspections are independent.',
      singleAgentAlternative: 'Inspect both areas sequentially.',
      userOverride: false,
    },
    pattern: 'parallel-fanout-fanin',
    optimizationTarget: 'latency',
    backendPreference: 'workflow',
    budget: { maxAgents: 3, maxConcurrent: 2, planTimeoutMs: 600_000 },
    roles: [{
      roleId: 'inspector',
      name: 'Inspector',
      responsibility: 'Inspect one assigned area.',
      boundaries: [],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'area-a',
      title: 'Inspect area A',
      brief: 'Inspect area A and return a concise factual summary.',
      roleId: 'inspector',
      dependsOn: [],
      expectedOutput: { description: 'Area A findings.' },
      completionCriteria: ['Findings are concise'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'area-b',
      title: 'Inspect area B',
      brief: 'Inspect area B and return a concise factual summary.',
      roleId: 'inspector',
      dependsOn: [],
      expectedOutput: { description: 'Area B findings.' },
      completionCriteria: ['Findings are concise'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'synthesis',
      title: 'Synthesize findings',
      brief: 'Synthesize both inspection results.',
      roleId: 'inspector',
      dependsOn: [
        { taskId: 'area-a', mode: 'context' },
        { taskId: 'area-b', mode: 'context' },
      ],
      expectedOutput: { description: 'One combined result.' },
      completionCriteria: ['Both findings are represented'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

describe('product-subagent-console owned delegation tool', () => {
  it('shows honest queued/starting/published states and settles a foreground run', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('codex-visual')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(ProductSubagentTool, {
      provider: provider.name,
      product: 'codex',
      displayName: 'Codex',
      instance: 'visual',
    }).await()

    const running = execute(ctx, {
      description: 'Review module status',
      prompt: 'SECRET foreground prompt',
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    expect(service.snapshot(['parent-owned']).attempts).toEqual([
      expect.objectContaining({
        state: 'starting',
        toolName: 'board_subagent',
        expectedProviderName: 'codex-visual',
        label: 'Review module status',
        product: 'codex',
        displayName: 'Codex',
        instance: 'visual',
      }),
    ])

    const controlled = provider.publish(0, 'codex-child')
    await vi.waitFor(() => { expect(service.snapshot(['parent-owned']).runs).toHaveLength(1) })
    expect(service.snapshot(['parent-owned'])).toMatchObject({
      attempts: [],
      runs: [expect.objectContaining({
        childId: 'codex-child',
        source: 'owned-tool',
        state: 'active',
        providerMismatch: false,
      })],
    })
    controlled.result.resolve({
      output: [{ type: 'text', text: 'foreground answer' }],
      stopReason: 'completed',
    })

    await expect(running).resolves.toMatchObject({
      isError: false,
      value: { kind: 'foreground', childId: 'codex-child' },
      content: [{ type: 'text', text: 'foreground answer' }],
    })
    expect(controlled.dispose).toHaveBeenCalledOnce()
    expect(JSON.stringify(service.snapshot(['parent-owned']))).not.toContain('SECRET')
  })

  it('submits through the optional Jobs service and forwards job cancellation', async () => {
    const { ctx, service, jobs } = await harness({}, true)
    const provider = new ControlledProvider('background-provider')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(ProductSubagentTool, { provider: provider.name }).await()

    await expect(execute(ctx, {
      description: 'Background audit',
      prompt: 'SECRET background prompt',
      run_in_background: true,
    })).resolves.toMatchObject({
      isError: false,
      value: { kind: 'background', jobId: 'subagent-1' },
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    expect(service.snapshot(['parent-owned']).attempts[0]?.state).toBe('starting')
    expect(jobs?.spec).toMatchObject({ kind: 'subagent', label: 'Background audit', owner: parent() })

    jobs?.handle?.cancel('operator stopped job')
    expect(provider.starts[0]?.request.signal.aborted).toBe(true)
    provider.starts[0]?.ready.reject(new Error('provider cleaned cancelled startup'))
    await expect(jobs?.handle?.done).resolves.toEqual({ status: 'killed' })
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-owned']).attempts[0]).toMatchObject({
        state: 'not-published',
        outcome: 'cancelled-before-publication',
        cancellationRequested: true,
      })
    })
  })

  it('fails loud when background jobs are absent or disabled', async () => {
    const { ctx } = await harness()
    const provider = new ControlledProvider('foreground-only')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(ProductSubagentTool, { provider: provider.name }).await()

    await expect(execute(ctx, {
      description: 'Missing jobs',
      prompt: 'private',
      run_in_background: true,
    })).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('background jobs unavailable') },
    })
    expect(provider.starts).toHaveLength(0)

    const ctxDisabled = new Context()
    contexts.push(ctxDisabled)
    await ctxDisabled.plugin(FakeSystemPromptService).await()
    await ctxDisabled.plugin(ToolRuntime).await()
    await ctxDisabled.plugin(SubagentRuntime).await()
    await ctxDisabled.plugin(FakeConnectionService).await()
    await ctxDisabled.plugin(ProductSubagentConsoleService).await()
    const disabledProvider = new ControlledProvider('disabled-background')
    ctxDisabled.subagents.registerProvider(disabledProvider)
    await ctxDisabled.plugin(ProductSubagentTool, {
      provider: disabledProvider.name,
      enableRunInBackground: false,
    }).await()
    await expect(execute(ctxDisabled, {
      description: 'Disabled jobs',
      prompt: 'private',
      run_in_background: true,
    })).resolves.toMatchObject({ isError: true })
    expect(disabledProvider.starts).toHaveLength(0)
  })

  it('mounts and removes the tool with the selected Provider lifecycle', async () => {
    const { ctx } = await harness()
    await ctx.plugin(ProductSubagentTool, { provider: 'late-provider' }).await()
    expect(ctx.tools.get('board_subagent')).toBeUndefined()

    const provider = new ControlledProvider('late-provider', true)
    const remove = ctx.subagents.registerProvider(provider)
    expect(ctx.tools.get('board_subagent')).toBeDefined()
    remove()
    expect(ctx.tools.get('board_subagent')).toBeUndefined()
  })

  it('applies the Host timeout to an owned startup without claiming a published run', async () => {
    const { ctx, service } = await harness({ runTimeoutMs: 10 })
    const provider = new ControlledProvider('timeout-provider')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(ProductSubagentTool, { provider: provider.name }).await()
    const running = execute(ctx, {
      description: 'Timeout startup',
      prompt: 'SECRET timeout prompt',
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    await vi.waitFor(() => { expect(provider.starts[0]?.request.signal.aborted).toBe(true) })
    provider.starts[0]?.ready.reject(new Error('provider observed timeout'))

    await expect(running).resolves.toMatchObject({ isError: true })
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-owned'])).toMatchObject({
        runs: [],
        attempts: [expect.objectContaining({
          state: 'not-published',
          outcome: 'cancelled-before-publication',
          cancellationRequested: true,
        })],
      })
    })
  })
})

describe('product-subagent-console Agent plan design tool', () => {
  it('saves only a reviewable draft and never starts a subagent', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('spawn')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(ProductSubagentPlanTool).await()

    await expect(ctx.tools.execute({
      callId: CallId('plan-call'),
      name: 'design_subagent_plan',
      arguments: { plan: planContent() },
      agent: parent('plan-parent'),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: false })

    expect(provider.starts).toEqual([])
    expect(service.planSnapshot(['plan-parent'])).toMatchObject({
      durability: 'host-only',
      plans: [{
        revision: 1,
        state: 'draft',
        title: 'Inspect two independent areas',
      }],
    })
    expect(service.planSnapshot(['other-parent']).plans).toEqual([])
  })

  it('requires the exact existing revision and a calling Agent', async () => {
    const { ctx, service } = await harness()
    await ctx.plugin(ProductSubagentPlanTool).await()
    const first = await ctx.tools.execute({
      callId: CallId('plan-call-1'),
      name: 'design_subagent_plan',
      arguments: { plan: planContent() },
      agent: parent('plan-parent'),
      signal: new AbortController().signal,
    })
    expect(first.isError).toBe(false)
    const saved = service.planSnapshot(['plan-parent']).plans[0]
    if (saved === undefined) throw new Error('fixture plan missing')

    await expect(ctx.tools.execute({
      callId: CallId('plan-call-2'),
      name: 'design_subagent_plan',
      arguments: {
        plan: { ...planContent(), title: 'Second revision' },
        plan_id: saved.planId,
        expected_revision: 0,
      },
      agent: parent('plan-parent'),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true })
    expect(service.planSnapshot(['plan-parent']).plans).toHaveLength(1)

    await expect(ctx.tools.execute({
      callId: CallId('plan-call-3'),
      name: 'design_subagent_plan',
      arguments: { plan: planContent() },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true })
  })
})
