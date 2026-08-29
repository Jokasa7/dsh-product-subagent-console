import type { FoundryEventEnvelope } from './foundry-types.js'
import type { PlanExecution, PlanExecutionStatus, PlanRunBinding } from './plan-types.js'

/** Rebuild the visible execution state at one monotonic event cursor. */
export function projectExecutionAtCursor(
  latest: PlanExecution,
  allEvents: readonly FoundryEventEnvelope[],
  throughCursor: number,
): PlanExecution | undefined {
  const validBindings = latest.bindings.filter(binding => (
    binding.executionId === latest.executionId
    && binding.planId === latest.planId
    && binding.planRevision === latest.planRevision
  ))
  const bindingsByAttempt = new Map(validBindings.map(binding => [binding.attemptId, binding] as const))
  const bindingTaskIds = new Set(validBindings.map(binding => binding.taskId))
  const events: FoundryEventEnvelope[] = []
  for (const event of allEvents) {
    if (
      event.parentSessionId === latest.parentSessionId
      && event.runId === latest.executionId
      && event.planId === latest.planId
      && event.planRevision === latest.planRevision
      && event.cursor <= throughCursor
    ) {
      if (event.taskId !== undefined && !bindingTaskIds.has(event.taskId)) continue
      if (event.attemptId !== undefined) {
        const binding = bindingsByAttempt.get(event.attemptId)
        if (binding === undefined || (event.taskId !== undefined && binding.taskId !== event.taskId)) continue
      }
      events.push(event)
    }
  }
  events.sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  const executionEvents: FoundryEventEnvelope[] = []
  const attemptEventsById = new Map<string, FoundryEventEnvelope[]>()
  for (const event of events) {
    if (event.executionStatus !== undefined) executionEvents.push(event)
    if (event.attemptId === undefined) continue
    const attemptEvents = attemptEventsById.get(event.attemptId) ?? []
    attemptEvents.push(event)
    attemptEventsById.set(event.attemptId, attemptEvents)
  }
  const lastExecutionEvent = executionEvents.at(-1)
  if (lastExecutionEvent === undefined) return undefined
  const status = lastExecutionEvent.executionStatus ?? eventExecutionStatus(lastExecutionEvent)
  const bindings = validBindings.flatMap(binding => {
    const attemptEvents = attemptEventsById.get(binding.attemptId) ?? []
    let lastAttemptEvent: FoundryEventEnvelope | undefined
    for (const event of attemptEvents) {
      if (event.attemptStatus !== undefined) lastAttemptEvent = event
    }
    if (lastAttemptEvent === undefined) return []
    const childWasPublished = attemptEvents.some(event => event.type === 'child-published')
    const attemptStatus = lastAttemptEvent.attemptStatus ?? binding.status
    const terminal = lastAttemptEvent.type === 'attempt-terminal'
    return [{
      planId: binding.planId,
      planRevision: binding.planRevision,
      executionId: binding.executionId,
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      attemptNumber: binding.attemptNumber,
      ...(binding.retryOf === undefined ? {} : { retryOf: binding.retryOf }),
      status: attemptStatus,
      ...(childWasPublished && binding.workflowSeq !== undefined ? { workflowSeq: binding.workflowSeq } : {}),
      ...(childWasPublished && binding.childId !== undefined ? { childId: binding.childId } : {}),
      ...(binding.teamMemberId === undefined ? {} : { teamMemberId: binding.teamMemberId }),
      ...(binding.teamTaskId === undefined ? {} : { teamTaskId: binding.teamTaskId }),
      startedAt: attemptEvents[0]?.occurredAt ?? attemptEvents[0]?.observedAt ?? binding.startedAt,
      ...(terminal ? {
        finishedAt: lastAttemptEvent.occurredAt ?? lastAttemptEvent.observedAt,
      } : {}),
    } satisfies PlanRunBinding]
  })
  const firstStarted = executionEvents.find(event => event.type === 'execution-started')
  const terminal = lastExecutionEvent.type === 'execution-terminal'
  return {
    executionId: latest.executionId,
    planId: latest.planId,
    planRevision: latest.planRevision,
    parentSessionId: latest.parentSessionId,
    backend: latest.backend,
    capabilityDigest: latest.capabilityDigest,
    status,
    cancellationRequested: events.some(event => event.type === 'execution-stopping'),
    createdAt: latest.createdAt,
    ...(firstStarted === undefined ? {} : {
      startedAt: firstStarted.occurredAt ?? firstStarted.observedAt,
    }),
    ...(terminal ? {
      finishedAt: lastExecutionEvent.occurredAt ?? lastExecutionEvent.observedAt,
    } : {}),
    bindings,
  }
}

function eventExecutionStatus(event: FoundryEventEnvelope): PlanExecutionStatus {
  if (event.type === 'execution-queued') return 'queued'
  if (event.type === 'execution-started') return 'running'
  if (event.type === 'execution-stopping') return 'stopping'
  return 'unknown'
}
