import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { SubagentRun, SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  AdmissionController,
  AdmissionQueueFullError,
  displayLabelFromArguments,
  ProductSubagentLedger,
  type ExecutionObservation,
} from './domain.js'
import {
  LIST_SESSIONS_ENDPOINT,
  listSessionsRequestSchema,
  PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
  type ConfiguredProduct,
  type ConsoleSnapshot,
} from './types.js'

export type * from './types.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

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
}

interface ResolvedConfig {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly historyLimit: number
  readonly maxObservedActive: number
  readonly runTimeoutMs: number
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

/** Standalone Host service for observed lifecycle records and owned-tool admission. */
export class ProductSubagentConsoleService extends Service {
  static inject = ['connection', 'subagents', 'tools']

  static Config: schema<Config> = schema.object({
    maxConcurrent: schema.natural().min(1).max(64).default(4),
    maxQueued: schema.natural().max(256).default(16),
    historyLimit: schema.natural().max(1_000).default(50),
    maxObservedActive: schema.natural().min(1).max(1_000).default(128),
    runTimeoutMs: schema.natural().max(MAX_TIMER_DELAY_MS).default(0),
  })

  private readonly resolved: ResolvedConfig
  private readonly execution = new AsyncLocalStorage<ExecutionObservation>()
  private readonly admission: AdmissionController
  private readonly ledger: ProductSubagentLedger
  private readonly listeners = new Set<() => void>()
  private readonly ownedControllers = new Set<AbortController>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'productSubagentConsole')
    this.resolved = resolveConfig(config)
    this.admission = new AdmissionController(this.resolved.maxConcurrent, this.resolved.maxQueued)
    this.ledger = new ProductSubagentLedger(this.resolved)
    const connection = ctx.get('connection') as unknown as HostConnectionHandle

    ctx.on('tools/execute', (exec, next) => this.observeToolExecution(exec, next))
    ctx.on('subagent/start', (info) => { this.observePublishedRun(info) })
    ctx.on('subagent/end', (info) => { this.observeTerminalRun(info) })
    ctx.effect(() => connection.rpc.handle(
      PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
      async (endpoint, payload, signal) => {
        if (signal.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
        }
        if (endpoint !== LIST_SESSIONS_ENDPOINT) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: { issues: [] } },
          }
        }
        const parsed = listSessionsRequestSchema.safeParse(payload)
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

  /**
   * Subscribe to ledger revisions for the optional invariant face.
   * @param listener - callback after any visible ledger change.
   * @returns disposer removing the callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
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

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxConcurrent: config.maxConcurrent ?? 4,
    maxQueued: config.maxQueued ?? 16,
    historyLimit: config.historyLimit ?? 50,
    maxObservedActive: config.maxObservedActive ?? 128,
    runTimeoutMs: config.runTimeoutMs ?? 0,
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
  return resolved
}

export default ProductSubagentConsoleService
