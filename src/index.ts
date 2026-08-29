import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
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
import { buildRunCapsule } from './capsule.js'
import { buildConformanceReport, sha256 } from './conformance.js'
import {
  FoundryEventLedger,
  FoundryLedgerCapacityError,
  type NewFoundryEvent,
} from './event-ledger.js'
import { preflightAgentPlan } from './plan-preflight.js'
import { buildRecoveryProposal } from './recovery.js'
import {
  buildRecipeCandidate,
  buildRunAdvisor,
  exportRecipeCandidate,
  instantiateRecipeCandidate,
  RecipeEligibilityError,
} from './recipe.js'
import { buildRunQuery } from './run-query.js'
import { buildTelemetryPreview } from './telemetry.js'
import { projectExecutionAtCursor } from './temporal-execution.js'
import { PRODUCT_VERSION } from './version.js'
import {
  PlanExecutionCapacityError,
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
  type PlannerRpcReason,
  planRevisionRequestSchema,
  SAVE_PLAN_ENDPOINT,
  savePlanRequestSchema,
  WATCH_PLANS_ENDPOINT,
  WATCH_PLAN_EXECUTIONS_ENDPOINT,
  watchPlanExecutionsRequestSchema,
  watchPlansRequestSchema,
  type ExecutionCapabilitySnapshot,
  type AgentPlanRevision,
  type PlanExecution,
  type PlanExecutionGrant,
  type PlanExecutionRepositorySnapshot,
  type PlanRunBinding,
  type PlanRepositorySnapshot,
} from './plan-types.js'
import type { SavePlanDraftInput } from './plan-store.js'
import type { PlanExecutionRun } from './planner-execution.js'
import {
  foundrySnapshotSchema,
  COMPARE_FOUNDRY_RUNS_ENDPOINT,
  compareRunsRequestSchema,
  EXPORT_RECIPE_ENDPOINT,
  exportRecipeRequestSchema,
  EXPORT_RUN_CAPSULE_ENDPOINT,
  exportRunCapsuleRequestSchema,
  EXPORT_TELEMETRY_ENDPOINT,
  exportTelemetryRequestSchema,
  EXECUTE_CANCEL_CONTROL_ENDPOINT,
  executeCancelControlRequestSchema,
  INSPECT_FOUNDRY_RUN_ENDPOINT,
  inspectRunRequestSchema,
  INSTANTIATE_RECIPE_ENDPOINT,
  instantiateRecipeRequestSchema,
  ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT,
  issueCancelGrantRequestSchema,
  LIST_FOUNDRY_RUNS_ENDPOINT,
  listFoundryRunsRequestSchema,
  projectPlanContractV2,
  PREVIEW_RECIPE_ENDPOINT,
  recipeCandidateRequestSchema,
  WATCH_FOUNDRY_RUNS_ENDPOINT,
  watchFoundryRunsRequestSchema,
  type FoundryEventEnvelope,
  type FoundrySnapshot,
  type CompareRunsRequest,
  type ExportRecipeRequest,
  type ExportRecipeResult,
  type ExportRunCapsuleRequest,
  type ExportRunCapsuleResult,
  type ExportTelemetryRequest,
  type ExportTelemetryResult,
  type ExecuteCancelControlRequest,
  type ExecuteCancelControlResult,
  type EvidenceReceipt,
  type FoundryControlGrant,
  type InspectRunRequest,
  type InspectRunResult,
  type InstantiateRecipeRequest,
  type InstantiateRecipeResult,
  type IssueCancelGrantRequest,
  type RecipeCandidate,
  type RecipeCandidateRequest,
  type RunAdvisorResult,
} from './foundry-types.js'
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
export type * from './foundry-types.js'
export { buildConformanceReport } from './conformance.js'
export { buildRecoveryProposal } from './recovery.js'
export { FoundryEventLedger } from './event-ledger.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const EXECUTION_GRANT_TTL_MS = 12 * 60 * 60_000
const FOUNDRY_CONTROL_GRANT_TTL_MS = 2 * 60_000
const FOUNDRY_CONTROL_SWEEP_INTERVAL_MS = 1_000
const MAX_CAPABILITY_NAME_LENGTH = 128

function assertSignalActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

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
  /** Persist privacy-safe Foundry facts under the DSH home directory. Default: true. */
  foundryStorage?: boolean
  /** Optional absolute directory override. Empty uses the DSH home directory. */
  foundryStorageDirectory?: string
  /** Allow offline OTLP JSON preview export. No network exporter is created. Default: false. */
  telemetryExport?: boolean
}

interface ResolvedConfig {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly historyLimit: number
  readonly maxObservedActive: number
  readonly runTimeoutMs: number
  readonly plannerMaxConcurrent: number
  readonly plannerMaxAgents: number
  readonly foundryStorageDirectory: string | null | undefined
  readonly telemetryExport: boolean
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

interface FoundryControlGrantRecord {
  readonly grant: FoundryControlGrant
  readonly issuedEventId: string
  readonly proposalEventCursor: number
  consumedEventId?: string
  pendingResult?: 'requested' | 'not-found' | 'interrupted'
}

type FoundryControlClosure =
  | 'not-found'
  | 'already-terminal'
  | 'already-requested'
  | 'stale-state'
  | 'expired'
  | 'host-unloaded'

interface ExecutionFactReservation {
  readonly planKey: string
  eventsRemaining: number
  receiptsRemaining: number
}

const EXECUTION_FACT_EVENT_TYPES = new Set<FoundryEventEnvelope['type']>([
  'execution-queued',
  'execution-started',
  'execution-stopping',
  'execution-terminal',
  'attempt-started',
  'attempt-waiting',
  'attempt-stopping',
  'attempt-terminal',
  'child-published',
  'child-terminal',
  'evidence-recorded',
])

type PlanExecutionGrantFailureReason = Extract<PlannerRpcReason,
  | 'agent-scope-unavailable'
  | 'already-active'
  | 'capacity-reached'
  | 'execution-tool-unavailable'
  | 'not-approved'
  | 'not-found'
  | 'stale-capabilities'
  | 'workflow-unavailable'>

class PlanExecutionGrantError extends Error {
  constructor(
    readonly reason: PlanExecutionGrantFailureReason,
    message: string,
  ) {
    super(message)
    this.name = 'PlanExecutionGrantError'
  }
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
    foundryStorage: schema.boolean().default(true),
    foundryStorageDirectory: schema.string().default(''),
    telemetryExport: schema.boolean().default(false),
  })

  private readonly resolved: ResolvedConfig
  private readonly execution = new AsyncLocalStorage<ExecutionObservation>()
  private readonly admission: AdmissionController
  private readonly ledger: ProductSubagentLedger
  private readonly plans: AgentPlanRepository
  private readonly executions: PlanExecutionSnapshotRepository
  private readonly foundry: FoundryEventLedger
  private readonly executionGrants = new Map<string, ExecutionGrantRecord>()
  private readonly foundryControlGrants = new Map<string, FoundryControlGrantRecord>()
  private readonly executionFactReservations = new Map<string, ExecutionFactReservation>()
  private readonly grantByPlanKey = new Map<string, string>()
  private readonly activePlanExecutions = new Set<string>()
  private readonly llmModelCatalog = new LlmModelCatalogCache()
  private readonly plannerDesignToolNames = new Set<string>()
  private readonly plannerExecuteToolNames = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly ownedControllers = new Set<AbortController>()
  private reservedControlEventSlots = 0
  private pendingExecutionFactReservation: ExecutionFactReservation | undefined
  private shuttingDown = false
  private workflowAdapter: WorkflowPlanExecutionAdapter<Agent> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'productSubagentConsole')
    this.resolved = resolveConfig(config)
    this.admission = new AdmissionController(this.resolved.maxConcurrent, this.resolved.maxQueued)
    this.ledger = new ProductSubagentLedger(this.resolved)
    this.foundry = new FoundryEventLedger({
      ...(this.resolved.foundryStorageDirectory === undefined
        ? {}
        : { storageDirectory: this.resolved.foundryStorageDirectory }),
      onStorageError: error => {
        ctx.logger.warn(`product-subagent-console: Foundry storage degraded: ${String(error)}`)
      },
    })
    this.plans = new AgentPlanRepository(
      100,
      50,
      16 * 1024 * 1024,
      20,
      error => { ctx.logger.warn(`product-subagent-console: plan listener failed: ${String(error)}`) },
    )
    this.executions = new PlanExecutionSnapshotRepository(
      5_000,
      Date.now,
      error => { ctx.logger.warn(`product-subagent-console: execution listener failed: ${String(error)}`) },
    )
    this.plans.restore(this.foundry.listPlanRevisions())
    this.executions.restore(this.foundry.listExecutionSnapshots())
    this.reconcileControlAudit()
    this.reconcileDurableExecutionEvents()
    this.reconcileLifecycleReceipts()
    this.closeInterruptedDurableExecutions()
    const foundryControlSweep = setInterval(() => {
      if (this.shuttingDown) return
      try {
        this.pruneFoundryControlGrants()
      } catch (error: unknown) {
        ctx.logger.warn(`product-subagent-console: Foundry control sweep failed: ${String(error)}`)
      }
    }, FOUNDRY_CONTROL_SWEEP_INTERVAL_MS)
    foundryControlSweep.unref()
    const connection = ctx.get('connection') as unknown as HostConnectionHandle

    const workflowFiber = ctx.inject(['workflowEngine'], (workflowCtx) => {
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
          const execution = this.executions.get(binding.parentSessionId, binding.executionId)
          const attempt = execution?.bindings.find(candidate => candidate.taskId === binding.taskId)
          this.recordFoundryEvent({
            source: 'dsh-workflow',
            sourceEventId: `${binding.executionId}:child:${String(binding.workflowSeq)}:published`,
            parentSessionId: binding.parentSessionId,
            runId: binding.executionId,
            ...(execution === undefined ? {} : {
              planId: execution.planId,
              planRevision: execution.planRevision,
            }),
            taskId: binding.taskId,
            ...(attempt === undefined ? {} : { attemptId: attempt.attemptId }),
            type: 'child-published',
            authority: 'dsh',
            observedAt: Date.now(),
            causalParents: [],
            artifacts: [],
          })
        },
        onTaskTerminal: terminal => {
          const execution = this.executions.get(terminal.parentSessionId, terminal.executionId)
          const attempt = execution?.bindings.find(candidate => candidate.attemptId === terminal.attemptId)
          const event = this.recordFoundryEvent({
            source: 'dsh-workflow',
            sourceEventId: `${terminal.executionId}:child:${String(terminal.workflowSeq)}:terminal`,
            parentSessionId: terminal.parentSessionId,
            runId: terminal.executionId,
            ...(execution === undefined ? {} : {
              planId: execution.planId,
              planRevision: execution.planRevision,
            }),
            taskId: terminal.taskId,
            attemptId: terminal.attemptId,
            type: 'child-terminal',
            authority: 'dsh',
            observedAt: terminal.observedAt,
            terminalReason: terminal.outcome,
            causalParents: [],
            artifacts: [],
          })
          if (execution !== undefined && attempt !== undefined && event !== undefined) {
            this.recordLifecycleReceipts(execution, attempt, event)
          }
        },
        onUnboundAgent: event => {
          const execution = this.executions.get(event.parentSessionId, event.executionId)
          this.recordFoundryEvent({
            source: 'dsh-workflow',
            sourceEventId: `${event.workflowRunId}:child:${String(event.workflowSeq)}:${event.phase}`,
            parentSessionId: event.parentSessionId,
            runId: event.executionId,
            ...(execution === undefined ? {} : {
              planId: execution.planId,
              planRevision: execution.planRevision,
            }),
            type: event.phase === 'start' ? 'child-published' : 'child-terminal',
            authority: 'dsh',
            observedAt: Date.now(),
            ...(event.phase === 'end' ? {
              terminalReason: event.outcome ?? 'unknown',
            } : {}),
            causalParents: [],
            artifacts: [],
          })
        },
        onExecutionCheckpoint: execution => { this.persistExecutionSnapshot(execution) },
        onListenerError: error => {
          ctx.logger.warn(`product-subagent-console: Workflow execution listener failed: ${String(error)}`)
        },
      })
      const unsubscribe = adapter.subscribe((execution) => {
        try {
          this.persistExecutionSnapshot(execution)
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
        const foundryResponse = await this.handleFoundryRpc(endpoint, payload, signal)
        if (foundryResponse !== undefined) return foundryResponse
        if (signal.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
        }
        const plannerResponse = await this.handlePlannerRpc(endpoint, payload, signal)
        if (plannerResponse !== undefined) return plannerResponse
        if (signal.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
        }
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
    ctx.effect(() => async () => {
      this.shuttingDown = true
      clearInterval(foundryControlSweep)
      this.closeAllFoundryControlGrants('host-unloaded')
      this.admission.close()
      for (const controller of this.ownedControllers) {
        controller.abort('product-subagent-console unloaded')
      }
      this.ownedControllers.clear()
      await workflowFiber.dispose()
      this.foundry.dispose()
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
      hostInstanceId: this.foundry.hostInstanceId,
      hostStartedAt: this.foundry.hostStartedAt,
      revision: this.plans.revision,
      capturedAt: Date.now(),
      durability: this.foundry.durability === 'disk' ? 'disk' : 'host-only',
      plans: [...this.plans.list(parentSessionIds)],
    }
  }

  /** Read detached, Host-generation-scoped execution snapshots for plan/run comparison. */
  executionSnapshot(parentSessionIds: readonly string[]): PlanExecutionRepositorySnapshot {
    return {
      schemaVersion: 1,
      hostInstanceId: this.foundry.hostInstanceId,
      hostStartedAt: this.foundry.hostStartedAt,
      revision: this.executions.revision,
      capturedAt: Date.now(),
      durability: this.foundry.durability === 'disk' ? 'disk' : 'host-only',
      executions: [...this.executions.list(parentSessionIds)],
    }
  }

  /** Return one atomic, privacy-safe Foundry projection for the requested Sessions. */
  foundrySnapshot(parentSessionIds: readonly string[]): FoundrySnapshot {
    const capturedAt = Date.now()
    const events = this.foundry.listEvents(parentSessionIds)
    const receipts = this.foundry.listReceipts(parentSessionIds)
    const plans = [...this.plans.list(parentSessionIds)]
    const executions = [...this.executions.list(parentSessionIds)]
    const runKey = (parentSessionId: string, runId: string): string => `${parentSessionId}\u0000${runId}`
    const planKey = (parentSessionId: string, planId: string, revision: number): string => (
      `${parentSessionId}\u0000${planId}\u0000${String(revision)}`
    )
    const plansByKey = new Map(plans.map(plan => [
      planKey(plan.parentSessionId, plan.planId, plan.revision),
      plan,
    ] as const))
    const executionsByRun = new Map(executions.map(execution => [
      runKey(execution.parentSessionId, execution.executionId),
      execution,
    ] as const))
    const executionIndexesByRun = new Map(executions.map(execution => [
      runKey(execution.parentSessionId, execution.executionId),
      executionIdentityIndex(execution),
    ] as const))
    const eventsByRun = new Map<string, FoundryEventEnvelope[]>()
    for (const event of events) {
      const key = runKey(event.parentSessionId, event.runId)
      const execution = executionsByRun.get(key)
      const index = executionIndexesByRun.get(key)
      if (execution === undefined || index === undefined || !eventMatchesExecutionIdentity(event, execution, index)) continue
      const scoped = eventsByRun.get(key) ?? []
      scoped.push(event)
      eventsByRun.set(key, scoped)
    }
    const receiptsByRun = new Map<string, EvidenceReceipt[]>()
    for (const receipt of receipts) {
      const key = runKey(receipt.parentSessionId, receipt.runId)
      const execution = executionsByRun.get(key)
      const index = executionIndexesByRun.get(key)
      if (execution === undefined || index === undefined || !receiptMatchesExecutionIdentity(receipt, execution, index)) continue
      const scoped = receiptsByRun.get(key) ?? []
      scoped.push(receipt)
      receiptsByRun.set(key, scoped)
    }
    const reports = executions.flatMap(execution => {
      const key = runKey(execution.parentSessionId, execution.executionId)
      const scopedEvents = eventsByRun.get(key) ?? []
      const scopedReceipts = receiptsByRun.get(key) ?? []
      const plan = plansByKey.get(planKey(
        execution.parentSessionId,
        execution.planId,
        execution.planRevision,
      ))
      if (plan === undefined) return []
      try {
        return [buildConformanceReport({
          contract: projectPlanContractV2(plan),
          execution,
          events: scopedEvents,
          receipts: scopedReceipts,
          eventCursor: scopedEvents.at(-1)?.cursor ?? 0,
          generatedAt: capturedAt,
        })]
      } catch (error: unknown) {
        this.ctx.logger.warn(`product-subagent-console: conformance projection failed: ${String(error)}`)
        return []
      }
    })
    const recoveryProposals = reports.flatMap(report => {
      const execution = executionsByRun.get(runKey(report.parentSessionId, report.runId))
      const plan = execution === undefined ? undefined : plansByKey.get(planKey(
        execution.parentSessionId,
        report.planId,
        report.planRevision,
      ))
      if (execution === undefined || plan === undefined) return []
      return [buildRecoveryProposal({
        contract: projectPlanContractV2(plan),
        execution,
        report,
        events: eventsByRun.get(runKey(execution.parentSessionId, execution.executionId)) ?? [],
        receipts: receiptsByRun.get(runKey(execution.parentSessionId, execution.executionId)) ?? [],
        capabilityDigest: execution.capabilityDigest,
        now: capturedAt,
        controlSupport: { retry: 'unsupported', fork: 'unsupported' },
      })]
    })
    return foundrySnapshotSchema.parse({
      schemaVersion: 1,
      hostInstanceId: this.foundry.hostInstanceId,
      hostStartedAt: this.foundry.hostStartedAt,
      revision: this.foundry.scopedRevision(parentSessionIds),
      eventCursor: events.at(-1)?.cursor ?? 0,
      capturedAt,
      durability: this.foundry.durability,
      storageStatus: this.foundry.storageStatus,
      projectionDigest: sha256(JSON.stringify({ plans, executions, events, receipts })),
      adapterFacts: [{
        schemaVersion: 1,
        adapterId: 'workflow',
        adapterVersion: PRODUCT_VERSION,
        capturedAt,
        available: this.workflowAdapter !== undefined,
        lifecycleAuthority: this.workflowAdapter === undefined ? 'unavailable' : 'dsh-public-events',
        bindingMode: this.workflowAdapter === undefined ? 'unavailable' : 'exact-contract-id',
        controlSupport: {
          cancel: this.workflowAdapter === undefined ? 'unsupported' : 'advisory',
          resume: 'unsupported',
          retry: 'unsupported',
          replay: 'unsupported',
          fork: 'unsupported',
          reassign: 'unsupported',
        },
      }],
      plans,
      executions,
      events,
      receipts,
      reports,
      recoveryProposals,
    })
  }

  /** Answer one factual run question without exposing prompts or raw outputs. */
  inspectRun(request: InspectRunRequest): InspectRunResult {
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    const latest = snapshot.executions.find(item => item.executionId === request.runId)
    const cursor = request.throughCursor ?? this.runEventCursor(request.parentSessionId, request.runId)
    const execution = latest === undefined
      ? undefined
      : projectExecutionAtCursor(latest, snapshot.events, cursor)
    const plan = execution === undefined ? undefined : snapshot.plans.find(item => (
      item.planId === execution.planId && item.revision === execution.planRevision
    ))
    const eventIds = new Set(snapshot.events.filter(event => event.cursor <= cursor).map(event => event.eventId))
    const receipts = snapshot.receipts.filter(receipt => receipt.evidenceEventIds.every(eventId => eventIds.has(eventId)))
    const report = execution === undefined || plan === undefined
      ? undefined
      : buildConformanceReport({
        contract: projectPlanContractV2(plan),
        execution,
        events: snapshot.events,
        receipts,
        eventCursor: cursor,
        generatedAt: snapshot.capturedAt,
      })
    const proposal = execution === undefined || plan === undefined || report === undefined
      ? undefined
      : buildRecoveryProposal({
        contract: projectPlanContractV2(plan),
        execution,
        report,
        events: snapshot.events,
        receipts,
        capabilityDigest: execution.capabilityDigest,
        now: snapshot.capturedAt,
        controlSupport: { retry: 'unsupported', fork: 'unsupported' },
      })
    return buildRunQuery({
      request,
      ...(execution === undefined ? {} : { execution }),
      ...(report === undefined ? {} : { report }),
      ...(proposal === undefined ? {} : { proposal }),
      events: snapshot.events,
      receipts,
    })
  }

  exportRunCapsule(request: ExportRunCapsuleRequest): ExportRunCapsuleResult {
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    const execution = requiredExecution(snapshot, request.runId)
    const plan = requiredPlan(snapshot, execution)
    const report = requiredReport(snapshot, execution.executionId)
    const proposal = snapshot.recoveryProposals.find(item => item.runId === execution.executionId)
    return buildRunCapsule({
      request,
      plan,
      execution,
      report,
      ...(proposal === undefined ? {} : { proposal }),
      events: snapshot.events,
      receipts: snapshot.receipts,
      projectionDigest: snapshot.projectionDigest,
      generatorVersion: PRODUCT_VERSION,
    })
  }

  previewRecipe(request: RecipeCandidateRequest): RecipeCandidate {
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    return buildRecipeCandidate({
      request,
      plans: snapshot.plans,
      executions: snapshot.executions,
      reports: snapshot.reports,
      receipts: snapshot.receipts,
      events: snapshot.events,
    })
  }

  exportRecipe(request: ExportRecipeRequest): ExportRecipeResult {
    const candidate = this.previewRecipe(request)
    return exportRecipeCandidate(candidate, request.candidateId, request.approvalDigest)
  }

  async instantiateRecipe(
    request: InstantiateRecipeRequest,
    signal: AbortSignal,
  ): Promise<InstantiateRecipeResult> {
    const candidate = this.previewRecipe(request)
    if (candidate.candidateId !== request.candidateId) {
      throw new RecipeEligibilityError('non-comparable-contracts', 'Recipe candidate changed; inspect the source runs again')
    }
    const capabilities = await this.executionCapabilities(request.parentSessionId, signal)
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    const content = instantiateRecipeCandidate(candidate, request.objective)
    const plan = this.savePlanDraft({
      parentSessionId: request.parentSessionId,
      expectedRevision: 0,
      content,
    }, 'derived')
    return {
      plan,
      preflight: preflightAgentPlan(plan, capabilities),
    }
  }

  compareRuns(request: CompareRunsRequest): RunAdvisorResult {
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    return buildRunAdvisor({
      request,
      plans: snapshot.plans,
      executions: snapshot.executions,
      reports: snapshot.reports,
      receipts: snapshot.receipts,
      events: snapshot.events,
    })
  }

  exportTelemetry(request: ExportTelemetryRequest): ExportTelemetryResult {
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    const execution = snapshot.executions.find(item => item.executionId === request.runId)
    const report = snapshot.reports.find(item => item.runId === request.runId)
    return buildTelemetryPreview({
      enabled: this.resolved.telemetryExport,
      ...(execution === undefined ? {} : { execution }),
      ...(report === undefined ? {} : { report }),
      events: snapshot.events,
      serviceVersion: PRODUCT_VERSION,
    })
  }

  /** Save one model- or user-authored draft without starting any Agent. */
  savePlanDraft(
    input: SavePlanDraftInput,
    authority: 'user' | 'model-claim' | 'derived' = 'user',
  ): AgentPlanRevision {
    const saved = this.plans.saveDraft(input)
    this.persistPlanRevisions(saved.parentSessionId, saved.planId)
    this.recordFoundryEvent({
      source: 'planner',
      sourceEventId: `${saved.planId}:${String(saved.revision)}:saved`,
      parentSessionId: saved.parentSessionId,
      runId: `plan:${saved.planId}:${String(saved.revision)}`,
      planId: saved.planId,
      planRevision: saved.revision,
      type: 'plan-saved',
      authority,
      observedAt: saved.updatedAt,
      causalParents: [],
      artifacts: [],
    })
    return saved
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
    assertSignalActive(signal)
    this.pruneExecutionGrants()
    const plan = this.plans.get(parentSessionId, planId, revision)
    if (plan === undefined) {
      throw new PlanExecutionGrantError('not-found', 'approved Agent plan revision was not found')
    }
    if (plan.state !== 'approved') {
      throw new PlanExecutionGrantError(
        'not-approved',
        'only an approved Agent plan revision can receive an execution grant',
      )
    }
    const planKey = executionPlanKey(parentSessionId, planId, revision)
    if (this.activePlanExecutions.has(planKey)) {
      throw new PlanExecutionGrantError(
        'already-active',
        'this Agent plan revision already has an active execution',
      )
    }
    this.assertPlanExecutionCapacity(plan)
    const capabilities = await this.executionCapabilities(parentSessionId, signal)
    assertSignalActive(signal)
    if (!capabilities.adapters.workflow) {
      throw new PlanExecutionGrantError(
        'workflow-unavailable',
        'Workflow execution is unavailable in this DSH profile',
      )
    }
    const executeToolName = capabilities.plannerTools?.execute.find(name => capabilities.tools.includes(name))
    if (capabilities.scopeStatus !== 'available') {
      throw new PlanExecutionGrantError('agent-scope-unavailable', 'the current Agent scope is unavailable')
    }
    if (executeToolName === undefined) {
      throw new PlanExecutionGrantError(
        'execution-tool-unavailable',
        'the plan execution tool is unavailable in the current Agent scope',
      )
    }
    if (plan.capabilityDigest !== capabilities.digest) {
      throw new PlanExecutionGrantError(
        'stale-capabilities',
        'execution capabilities changed after approval',
      )
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
      throw new PlanExecutionGrantError(
        'capacity-reached',
        'execution grant capacity reached; wait for existing grants to expire',
      )
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
    assertSignalActive(signal)
    const parentSessionId = String(parent.id)
    const planKey = executionPlanKey(parentSessionId, planId, revision)
    const grant = this.consumeExecutionGrant(parentSessionId, planId, revision, grantId)
    if (this.activePlanExecutions.has(planKey)) {
      throw new Error('this Agent plan revision already has an active execution')
    }
    this.activePlanExecutions.add(planKey)
    let factReservation: ExecutionFactReservation | undefined
    try {
      const plan = this.plans.get(parentSessionId, planId, revision)
      if (plan === undefined) throw new Error('approved Agent plan revision was not found')
      if (plan.state !== 'approved') throw new Error('only an approved Agent plan revision can execute')
      const adapter = this.workflowAdapter
      if (adapter === undefined) throw new Error('Workflow execution is unavailable in this DSH profile')
      const capabilities = await this.executionCapabilities(parentSessionId, signal)
      assertSignalActive(signal)
      if (
        plan.capabilityDigest !== grant.capabilityDigest
        || grant.capabilityDigest !== capabilities.digest
      ) {
        throw new PlanExecutionGrantError(
          'stale-capabilities',
          'execution capabilities changed after the grant was issued',
        )
      }
      const preflight = preflightAgentPlan(plan, capabilities)
      factReservation = this.reservePlanExecutionFacts(plan)
      let run: PlanExecutionRun
      try {
        run = adapter.start({ parent, plan, preflight, capabilities, signal })
      } catch (error: unknown) {
        this.releaseExecutionFactReservation(factReservation)
        throw error
      }
      let initialSnapshotPersisted = false
      try {
        // The adapter-wide subscription normally publishes this initial state;
        // this explicit upsert closes any mount/listener scheduling race.
        this.persistExecutionSnapshot(run.snapshot())
        initialSnapshotPersisted = true
        return await run.result
      } catch (error: unknown) {
        if (!initialSnapshotPersisted) {
          run.cancel('Agent plan execution could not be recorded durably')
        }
        throw error
      } finally {
        await run.dispose()
        if (initialSnapshotPersisted) this.persistExecutionSnapshot(run.snapshot())
        this.releaseExecutionFactReservation(factReservation, run.executionId)
      }
    } finally {
      if (factReservation !== undefined) this.releaseExecutionFactReservation(factReservation)
      this.activePlanExecutions.delete(planKey)
    }
  }

  private consumeExecutionGrant(
    parentSessionId: string,
    planId: string,
    revision: number,
    grantId: string,
  ): ExecutionGrantRecord {
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
    return grant
  }

  private assertPlanExecutionCapacity(plan: AgentPlanRevision): void {
    try {
      this.executions.assertCanInsert()
      const envelope = this.executionFactEnvelope(plan)
      const reserved = this.reservedExecutionFacts()
      // Four execution states, a bounded attempt/child envelope per task, and
      // one Evidence Event plus Receipt for every enforceable lifecycle verifier.
      this.foundry.assertCanStartExecution(
        envelope.events + reserved.events + this.reservedControlEventSlots,
        envelope.receipts + reserved.receipts,
      )
    } catch (error: unknown) {
      if (error instanceof PlanExecutionCapacityError || error instanceof FoundryLedgerCapacityError) {
        throw new PlanExecutionGrantError(
          'capacity-reached',
          'execution history capacity reached; archive or clear old Foundry data before starting another run',
        )
      }
      throw error
    }
  }

  private reservePlanExecutionFacts(plan: AgentPlanRevision): ExecutionFactReservation {
    if (this.pendingExecutionFactReservation !== undefined) {
      throw new PlanExecutionGrantError('capacity-reached', 'another execution is entering the Workflow adapter')
    }
    this.assertPlanExecutionCapacity(plan)
    const envelope = this.executionFactEnvelope(plan)
    const reservation: ExecutionFactReservation = {
      planKey: executionPlanKey(plan.parentSessionId, plan.planId, plan.revision),
      eventsRemaining: envelope.events,
      receiptsRemaining: envelope.receipts,
    }
    this.pendingExecutionFactReservation = reservation
    return reservation
  }

  private executionFactEnvelope(plan: AgentPlanRevision): { readonly events: number; readonly receipts: number } {
    const lifecycleVerifierCount = plan.tasks.reduce(
      (total, task) => total + (task.verifiers ?? []).filter(verifier => verifier.kind === 'lifecycle').length,
      0,
    )
    return {
      events: 6 + plan.tasks.length * 10 + lifecycleVerifierCount,
      receipts: lifecycleVerifierCount,
    }
  }

  private reservedExecutionFacts(): { readonly events: number; readonly receipts: number } {
    const reservations = [
      ...this.executionFactReservations.values(),
      ...(this.pendingExecutionFactReservation === undefined ? [] : [this.pendingExecutionFactReservation]),
    ]
    return reservations.reduce((total, reservation) => ({
      events: total.events + reservation.eventsRemaining,
      receipts: total.receipts + reservation.receiptsRemaining,
    }), { events: 0, receipts: 0 })
  }

  private claimExecutionFactReservation(execution: PlanExecution): void {
    if (this.executionFactReservations.has(execution.executionId)) return
    const pending = this.pendingExecutionFactReservation
    if (
      pending === undefined
      || pending.planKey !== executionPlanKey(
        execution.parentSessionId,
        execution.planId,
        execution.planRevision,
      )
    ) return
    this.pendingExecutionFactReservation = undefined
    this.executionFactReservations.set(execution.executionId, pending)
  }

  private releaseExecutionFactReservation(
    reservation: ExecutionFactReservation,
    executionId?: string,
  ): void {
    if (this.pendingExecutionFactReservation === reservation) {
      this.pendingExecutionFactReservation = undefined
    }
    if (executionId !== undefined && this.executionFactReservations.get(executionId) === reservation) {
      this.executionFactReservations.delete(executionId)
    } else {
      for (const [candidateId, candidate] of this.executionFactReservations) {
        if (candidate === reservation) this.executionFactReservations.delete(candidateId)
      }
    }
    reservation.eventsRemaining = 0
    reservation.receiptsRemaining = 0
  }

  private pruneExecutionGrants(): void {
    const now = Date.now()
    for (const [grantId, grant] of this.executionGrants) {
      if (grant.expiresAt > now) continue
      this.executionGrants.delete(grantId)
      if (this.grantByPlanKey.get(grant.planKey) === grantId) this.grantByPlanKey.delete(grant.planKey)
    }
  }

  issueCancelControlGrant(request: IssueCancelGrantRequest): FoundryControlGrant {
    if (this.shuttingDown) throw new Error('Foundry control is shutting down')
    this.pruneFoundryControlGrants()
    const snapshot = this.foundrySnapshot([request.parentSessionId])
    const execution = requiredExecution(snapshot, request.runId)
    if (isTerminalPlanExecutionStatus(execution.status)) throw new Error('terminal execution cannot be cancelled')
    if (execution.status === 'stopping' || execution.cancellationRequested) {
      throw new Error('execution cancellation is already in progress')
    }
    const proposal = snapshot.recoveryProposals.find(candidate => candidate.runId === request.runId)
    const issuedAt = Date.now()
    if (
      proposal === undefined
      || proposal.proposalId !== request.proposalId
      || proposal.eventCursor !== request.eventCursor
      || proposal.expiresAt <= issuedAt
      || this.runEventCursor(request.parentSessionId, request.runId) !== request.eventCursor
    ) throw new Error('recovery proposal is stale')
    if (this.foundryControlGrants.size >= 256) throw new Error('Foundry control grant capacity reached')
    // The request Event is written now; two additional Event slots remain
    // reserved for consumed + result, or one invalidation and one released slot.
    this.foundry.assertCanRecordFacts(
      this.reservedExecutionFacts().events + this.reservedControlEventSlots + 3,
    )
    const grantId = randomUUID()
    const grantAuditId = sha256(grantId)
    const issued = this.recordFoundryEvent({
      source: 'foundry-control',
      sourceEventId: `control:${grantAuditId}:issued`,
      parentSessionId: request.parentSessionId,
      runId: request.runId,
      planId: execution.planId,
      planRevision: execution.planRevision,
      type: 'control-requested',
      authority: 'user',
      observedAt: issuedAt,
      causalParents: [],
      controlAction: 'cancel',
      controlProposalId: request.proposalId,
      controlEventCursor: request.eventCursor,
      artifacts: [],
    })
    if (issued === undefined) throw new Error('control grant could not be recorded')
    const grant: FoundryControlGrant = {
      grantId,
      action: 'cancel',
      parentSessionId: request.parentSessionId,
      runId: request.runId,
      proposalId: request.proposalId,
      planId: execution.planId,
      planRevision: execution.planRevision,
      capabilityDigest: execution.capabilityDigest,
      issuedCursor: issued.cursor,
      expiresAt: Math.min(proposal.expiresAt, issuedAt + FOUNDRY_CONTROL_GRANT_TTL_MS),
    }
    this.foundryControlGrants.set(grantId, {
      grant,
      issuedEventId: issued.eventId,
      proposalEventCursor: request.eventCursor,
    })
    this.reservedControlEventSlots += 2
    return structuredClone(grant)
  }

  executeCancelControl(request: ExecuteCancelControlRequest): ExecuteCancelControlResult {
    this.pruneFoundryControlGrants()
    const stored = this.foundryControlGrants.get(request.grantId)
    if (stored === undefined) return { status: 'stale-grant' }
    const grant = stored.grant
    if (
      grant.parentSessionId !== request.parentSessionId
      || grant.runId !== request.runId
    ) return { status: 'stale-grant' }
    if (stored.pendingResult !== undefined) {
      return this.completeFoundryControlGrant(request.grantId, stored)
        ? { status: stored.pendingResult }
        : { status: 'interrupted' }
    }
    if (this.shuttingDown) {
      this.closeFoundryControlGrant(request.grantId, stored, 'host-unloaded')
      return { status: 'stale-grant' }
    }
    if (
      grant.expiresAt <= Date.now()
      || grant.issuedCursor !== this.runEventCursor(grant.parentSessionId, grant.runId)
    ) {
      this.closeFoundryControlGrant(request.grantId, stored, 'stale-state')
      return { status: 'stale-grant' }
    }
    const execution = this.executions.get(request.parentSessionId, request.runId)
    if (execution === undefined) {
      this.closeFoundryControlGrant(request.grantId, stored, 'not-found')
      return { status: 'not-found' }
    }
    if (isTerminalPlanExecutionStatus(execution.status)) {
      this.closeFoundryControlGrant(request.grantId, stored, 'already-terminal')
      return { status: 'already-terminal' }
    }
    if (execution.status === 'stopping' || execution.cancellationRequested) {
      this.closeFoundryControlGrant(request.grantId, stored, 'already-requested')
      return { status: 'already-requested' }
    }
    if (
      execution.planId !== grant.planId
      || execution.planRevision !== grant.planRevision
      || execution.capabilityDigest !== grant.capabilityDigest
    ) {
      this.closeFoundryControlGrant(request.grantId, stored, 'stale-state')
      return { status: 'stale-grant' }
    }
    const grantAuditId = sha256(grant.grantId)
    const consumed = this.recordFoundryEvent({
      source: 'foundry-control',
      sourceEventId: `control:${grantAuditId}:consumed`,
      parentSessionId: grant.parentSessionId,
      runId: grant.runId,
      planId: grant.planId,
      planRevision: grant.planRevision,
      type: 'control-consumed',
      authority: 'adapter',
      observedAt: Date.now(),
      causalParents: [stored.issuedEventId],
      controlAction: 'cancel',
      controlProposalId: grant.proposalId,
      controlEventCursor: stored.proposalEventCursor,
      artifacts: [],
    }, 1)
    if (consumed === undefined) return { status: 'stale-grant' }
    stored.consumedEventId = consumed.eventId
    let controlResult: 'requested' | 'not-found' | 'interrupted' = 'not-found'
    try {
      const requested = this.workflowAdapter?.cancel(
        request.parentSessionId,
        request.runId,
        'Foundry approved cancel',
      ) === true
      controlResult = requested ? 'requested' : 'not-found'
    } catch (error: unknown) {
      controlResult = 'interrupted'
      this.ctx.logger.warn(`product-subagent-console: Foundry cancel adapter failed: ${String(error)}`)
    }
    stored.pendingResult = controlResult
    return this.completeFoundryControlGrant(request.grantId, stored)
      ? { status: controlResult }
      : { status: 'interrupted' }
  }

  private completeFoundryControlGrant(
    grantId: string,
    stored: FoundryControlGrantRecord,
  ): boolean {
    if (stored.consumedEventId === undefined || stored.pendingResult === undefined) return false
    const grantAuditId = sha256(stored.grant.grantId)
    const result = this.recordFoundryEvent({
      source: 'foundry-control',
      sourceEventId: `control:${grantAuditId}:result`,
      parentSessionId: stored.grant.parentSessionId,
      runId: stored.grant.runId,
      planId: stored.grant.planId,
      planRevision: stored.grant.planRevision,
      type: 'control-result',
      authority: 'adapter',
      observedAt: Date.now(),
      causalParents: [stored.consumedEventId],
      controlAction: 'cancel',
      controlProposalId: stored.grant.proposalId,
      controlEventCursor: stored.proposalEventCursor,
      controlResult: stored.pendingResult,
      artifacts: [],
    }, 1)
    if (result === undefined) return false
    this.foundryControlGrants.delete(grantId)
    return true
  }

  private pruneFoundryControlGrants(): void {
    const now = Date.now()
    for (const [grantId, stored] of this.foundryControlGrants) {
      if (stored.pendingResult !== undefined && this.completeFoundryControlGrant(grantId, stored)) continue
      if (stored.grant.expiresAt > now) continue
      this.closeFoundryControlGrant(grantId, stored, 'expired', now)
    }
  }

  private closeFoundryControlGrant(
    grantId: string,
    stored: FoundryControlGrantRecord,
    result: FoundryControlClosure,
    observedAt = Date.now(),
  ): void {
    if (this.foundryControlGrants.get(grantId) !== stored) return
    const consumed = stored.consumedEventId !== undefined
    const closureResult = consumed && result !== 'host-unloaded' ? 'interrupted' as const : result
    const event = this.recordFoundryEvent({
      source: 'foundry-control',
      sourceEventId: `control:${sha256(grantId)}:${closureResult}`,
      parentSessionId: stored.grant.parentSessionId,
      runId: stored.grant.runId,
      planId: stored.grant.planId,
      planRevision: stored.grant.planRevision,
      type: !consumed && closureResult === 'expired' ? 'control-expired' : 'control-result',
      authority: 'adapter',
      observedAt,
      causalParents: [stored.consumedEventId ?? stored.issuedEventId],
      controlAction: 'cancel',
      controlProposalId: stored.grant.proposalId,
      controlEventCursor: stored.proposalEventCursor,
      ...(!consumed && closureResult === 'expired' ? {} : {
        controlResult: closureResult as Exclude<FoundryControlClosure, 'expired'>,
      }),
      artifacts: [],
    }, 1)
    if (event === undefined) return
    this.foundryControlGrants.delete(grantId)
    // An unconsumed invalidation uses one Event and releases the unused second
    // slot. A consumed chain has only its final-result slot remaining.
    if (!consumed) this.releaseControlEventSlots(1)
  }

  private closeAllFoundryControlGrants(result: Extract<FoundryControlClosure, 'host-unloaded'>): void {
    for (const [grantId, stored] of [...this.foundryControlGrants]) {
      if (stored.pendingResult !== undefined && this.completeFoundryControlGrant(grantId, stored)) continue
      this.closeFoundryControlGrant(grantId, stored, result)
    }
  }

  private releaseControlEventSlots(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.reservedControlEventSlots) {
      throw new Error('Foundry control Event reservation underflow')
    }
    this.reservedControlEventSlots -= count
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
      contractSupport: {
        reasoningEffort: 'unsupported' as const,
        verifiers: {
          lifecycle: 'enforced' as const,
          schema: 'unsupported' as const,
          test: 'unsupported' as const,
          manual: 'unsupported' as const,
        },
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
      contractSupport: payload.contractSupport,
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
      hostInstanceId !== undefined && hostInstanceId !== this.foundry.hostInstanceId
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
      hostInstanceId !== undefined && hostInstanceId !== this.foundry.hostInstanceId
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

  private waitForFoundryRevision(
    afterRevision: number,
    hostInstanceId: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
    parentSessionIds: readonly string[],
  ): Promise<void> {
    const currentRevision = (): number => this.foundry.scopedRevision(parentSessionIds)
    const relevant = new Set(parentSessionIds)
    if (
      hostInstanceId !== undefined && hostInstanceId !== this.foundry.hostInstanceId
      || currentRevision() !== afterRevision
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
      unsubscribe = this.foundry.subscribe((_revision, parentSessionId) => {
        if (relevant.has(parentSessionId) && currentRevision() > afterRevision) finish()
      })
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, timeoutMs)
      if (currentRevision() > afterRevision) finish()
    })
  }

  private async handleFoundryRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<ConsoleRpcResponse | undefined> {
    try {
      if (endpoint === INSPECT_FOUNDRY_RUN_ENDPOINT) {
        const parsed = inspectRunRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.inspectRun(parsed.data) }
      }
      if (endpoint === EXPORT_RUN_CAPSULE_ENDPOINT) {
        const parsed = exportRunCapsuleRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.exportRunCapsule(parsed.data) }
      }
      if (endpoint === PREVIEW_RECIPE_ENDPOINT) {
        const parsed = recipeCandidateRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.previewRecipe(parsed.data) }
      }
      if (endpoint === EXPORT_RECIPE_ENDPOINT) {
        const parsed = exportRecipeRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.exportRecipe(parsed.data) }
      }
      if (endpoint === INSTANTIATE_RECIPE_ENDPOINT) {
        const parsed = instantiateRecipeRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: await this.instantiateRecipe(parsed.data, signal) }
      }
      if (endpoint === COMPARE_FOUNDRY_RUNS_ENDPOINT) {
        const parsed = compareRunsRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.compareRuns(parsed.data) }
      }
      if (endpoint === EXPORT_TELEMETRY_ENDPOINT) {
        const parsed = exportTelemetryRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.exportTelemetry(parsed.data) }
      }
      if (endpoint === ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT) {
        const parsed = issueCancelGrantRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.issueCancelControlGrant(parsed.data) }
      }
      if (endpoint === EXECUTE_CANCEL_CONTROL_ENDPOINT) {
        const parsed = executeCancelControlRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
        return { ok: true, value: this.executeCancelControl(parsed.data) }
      }
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) return cancelledRpcResponse()
      if (error instanceof RecipeEligibilityError) return foundryRpcError(error.code, error.message)
      this.ctx.logger.warn(`product-subagent-console: Foundry RPC failed: ${String(error)}`)
      return foundryRpcError('foundry-operation-failed', 'Foundry operation failed')
    }
    if (endpoint !== LIST_FOUNDRY_RUNS_ENDPOINT && endpoint !== WATCH_FOUNDRY_RUNS_ENDPOINT) {
      return undefined
    }
    const parsed = endpoint === WATCH_FOUNDRY_RUNS_ENDPOINT
      ? watchFoundryRunsRequestSchema.safeParse(payload)
      : listFoundryRunsRequestSchema.safeParse(payload)
    if (!parsed.success) return invalidPlannerRequest(parsed.error.issues)
    if (endpoint === WATCH_FOUNDRY_RUNS_ENDPOINT) {
      const request = watchFoundryRunsRequestSchema.parse(parsed.data)
      await this.waitForFoundryRevision(
        request.afterRevision,
        request.hostInstanceId,
        request.timeoutMs,
        signal,
        request.parentSessionIds,
      )
      if (signal.aborted) return cancelledRpcResponse()
    }
    return { ok: true, value: this.foundrySnapshot(parsed.data.parentSessionIds) }
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
        return foundryRpcError(
          'control-grant-required',
          'Direct cancellation is disabled; use an exact Foundry control grant',
        )
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
        const saved = this.savePlanDraft({
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
        assertSignalActive(signal)
        if (endpoint === APPROVE_PLAN_ENDPOINT) {
          const request = approvePlanRequestSchema.parse(parsed.data)
          if (request.capabilityDigest !== capabilities.digest) {
            return plannerRpcError('stale-capabilities', 'runtime capabilities changed; run preflight again')
          }
          const preflight = preflightAgentPlan(plan, capabilities)
          const approved = this.plans.approve({
              parentSessionId: request.parentSessionId,
              planId: request.planId,
              revision: request.revision,
              preflight,
              acceptedWarningIds: request.acceptedWarningIds,
            })
          this.persistPlanRevisions(approved.parentSessionId, approved.planId)
          this.recordFoundryEvent({
            source: 'planner',
            sourceEventId: `${approved.planId}:${String(approved.revision)}:approved`,
            parentSessionId: approved.parentSessionId,
            runId: `plan:${approved.planId}:${String(approved.revision)}`,
            planId: approved.planId,
            planRevision: approved.revision,
            type: 'plan-approved',
            authority: 'user',
            observedAt: approved.updatedAt,
            causalParents: [],
            artifacts: [],
          })
          return { ok: true, value: approved }
        }
        return { ok: true, value: preflightAgentPlan(plan, capabilities) }
      }
      return undefined
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) return cancelledRpcResponse()
      if (error instanceof PlanRevisionConflictError) {
        return plannerRpcError(
          'revision-conflict',
          `${error.message}; expected=${String(error.expectedRevision)} actual=${String(error.actualRevision)}`,
        )
      }
      if (error instanceof PlanExecutionGrantError) return plannerRpcError(error.reason, error.message)
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

    if (spec.signal.aborted) {
      this.mutate(() => { this.ledger.settleAttempt(attemptId, 'cancelled-before-publication', true) })
      release()
      throw new DOMException('aborted', 'AbortError')
    }

    const ownedSignal = this.ownedSignal(spec.signal)
    if (ownedSignal.signal.aborted) {
      this.mutate(() => { this.ledger.settleAttempt(attemptId, 'cancelled-before-publication', true) })
      ownedSignal.dispose()
      release()
      throw new DOMException('aborted', 'AbortError')
    }
    this.mutate(() => { this.ledger.markStarting(attemptId) })
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

    if (ownedSignal.signal.aborted) {
      try {
        await run.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`product-subagent-console: late owned run disposal failed: ${String(error)}`)
      }
      const published = this.ledger.snapshot([spec.parentSessionId]).runs.some(record => record.attemptId === attemptId)
      if (!published) {
        this.mutate(() => { this.ledger.settleAttempt(attemptId, 'cancelled-before-publication', true) })
      }
      ownedSignal.dispose()
      release()
      throw new DOMException('aborted', 'AbortError')
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

  private persistPlanRevisions(parentSessionId: string, planId: string): void {
    for (const revision of this.plans.list([parentSessionId])) {
      if (revision.planId === planId) this.foundry.recordPlanRevision(revision)
    }
  }

  private persistExecutionSnapshot(execution: PlanExecution): void {
    this.claimExecutionFactReservation(execution)
    const previous = this.executions.get(execution.parentSessionId, execution.executionId)
    this.foundry.recordExecutionSnapshot(execution)
    this.executions.upsert(execution)
    this.recordExecutionTransitions(previous, execution)
  }

  private recordExecutionTransitions(previous: PlanExecution | undefined, next: PlanExecution): void {
    if (previous?.status !== next.status) {
      const type = next.status === 'queued'
        ? 'execution-queued' as const
        : next.status === 'running'
          ? 'execution-started' as const
          : next.status === 'stopping'
            ? 'execution-stopping' as const
            : 'execution-terminal' as const
      this.recordFoundryEvent({
        source: 'workflow-adapter',
        sourceEventId: `${next.executionId}:execution:${next.status}`,
        parentSessionId: next.parentSessionId,
        runId: next.executionId,
        planId: next.planId,
        planRevision: next.planRevision,
        type,
        authority: 'adapter',
        observedAt: eventTimeForExecution(next),
        causalParents: [],
        executionStatus: next.status,
        ...(type === 'execution-terminal' ? {
          terminalReason: terminalReasonForExecution(next.status),
        } : {}),
        artifacts: [],
      })
    }
    const previousAttempts = new Map(previous?.bindings.map(binding => [binding.attemptId, binding] as const) ?? [])
    const plan = this.plans.get(next.parentSessionId, next.planId, next.planRevision)
    const planTasks = new Map(plan?.tasks.map(task => [task.taskId, task] as const) ?? [])
    const planRoles = new Map(plan?.roles.map(role => [role.roleId, role] as const) ?? [])
    for (const binding of next.bindings) {
      const before = previousAttempts.get(binding.attemptId)
      if (before?.status === binding.status) continue
      const type = binding.status === 'waiting'
        ? 'attempt-waiting' as const
        : binding.status === 'stopping'
          ? 'attempt-stopping' as const
          : isTerminalAttemptStatus(binding.status)
            ? 'attempt-terminal' as const
            : 'attempt-started' as const
      const task = planTasks.get(binding.taskId)
      const role = task === undefined ? undefined : planRoles.get(task.roleId)
      this.recordFoundryEvent({
        source: 'workflow-adapter',
        sourceEventId: `${next.executionId}:attempt:${binding.attemptId}:${binding.status}`,
        parentSessionId: next.parentSessionId,
        runId: next.executionId,
        planId: next.planId,
        planRevision: next.planRevision,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        type,
        authority: 'adapter',
        observedAt: eventTimeForAttempt(binding, next.createdAt),
        causalParents: [],
        attemptStatus: binding.status,
        ...(role === undefined ? {} : {
          configuration: {
            transportProvider: role.transportProvider,
            ...(role.llmProvider === undefined ? {} : { llmProvider: role.llmProvider }),
            ...(role.model === undefined ? {} : { model: role.model }),
            toolPolicyMode: role.toolPolicy.mode,
          },
        }),
        ...(type === 'attempt-terminal' ? {
          terminalReason: terminalReasonForAttempt(binding.status),
        } : {}),
        artifacts: [],
      })
    }
  }

  private recordFoundryEvent(
    event: NewFoundryEvent,
    consumeReservedControlSlots = 0,
  ): FoundryEventEnvelope | undefined {
    if (
      !Number.isInteger(consumeReservedControlSlots)
      || consumeReservedControlSlots < 0
      || consumeReservedControlSlots > this.reservedControlEventSlots
    ) {
      this.ctx.logger.warn('product-subagent-console: invalid Foundry control Event reservation')
      return undefined
    }
    const isNew = !this.foundry.hasEventIdentity(event.source, event.sourceEventId)
    const executionReservation = isNew && EXECUTION_FACT_EVENT_TYPES.has(event.type)
      ? this.executionFactReservations.get(event.runId)
      : undefined
    const consumeExecutionSlot = executionReservation !== undefined && executionReservation.eventsRemaining > 0
    if (consumeReservedControlSlots > 0) {
      this.reservedControlEventSlots -= consumeReservedControlSlots
    }
    if (consumeExecutionSlot) executionReservation.eventsRemaining -= 1
    try {
      const reserved = this.reservedExecutionFacts()
      return this.foundry.recordEvent(
        event,
        this.reservedControlEventSlots + reserved.events,
      )
    } catch (error: unknown) {
      this.reservedControlEventSlots += consumeReservedControlSlots
      if (consumeExecutionSlot) executionReservation.eventsRemaining += 1
      this.ctx.logger.warn(`product-subagent-console: Foundry event rejected: ${String(error)}`)
      return undefined
    }
  }

  private recordFoundryReceipt(receipt: EvidenceReceipt): EvidenceReceipt {
    const isNew = !this.foundry.hasReceipt(receipt.receiptId)
    const reservation = isNew ? this.executionFactReservations.get(receipt.runId) : undefined
    const consumeReceiptSlot = reservation !== undefined && reservation.receiptsRemaining > 0
    if (consumeReceiptSlot) reservation.receiptsRemaining -= 1
    try {
      return this.foundry.recordReceipt(receipt, this.reservedExecutionFacts().receipts)
    } catch (error: unknown) {
      if (consumeReceiptSlot) reservation.receiptsRemaining += 1
      throw error
    }
  }

  private recordLifecycleReceipts(
    execution: PlanExecution,
    binding: PlanRunBinding,
    terminalEvent: FoundryEventEnvelope,
  ): void {
    if (
      terminalEvent.type !== 'child-terminal'
      || terminalEvent.authority !== 'dsh'
      || terminalEvent.parentSessionId !== execution.parentSessionId
      || terminalEvent.runId !== execution.executionId
      || terminalEvent.planId !== execution.planId
      || terminalEvent.planRevision !== execution.planRevision
      || terminalEvent.taskId !== binding.taskId
      || terminalEvent.attemptId !== binding.attemptId
    ) return
    const plan = this.plans.get(execution.parentSessionId, execution.planId, execution.planRevision)
    const task = plan?.tasks.find(candidate => candidate.taskId === binding.taskId)
    if (plan === undefined || task === undefined) return
    for (const verifier of (task.verifiers ?? []).filter(candidate => candidate.kind === 'lifecycle')) {
      const result = terminalEvent.terminalReason === 'unknown' ? 'unknown' as const : 'pass' as const
      const receiptId = sha256([
        execution.executionId,
        binding.attemptId,
        verifier.verifierId,
        result,
      ].join('\u0000'))
      try {
        const receipt = this.recordFoundryReceipt({
          schemaVersion: 1,
          receiptId,
          parentSessionId: execution.parentSessionId,
          runId: execution.executionId,
          planId: execution.planId,
          planRevision: execution.planRevision,
          taskId: binding.taskId,
          attemptId: binding.attemptId,
          verifierId: verifier.verifierId,
          verifierVersion: 'dsh-workflow-lifecycle-v1',
          verifierKind: 'lifecycle',
          claim: 'lifecycle-terminal',
          result,
          authority: 'dsh',
          observedAt: terminalEvent.observedAt,
          evidenceEventIds: [terminalEvent.eventId],
          artifacts: [],
        })
        this.recordFoundryEvent({
          source: 'lifecycle-verifier',
          sourceEventId: `${receipt.receiptId}:recorded`,
          parentSessionId: execution.parentSessionId,
          runId: execution.executionId,
          planId: execution.planId,
          planRevision: execution.planRevision,
          taskId: binding.taskId,
          attemptId: binding.attemptId,
          type: 'evidence-recorded',
          authority: 'verifier',
          observedAt: receipt.observedAt,
          causalParents: [terminalEvent.eventId],
          artifacts: [],
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`product-subagent-console: lifecycle evidence rejected: ${String(error)}`)
      }
    }
  }

  /** Repair any crash gap between a durable snapshot and its derived event/receipt records. */
  private reconcileDurableExecutionEvents(): void {
    const executions = this.foundry.listExecutionSnapshots()
    for (const execution of executions) this.recordExecutionTransitions(undefined, execution)
  }

  /** Rebuild only verifier receipts backed by an already durable authoritative child-terminal fact. */
  private reconcileLifecycleReceipts(): void {
    const executions = this.foundry.listExecutionSnapshots()
    const byId = new Map(executions.map(execution => [execution.executionId, execution] as const))
    for (const event of this.foundry.listEvents([...new Set(executions.map(item => item.parentSessionId))])) {
      if (
        event.type !== 'child-terminal'
        || event.authority !== 'dsh'
        || event.attemptId === undefined
      ) continue
      const execution = byId.get(event.runId)
      const binding = execution?.bindings.find(candidate => candidate.attemptId === event.attemptId)
      if (
        execution !== undefined
        && binding !== undefined
        && event.parentSessionId === execution.parentSessionId
        && event.planId === execution.planId
        && event.planRevision === execution.planRevision
        && event.taskId === binding.taskId
      ) {
        this.recordLifecycleReceipts(execution, binding, event)
      }
    }
  }

  private runEventCursor(parentSessionId: string, runId: string): number {
    const execution = this.executions.get(parentSessionId, runId)
    if (execution === undefined) return 0
    const identityIndex = executionIdentityIndex(execution)
    const events = this.foundry.listEvents([parentSessionId])
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = events[eventIndex]
      if (event !== undefined && eventMatchesExecutionIdentity(event, execution, identityIndex)) return event.cursor
    }
    return 0
  }

  private closeInterruptedDurableExecutions(): void {
    const interruptedAt = Date.now()
    for (const execution of this.executions.list(this.foundry.listExecutionSnapshots().map(item => item.parentSessionId))) {
      if (isTerminalPlanExecutionStatus(execution.status)) continue
      const interrupted: PlanExecution = {
        ...execution,
        status: 'unknown',
        finishedAt: interruptedAt,
        bindings: execution.bindings.map(binding => isTerminalAttemptStatus(binding.status)
          ? binding
          : { ...binding, status: 'unknown', finishedAt: interruptedAt }),
      }
      this.persistExecutionSnapshot(interrupted)
    }
  }

  /** Close control chains whose in-memory grants or adapter call vanished on restart. */
  private reconcileControlAudit(): void {
    const events = this.foundry.listAllEvents()
    const closedParents = new Set(events
      .filter(event => ['control-consumed', 'control-expired', 'control-result'].includes(event.type))
      .flatMap(event => event.causalParents))
    for (const event of events) {
      const result = event.type === 'control-requested' && !closedParents.has(event.eventId)
        ? 'host-restarted' as const
        : event.type === 'control-consumed' && !closedParents.has(event.eventId)
          ? 'interrupted' as const
          : undefined
      if (
        result === undefined
        || event.controlAction === undefined
        || event.controlProposalId === undefined
        || event.controlEventCursor === undefined
      ) continue
      this.recordFoundryEvent({
        source: 'foundry-control-reconcile',
        sourceEventId: `${event.eventId}:${result}`,
        parentSessionId: event.parentSessionId,
        runId: event.runId,
        ...(event.planId === undefined ? {} : { planId: event.planId }),
        ...(event.planRevision === undefined ? {} : { planRevision: event.planRevision }),
        type: 'control-result',
        authority: 'adapter',
        observedAt: Date.now(),
        causalParents: [event.eventId],
        controlAction: event.controlAction,
        controlProposalId: event.controlProposalId,
        controlEventCursor: event.controlEventCursor,
        controlResult: result,
        artifacts: [],
      })
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

function isTerminalAttemptStatus(status: PlanRunBinding['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown'].includes(status)
}

function eventTimeForExecution(execution: PlanExecution): number {
  if (isTerminalPlanExecutionStatus(execution.status)) {
    return execution.finishedAt ?? execution.startedAt ?? execution.createdAt
  }
  if (execution.status === 'running' || execution.status === 'stopping') {
    return execution.startedAt ?? execution.createdAt
  }
  return execution.createdAt
}

function eventTimeForAttempt(binding: PlanRunBinding, fallback: number): number {
  return isTerminalAttemptStatus(binding.status)
    ? binding.finishedAt ?? binding.startedAt ?? fallback
    : binding.startedAt ?? fallback
}

function terminalReasonForExecution(status: PlanExecution['status']): NewFoundryEvent['terminalReason'] {
  if (status === 'succeeded') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'unknown'
}

function terminalReasonForAttempt(status: PlanRunBinding['status']): NewFoundryEvent['terminalReason'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'rejected') return 'rejected'
  if (status === 'skipped') return 'skipped'
  return 'unknown'
}

interface ExecutionIdentityIndex {
  readonly bindingsByAttempt: ReadonlyMap<string, PlanRunBinding>
  readonly bindingTaskIds: ReadonlySet<string>
}

function executionIdentityIndex(execution: PlanExecution): ExecutionIdentityIndex {
  return {
    bindingsByAttempt: new Map(execution.bindings.map(binding => [binding.attemptId, binding] as const)),
    bindingTaskIds: new Set(execution.bindings.map(binding => binding.taskId)),
  }
}

function eventMatchesExecutionIdentity(
  event: FoundryEventEnvelope,
  execution: PlanExecution,
  index: ExecutionIdentityIndex,
): boolean {
  if (
    event.parentSessionId !== execution.parentSessionId
    || event.runId !== execution.executionId
    || event.planId !== execution.planId
    || event.planRevision !== execution.planRevision
  ) return false
  if (event.taskId !== undefined && !index.bindingTaskIds.has(event.taskId)) return false
  if (event.attemptId === undefined) return true
  const binding = index.bindingsByAttempt.get(event.attemptId)
  if (binding !== undefined) return event.taskId === undefined || binding.taskId === event.taskId
  return event.taskId === undefined
    && event.authority === 'dsh'
    && (event.type === 'child-published' || event.type === 'child-terminal')
}

function receiptMatchesExecutionIdentity(
  receipt: EvidenceReceipt,
  execution: PlanExecution,
  index: ExecutionIdentityIndex,
): boolean {
  return receipt.parentSessionId === execution.parentSessionId
    && receipt.runId === execution.executionId
    && receipt.planId === execution.planId
    && receipt.planRevision === execution.planRevision
    && index.bindingsByAttempt.get(receipt.attemptId)?.taskId === receipt.taskId
}

function requiredExecution(snapshot: FoundrySnapshot, runId: string): PlanExecution {
  const execution = snapshot.executions.find(candidate => candidate.executionId === runId)
  if (execution === undefined) throw new Error('Foundry execution was not found')
  return execution
}

function requiredPlan(snapshot: FoundrySnapshot, execution: PlanExecution): AgentPlanRevision {
  const plan = snapshot.plans.find(candidate => (
    candidate.planId === execution.planId && candidate.revision === execution.planRevision
  ))
  if (plan === undefined) throw new Error('Foundry plan revision was not found')
  return plan
}

function requiredReport(snapshot: FoundrySnapshot, runId: string): FoundrySnapshot['reports'][number] {
  const report = snapshot.reports.find(candidate => candidate.runId === runId)
  if (report === undefined) throw new Error('Foundry conformance report was not found')
  return report
}

function plannerRpcError(reason: PlannerRpcReason, message: string): ConsoleRpcResponse {
  return {
    ok: false,
    // DSH keeps command-error details closed as {}; the bounded prefix is the
    // channel-owned machine reason and clients only accept an explicit allowlist.
    error: { code: 'command-error', message: `[${reason}] ${message}`, details: {} },
  }
}

function foundryRpcError(reason: string, message: string): ConsoleRpcResponse {
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
  const configuredStorageDirectory = config.foundryStorageDirectory?.trim()
  const resolved: ResolvedConfig = {
    maxConcurrent: config.maxConcurrent ?? 4,
    maxQueued: config.maxQueued ?? 16,
    historyLimit: config.historyLimit ?? 50,
    maxObservedActive: config.maxObservedActive ?? 128,
    runTimeoutMs: config.runTimeoutMs ?? 0,
    plannerMaxConcurrent: config.plannerMaxConcurrent ?? 4,
    plannerMaxAgents: config.plannerMaxAgents ?? 32,
    foundryStorageDirectory: config.foundryStorage === false
      ? null
      : configuredStorageDirectory === undefined || configuredStorageDirectory.length === 0
        ? undefined
        : configuredStorageDirectory,
    telemetryExport: config.telemetryExport ?? false,
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
  if (
    typeof resolved.foundryStorageDirectory === 'string'
    && !isAbsolute(resolved.foundryStorageDirectory)
  ) {
    throw new Error('product-subagent-console: foundryStorageDirectory must be an absolute path')
  }
  return resolved
}

export default ProductSubagentConsoleService
