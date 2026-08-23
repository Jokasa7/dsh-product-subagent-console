import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ProductSubagentConsoleService from '../src/index.js'
import {
  executionCapabilitySnapshotSchema,
  planRepositorySnapshotSchema,
  type AgentPlanContent,
} from '../src/plan-types.js'
import { consoleSnapshotSchema } from '../src/types.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

class FakeSystemPromptService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(_render: unknown): () => void { return () => {} }
  section(_section: unknown): () => void { return () => {} }
}

class FakeConnectionService extends Service {
  handler: ConnectionRpcHandler | undefined
  channel: string | undefined
  authority: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  readonly rpc: HostConnectionRpc = {
    handle: (channel, handler, options) => {
      this.channel = channel
      this.handler = handler
      this.authority = options.authority
      return async () => {
        if (this.handler === handler) {
          this.channel = undefined
          this.handler = undefined
          this.authority = undefined
        }
      }
    },
    intercept: () => { throw new Error('not used by this fixture') },
  }
}

interface PendingStart {
  readonly request: ResolvedSubagentStartRequest
  readonly ready: PromiseWithResolvers<SubagentRun>
  readonly result: PromiseWithResolvers<SubagentResult>
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

class ControlledProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly starts: PendingStart[] = []

  constructor(readonly name: string) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const pending: PendingStart = {
      request,
      ready: Promise.withResolvers<SubagentRun>(),
      result: Promise.withResolvers<SubagentResult>(),
      dispose: vi.fn(async () => {}),
    }
    this.starts.push(pending)
    return pending.ready.promise
  }

  publish(index: number, childId = `child-${index + 1}`): PendingStart {
    const pending = this.starts[index]
    if (pending === undefined) throw new Error(`missing pending start ${String(index)}`)
    pending.ready.resolve({
      id: SessionId(childId),
      localAgent: undefined,
      result: pending.result.promise,
      dispose: pending.dispose,
    })
    return pending
  }
}

function parent(id: string): Agent {
  return { id: SessionId(id) } as Agent
}

function planContent(title = 'Planner fixture'): AgentPlanContent {
  return {
    title,
    objective: 'Produce one bounded factual result.',
    successCriteria: ['The result is complete'],
    recommendation: {
      useMultiAgent: false,
      rationale: 'One Agent is sufficient.',
      singleAgentAlternative: 'Use the current Agent.',
      userOverride: false,
    },
    pattern: 'single-agent',
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 1, maxConcurrent: 1, planTimeoutMs: 60_000 },
    roles: [{
      roleId: 'worker',
      name: 'Worker',
      responsibility: 'Complete the bounded task.',
      boundaries: [],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'task',
      title: 'Task',
      brief: 'Complete the bounded task.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'One factual result.' },
      completionCriteria: ['The result is present'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

async function harness(config: ConstructorParameters<typeof ProductSubagentConsoleService>[1] = {}): Promise<{
  readonly ctx: Context
  readonly service: ProductSubagentConsoleService
  readonly connection: FakeConnectionService
  readonly consoleFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeSystemPromptService).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(SubagentRuntime).await()
  await ctx.plugin(FakeConnectionService).await()
  const consoleFiber = ctx.plugin(ProductSubagentConsoleService, config)
  await consoleFiber.await()
  return {
    ctx,
    service: ctx.productSubagentConsole,
    connection: ctx.get('connection') as unknown as FakeConnectionService,
    consoleFiber,
  }
}

function registerDelegatingTool(ctx: Context, provider: string): () => void {
  return ctx.tools.register(defineTool({
    name: 'fixture_delegate',
    description: 'Delegate one controlled fixture task.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { childId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.childId }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('fixture requires an agent')
      const run = await ctx.subagents.start(provider, {
        parent: agent,
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        signal: exec.signal,
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error(`fixture ended ${result.stopReason}`)
        return { childId: String(run.id) }
      } finally {
        await run.dispose()
      }
    },
  }))
}

describe('ProductSubagentConsoleService with DSH 0.1.1-rc.2 runtimes', () => {
  it('registers a loopback-only, validated, session-filtered RPC', async () => {
    const { connection } = await harness()
    expect(connection).toMatchObject({
      channel: '/product-subagent-console',
      authority: 'loopback',
    })
    expect(connection.handler).toBeTypeOf('function')

    const signal = new AbortController().signal
    await expect(connection.handler?.('unknown', {}, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    await expect(connection.handler?.('list-sessions', { parentSessionIds: [] }, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    const snapshotResponse = await connection.handler?.('list-sessions', { parentSessionIds: ['parent-a'] }, signal)
    expect(snapshotResponse).toMatchObject({
      ok: true,
      value: {
        attempts: [],
        runs: [],
        diagnostics: { droppedActiveRuns: 0 },
      },
    })
    if (snapshotResponse?.ok !== true) throw new Error('fixture expected a successful snapshot response')
    const snapshot = consoleSnapshotSchema.parse(snapshotResponse.value)
    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(snapshot.hostStartedAt)

    const cancelled = new AbortController()
    cancelled.abort('test')
    await expect(connection.handler?.('list-sessions', { parentSessionIds: ['parent-a'] }, cancelled.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })

    await expect(connection.handler?.('watch-sessions', {
      parentSessionIds: ['parent-a'],
      hostInstanceId: '00000000-0000-4000-8000-000000000099',
      afterRevision: snapshot.revision,
      timeoutMs: 30_000,
    }, signal)).resolves.toMatchObject({ ok: true })
  })

  it('saves, watches, preflights, and isolates Host-only plan revisions', async () => {
    const { connection } = await harness({ plannerMaxConcurrent: 3, plannerMaxAgents: 8 })
    const signal = new AbortController().signal
    const firstResponse = await connection.handler?.('planner.save', {
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: planContent('First'),
    }, signal)
    expect(firstResponse).toMatchObject({ ok: true, value: { revision: 1, state: 'draft' } })
    if (firstResponse?.ok !== true) throw new Error('fixture expected a saved plan')
    const first = firstResponse.value as { readonly planId: string; readonly revision: number }

    const listResponse = await connection.handler?.('planner.list', {
      parentSessionIds: ['parent-a'],
    }, signal)
    if (listResponse?.ok !== true) throw new Error('fixture expected a plan snapshot')
    const snapshot = planRepositorySnapshotSchema.parse(listResponse.value)
    expect(snapshot).toMatchObject({ durability: 'host-only', revision: 1 })
    expect(snapshot.plans).toHaveLength(1)

    const watch = connection.handler?.('planner.watch', {
      parentSessionIds: ['parent-a'],
      hostInstanceId: snapshot.hostInstanceId,
      afterRevision: snapshot.revision,
      timeoutMs: 30_000,
    }, signal)
    await Promise.resolve()
    const secondResponse = await connection.handler?.('planner.save', {
      parentSessionId: 'parent-a',
      planId: first.planId,
      expectedRevision: first.revision,
      content: planContent('Second'),
    }, signal)
    expect(secondResponse).toMatchObject({ ok: true, value: { revision: 2, state: 'draft' } })
    await expect(watch).resolves.toMatchObject({ ok: true, value: { revision: 2 } })

    await expect(connection.handler?.('planner.watch', {
      parentSessionIds: ['parent-a'],
      hostInstanceId: '00000000-0000-4000-8000-000000000099',
      afterRevision: 2,
      timeoutMs: 30_000,
    }, signal)).resolves.toMatchObject({ ok: true, value: { revision: 2 } })

    await expect(connection.handler?.('planner.list', {
      parentSessionIds: ['parent-b'],
    }, signal)).resolves.toMatchObject({ ok: true, value: { plans: [] } })

    const capabilitiesResponse = await connection.handler?.('planner.capabilities', {
      parentSessionId: 'parent-a',
    }, signal)
    if (capabilitiesResponse?.ok !== true) throw new Error('fixture expected capabilities')
    const capabilities = executionCapabilitySnapshotSchema.parse(capabilitiesResponse.value)
    expect(capabilities).toMatchObject({
      scopeStatus: 'unavailable',
      adapters: { workflow: false, agentTeam: false },
      limits: { maxAgents: 8, maxConcurrent: 3 },
    })

    const preflight = await connection.handler?.('planner.preflight', {
      parentSessionId: 'parent-a',
      planId: first.planId,
      revision: 2,
    }, signal)
    expect(preflight).toMatchObject({
      ok: true,
      value: { valid: false, capabilityDigest: capabilities.digest },
    })
    await expect(connection.handler?.('planner.approve', {
      parentSessionId: 'parent-a',
      planId: first.planId,
      revision: 2,
      capabilityDigest: capabilities.digest,
      acceptedWarningIds: [],
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'command-error' } })

    await expect(connection.handler?.('planner.save', {
      parentSessionId: 'parent-a',
      planId: first.planId,
      expectedRevision: 1,
      content: planContent('Stale'),
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'command-error' } })
  })

  it('uses AsyncLocalStorage to correlate concurrent official tool/subagent lifecycles exactly', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('controlled')
    ctx.subagents.registerProvider(provider)
    registerDelegatingTool(ctx, provider.name)

    const first = ctx.tools.execute({
      callId: CallId('call-a'),
      name: 'fixture_delegate',
      arguments: { description: 'Inspect branch A', prompt: 'SECRET prompt A' },
      agent: parent('parent-a'),
      signal: new AbortController().signal,
    })
    const second = ctx.tools.execute({
      callId: CallId('call-b'),
      name: 'fixture_delegate',
      arguments: { description: 'Inspect branch B', prompt: 'SECRET prompt B' },
      agent: parent('parent-b'),
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(2) })

    const secondRun = provider.publish(1, 'child-b')
    const firstRun = provider.publish(0, 'child-a')
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-a', 'parent-b']).runs).toHaveLength(2)
    })

    expect(service.snapshot(['parent-a']).runs).toEqual([
      expect.objectContaining({
        parentSessionId: 'parent-a',
        childId: 'child-a',
        callId: 'call-a',
        toolName: 'fixture_delegate',
        label: 'Inspect branch A',
        providerName: 'controlled',
        source: 'observed-tool',
        state: 'active',
      }),
    ])
    expect(service.snapshot(['parent-b']).runs).toEqual([
      expect.objectContaining({
        parentSessionId: 'parent-b',
        childId: 'child-b',
        callId: 'call-b',
        label: 'Inspect branch B',
      }),
    ])

    firstRun.result.resolve({
      output: [{ type: 'text', text: 'SECRET result A' }],
      diagnostic: 'SECRET diagnostic A',
      stopReason: 'completed',
    })
    secondRun.result.resolve({ output: [], stopReason: 'max-tokens' })
    await expect(first).resolves.toMatchObject({ isError: false })
    await expect(second).resolves.toMatchObject({ isError: true })
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-a']).runs[0]?.state).toBe('completed')
      expect(service.snapshot(['parent-b']).runs[0]?.state).toBe('max-tokens')
    })

    const serialized = JSON.stringify(service.snapshot(['parent-a', 'parent-b']))
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('SECRET diagnostic A')
    expect(firstRun.dispose).toHaveBeenCalledOnce()
    expect(secondRun.dispose).toHaveBeenCalledOnce()
  })

  it('does not invent records for direct runtime starts outside a tool execution', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('direct')
    ctx.subagents.registerProvider(provider)
    const starting = ctx.subagents.start(provider.name, {
      parent: parent('parent-direct'),
      prompt: [{ type: 'text', text: 'SECRET direct prompt' }],
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    provider.publish(0).result.resolve({ output: [], stopReason: 'completed' })
    await starting
    await Promise.resolve()
    expect(service.snapshot(['parent-direct']).runs).toEqual([])
  })

  it('contains observer failures without failing or mutating the official run', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('   ')
    ctx.subagents.registerProvider(provider)
    registerDelegatingTool(ctx, provider.name)
    const execution = ctx.tools.execute({
      callId: CallId('call-malformed'),
      name: 'fixture_delegate',
      arguments: { description: 'Malformed observer', prompt: 'SECRET malformed prompt' },
      agent: parent('parent-malformed'),
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    const pending = provider.publish(0)
    pending.result.resolve({ output: [], stopReason: 'completed' })

    await expect(execution).resolves.toMatchObject({ isError: false })
    expect(service.snapshot(['parent-malformed']).runs).toEqual([])
    expect(pending.dispose).toHaveBeenCalledOnce()
  })

  it('records official cancellation after publication and never exposes result content', async () => {
    const { ctx, service } = await harness()
    const provider = new ControlledProvider('cancelled')
    ctx.subagents.registerProvider(provider)
    registerDelegatingTool(ctx, provider.name)
    const controller = new AbortController()
    const execution = ctx.tools.execute({
      callId: CallId('call-cancel'),
      name: 'fixture_delegate',
      arguments: { description: 'Cancel published run', prompt: 'SECRET cancellation prompt' },
      agent: parent('parent-cancel'),
      signal: controller.signal,
    })
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    const pending = provider.publish(0, 'child-cancel')
    await vi.waitFor(() => { expect(service.snapshot(['parent-cancel']).runs[0]?.state).toBe('active') })
    controller.abort('operator cancelled')
    pending.result.resolve({
      output: [{ type: 'text', text: 'SECRET partial output' }],
      stopReason: 'aborted',
    })

    await expect(execution).resolves.toMatchObject({ isError: true })
    await vi.waitFor(() => { expect(service.snapshot(['parent-cancel']).runs[0]?.state).toBe('aborted') })
    expect(JSON.stringify(service.snapshot(['parent-cancel']))).not.toContain('SECRET')
  })

  it('aborts active owned starts and rejects queued starts when its plugin unloads', async () => {
    const { service, consoleFiber } = await harness({ maxConcurrent: 1, maxQueued: 1 })
    const activeSignal = Promise.withResolvers<AbortSignal>()
    const queuedEntered = vi.fn()
    const active = service.startOwned({
      parentSessionId: 'parent-unload',
      callId: 'call-active',
      toolName: 'owned',
      providerName: 'provider',
      signal: new AbortController().signal,
    }, async signal => {
      activeSignal.resolve(signal)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('active start aborted')) }, { once: true })
      })
      throw new Error('unreachable')
    })
    const queued = service.startOwned({
      parentSessionId: 'parent-unload',
      callId: 'call-queued',
      toolName: 'owned',
      providerName: 'provider',
      signal: new AbortController().signal,
    }, async () => {
      queuedEntered()
      throw new Error('queued start should not execute')
    })
    const signal = await activeSignal.promise
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-unload']).attempts.map(attempt => attempt.state)).toEqual(['starting', 'queued'])
    })

    await consoleFiber.dispose()
    expect(signal.aborted).toBe(true)
    await expect(active).rejects.toThrow('active start aborted')
    await expect(queued).rejects.toThrow('cancelled before admission')
    expect(queuedEntered).not.toHaveBeenCalled()
  })

  it('does not report lifecycle-missing when an immediately settled run is trimmed at historyLimit zero', async () => {
    const { ctx, service } = await harness({ historyLimit: 0 })
    const provider = new ControlledProvider('instant')
    ctx.subagents.registerProvider(provider)
    const starting = service.startOwned({
      parentSessionId: 'parent-instant',
      callId: 'call-instant',
      toolName: 'owned',
      providerName: provider.name,
      signal: new AbortController().signal,
    }, signal => ctx.subagents.start(provider.name, {
      parent: parent('parent-instant'),
      prompt: [{ type: 'text', text: 'SECRET instant prompt' }],
      signal,
    }))
    await vi.waitFor(() => { expect(provider.starts).toHaveLength(1) })
    const pending = provider.starts[0]
    if (pending === undefined) throw new Error('missing instant start')
    pending.result.resolve({ output: [], stopReason: 'completed' })
    provider.publish(0, 'child-instant')
    const run = await starting
    await Promise.resolve()

    expect(service.snapshot(['parent-instant'])).toMatchObject({ attempts: [], runs: [] })
    await run.dispose()
  })
})
