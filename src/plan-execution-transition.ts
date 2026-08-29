import type { PlanAttemptStatus, PlanExecution, PlanExecutionStatus, PlanRunBinding } from './plan-types.js'

const TERMINAL_EXECUTION = new Set<PlanExecutionStatus>([
  'succeeded', 'partial', 'failed', 'cancelled', 'unknown',
])

const TERMINAL_ATTEMPT = new Set<PlanAttemptStatus>([
  'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown',
])

const EXECUTION_TRANSITIONS: Readonly<Record<PlanExecutionStatus, ReadonlySet<PlanExecutionStatus>>> = {
  queued: new Set(['queued', 'running', 'stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']),
  running: new Set(['running', 'stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']),
  stopping: new Set(['stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown']),
  succeeded: new Set(['succeeded']),
  partial: new Set(['partial']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  unknown: new Set(['unknown']),
}

const ATTEMPT_TRANSITIONS: Readonly<Record<PlanAttemptStatus, ReadonlySet<PlanAttemptStatus>>> = {
  queued: new Set(['queued', 'starting', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown']),
  starting: new Set(['starting', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'rejected', 'unknown']),
  running: new Set(['running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'unknown']),
  waiting: new Set(['waiting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'unknown']),
  stopping: new Set(['stopping', 'completed', 'failed', 'cancelled', 'unknown']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  rejected: new Set(['rejected']),
  skipped: new Set(['skipped']),
  unknown: new Set(['unknown']),
}

/**
 * Return the first reason a newer execution projection would rewrite history.
 * Undefined means the transition is monotonic and may be persisted.
 */
export function planExecutionTransitionError(previous: PlanExecution, next: PlanExecution): string | undefined {
  if (
    previous.executionId !== next.executionId
    || previous.parentSessionId !== next.parentSessionId
    || previous.planId !== next.planId
    || previous.planRevision !== next.planRevision
    || previous.backend !== next.backend
    || previous.capabilityDigest !== next.capabilityDigest
    || previous.createdAt !== next.createdAt
  ) return 'immutable execution identity fields changed'

  if (!EXECUTION_TRANSITIONS[previous.status].has(next.status)) {
    return `execution status regressed from ${previous.status} to ${next.status}`
  }
  if (TERMINAL_EXECUTION.has(previous.status) && previous.status !== next.status) {
    return 'terminal execution status changed'
  }
  if (previous.cancellationRequested && !next.cancellationRequested) {
    return 'execution cancellation request disappeared'
  }
  const executionTimeError = monotonicTimes(
    previous.createdAt,
    previous.startedAt,
    previous.finishedAt,
    next.startedAt,
    next.finishedAt,
    TERMINAL_EXECUTION.has(next.status),
    'execution',
  )
  if (executionTimeError !== undefined) return executionTimeError

  const nextAttempts = new Map<string, PlanRunBinding>()
  for (const binding of next.bindings) {
    if (nextAttempts.has(binding.attemptId)) return 'duplicate attempt identity appeared'
    nextAttempts.set(binding.attemptId, binding)
  }
  for (const before of previous.bindings) {
    const after = nextAttempts.get(before.attemptId)
    if (after === undefined) return 'an existing attempt disappeared'
    const error = attemptTransitionError(before, after, next.createdAt)
    if (error !== undefined) return error
  }
  return undefined
}
function attemptTransitionError(previous: PlanRunBinding, next: PlanRunBinding, executionCreatedAt: number): string | undefined {
  if (
    previous.taskId !== next.taskId
    || previous.attemptNumber !== next.attemptNumber
    || previous.planId !== next.planId
    || previous.planRevision !== next.planRevision
    || previous.executionId !== next.executionId
    || previous.retryOf !== next.retryOf
  ) return `immutable attempt identity fields changed for ${previous.attemptId}`

  if (!ATTEMPT_TRANSITIONS[previous.status].has(next.status)) {
    return `attempt ${previous.attemptId} status regressed from ${previous.status} to ${next.status}`
  }
  if (TERMINAL_ATTEMPT.has(previous.status) && previous.status !== next.status) {
    return `terminal attempt ${previous.attemptId} status changed`
  }
  for (const field of ['workflowSeq', 'childId', 'teamMemberId', 'teamTaskId'] as const) {
    if (previous[field] !== undefined && previous[field] !== next[field]) {
      return `attempt ${previous.attemptId} field ${field} changed or disappeared`
    }
  }
  return monotonicTimes(
    executionCreatedAt,
    previous.startedAt,
    previous.finishedAt,
    next.startedAt,
    next.finishedAt,
    TERMINAL_ATTEMPT.has(next.status),
    `attempt ${previous.attemptId}`,
  )
}

function monotonicTimes(
  createdAt: number,
  previousStartedAt: number | undefined,
  previousFinishedAt: number | undefined,
  nextStartedAt: number | undefined,
  nextFinishedAt: number | undefined,
  nextTerminal: boolean,
  label: string,
): string | undefined {
  if (previousStartedAt !== undefined && previousStartedAt !== nextStartedAt) {
    return `${label} startedAt changed or disappeared`
  }
  if (nextStartedAt !== undefined && nextStartedAt < createdAt) {
    return `${label} startedAt precedes creation`
  }
  if (previousFinishedAt !== undefined && previousFinishedAt !== nextFinishedAt) {
    return `${label} finishedAt changed or disappeared`
  }
  if (nextFinishedAt !== undefined) {
    if (!nextTerminal) return `${label} has finishedAt before a terminal state`
    if (nextFinishedAt < (nextStartedAt ?? createdAt)) return `${label} finishedAt precedes start`
  }
  return undefined
}
