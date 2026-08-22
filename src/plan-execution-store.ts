import {
  planExecutionSchema,
  type PlanExecution,
} from './plan-types.js'
import { isTerminalPlanExecutionStatus } from './planner-execution.js'

export class PlanExecutionOwnershipError extends Error {
  constructor() {
    super('plan execution does not belong to the requested parent Session')
    this.name = 'PlanExecutionOwnershipError'
  }
}

export class PlanExecutionCapacityError extends Error {
  constructor() {
    super('plan execution repository capacity reached with no terminal execution available for eviction')
    this.name = 'PlanExecutionCapacityError'
  }
}

export class PlanExecutionIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanExecutionIdentityError'
  }
}

interface ExecutionRecord {
  readonly execution: PlanExecution
  readonly encoded: string
}

export interface PlanExecutionStoreSnapshot {
  readonly schemaVersion: 1
  readonly revision: number
  readonly capturedAt: number
  readonly executions: readonly PlanExecution[]
}

/**
 * Host-owned execution history. A Workflow adapter may be replaced or
 * unloaded while this repository continues to serve completed comparisons.
 */
export class PlanExecutionSnapshotRepository {
  private readonly records = new Map<string, ExecutionRecord>()
  private readonly listeners = new Set<(revision: number) => void>()
  private revisionValue = 0

  constructor(
    private readonly maxExecutions = 500,
    private readonly now: () => number = Date.now,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(maxExecutions) || maxExecutions < 1 || maxExecutions > 5_000) {
      throw new Error('maxExecutions must be an integer from 1 to 5000')
    }
  }

  get revision(): number { return this.revisionValue }
  get size(): number { return this.records.size }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Insert or replace one schema-valid snapshot. An identical canonical
   * snapshot is a no-op and therefore does not wake long-poll consumers.
   */
  upsert(rawExecution: unknown): PlanExecution {
    const execution = structuredClone(planExecutionSchema.parse(rawExecution))
    const encoded = JSON.stringify(execution)
    const previous = this.records.get(execution.executionId)
    if (previous !== undefined) {
      this.assertSameIdentity(previous.execution, execution)
      if (previous.encoded === encoded) return structuredClone(previous.execution)
      if (isTerminalPlanExecutionStatus(previous.execution.status)) {
        throw new PlanExecutionIdentityError('a terminal plan execution snapshot is immutable')
      }
      this.records.set(execution.executionId, { execution, encoded })
      this.changed()
      return structuredClone(execution)
    }

    if (this.records.size >= this.maxExecutions) this.evictOldestTerminal()
    this.records.set(execution.executionId, { execution, encoded })
    this.changed()
    return structuredClone(execution)
  }

  /** Read one execution only through its owning parent Session. */
  get(parentSessionId: string, executionId: string): PlanExecution | undefined {
    const record = this.records.get(executionId)
    if (record === undefined) return undefined
    if (record.execution.parentSessionId !== parentSessionId) throw new PlanExecutionOwnershipError()
    return structuredClone(record.execution)
  }

  /** Newest-started first, with executionId as a stable tie-breaker. */
  list(parentSessionIds: readonly string[]): readonly PlanExecution[] {
    const allowed = new Set(parentSessionIds)
    return [...this.records.values()]
      .map(record => record.execution)
      .filter(execution => allowed.has(execution.parentSessionId))
      .sort((left, right) => (
        right.createdAt - left.createdAt
        || left.executionId.localeCompare(right.executionId)
      ))
      .map(execution => structuredClone(execution))
  }

  snapshot(parentSessionIds: readonly string[]): PlanExecutionStoreSnapshot {
    return {
      schemaVersion: 1,
      revision: this.revisionValue,
      capturedAt: this.now(),
      executions: this.list(parentSessionIds),
    }
  }

  private assertSameIdentity(previous: PlanExecution, next: PlanExecution): void {
    if (previous.parentSessionId !== next.parentSessionId) throw new PlanExecutionOwnershipError()
    if (
      previous.planId !== next.planId
      || previous.planRevision !== next.planRevision
      || previous.backend !== next.backend
      || previous.capabilityDigest !== next.capabilityDigest
      || previous.createdAt !== next.createdAt
    ) {
      throw new PlanExecutionIdentityError('immutable plan execution identity fields changed')
    }
    const nextAttempts = new Map(next.bindings.map(binding => [binding.attemptId, binding] as const))
    for (const before of previous.bindings) {
      const binding = nextAttempts.get(before.attemptId)
      if (
        binding === undefined
        || before.taskId !== binding.taskId
        || before.attemptNumber !== binding.attemptNumber
        || before.planId !== binding.planId
        || before.planRevision !== binding.planRevision
        || before.executionId !== binding.executionId
      ) {
        throw new PlanExecutionIdentityError('an existing plan execution attempt identity changed or disappeared')
      }
    }
  }

  private evictOldestTerminal(): void {
    const candidate = [...this.records.values()]
      .filter(record => isTerminalPlanExecutionStatus(record.execution.status))
      .sort((left, right) => {
        const leftTime = left.execution.finishedAt ?? left.execution.createdAt
        const rightTime = right.execution.finishedAt ?? right.execution.createdAt
        return leftTime - rightTime
          || left.execution.createdAt - right.execution.createdAt
          || left.execution.executionId.localeCompare(right.execution.executionId)
      })[0]
    if (candidate === undefined) throw new PlanExecutionCapacityError()
    this.records.delete(candidate.execution.executionId)
  }

  private changed(): void {
    this.revisionValue += 1
    for (const listener of [...this.listeners]) {
      try {
        listener(this.revisionValue)
      } catch (error: unknown) {
        try {
          this.onListenerError(error)
        } catch {
          // Error reporting is also contained so one listener cannot starve others.
        }
      }
    }
  }
}
