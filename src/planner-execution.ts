import { randomUUID } from 'node:crypto'
import {
  planExecutionSchema,
  planRunBindingSchema,
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
  private readonly plannedTaskIds: ReadonlySet<string>
  private readonly listeners = new Set<(snapshot: PlanExecution) => void>()

  constructor(
    plan: AgentPlanRevision,
    capabilityDigest: string,
    executionId: string = randomUUID(),
    private readonly now: () => number = Date.now,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {
    const createdAt = this.now()
    this.plannedTaskIds = new Set(plan.tasks.map(task => task.taskId))
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
      // A planned task is not an actual attempt. Bindings materialize only
      // after Workflow publishes a task Agent or a trusted terminal summary.
      bindings: [],
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
    const binding = this.bindingFor(taskId, data)
      ?? this.materializeBinding(taskId, 'starting', data)
    this.updateBinding(binding.attemptId, (current) => {
      if (isTerminalPlanAttemptStatus(current.status)) return current
      return {
        ...current,
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
    beforeCommit?: (binding: PlanRunBinding) => void,
  ): void {
    let binding = this.bindingFor(taskId, data)
    if (binding === undefined) {
      // A skipped plan slot never became an actual attempt.
      if (status === 'skipped') return
      binding = this.materializeBinding(taskId, 'starting', data)
    }
    const current = this.current.bindings.find(candidate => candidate.attemptId === binding.attemptId)
    if (current === undefined || isTerminalPlanAttemptStatus(current.status)) return
    const next = planRunBindingSchema.parse({
      ...current,
      status,
      ...data.workflowSeq === undefined ? {} : { workflowSeq: data.workflowSeq },
      ...data.childId === undefined ? {} : { childId: data.childId },
      ...current.startedAt === undefined && status !== 'skipped' ? { startedAt: data.at ?? at } : {},
      finishedAt: at,
    })
    beforeCommit?.(structuredClone(next))
    this.updateBinding(binding.attemptId, () => next)
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
    if (
      statuses.length === this.plannedTaskIds.size
      && statuses.length > 0
      && statuses.every(status => status === 'completed')
    ) return 'succeeded'
    if (statuses.some(status => status === 'completed')) return 'partial'
    return 'failed'
  }

  private bindingFor(taskId: string, data: Partial<AttemptStartData>): PlanRunBinding | undefined {
    return this.current.bindings.findLast(binding => (
      binding.taskId === taskId
      && (data.childId === undefined || binding.childId === undefined || binding.childId === data.childId)
      && (data.workflowSeq === undefined || binding.workflowSeq === undefined || binding.workflowSeq === data.workflowSeq)
    ))
  }

  private materializeBinding(
    taskId: string,
    status: PlanAttemptStatus,
    data: Partial<AttemptStartData>,
  ): PlanRunBinding {
    if (!this.plannedTaskIds.has(taskId)) throw new Error(`attempt task ${taskId} is absent from the approved plan`)
    const previous = this.current.bindings.filter(binding => binding.taskId === taskId)
    const binding = planRunBindingSchema.parse({
      planId: this.current.planId,
      planRevision: this.current.planRevision,
      executionId: this.current.executionId,
      taskId,
      attemptId: randomUUID(),
      attemptNumber: previous.length + 1,
      status,
      ...data.workflowSeq === undefined ? {} : { workflowSeq: data.workflowSeq },
      ...data.childId === undefined ? {} : { childId: data.childId },
      ...data.at === undefined ? {} : { startedAt: data.at },
    })
    this.replace({ ...this.current, bindings: [...this.current.bindings, binding] })
    return binding
  }

  private updateBinding(attemptId: string, update: (binding: PlanRunBinding) => PlanRunBinding): void {
    const index = this.current.bindings.findIndex(binding => binding.attemptId === attemptId)
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
