import { createHash } from 'node:crypto'
import {
  exportTelemetryResultSchema,
  type ConformanceReport,
  type ExportTelemetryResult,
  type FoundryEventEnvelope,
} from './foundry-types.js'
import type { PlanExecution } from './plan-types.js'

export interface BuildTelemetryPreviewInput {
  readonly enabled: boolean
  readonly execution?: PlanExecution
  readonly report?: ConformanceReport
  readonly events: readonly FoundryEventEnvelope[]
  readonly serviceVersion: string
}

/** Build an offline OTLP-shaped preview; this module never opens a network connection. */
export function buildTelemetryPreview(input: BuildTelemetryPreviewInput): ExportTelemetryResult {
  if (!input.enabled || input.execution === undefined) {
    return exportTelemetryResultSchema.parse({ enabled: false, format: 'otlp-json-preview', payload: '' })
  }
  const execution = input.execution
  const traceId = hexDigest(execution.executionId, 32)
  const executionSpanId = hexDigest(`${execution.executionId}:execution`, 16)
  const bindingsByAttempt = new Map(execution.bindings.map(binding => [binding.attemptId, binding] as const))
  const bindingTaskIds = new Set(execution.bindings.map(binding => binding.taskId))
  const scopedEvents = input.events.filter(event => {
    if (
      event.parentSessionId !== execution.parentSessionId
      || event.runId !== execution.executionId
      || event.planId !== execution.planId
      || event.planRevision !== execution.planRevision
    ) return false
    if (event.taskId !== undefined && !bindingTaskIds.has(event.taskId)) return false
    if (event.attemptId === undefined) return true
    const binding = bindingsByAttempt.get(event.attemptId)
    return binding !== undefined && (event.taskId === undefined || event.taskId === binding.taskId)
  }).sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  const report = input.report !== undefined && reportMatchesExecution(input.report, execution, scopedEvents)
    ? input.report
    : undefined
  const spans = [{
    traceId,
    spanId: executionSpanId,
    name: 'agent.execution',
    kind: 1,
    startTimeUnixNano: millisToNanos(execution.startedAt ?? execution.createdAt),
    endTimeUnixNano: millisToNanos(execution.finishedAt ?? scopedEvents.at(-1)?.observedAt ?? Date.now()),
    attributes: attributes({
      'agent.backend': execution.backend,
      'agent.lifecycle.status': execution.status,
      'agent.plan.revision': execution.planRevision,
      'agent.task.count': execution.bindings.length,
      'agent.conformance.state': report?.state ?? 'unknown',
      'agent.finding.count': report?.findings.length ?? 0,
    }),
    status: { code: executionStatusCode(execution.status) },
  }, ...execution.bindings.map(binding => ({
    traceId,
    spanId: hexDigest(binding.attemptId, 16),
    parentSpanId: executionSpanId,
    name: 'agent.task.attempt',
    kind: 1,
    startTimeUnixNano: millisToNanos(binding.startedAt ?? execution.startedAt ?? execution.createdAt),
    endTimeUnixNano: millisToNanos(binding.finishedAt ?? execution.finishedAt ?? Date.now()),
    attributes: attributes({
      'agent.task.digest': hexDigest(`${execution.executionId}\u0000task\u0000${binding.taskId}`, 32),
      'agent.attempt.number': binding.attemptNumber,
      'agent.attempt.status': binding.status,
    }),
    status: { code: attemptStatusCode(binding.status) },
  }))]
  const payload = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: attributes({
        'service.name': 'dsh-product-subagent-console',
        'service.version': input.serviceVersion,
      }) },
      scopeSpans: [{
        scope: { name: 'dsh-product-subagent-console.foundry', version: input.serviceVersion },
        spans,
      }],
    }],
  }, null, 2)
  return exportTelemetryResultSchema.parse({ enabled: true, format: 'otlp-json-preview', payload })
}

function reportMatchesExecution(
  report: ConformanceReport,
  execution: PlanExecution,
  events: readonly FoundryEventEnvelope[],
): boolean {
  const eventsById = new Map(events.map(event => [event.eventId, event] as const))
  return report.parentSessionId === execution.parentSessionId
    && report.runId === execution.executionId
    && report.planId === execution.planId
    && report.planRevision === execution.planRevision
    && report.eventCursor <= (events.at(-1)?.cursor ?? 0)
    && report.findings.every(finding => (
      finding.parentSessionId === execution.parentSessionId
      && finding.runId === execution.executionId
      && finding.planId === execution.planId
      && finding.planRevision === execution.planRevision
      && finding.evidenceEventIds.every((eventId) => {
        const event = eventsById.get(eventId)
        return event !== undefined
          && event.cursor <= report.eventCursor
          && (finding.taskId === undefined || event.taskId === undefined || event.taskId === finding.taskId)
          && (finding.attemptId === undefined || event.attemptId === undefined || event.attemptId === finding.attemptId)
      })
    ))
}

function executionStatusCode(status: PlanExecution['status']): 0 | 1 | 2 {
  if (status === 'succeeded') return 1
  if (['partial', 'failed', 'cancelled', 'unknown'].includes(status)) return 2
  return 0
}

function attemptStatusCode(status: PlanExecution['bindings'][number]['status']): 0 | 1 | 2 {
  if (status === 'completed') return 1
  if (['failed', 'cancelled', 'rejected', 'unknown'].includes(status)) return 2
  return 0
}

function hexDigest(value: string, length: 16 | 32): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function millisToNanos(value: number): string {
  return String(BigInt(Math.max(0, Math.floor(value))) * 1_000_000n)
}

function attributes(values: Readonly<Record<string, string | number>>): Array<{
  readonly key: string
  readonly value: { readonly stringValue?: string; readonly intValue?: string }
}> {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
  }))
}
