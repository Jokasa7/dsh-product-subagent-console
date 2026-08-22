import { randomUUID } from 'node:crypto'
import {
  planExecutionSchema,
  type AgentPlanRevision,
  type PlanAttemptStatus,
  type PlanExecution,
  type PlanExecutionStatus,
  type PlanRunBinding,
} from './plan-types.js'

/** Only Workflow has a stable whole-run control handle in the supported DSH baseline. */
export const EXECUTABLE_PLAN_BACKENDS = ['workflow'] as const
export type ExecutablePlanBackend = typeof EXECUTABLE_PLAN_BACKENDS[number]

export interface PlanExecutionRun {
  readonly executionId: string
  /** Resolves after the backend run and its owned cleanup have both settled. */
  readonly result: Promise<PlanExecution>
  snapshot(): PlanExecution
  subscribe(listener: (snapshot: PlanExecution) => void): () => void
  cancel(reason?: string): void
  /** Idempotently cancels when needed and joins backend cleanup. */
  dispose(): Promise<void>
}

export interface AttemptStartData {
  readonly workflowSeq: number
  readonly childId: string
  readonly at?: number
}

export type AttemptTerminalStatus = Extract<
  PlanAttemptStatus,
  'completed' | 'failed' | 'cancelled' | 'rejected' | 'skipped' | 'unknown'
>

const TERMINAL_EXECUTION_STATUSES = new Set<PlanExecutionStatus>([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'unknown',
])

const TERMINAL_ATTEMPT_STATUSES = new Set<PlanAttemptStatus>([
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'skipped',
  'unknown',
])

export function isTerminalPlanExecutionStatus(status: PlanExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status)
}

export function isTerminalPlanAttemptStatus(status: PlanAttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status)
}

/**
 * Mutable, schema-checked state machine for one execution. It stores task/run
 * bindings only; prompts and child outputs deliberately never enter snapshots.
 */
export class PlanExecutionTracker {
  private current: PlanExecution
  private readonly listeners = new Set<(snapshot: PlanExecution) => void>()

  constructor(
    plan: AgentPlanRevision,
    capabilityDigest: string,
    executionId: string = randomUUID(),
    private readonly now: () => number = Date.now,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {
    const createdAt = this.now()
    this.current = planExecutionSchema.parse({
      executionId,
      planId: plan.planId,
      planRevision: plan.revision,
      parentSessionId: plan.parentSessionId,
      backend: 'workflow',
      capabilityDigest,
      status: 'queued',
      cancellationRequested: false,
      createdAt,
      bindings: plan.tasks.map(task => ({
        planId: plan.planId,
        planRevision: plan.revision,
        executionId,
        taskId: task.taskId,
        attemptId: randomUUID(),
        attemptNumber: 1,
        status: 'queued',
      })),
    })
  }

  get executionId(): string { return this.current.executionId }

  snapshot(): PlanExecution {
    return structuredClone(this.current)
  }

  subscribe(listener: (snapshot: PlanExecution) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  markRunning(at: number = this.now()): void {
    if (this.current.status !== 'queued') return
    this.replace({ ...this.current, status: 'running', startedAt: at })
  }

  requestCancellation(): void {
    if (isTerminalPlanExecutionStatus(this.current.status)) return
    this.replace({
      ...this.current,
      status: 'stopping',
      cancellationRequested: true,
      ...this.current.startedAt === undefined ? { startedAt: this.now() } : {},
    })
  }

  markAttemptRunning(taskId: string, data: AttemptStartData): void {
    this.updateBinding(taskId, (binding) => {
      if (isTerminalPlanAttemptStatus(binding.status)) return binding
      return {
        ...binding,
        status: 'running',
        workflowSeq: data.workflowSeq,
        childId: data.childId,
        startedAt: data.at ?? this.now(),
      }
    })
  }

  markAttemptFinished(
    taskId: string,
    status: AttemptTerminalStatus,
    data: Partial<AttemptStartData> = {},
    at: number = this.now(),
  ): void {
    this.updateBinding(taskId, (binding) => {
      if (isTerminalPlanAttemptStatus(binding.status)) return binding
      return {
        ...binding,
        status,
        ...data.workflowSeq === undefined ? {} : { workflowSeq: data.workflowSeq },
        ...data.childId === undefined ? {} : { childId: data.childId },
        ...binding.startedAt === undefined && status !== 'skipped' ? { startedAt: data.at ?? at } : {},
        finishedAt: at,
      }
    })
  }

  /** Applies the fixed script's output-only status summary when an event was unavailable. */
  applyReportedStatus(taskId: string, status: Extract<AttemptTerminalStatus, 'completed' | 'failed' | 'skipped'>): void {
    this.markAttemptFinished(taskId, status)
  }

  markUnsettledAttempts(status: Extract<AttemptTerminalStatus, 'cancelled' | 'skipped' | 'unknown'>): void {
    for (const binding of this.current.bindings) {
      if (!isTerminalPlanAttemptStatus(binding.status)) this.markAttemptFinished(binding.taskId, status)
    }
  }

  finish(status: Extract<PlanExecutionStatus, 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'>): void {
    if (isTerminalPlanExecutionStatus(this.current.status)) return
    this.replace({ ...this.current, status, finishedAt: this.now() })
  }

  deriveCompletionStatus(): Extract<PlanExecutionStatus, 'succeeded' | 'partial' | 'failed'> {
    const statuses = this.current.bindings.map(binding => binding.status)
    if (statuses.length > 0 && statuses.every(status => status === 'completed')) return 'succeeded'
    if (statuses.some(status => status === 'completed')) return 'partial'
    return 'failed'
  }

  private updateBinding(taskId: string, update: (binding: PlanRunBinding) => PlanRunBinding): void {
    const index = this.current.bindings.findIndex(binding => binding.taskId === taskId)
    if (index < 0) return
    const previous = this.current.bindings[index]
    if (previous === undefined) return
    const next = update(previous)
    if (next === previous) return
    const bindings = [...this.current.bindings]
    bindings[index] = next
    this.replace({ ...this.current, bindings })
  }

  private replace(value: PlanExecution): void {
    this.current = planExecutionSchema.parse(value)
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(snapshot))
      } catch (error: unknown) {
        this.onListenerError(error)
      }
    }
  }
}
