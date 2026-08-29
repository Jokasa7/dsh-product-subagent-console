import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { FoundryEventLedger } from '../src/event-ledger.js'
import { foundrySnapshotSchema } from '../src/foundry-types.js'
import {
  executionCapabilitySnapshotSchema,
  planRepositorySnapshotSchema,
  type AgentPlanContent,
  type AgentPlanRevision,
  type PlanExecution,
} from '../src/plan-types.js'
import { consoleSnapshotSchema } from '../src/types.js'
import { verifiedRun } from './foundry-fixtures.js'

const contexts: Context[] = []
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  const safeRoot = resolve(tmpdir())
  for (const root of tempRoots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(`${safeRoot}\\`) && !target.startsWith(`${safeRoot}/`)) {
      throw new Error(`refusing to remove temp path outside ${safeRoot}`)
    }
    rmSync(target, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = join(tmpdir(), `dsh-foundry-host-${randomUUID()}`)
  mkdirSync(root, { recursive: false })
  tempRoots.push(root)
  return root
}

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
  const consoleFiber = ctx.plugin(ProductSubagentConsoleService, { foundryStorage: false, ...config })
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

function seedFoundryRun(
  service: ProductSubagentConsoleService,
  plan: AgentPlanRevision,
  execution: PlanExecution,
): { readonly reservedControlEventSlots: () => number } {
  const internal = service as unknown as {
    readonly plans: { restore: (plans: readonly AgentPlanRevision[]) => void }
    readonly executions: { restore: (executions: readonly PlanExecution[]) => void }
    readonly foundry: FoundryEventLedger
    readonly reservedControlEventSlots: number
  }
  internal.foundry.recordPlanRevision(plan)
  internal.foundry.recordExecutionSnapshot(execution)
  internal.plans.restore([plan])
  internal.executions.restore([execution])
  return { reservedControlEventSlots: () => internal.reservedControlEventSlots }
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

  it('persists plan revisions on disk and restores them in a new Host generation', async () => {
    const storageDirectory = tempRoot()
    const first = await harness({ foundryStorage: true, foundryStorageDirectory: storageDirectory })
    const saved = first.service.savePlanDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: planContent('Durable plan'),
    })
    expect(first.service.planSnapshot(['parent-a'])).toMatchObject({
      durability: 'disk',
      plans: [{ planId: saved.planId, revision: 1 }],
    })
    expect(first.service.foundrySnapshot(['parent-a']).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan-saved', authority: 'user' }),
    ]))
    await first.consoleFiber.dispose()

    const second = await harness({ foundryStorage: true, foundryStorageDirectory: storageDirectory })
    expect(second.service.planSnapshot(['parent-a'])).toMatchObject({
      durability: 'disk',
      plans: [{ planId: saved.planId, revision: 1, title: 'Durable plan' }],
    })
    expect(second.service.planSnapshot(['parent-b']).plans).toEqual([])
  })

  it('closes a recovered nonterminal durable execution as unknown without inventing success', async () => {
    const storageDirectory = tempRoot()
    const source = verifiedRun(9)
    const { finishedAt: _finishedAt, ...runningBase } = source.execution
    const running = {
      ...runningBase,
      status: 'running' as const,
      bindings: source.execution.bindings.map(binding => {
        const { finishedAt: _bindingFinishedAt, ...bindingBase } = binding
        return { ...bindingBase, status: 'running' as const }
      }),
    }
    const ledger = new FoundryEventLedger({ storageDirectory })
    ledger.recordPlanRevision(source.plan)
    ledger.recordExecutionSnapshot(running)
    ledger.dispose()

    const fixture = await harness({ foundryStorage: true, foundryStorageDirectory: storageDirectory })
    const snapshot = foundrySnapshotSchema.parse(fixture.service.foundrySnapshot(['parent-a']))
    expect(snapshot).toMatchObject({ durability: 'disk', storageStatus: 'ready' })
    expect(snapshot.executions).toEqual([
      expect.objectContaining({
        executionId: source.execution.executionId,
        status: 'unknown',
        bindings: [expect.objectContaining({ status: 'unknown' })],
      }),
    ])
    expect(snapshot.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'execution-terminal',
      'attempt-terminal',
    ]))
    expect(JSON.stringify(snapshot)).not.toContain('succeeded')
  })

  it('closes requested-only and consumed-only control chains after a Host restart idempotently', async () => {
    const storageDirectory = tempRoot()
    const ledger = new FoundryEventLedger({ storageDirectory })
    const requestedOnly = ledger.recordEvent({
      source: 'foundry-control',
      sourceEventId: 'requested-only',
      parentSessionId: 'parent-a',
      runId: '00000000-0000-4000-8000-000000000901',
      planId: '00000000-0000-4000-8000-000000000902',
      planRevision: 1,
      type: 'control-requested',
      authority: 'user',
      observedAt: 10,
      causalParents: [],
      controlAction: 'cancel',
      controlProposalId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      controlEventCursor: 0,
      artifacts: [],
    })
    const requestedThenConsumed = ledger.recordEvent({
      source: 'foundry-control',
      sourceEventId: 'requested-then-consumed',
      parentSessionId: 'parent-a',
      runId: '00000000-0000-4000-8000-000000000903',
      planId: '00000000-0000-4000-8000-000000000904',
      planRevision: 1,
      type: 'control-requested',
      authority: 'user',
      observedAt: 20,
      causalParents: [],
      controlAction: 'cancel',
      controlProposalId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      controlEventCursor: 0,
      artifacts: [],
    })
    const consumed = ledger.recordEvent({
      source: 'foundry-control',
      sourceEventId: 'consumed-without-result',
      parentSessionId: 'parent-a',
      runId: requestedThenConsumed.runId,
      planId: requestedThenConsumed.planId,
      planRevision: requestedThenConsumed.planRevision,
      type: 'control-consumed',
      authority: 'user',
      observedAt: 21,
      causalParents: [requestedThenConsumed.eventId],
      controlAction: 'cancel',
      controlProposalId: requestedThenConsumed.controlProposalId,
      controlEventCursor: requestedThenConsumed.controlEventCursor,
      artifacts: [],
    })
    ledger.dispose()

    const first = await harness({ foundryStorage: true, foundryStorageDirectory: storageDirectory })
    const recovered = foundrySnapshotSchema.parse(first.service.foundrySnapshot(['parent-a']))
    expect(recovered.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'control-result',
        controlResult: 'host-restarted',
        causalParents: [requestedOnly.eventId],
      }),
      expect.objectContaining({
        type: 'control-result',
        controlResult: 'interrupted',
        causalParents: [consumed.eventId],
      }),
    ]))
    const closureCount = recovered.events.filter(event => (
      event.type === 'control-result'
      && ['host-restarted', 'interrupted'].includes(event.controlResult ?? '')
    )).length
    await first.consoleFiber.dispose()

    const second = await harness({ foundryStorage: true, foundryStorageDirectory: storageDirectory })
    const replayed = foundrySnapshotSchema.parse(second.service.foundrySnapshot(['parent-a']))
    expect(replayed.events.filter(event => (
      event.type === 'control-result'
      && ['host-restarted', 'interrupted'].includes(event.controlResult ?? '')
    ))).toHaveLength(closureCount)
  })

  it('expires an abandoned control grant and releases its Event reservation without another RPC', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const fixture = await harness()
      const source = verifiedRun(95)
      const { finishedAt: _finishedAt, ...executionBase } = source.execution
      const running: PlanExecution = {
        ...executionBase,
        status: 'running',
        bindings: source.execution.bindings.map(binding => {
          const { finishedAt: _bindingFinishedAt, ...bindingBase } = binding
          return { ...bindingBase, status: 'running' as const }
        }),
      }
      const internal = seedFoundryRun(fixture.service, source.plan, running)
      const preview = fixture.service.foundrySnapshot(['parent-a']).recoveryProposals[0]
      if (preview === undefined) throw new Error('fixture recovery proposal missing')
      fixture.service.issueCancelControlGrant({
        parentSessionId: 'parent-a',
        runId: running.executionId,
        proposalId: preview.proposalId,
        eventCursor: preview.eventCursor,
      })
      expect(internal.reservedControlEventSlots()).toBe(2)

      await vi.advanceTimersByTimeAsync(121_000)

      expect(fixture.service.foundrySnapshot(['parent-a']).events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'control-expired', runId: running.executionId }),
      ]))
      expect(internal.reservedControlEventSlots()).toBe(0)
      await fixture.consoleFiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('validates and isolates Foundry RPC snapshots and factual missing-run queries', async () => {
    const { connection } = await harness()
    const signal = new AbortController().signal
    await expect(connection.handler?.('foundry.list', {
      parentSessionIds: [],
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(connection.handler?.('foundry.list', {
      parentSessionIds: ['parent-a'],
      prompt: 'SECRET must be rejected',
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const listed = await connection.handler?.('foundry.list', {
      parentSessionIds: ['parent-a'],
    }, signal)
    if (listed?.ok !== true) throw new Error('fixture expected a Foundry snapshot')
    expect(foundrySnapshotSchema.parse(listed.value)).toMatchObject({
      durability: 'memory',
      plans: [],
      executions: [],
    })

    await expect(connection.handler?.('foundry.inspect', {
      parentSessionId: 'parent-a',
      runId: 'missing-run',
      kind: 'summary',
    }, signal)).resolves.toMatchObject({
      ok: true,
      value: {
        parentSessionId: 'parent-a',
        runId: 'missing-run',
        answerCode: 'run-not-found',
        facts: [],
        hypotheses: [],
      },
    })
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

  it('does not dispatch a planner mutation when cancellation lands between RPC stages', async () => {
    const { service, connection } = await harness()
    const controller = new AbortController()
    const internal = service as unknown as {
      handleFoundryRpc: (
        endpoint: string,
        payload: unknown,
        signal: AbortSignal,
      ) => Promise<unknown | undefined>
    }
    const foundryStage = vi.spyOn(internal, 'handleFoundryRpc').mockImplementation(async () => {
      controller.abort('cancelled between dispatch stages')
      return undefined
    })

    await expect(connection.handler?.('planner.save', {
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: planContent('Must not be saved'),
    }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(foundryStage).toHaveBeenCalledOnce()
    expect(service.planSnapshot(['parent-a']).plans).toEqual([])
  })

  it('releases admission without starting when the caller aborts before permit delivery', async () => {
    const { service } = await harness()
    const controller = new AbortController()
    const permit = Promise.withResolvers<() => void>()
    const release = vi.fn()
    const start = vi.fn<() => Promise<SubagentRun>>()
    const internal = service as unknown as {
      readonly admission: { acquire: (signal: AbortSignal) => Promise<() => void> }
    }
    vi.spyOn(internal.admission, 'acquire').mockReturnValue(permit.promise)
    const starting = service.startOwned({
      parentSessionId: 'parent-admission-race',
      callId: 'call-admission-race',
      toolName: 'owned',
      providerName: 'provider',
      signal: controller.signal,
    }, start)

    controller.abort('cancelled before permit delivery')
    permit.resolve(release)

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(service.snapshot(['parent-admission-race']).attempts).toEqual([
      expect.objectContaining({
        state: 'not-published',
        outcome: 'cancelled-before-publication',
        cancellationRequested: true,
      }),
    ])
  })

  it('disposes and withholds a run that resolves after its owned start was cancelled', async () => {
    const { service } = await harness()
    const controller = new AbortController()
    const deferred = Promise.withResolvers<SubagentRun>()
    const dispose = vi.fn(async () => {})
    const starting = service.startOwned({
      parentSessionId: 'parent-late-run',
      callId: 'call-late-run',
      toolName: 'owned',
      providerName: 'provider',
      signal: controller.signal,
    }, async () => deferred.promise)
    await vi.waitFor(() => {
      expect(service.snapshot(['parent-late-run']).attempts[0]?.state).toBe('starting')
    })

    controller.abort('cancelled while provider start was pending')
    deferred.resolve({
      id: SessionId('late-child'),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'aborted' }),
      dispose,
    })

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalledOnce()
    expect(service.snapshot(['parent-late-run']).attempts).toEqual([
      expect.objectContaining({
        state: 'not-published',
        outcome: 'cancelled-before-publication',
        cancellationRequested: true,
      }),
    ])
  })

  it('keeps a run cursor pinned to exact execution identity when a foreign fact arrives later', async () => {
    const { service } = await harness()
    const source = verifiedRun(97)
    seedFoundryRun(service, source.plan, source.execution)
    const internal = service as unknown as {
      readonly foundry: FoundryEventLedger
      runEventCursor: (parentSessionId: string, runId: string) => number
    }
    const firstSourceEvent = source.events[0]
    if (firstSourceEvent === undefined) throw new Error('fixture event missing')
    const { schemaVersion: _schemaVersion, eventId: _eventId, cursor: _cursor, ...firstEvent } = firstSourceEvent
    const exact = internal.foundry.recordEvent(firstEvent)
    internal.foundry.recordEvent({
      ...firstEvent,
      source: 'foreign-fixture',
      sourceEventId: 'foreign-plan-revision',
      planId: '00000000-0000-4000-8000-999999999999',
    })

    expect(internal.runEventCursor(source.execution.parentSessionId, source.execution.executionId)).toBe(exact.cursor)
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
