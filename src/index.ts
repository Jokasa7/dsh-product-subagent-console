import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { SubagentRun, SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowRunInfo,
} from '@deepseek-ai/dsh-workflow'
import {
  AdmissionController,
  AdmissionQueueFullError,
  displayLabelFromArguments,
  ProductSubagentLedger,
  type ExecutionObservation,
} from './domain.js'
import { collectLlmRoutes, LlmModelCatalogCache } from './capability-catalog.js'
import { preflightAgentPlan } from './plan-preflight.js'
import {
  PlanExecutionOwnershipError,
  PlanExecutionSnapshotRepository,
} from './plan-execution-store.js'
import {
  AgentPlanRepository,
  PlanApprovalError,
  PlanOwnershipError,
  PlanRevisionConflictError,
} from './plan-store.js'
import {
  isTerminalPlanExecutionStatus,
} from './planner-execution.js'
import {
  WorkflowPlanExecutionAdapter,
  type WorkflowEngineLike,
  type WorkflowLifecycleRegistrar,
} from './workflow-adapter.js'
import {
  APPROVE_PLAN_ENDPOINT,
  approvePlanRequestSchema,
  assertBoundedJsonValue,
  CANCEL_PLAN_EXECUTION_ENDPOINT,
  cancelPlanExecutionRequestSchema,
  EXECUTION_CAPABILITIES_ENDPOINT,
  executionCapabilitiesRequestSchema,
  executionCapabilitySnapshotSchema,
  ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT,
  LIST_PLANS_ENDPOINT,
  LIST_PLAN_EXECUTIONS_ENDPOINT,
  listPlanExecutionsRequestSchema,
  listPlansRequestSchema,
  PREFLIGHT_PLAN_ENDPOINT,
  planRevisionRequestSchema,
  SAVE_PLAN_ENDPOINT,
  savePlanRequestSchema,
  WATCH_PLANS_ENDPOINT,
  WATCH_PLAN_EXECUTIONS_ENDPOINT,
  watchPlanExecutionsRequestSchema,
  watchPlansRequestSchema,
  type ExecutionCapabilitySnapshot,
  type AgentPlanRevision,
  type CancelPlanExecutionResult,
  type PlanExecution,
  type PlanExecutionGrant,
  type PlanExecutionRepositorySnapshot,
  type PlanRepositorySnapshot,
} from './plan-types.js'
import type { SavePlanDraftInput } from './plan-store.js'
import {
  LIST_SESSIONS_ENDPOINT,
  listSessionsRequestSchema,
  PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
  WATCH_SESSIONS_ENDPOINT,
  watchSessionsRequestSchema,
  type ConfiguredProduct,
  type ConsoleSnapshot,
} from './types.js'

export type * from './types.js'
export type * from './plan-types.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const EXECUTION_GRANT_TTL_MS = 12 * 60 * 60_000
const MAX_CAPABILITY_NAME_LENGTH = 128

function normalizedCapabilityName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length >= 1 && normalized.length <= MAX_CAPABILITY_NAME_LENGTH
    ? normalized
    : undefined
}

function normalizedCapabilityNames(values: readonly unknown[], limit: number): string[] {
  return [...new Set(values.flatMap(value => {
    const normalized = normalizedCapabilityName(value)
    return normalized === undefined ? [] : [normalized]
  }))].sort().slice(0, limit)
}

function executionPlanKey(parentSessionId: string, planId: string, revision: number): string {
  return `${parentSessionId}\u0000${planId}\u0000${String(revision)}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Independent task-canvas observer and owned-delegation admission service. */
    productSubagentConsole: ProductSubagentConsoleService
  }
}

/** Host plugin configuration for capacity, retention, and optional owned-run timeout. */
export interface Config {
  /** Maximum concurrently active plugin-owned delegations. Default: 4. */
  maxConcurrent?: number
  /** Maximum plugin-owned delegations waiting for admission. Default: 16. */
  maxQueued?: number
  /** Combined terminal attempt/run records retained in this Host generation. Default: 50. */
  historyLimit?: number
  /** Maximum observed-tool runs retained active at once. Default: 128. */
  maxObservedActive?: number
  /** Abort plugin-owned runs after this many milliseconds; 0 disables the timeout. Default: 0. */
  runTimeoutMs?: number
  /** Maximum concurrent Workflow tasks in one approved plan. Default: 4. */
  plannerMaxConcurrent?: number
  /** Maximum task Agents in one approved plan. Default: 32. */
  plannerMaxAgents?: number
}

interface ResolvedConfig {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly historyLimit: number
  readonly maxObservedActive: number
  readonly runTimeoutMs: number
  readonly plannerMaxConcurrent: number
  readonly plannerMaxAgents: number
}

/** Exact metadata owned by the optional `dsh-product-subagent-console/tool` face. */
export interface OwnedDelegationSpec extends ConfiguredProduct {
  readonly parentSessionId: string
  readonly callId: string
  readonly toolName: string
  readonly providerName: string
  readonly label?: string
  readonly signal: AbortSignal
}

interface OwnedSignal {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

interface ExecutionGrantRecord extends PlanExecutionGrant {
  readonly planKey: string
}

type ConsoleRpcResponse = Awaited<ReturnType<ConnectionRpcHandler>>

/** Standalone Host service for observed lifecycle records and owned-tool admission. */
export class ProductSubagentConsoleService extends Service {
  static inject = ['connection', 'subagents', 'tools']

  static Config: schema<Config> = schema.object({
    maxConcurrent: schema.natural().min(1).max(64).default(4),
    maxQueued: schema.natural().max(256).default(16),
    historyLimit: schema.natural().max(1_000).default(50),
    maxObservedActive: schema.natural().min(1).max(1_000).default(128),
    runTimeoutMs: schema.natural().max(MAX_TIMER_DELAY_MS).default(0),
    plannerMaxConcurrent: schema.natural().min(1).max(16).default(4),
    plannerMaxAgents: schema.natural().min(1).max(32).default(32),
  })

  private readonly resolved: ResolvedConfig
  private readonly execution = new AsyncLocalStorage<ExecutionObservation>()
  private readonly admission: AdmissionController
  private readonly ledger: ProductSubagentLedger
  private readonly plans: AgentPlanRepository
  private readonly executions: PlanExecutionSnapshotRepository
  private readonly executionGrants = new Map<string, ExecutionGrantRecord>()
  private readonly grantByPlanKey = new Map<string, string>()
  private readonly activePlanExecutions = new Set<string>()
  private readonly llmModelCatalog = new LlmModelCatalogCache()
  private readonly plannerDesignToolNames = new Set<string>()
  private readonly plannerExecuteToolNames = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly ownedControllers = new Set<AbortController>()
  private workflowAdapter: WorkflowPlanExecutionAdapter<Agent> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'productSubagentConsole')
    this.resolved = resolveConfig(config)
    this.admission = new AdmissionController(this.resolved.maxConcurrent, this.resolved.maxQueued)
    this.ledger = new ProductSubagentLedger(this.resolved)
    this.plans = new AgentPlanRepository(
      100,
      50,
      16 * 1024 * 1024,
      20,
      error => { ctx.logger.warn(`product-subagent-console: plan listener failed: ${String(error)}`) },
    )
    this.executions = new PlanExecutionSnapshotRepository(
      500,
      Date.now,
      error => { ctx.logger.warn(`product-subagent-console: execution listener failed: ${String(error)}`) },
    )
    const connection = ctx.get('connection') as unknown as HostConnectionHandle

    void ctx.inject(['workflowEngine'], (workflowCtx) => {
      const events: WorkflowLifecycleRegistrar = {
        onAgentStart: listener => workflowCtx.on('workflow/agent-start', (
          info: WorkflowRunInfo,
          agent: WorkflowAgentInfo,
        ) => {
          listener(String(info.id), {
            seq: agent.seq,
            label: agent.label,
            childId: String(agent.childId),
          })
        }),
        onAgentEnd: listener => workflowCtx.on('workflow/agent-end', (
          info: WorkflowRunInfo,
          agent: WorkflowAgentEndInfo,
        ) => {
          listener(String(info.id), {
            seq: agent.seq,
            label: agent.label,
            childId: String(agent.childId),
            outcome: agent.outcome,
          })
        }),
      }
      const adapter = new WorkflowPlanExecutionAdapter<Agent>({
        engine: workflowCtx.workflowEngine as unknown as WorkflowEngineLike<Agent>,
        events,
        onTaskBound: binding => {
          this.mutate(() => {
            this.ledger.relabelPublishedRun(binding.parentSessionId, binding.childId, binding.taskTitle)
          })
        },
        onListenerError: error => {
          ctx.logger.warn(`product-subagent-console: Workflow execution listener failed: ${String(error)}`)
        },
      })
      const unsubscribe = adapter.subscribe((execution) => {
        try {
          this.executions.upsert(execution)
        } catch (error: unknown) {
          ctx.logger.warn(`product-subagent-console: execution snapshot rejected: ${String(error)}`)
        }
      })
      this.workflowAdapter = adapter
      return async () => {
        if (this.workflowAdapter === adapter) this.workflowAdapter = undefined
        try {
          await adapter.dispose()
        } finally {
          unsubscribe()
        }
      }
    })

    ctx.on('tools/execute', (exec, next) => this.observeToolExecution(exec, next))
    ctx.on('subagent/start', (info) => { this.observePublishedRun(info) })
    ctx.on('subagent/end', (info) => { this.observeTerminalRun(info) })
    ctx.effect(() => connection.rpc.handle(
      PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
      async (endpoint, payload, signal) => {
        if (signal.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
        }
        const plannerResponse = await this.handlePlannerRpc(endpoint, payload, signal)
        if (plannerResponse !== undefined) return plannerResponse
        if (endpoint !== LIST_SESSIONS_ENDPOINT && endpoint !== WATCH_SESSIONS_ENDPOINT) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: { issues: [] } },
          }
        }
        const parsed = endpoint === WATCH_SESSIONS_ENDPOINT
          ? watchSessionsRequestSchema.safeParse(payload)
          : listSessionsRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'invalid product-subagent-console request',
              details: { issues: parsed.error.issues },
            },
          }
        }
        if (endpoint === WATCH_SESSIONS_ENDPOINT) {
          const request = watchSessionsRequestSchema.parse(parsed.data)
          await this.waitForRevision(
            request.afterRevision,
            request.hostInstanceId,
            request.timeoutMs,
            signal,
          )
          if (signal.aborted) {
            return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
          }
        }
        return { ok: true, value: this.ledger.snapshot(parsed.data.parentSessionIds) }
      },
      { authority: 'loopback' },
    ), 'product-subagent-console: loopback RPC')
    ctx.effect(() => () => {
      this.admission.close()
      for (const controller of this.ownedControllers) {
        controller.abort('product-subagent-console unloaded')
      }
      this.ownedControllers.clear()
    }, 'product-subagent-console: abort owned runs on unload')
  }

  /** Read a detached, session-filtered point-in-time snapshot. */
  snapshot(parentSessionIds: readonly string[]): ConsoleSnapshot {
    return this.ledger.snapshot(parentSessionIds)
  }

  /** Read a detached plan snapshot without implying durable Session-backed history. */
  planSnapshot(parentSessionIds: readonly string[]): PlanRepositorySnapshot {
    return {
      schemaVersion: 1,
      hostInstanceId: this.ledger.hostInstanceId,
      hostStartedAt: this.ledger.hostStartedAt,
      revision: this.plans.revision,
      capturedAt: Date.now(),
      durability: 'host-only',
      plans: [...this.plans.list(parentSessionIds)],
    }
  }

  /** Read detached, Host-generation-scoped execution snapshots for plan/run comparison. */
  executionSnapshot(parentSessionIds: readonly string[]): PlanExecutionRepositorySnapshot {
    return {
      schemaVersion: 1,
      hostInstanceId: this.ledger.hostInstanceId,
      hostStartedAt: this.ledger.hostStartedAt,
      revision: this.executions.revision,
      capturedAt: Date.now(),
      durability: 'host-only',
      executions: [...this.executions.list(parentSessionIds)],
    }
  }

  /** Save one model- or user-authored draft without starting any Agent. */
  savePlanDraft(input: SavePlanDraftInput): AgentPlanRevision {
    return this.plans.saveDraft(input)
  }

  /** Register the model-facing planner tool names owned by one plan-tool instance. */
  registerPlannerToolNames(designToolName: string, executeToolName: string): () => void {
    this.plannerDesignToolNames.add(designToolName)
    this.plannerExecuteToolNames.add(executeToolName)
    return () => {
      this.plannerDesignToolNames.delete(designToolName)
      this.plannerExecuteToolNames.delete(executeToolName)
    }
  }

  /** Issue one short-lived, one-time grant after an explicit browser execution request. */
  async issuePlanExecutionGrant(
    parentSessionId: string,
    planId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<PlanExecutionGrant> {
    this.pruneExecutionGrants()
    const plan = this.plans.get(parentSessionId, planId, revision)
    if (plan === undefined) throw new Error('approved Agent plan revision was not found')
    if (plan.state !== 'approved') throw new Error('only an approved Agent plan revision can receive an execution grant')
    const planKey = executionPlanKey(parentSessionId, planId, revision)
    if (this.activePlanExecutions.has(planKey)) {
      throw new Error('this Agent plan revision already has an active execution')
    }
    const capabilities = await this.executionCapabilities(parentSessionId, signal)
    if (!capabilities.adapters.workflow) {
      throw new Error('Workflow execution is unavailable in this DSH profile')
    }
    const executeToolName = capabilities.plannerTools?.execute.find(name => capabilities.tools.includes(name))
    if (capabilities.scopeStatus !== 'available') {
      throw new Error('the current Agent scope is unavailable')
    }
    if (executeToolName === undefined) {
      throw new Error('the plan execution tool is unavailable in the current Agent scope')
    }
    if (plan.capabilityDigest !== capabilities.digest) {
      throw new Error('execution capabilities changed after approval')
    }
    const preflight = preflightAgentPlan(plan, capabilities)
    if (!preflight.valid) throw new PlanApprovalError('approved Agent plan no longer passes preflight')
    this.pruneExecutionGrants()
    const previousGrantId = this.grantByPlanKey.get(planKey)
    const previousGrant = previousGrantId === undefined
      ? undefined
      : this.executionGrants.get(previousGrantId)
    if (previousGrant !== undefined) {
      const { planKey: _planKey, ...publicGrant } = previousGrant
      return publicGrant
    }
    if (this.executionGrants.size >= 256) {
      throw new Error('execution grant capacity reached; wait for existing grants to expire')
    }
    const grant: ExecutionGrantRecord = {
      grantId: randomUUID(),
      parentSessionId,
      planId,
      revision,
      capabilityDigest: capabilities.digest,
      executeToolName,
      expiresAt: Date.now() + EXECUTION_GRANT_TTL_MS,
      planKey,
    }
    this.executionGrants.set(grant.grantId, grant)
    this.grantByPlanKey.set(planKey, grant.grantId)
    const { planKey: _planKey, ...publicGrant } = grant
    return publicGrant
  }

  /** Execute one approved exact revision through the currently available official Workflow service. */
  async executeApprovedPlan(
    parent: Agent,
    planId: string,
    revision: number,
    grantId: string,
    signal: AbortSignal,
  ): Promise<PlanExecution> {
    const parentSessionId = String(parent.id)
    const planKey = executionPlanKey(parentSessionId, planId, revision)
    this.consumeExecutionGrant(parentSessionId, planId, revision, grantId)
    if (this.activePlanExecutions.has(planKey)) {
      throw new Error('this Agent plan revision already has an active execution')
    }
    this.activePlanExecutions.add(planKey)
    try {
      const plan = this.plans.get(parentSessionId, planId, revision)
      if (plan === undefined) throw new Error('approved Agent plan revision was not found')
      if (plan.state !== 'approved') throw new Error('only an approved Agent plan revision can execute')
      const adapter = this.workflowAdapter
      if (adapter === undefined) throw new Error('Workflow execution is unavailable in this DSH profile')
      const capabilities = await this.executionCapabilities(parentSessionId, signal)
      const preflight = preflightAgentPlan(plan, capabilities)
      const run = adapter.start({ parent, plan, preflight, capabilities, signal })
      // The adapter-wide subscription normally publishes this initial state;
      // this explicit upsert closes any mount/listener scheduling race.
      this.executions.upsert(run.snapshot())
      try {
        return await run.result
      } finally {
        await run.dispose()
        this.executions.upsert(run.snapshot())
      }
    } finally {
      this.activePlanExecutions.delete(planKey)
    }
  }

  private consumeExecutionGrant(
    parentSessionId: string,
    planId: string,
    revision: number,
    grantId: string,
  ): void {
    this.pruneExecutionGrants()
    const grant = this.executionGrants.get(grantId)
    if (grant === undefined) throw new Error('a valid execution grant is required')
    this.executionGrants.delete(grantId)
    if (this.grantByPlanKey.get(grant.planKey) === grantId) this.grantByPlanKey.delete(grant.planKey)
    if (
      grant.expiresAt <= Date.now()
      || grant.parentSessionId !== parentSessionId
      || grant.planId !== planId
      || grant.revision !== revision
    ) {
      throw new Error('execution grant is expired or does not match this plan revision')
    }
  }

  private pruneExecutionGrants(): void {
    const now = Date.now()
    for (const [grantId, grant] of this.executionGrants) {
      if (grant.expiresAt > now) continue
      this.executionGrants.delete(grantId)
      if (this.grantByPlanKey.get(grant.planKey) === grantId) this.grantByPlanKey.delete(grant.planKey)
    }
  }

  /** Request cancellation only for an execution owned by the requesting parent Session. */
  cancelPlanExecution(
    parentSessionId: string,
    executionId: string,
    reason?: string,
  ): CancelPlanExecutionResult {
    const snapshot = this.executions.get(parentSessionId, executionId)
    if (snapshot === undefined) return { status: 'not-found' }
    if (isTerminalPlanExecutionStatus(snapshot.status)) return { status: 'already-terminal' }
    return this.workflowAdapter?.cancel(parentSessionId, executionId, reason) === true
      ? { status: 'requested' }
      : { status: 'not-found' }
  }

  /** Discover the exact public capabilities currently enforceable by this plugin Host. */
  async executionCapabilities(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionCapabilitySnapshot> {
    const transportProvidersByName = new Map<string, ExecutionCapabilitySnapshot['transportProviders'][number]>()
    for (const registeredName of this.ctx.subagents.list()) {
      const provider = this.ctx.subagents.getProvider(registeredName)
      const name = normalizedCapabilityName(provider?.name)
      if (provider === undefined || name === undefined || transportProvidersByName.has(name)) continue
      transportProvidersByName.set(name, {
        name,
        inheritsParentContext: provider.inheritsParentContext,
        outputSchema: provider.capabilities.outputSchema,
        depthLimit: provider.capabilities.depthLimit,
        toolFilter: provider.capabilities.toolFilter,
        persona: provider.capabilities.persona,
        continuable: provider.prepareContinuable !== undefined,
        modelRouting: 'unsupported',
        maxTokens: 'unsupported',
      })
    }
    const transportProviders = [...transportProvidersByName.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 128)
    const llm = this.ctx.get('llm')
    let llmRoutes: ExecutionCapabilitySnapshot['llmRoutes'] = []
    if (llm !== undefined) {
      let providerIds: string[] = []
      try {
        providerIds = llm.listProviders().map(provider => provider.id)
      } catch {
        providerIds = []
      }
      llmRoutes = await collectLlmRoutes(
        providerIds,
        async provider => await this.llmModelCatalog.load(
          provider,
          async providerId => await llm.listModels(providerId),
        ),
        signal,
      )
    }
    const parent = this.ctx.get('agents')?.get(parentSessionId as SessionId)
    const scopeStatus = parent === undefined ? 'unavailable' as const : 'available' as const
    const plannerTools = {
      design: normalizedCapabilityNames([...this.plannerDesignToolNames], 32),
      execute: normalizedCapabilityNames([...this.plannerExecuteToolNames], 32),
    }
    const registeredPlannerTools = normalizedCapabilityNames([
      ...plannerTools.design,
      ...plannerTools.execute,
    ], 64)
    const scopedTools = parent === undefined
      ? []
      : normalizedCapabilityNames(this.ctx.tools.schemas(parent).map(tool => tool.name), Number.MAX_SAFE_INTEGER)
    const scopedToolSet = new Set(scopedTools)
    const requiredPlannerTools = registeredPlannerTools.filter(name => scopedToolSet.has(name))
    const requiredPlannerToolSet = new Set(requiredPlannerTools)
    const tools = parent === undefined ? [] : [
      ...requiredPlannerTools,
      ...scopedTools.filter(name => !requiredPlannerToolSet.has(name)),
    ].slice(0, 1_024)
    const base = executionCapabilitySnapshotSchema.omit({ digest: true, catalogDigest: true }).parse({
      schemaVersion: 1,
      capturedAt: Date.now(),
      adapters: { workflow: this.workflowAdapter !== undefined, agentTeam: false },
      transportProviders,
      llmRoutes,
      agentPresets: [] as string[],
      tools,
      plannerTools,
      budgetSupport: {
        maxAgents: 'enforced' as const,
        maxConcurrent: 'enforced' as const,
        planTimeout: 'enforced' as const,
        requests: 'advisory' as const,
        tokens: 'advisory' as const,
        cost: 'unsupported' as const,
      },
      limits: {
        maxAgents: this.resolved.plannerMaxAgents,
        maxConcurrent: this.resolved.plannerMaxConcurrent,
      },
      experimentalAgentTeam: false,
      scopeStatus,
    })
    const { schemaVersion: _schemaVersion, capturedAt: _capturedAt, ...payload } = base
    const enforcementPayload = {
      adapters: payload.adapters,
      transportProviders: payload.transportProviders,
      llmProviders: payload.llmRoutes.map(route => route.provider),
      tools: payload.tools,
      plannerTools: payload.plannerTools,
      budgetSupport: payload.budgetSupport,
      limits: payload.limits,
      experimentalAgentTeam: payload.experimentalAgentTeam,
      scopeStatus: payload.scopeStatus,
    }
    const digest = createHash('sha256').update(JSON.stringify(enforcementPayload)).digest('hex')
    const catalogDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return executionCapabilitySnapshotSchema.parse({
      ...base,
      digest,
      catalogDigest,
    })
  }

  /**
   * Subscribe to ledger revisions for the optional invariant face.
   * @param listener - callback after any visible ledger change.
   * @returns disposer removing the callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Wait until the Host ledger advances, the request is cancelled, or a heartbeat timeout expires. */
  private waitForRevision(
    afterRevision: number,
    hostInstanceId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      hostInstanceId !== undefined && hostInstanceId !== this.ledger.hostInstanceId
      || this.ledger.revision !== afterRevision
      || signal.aborted
    ) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = (): void => {}
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        unsubscribe()
        resolve()
      }
      unsubscribe = this.subscribe(() => {
        if (this.ledger.revision > afterRevision) finish()
      })
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, timeoutMs)
      // Close the subscribe/check race when a mutation landed between the first check and registration.
      if (this.ledger.revision > afterRevision) finish()
    })
  }

  private waitForPlanRevision(
    afterRevision: number,
    hostInstanceId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      hostInstanceId !== undefined && hostInstanceId !== this.ledger.hostInstanceId
      || afterRevision > this.plans.revision
      || this.plans.revision > afterRevision
      || signal.aborted
    ) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = (): void => {}
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        unsubscribe()
        resolve()
      }
      unsubscribe = this.plans.subscribe(() => {
        if (this.plans.revision > afterRevision) finish()
      })
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, timeoutMs)
      if (this.plans.revision > afterRevision) finish()
    })
  }

  private waitForExecutionRevision(
    afterRevision: number,
    hostInstanceId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      hostInstanceId !== undefined && hostInstanceId !== this.ledger.hostInstanceId
      || afterRevision > this.executions.revision
      || this.executions.revision > afterRevision
      || signal.aborted
    ) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = (): void => {}
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        unsubscribe()
        resolve()
      }
      unsubscribe = this.executions.subscribe((revision) => {
        if (revision > afterRevision) finish()
      })
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, timeoutMs)
      if (this.executions.revision > afterRevision) finish()
    })
  }

  private async handlePlannerRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<ConsoleRpcResponse | undefined> {
    try {
      if (endpoint === LIST_PLAN_EXECUTIONS_ENDPOINT || endpoint === WATCH_PLAN_EXECUTIONS_ENDPOINT) {
        const parsed = endpoint === WATCH_PLAN_EXECUTIONS_ENDPOINT
          ? watchPlanExecutionsRequestSchema.safeParse(payload)
          : listPlanExecutionsRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        if (endpoint === WATCH_PLAN_EXECUTIONS_ENDPOINT) {
          const request = watchPlanExecutionsRequestSchema.parse(parsed.data)
          await this.waitForExecutionRevision(
            request.afterRevision,
            request.hostInstanceId,
            request.timeoutMs,
            signal,
          )
          if (signal.aborted) return cancelledRpcResponse()
        }
        return { ok: true, value: this.executionSnapshot(parsed.data.parentSessionIds) }
      }
      if (endpoint === ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT) {
        const parsed = planRevisionRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return {
          ok: true,
          value: await this.issuePlanExecutionGrant(
            parsed.data.parentSessionId,
            parsed.data.planId,
            parsed.data.revision,
            signal,
          ),
        }
      }
      if (endpoint === CANCEL_PLAN_EXECUTION_ENDPOINT) {
        const parsed = cancelPlanExecutionRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return {
          ok: true,
          value: this.cancelPlanExecution(
            parsed.data.parentSessionId,
            parsed.data.executionId,
            parsed.data.reason,
          ),
        }
      }
      if (endpoint === LIST_PLANS_ENDPOINT || endpoint === WATCH_PLANS_ENDPOINT) {
        const parsed = endpoint === WATCH_PLANS_ENDPOINT
          ? watchPlansRequestSchema.safeParse(payload)
          : listPlansRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        if (endpoint === WATCH_PLANS_ENDPOINT) {
          const request = watchPlansRequestSchema.parse(parsed.data)
          await this.waitForPlanRevision(
            request.afterRevision,
            request.hostInstanceId,
            request.timeoutMs,
            signal,
          )
          if (signal.aborted) return cancelledRpcResponse()
        }
        return { ok: true, value: this.planSnapshot(parsed.data.parentSessionIds) }
      }
      if (endpoint === SAVE_PLAN_ENDPOINT) {
        try {
          assertBoundedJsonValue(payload, 272 * 1024)
        } catch {
          return plannerRpcError('invalid-request', 'agent plan payload is not bounded JSON')
        }
        const parsed = savePlanRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        const saved = this.plans.saveDraft({
          parentSessionId: parsed.data.parentSessionId,
          expectedRevision: parsed.data.expectedRevision,
          content: parsed.data.content,
          ...(parsed.data.planId === undefined ? {} : { planId: parsed.data.planId }),
        })
        return { ok: true, value: saved }
      }
      if (endpoint === EXECUTION_CAPABILITIES_ENDPOINT) {
        const parsed = executionCapabilitiesRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: await this.executionCapabilities(parsed.data.parentSessionId, signal) }
      }
      if (endpoint === PREFLIGHT_PLAN_ENDPOINT || endpoint === APPROVE_PLAN_ENDPOINT) {
        const parsed = endpoint === APPROVE_PLAN_ENDPOINT
          ? approvePlanRequestSchema.safeParse(payload)
          : planRevisionRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        const plan = this.plans.get(
          parsed.data.parentSessionId,
          parsed.data.planId,
          parsed.data.revision,
        )
        if (plan === undefined) {
          return plannerRpcError('not-found', 'agent plan revision was not found')
        }
        const capabilities = await this.executionCapabilities(parsed.data.parentSessionId, signal)
        if (endpoint === APPROVE_PLAN_ENDPOINT) {
          const request = approvePlanRequestSchema.parse(parsed.data)
          if (request.capabilityDigest !== capabilities.digest) {
            return plannerRpcError('stale-capabilities', 'runtime capabilities changed; run preflight again')
          }
          const preflight = preflightAgentPlan(plan, capabilities)
          return {
            ok: true,
            value: this.plans.approve({
              parentSessionId: request.parentSessionId,
              planId: request.planId,
              revision: request.revision,
              preflight,
              acceptedWarningIds: request.acceptedWarningIds,
            }),
          }
        }
        return { ok: true, value: preflightAgentPlan(plan, capabilities) }
      }
      return undefined
    } catch (error: unknown) {
      if (error instanceof PlanRevisionConflictError) {
        return plannerRpcError(
          'revision-conflict',
          `${error.message}; expected=${String(error.expectedRevision)} actual=${String(error.actualRevision)}`,
        )
      }
      if (error instanceof PlanOwnershipError) return plannerRpcError('forbidden', error.message)
      if (error instanceof PlanExecutionOwnershipError) return plannerRpcError('forbidden', error.message)
      if (error instanceof PlanApprovalError) return plannerRpcError('preflight-blocked', error.message)
      this.ctx.logger.warn(`product-subagent-console: planner RPC failed: ${String(error)}`)
      return internalRpcError('planner request failed')
    }
  }

  /** Assert internal capacity and attempt-promotion relationships. */
  assertIntegrity(): void {
    this.ledger.assertIntegrity()
    if (this.admission.activeCount > this.resolved.maxConcurrent) {
      throw new Error('product-subagent-console: active admission exceeds its configured maximum')
    }
    if (this.admission.queuedCount > this.resolved.maxQueued) {
      throw new Error('product-subagent-console: queued admission exceeds its configured maximum')
    }
  }

  /**
   * Admit and start one plugin-owned delegation while preserving the official run lifecycle.
   * @param spec - exact display-safe tool and provider metadata.
   * @param start - official `ctx.subagents.start` call using the supplied fused signal.
   * @returns the unmodified official SubagentRun.
   */
  async startOwned(
    spec: OwnedDelegationSpec,
    start: (signal: AbortSignal) => Promise<SubagentRun>,
  ): Promise<SubagentRun> {
    const attemptId = randomUUID()
    const observation: ExecutionObservation = {
      source: 'owned-tool',
      attemptId,
      parentSessionId: spec.parentSessionId,
      callId: spec.callId,
      toolName: spec.toolName,
      expectedProviderName: spec.providerName,
      ...spec.label === undefined ? {} : { label: spec.label },
      ...spec.product === undefined ? {} : { product: spec.product },
      ...spec.displayName === undefined ? {} : { displayName: spec.displayName },
      ...spec.instance === undefined ? {} : { instance: spec.instance },
    }
    this.mutate(() => { this.ledger.createAttempt(observation, spec.providerName) })

    let release: (() => void) | undefined
    try {
      release = await this.admission.acquire(spec.signal)
    } catch (error: unknown) {
      const outcome = error instanceof AdmissionQueueFullError
        ? 'queue-full'
        : 'cancelled-before-publication'
      this.mutate(() => { this.ledger.settleAttempt(attemptId, outcome, spec.signal.aborted) })
      throw error
    }

    this.mutate(() => { this.ledger.markStarting(attemptId) })
    const ownedSignal = this.ownedSignal(spec.signal)
    let run: SubagentRun
    try {
      run = await this.execution.run(observation, () => start(ownedSignal.signal))
    } catch (error: unknown) {
      this.mutate(() => {
        this.ledger.settleAttempt(
          attemptId,
          ownedSignal.signal.aborted ? 'cancelled-before-publication' : 'start-failed',
          ownedSignal.signal.aborted,
        )
      })
      ownedSignal.dispose()
      release()
      throw error
    }

    const published = this.ledger.snapshot([spec.parentSessionId]).runs.some(record => record.attemptId === attemptId)
    if (!published) {
      this.mutate(() => { this.ledger.settleAttempt(attemptId, 'lifecycle-missing', false) })
      this.ctx.logger.warn('product-subagent-console: an owned run returned without its official start edge')
    }
    let disposed = false
    return {
      ...run,
      async dispose() {
        if (disposed) return
        disposed = true
        try {
          await run.dispose()
        } finally {
          ownedSignal.dispose()
          release?.()
        }
      },
    }
  }

  private observeToolExecution(
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    const parent = exec.agent
    if (parent === undefined) return next()
    const label = displayLabelFromArguments(exec.arguments)
    const observation: ExecutionObservation = {
      source: 'observed-tool',
      parentSessionId: String(parent.id),
      callId: String(exec.callId),
      toolName: exec.name,
      ...label === undefined ? {} : { label },
    }
    return this.execution.run(observation, next)
  }

  private observePublishedRun(info: SubagentRunInfo): void {
    const observation = this.execution.getStore()
    if (observation === undefined) return
    try {
      const before = this.ledger.revision
      const published = this.ledger.publish(observation, info)
      if (this.ledger.revision !== before) this.publishChange()
      if (!published) this.ctx.logger.warn('product-subagent-console: observed active-run capacity reached; run omitted')
    } catch (error: unknown) {
      this.ctx.logger.warn(`product-subagent-console: start observation failed: ${String(error)}`)
    }
  }

  private observeTerminalRun(info: SubagentRunEndInfo): void {
    try {
      const before = this.ledger.revision
      this.ledger.settle(info)
      if (this.ledger.revision !== before) this.publishChange()
    } catch (error: unknown) {
      this.ctx.logger.warn(`product-subagent-console: end observation failed: ${String(error)}`)
    }
  }

  private mutate(operation: () => void): void {
    const before = this.ledger.revision
    operation()
    if (this.ledger.revision !== before) this.publishChange()
  }

  private publishChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error: unknown) {
        this.ctx.logger.warn(`product-subagent-console: revision listener failed: ${String(error)}`)
      }
    }
  }

  private ownedSignal(caller: AbortSignal): OwnedSignal {
    const controller = new AbortController()
    this.ownedControllers.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => { controller.abort(caller.reason ?? 'owned delegation cancelled') }
    if (caller.aborted) abort()
    else caller.addEventListener('abort', abort, { once: true })
    if (this.resolved.runTimeoutMs > 0 && !controller.signal.aborted) {
      timer = setTimeout(() => {
        controller.abort(`owned delegation exceeded ${String(this.resolved.runTimeoutMs)}ms`)
      }, this.resolved.runTimeoutMs)
    }
    let disposed = false
    return {
      signal: controller.signal,
      dispose: () => {
        if (disposed) return
        disposed = true
        caller.removeEventListener('abort', abort)
        if (timer !== undefined) clearTimeout(timer)
        this.ownedControllers.delete(controller)
      },
    }
  }
}

function plannerRpcError(reason: string, message: string): ConsoleRpcResponse {
  return {
    ok: false,
    error: { code: 'command-error', message: `[${reason}] ${message}`, details: {} },
  }
}

function internalRpcError(message: string): ConsoleRpcResponse {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function invalidPlannerRequest(issues: readonly unknown[]): ConsoleRpcResponse {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message: 'invalid planner request',
      // The caller supplies only arrays returned by Zod safeParse.
      details: { issues: [...issues] as never[] },
    },
  }
}

function cancelledRpcResponse(): ConsoleRpcResponse {
  return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxConcurrent: config.maxConcurrent ?? 4,
    maxQueued: config.maxQueued ?? 16,
    historyLimit: config.historyLimit ?? 50,
    maxObservedActive: config.maxObservedActive ?? 128,
    runTimeoutMs: config.runTimeoutMs ?? 0,
    plannerMaxConcurrent: config.plannerMaxConcurrent ?? 4,
    plannerMaxAgents: config.plannerMaxAgents ?? 32,
  }
  if (!Number.isInteger(resolved.maxConcurrent) || resolved.maxConcurrent < 1 || resolved.maxConcurrent > 64) {
    throw new Error('product-subagent-console: maxConcurrent must be an integer from 1 to 64')
  }
  if (!Number.isInteger(resolved.maxQueued) || resolved.maxQueued < 0 || resolved.maxQueued > 256) {
    throw new Error('product-subagent-console: maxQueued must be an integer from 0 to 256')
  }
  if (!Number.isInteger(resolved.historyLimit) || resolved.historyLimit < 0 || resolved.historyLimit > 1_000) {
    throw new Error('product-subagent-console: historyLimit must be an integer from 0 to 1000')
  }
  if (!Number.isInteger(resolved.maxObservedActive) || resolved.maxObservedActive < 1 || resolved.maxObservedActive > 1_000) {
    throw new Error('product-subagent-console: maxObservedActive must be an integer from 1 to 1000')
  }
  if (!Number.isInteger(resolved.runTimeoutMs) || resolved.runTimeoutMs < 0 || resolved.runTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`product-subagent-console: runTimeoutMs must be an integer from 0 to ${String(MAX_TIMER_DELAY_MS)}`)
  }
  if (
    !Number.isInteger(resolved.plannerMaxConcurrent)
    || resolved.plannerMaxConcurrent < 1
    || resolved.plannerMaxConcurrent > 16
  ) {
    throw new Error('product-subagent-console: plannerMaxConcurrent must be an integer from 1 to 16')
  }
  if (!Number.isInteger(resolved.plannerMaxAgents) || resolved.plannerMaxAgents < 1 || resolved.plannerMaxAgents > 32) {
    throw new Error('product-subagent-console: plannerMaxAgents must be an integer from 1 to 32')
  }
  return resolved
}

export default ProductSubagentConsoleService
