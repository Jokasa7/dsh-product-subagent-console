import { randomUUID } from 'node:crypto'
import type { SubagentRunEndInfo, SubagentRunInfo, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type {
  ConfiguredProduct,
  ConsoleSnapshot,
  ObservedRunState,
  ObservedRunView,
  OwnedAttemptOutcome,
  OwnedAttemptView,
} from './types.js'

const MAX_LABEL_LENGTH = 160
const MAX_TOOL_NAME_LENGTH = 128
const MAX_PROVIDER_NAME_LENGTH = 128

/** Display-safe execution metadata retained while a tool may publish child runs. */
export interface ExecutionObservation extends ConfiguredProduct {
  readonly source: 'observed-tool' | 'owned-tool'
  readonly attemptId?: string
  readonly parentSessionId: string
  readonly callId: string
  readonly toolName: string
  readonly expectedProviderName?: string
  readonly label?: string
}

/** Configuration that bounds one Host-generation ledger. */
export interface LedgerConfig {
  readonly historyLimit: number
  readonly maxObservedActive: number
}

/** Error raised when the owned-delegation queue has reached its configured capacity. */
export class AdmissionQueueFullError extends Error {
  constructor() {
    super('product-subagent-console: owned delegation queue is full')
    this.name = 'AdmissionQueueFullError'
  }
}

/** Error raised when a queued owned delegation is cancelled before admission. */
export class AdmissionCancelledError extends Error {
  constructor() {
    super('product-subagent-console: owned delegation cancelled before admission')
    this.name = 'AdmissionCancelledError'
  }
}

interface PendingAdmission {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: AdmissionCancelledError) => void
  readonly signal: AbortSignal
  readonly abort: () => void
}

/** FIFO admission controller shared by every plugin-owned tool instance. */
export class AdmissionController {
  private active = 0
  private readonly pending: PendingAdmission[] = []
  private closed = false

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueued: number,
  ) {}

  /** Number of currently admitted owned delegations. */
  get activeCount(): number { return this.active }

  /** Number of owned delegations waiting for a permit. */
  get queuedCount(): number { return this.pending.length }

  /**
   * Wait for one admission permit.
   * @param signal - caller cancellation while queued.
   * @returns an idempotent permit release callback.
   */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new AdmissionCancelledError())
    if (signal.aborted) return Promise.reject(new AdmissionCancelledError())
    if (this.active < this.maxConcurrent) return Promise.resolve(this.grant())
    if (this.pending.length >= this.maxQueued) return Promise.reject(new AdmissionQueueFullError())
    return new Promise((resolve, reject) => {
      const pending: PendingAdmission = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.pending.indexOf(pending)
          if (index >= 0) this.pending.splice(index, 1)
          reject(new AdmissionCancelledError())
        },
      }
      signal.addEventListener('abort', pending.abort, { once: true })
      this.pending.push(pending)
    })
  }

  /** Reject every queued request and prevent new admission after service disposal. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.splice(0)) {
      pending.signal.removeEventListener('abort', pending.abort)
      pending.reject(new AdmissionCancelledError())
    }
  }

  private grant(): () => void {
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.pump()
    }
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const pending = this.pending.shift()
      if (pending === undefined) return
      pending.signal.removeEventListener('abort', pending.abort)
      if (pending.signal.aborted) {
        pending.reject(new AdmissionCancelledError())
        continue
      }
      pending.resolve(this.grant())
    }
  }
}

/** Bounded volatile record of correlated startup attempts and published runs. */
export class ProductSubagentLedger {
  readonly hostInstanceId = randomUUID()
  readonly hostStartedAt = Date.now()
  private revisionValue = 0
  private droppedActiveRuns = 0
  private readonly attempts = new Map<string, OwnedAttemptView>()
  private readonly runs = new Map<string, ObservedRunView>()

  constructor(private readonly config: LedgerConfig) {}

  /** Monotonic revision for this Host generation. */
  get revision(): number { return this.revisionValue }

  /** Create one visible plugin-owned attempt. */
  createAttempt(observation: ExecutionObservation, expectedProviderName: string): OwnedAttemptView {
    if (observation.attemptId === undefined) throw new Error('owned attempt requires an attempt id')
    const attempt: OwnedAttemptView = {
      attemptId: observation.attemptId,
      parentSessionId: observation.parentSessionId,
      callId: observation.callId,
      toolName: boundRequired(observation.toolName, MAX_TOOL_NAME_LENGTH, 'tool'),
      expectedProviderName: boundRequired(expectedProviderName, MAX_PROVIDER_NAME_LENGTH, 'provider'),
      ...boundedLabel(observation.label),
      ...configuredProduct(observation),
      state: 'queued',
      createdAt: Date.now(),
    }
    this.attempts.set(attempt.attemptId, attempt)
    this.changed()
    return attempt
  }

  /** Mark one queued attempt as admitted and starting its Provider. */
  markStarting(attemptId: string): void {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || attempt.state !== 'queued') return
    this.attempts.set(attemptId, { ...attempt, state: 'starting', startedAt: Date.now() })
    this.changed()
  }

  /** Settle one attempt that never published a DSH run. */
  settleAttempt(
    attemptId: string,
    outcome: OwnedAttemptOutcome,
    cancellationRequested: boolean,
  ): void {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || (attempt.state !== 'queued' && attempt.state !== 'starting')) return
    this.attempts.set(attemptId, {
      ...attempt,
      state: outcome === 'lifecycle-missing' ? 'unknown' : 'not-published',
      outcome,
      cancellationRequested,
      finishedAt: Date.now(),
    })
    this.trimSettled()
    this.changed()
  }

  /** Promote the current execution context into one exact official run. */
  publish(observation: ExecutionObservation, info: SubagentRunInfo): boolean {
    if (observation.source === 'observed-tool') {
      const activeObserved = [...this.runs.values()].filter(run => (
        run.source === 'observed-tool' && run.state === 'active'
      )).length
      if (activeObserved >= this.config.maxObservedActive) {
        this.droppedActiveRuns += 1
        this.changed()
        return false
      }
    }
    const providerName = boundRequired(info.provider, MAX_PROVIDER_NAME_LENGTH, 'provider')
    const expected = boundedOptional(observation.expectedProviderName, MAX_PROVIDER_NAME_LENGTH)
    const run: ObservedRunView = {
      runId: String(info.runId),
      ...observation.attemptId === undefined ? {} : { attemptId: observation.attemptId },
      parentSessionId: observation.parentSessionId,
      childId: String(info.id),
      callId: observation.callId,
      toolName: boundRequired(observation.toolName, MAX_TOOL_NAME_LENGTH, 'tool'),
      ...boundedLabel(observation.label),
      providerName,
      ...expected === undefined ? {} : { expectedProviderName: expected },
      providerMismatch: expected !== undefined && expected !== providerName,
      ...configuredProduct(observation),
      source: observation.source,
      local: info.local,
      state: 'active',
      startedAt: Date.now(),
    }
    if (observation.attemptId !== undefined) this.attempts.delete(observation.attemptId)
    this.runs.set(run.runId, run)
    this.changed()
    return true
  }

  /** Settle one previously observed official run without retaining its output. */
  settle(info: SubagentRunEndInfo): void {
    const run = this.runs.get(String(info.runId))
    if (run === undefined || run.state !== 'active') return
    this.runs.set(run.runId, {
      ...run,
      state: runState(info.stopReason),
      finishedAt: Date.now(),
    })
    this.trimSettled()
    this.changed()
  }

  /** Read a detached snapshot filtered to exact parent Session ids. */
  snapshot(parentSessionIds: readonly string[]): ConsoleSnapshot {
    const allowed = new Set(parentSessionIds)
    return {
      schemaVersion: 1,
      hostInstanceId: this.hostInstanceId,
      hostStartedAt: this.hostStartedAt,
      revision: this.revisionValue,
      capturedAt: Date.now(),
      capabilities: {
        publishedLifecycle: true,
        startupLifecycle: 'owned-tool-only',
        liveProgress: false,
        browserCancellation: false,
        durableHistory: false,
      },
      diagnostics: { droppedActiveRuns: this.droppedActiveRuns },
      attempts: [...this.attempts.values()]
        .filter(attempt => allowed.has(attempt.parentSessionId))
        .map(attempt => ({ ...attempt })),
      runs: [...this.runs.values()]
        .filter(run => allowed.has(run.parentSessionId))
        .map(run => ({ ...run })),
    }
  }

  /** Assert internal capacity and identity relationships for the optional invariant face. */
  assertIntegrity(): void {
    if (this.config.historyLimit < 0 || this.config.maxObservedActive < 1) {
      throw new Error('product-subagent-console: invalid ledger bounds')
    }
    for (const run of this.runs.values()) {
      if (run.attemptId !== undefined && this.attempts.has(run.attemptId)) {
        throw new Error(`product-subagent-console: attempt ${run.attemptId} is both pending and published`)
      }
    }
  }

  private trimSettled(): void {
    const settled = [
      ...[...this.attempts.values()]
        .filter((record): record is OwnedAttemptView & { finishedAt: number } => record.finishedAt !== undefined)
        .map(record => ({ kind: 'attempt' as const, id: record.attemptId, finishedAt: record.finishedAt })),
      ...[...this.runs.values()]
        .filter((record): record is ObservedRunView & { finishedAt: number } => record.finishedAt !== undefined)
        .map(record => ({ kind: 'run' as const, id: record.runId, finishedAt: record.finishedAt })),
    ].sort((left, right) => left.finishedAt - right.finishedAt)
    for (const record of settled.slice(0, Math.max(0, settled.length - this.config.historyLimit))) {
      if (record.kind === 'attempt') this.attempts.delete(record.id)
      else this.runs.delete(record.id)
    }
  }

  private changed(): void { this.revisionValue += 1 }
}

/** Extract only the bounded display description from otherwise discarded tool arguments. */
export function displayLabelFromArguments(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const description = (value as Record<string, unknown>).description
  return typeof description === 'string' ? boundedOptional(description, MAX_LABEL_LENGTH) : undefined
}

function configuredProduct(value: ConfiguredProduct): ConfiguredProduct {
  const product = boundedOptional(value.product, 64)
  const displayName = boundedOptional(value.displayName, 80)
  const instance = boundedOptional(value.instance, 80)
  return {
    ...product === undefined ? {} : { product },
    ...displayName === undefined ? {} : { displayName },
    ...instance === undefined ? {} : { instance },
  }
}

function boundedLabel(value: string | undefined): { readonly label?: string } {
  const label = boundedOptional(value, MAX_LABEL_LENGTH)
  return label === undefined ? {} : { label }
}

function boundedOptional(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed.slice(0, max)
}

function boundRequired(value: string, max: number, field: string): string {
  const bounded = boundedOptional(value, max)
  if (bounded === undefined) throw new Error(`product-subagent-console: ${field} name is blank`)
  return bounded
}

function runState(reason: SubagentStopReason): ObservedRunState {
  switch (reason) {
    case 'completed':
    case 'aborted':
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return reason
    default:
      return 'unknown'
  }
}
