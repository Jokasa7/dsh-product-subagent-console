import { sha256 } from './conformance.js'
import {
  inspectRunResultSchema,
  runFactSchema,
  type ConformanceReport,
  type EvidenceReceipt,
  type FoundryEventEnvelope,
  type InspectRunRequest,
  type InspectRunResult,
  type RecoveryProposal,
  type RunFact,
} from './foundry-types.js'
import type { PlanExecution } from './plan-types.js'
import { isTerminalPlanExecutionStatus } from './planner-execution.js'

export interface BuildRunQueryInput {
  readonly request: InspectRunRequest
  readonly execution?: PlanExecution
  readonly report?: ConformanceReport
  readonly proposal?: RecoveryProposal
  readonly events: readonly FoundryEventEnvelope[]
  readonly receipts: readonly EvidenceReceipt[]
}

/** Build a bounded deterministic answer. This function never calls a model. */
export function buildRunQuery(input: BuildRunQueryInput): InspectRunResult {
  const execution = input.execution !== undefined
    && input.execution.parentSessionId === input.request.parentSessionId
    && input.execution.executionId === input.request.runId
    ? input.execution
    : undefined
  const bindingsByAttempt = new Map(execution?.bindings.map(binding => [binding.attemptId, binding] as const) ?? [])
  const bindingTaskIds = new Set(execution?.bindings.map(binding => binding.taskId) ?? [])
  const runEvents = input.events
    .filter((event) => {
      if (
        event.parentSessionId !== input.request.parentSessionId
        || event.runId !== input.request.runId
      ) return false
      if (execution === undefined) return true
      if (event.planId !== execution.planId || event.planRevision !== execution.planRevision) return false
      if (event.taskId !== undefined && !bindingTaskIds.has(event.taskId)) return false
      if (event.attemptId === undefined) return true
      const binding = bindingsByAttempt.get(event.attemptId)
      if (binding !== undefined) return event.taskId === undefined || binding.taskId === event.taskId
      return event.taskId === undefined
        && event.authority === 'dsh'
        && (event.type === 'child-published' || event.type === 'child-terminal')
    })
    .sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  const runEventsById = new Map(runEvents.map(event => [event.eventId, event] as const))
  const matchingReport = execution !== undefined
    && input.report?.parentSessionId === execution.parentSessionId
    && input.report.runId === execution.executionId
    && input.report.planId === execution.planId
    && input.report.planRevision === execution.planRevision
    && input.report.eventCursor <= (runEvents.at(-1)?.cursor ?? 0)
    && input.report.findings.every(finding => (
      finding.parentSessionId === execution.parentSessionId
      && finding.runId === execution.executionId
      && finding.planId === execution.planId
      && finding.planRevision === execution.planRevision
      && finding.evidenceEventIds.every((eventId) => {
        const event = runEventsById.get(eventId)
        return event !== undefined
          && event.cursor <= input.report!.eventCursor
          && event.planId === execution.planId
          && event.planRevision === execution.planRevision
          && (finding.taskId === undefined || event.taskId === undefined || event.taskId === finding.taskId)
          && (finding.attemptId === undefined || event.attemptId === undefined || event.attemptId === finding.attemptId)
      })
    ))
    ? input.report
    : undefined
  const throughCursor = input.request.throughCursor
    ?? runEvents.at(-1)?.cursor
    ?? matchingReport?.eventCursor
    ?? 0
  const runEventsThroughCursor = runEvents.filter(event => event.cursor <= throughCursor)
  const visibleEventsById = new Map(runEventsThroughCursor.map(event => [event.eventId, event] as const))
  const scopedEvents = runEventsThroughCursor.filter(event => (
    input.request.taskId === undefined || event.taskId === input.request.taskId
  ))
  if (execution === undefined) {
    return inspectRunResultSchema.parse({
      schemaVersion: 1,
      queryId: queryId(input.request, throughCursor),
      parentSessionId: input.request.parentSessionId,
      runId: input.request.runId,
      kind: input.request.kind,
      throughCursor,
      state: 'unknown',
      answerCode: 'run-not-found',
      facts: [],
      hypotheses: [],
    })
  }

  const report = matchingReport !== undefined && matchingReport.eventCursor <= throughCursor
    ? matchingReport
    : undefined
  const proposal = report !== undefined
    && input.proposal?.parentSessionId === execution.parentSessionId
    && input.proposal.runId === execution.executionId
    && input.proposal.planId === execution.planId
    && input.proposal.planRevision === execution.planRevision
    && input.proposal.capabilityDigest === execution.capabilityDigest
    && input.proposal.eventCursor === report.eventCursor
    && input.proposal.eventCursor <= throughCursor
    && input.proposal.divergenceIds.every(findingId => report.findings.some(finding => finding.findingId === findingId))
    ? input.proposal
    : undefined
  const scopedReceipts = input.receipts.filter(receipt => (
    receipt.parentSessionId === execution.parentSessionId
    && receipt.runId === execution.executionId
    && receipt.planId === execution.planId
    && receipt.planRevision === execution.planRevision
    && (input.request.taskId === undefined || receipt.taskId === input.request.taskId)
    && execution.bindings.some(binding => (
      binding.taskId === receipt.taskId && binding.attemptId === receipt.attemptId
    ))
    && receipt.evidenceEventIds.every((eventId) => {
      const event = visibleEventsById.get(eventId)
      return event !== undefined
        && event.planId === execution.planId
        && event.planRevision === execution.planRevision
        && event.taskId === receipt.taskId
        && event.attemptId === receipt.attemptId
    })
  ))
  const facts = queryFacts({
    request: input.request,
    execution,
    events: input.events,
    receipts: input.receipts,
    ...(report === undefined ? {} : { report }),
    ...(proposal === undefined ? {} : { proposal }),
  }, scopedEvents, scopedReceipts)
  return inspectRunResultSchema.parse({
    schemaVersion: 1,
    queryId: queryId(input.request, throughCursor),
    parentSessionId: input.request.parentSessionId,
    runId: input.request.runId,
    kind: input.request.kind,
    throughCursor,
    state: report?.state ?? 'unknown',
    answerCode: facts.length === 0 ? 'insufficient-evidence' : 'facts-available',
    facts,
    hypotheses: [],
  })
}

function queryFacts(
  input: BuildRunQueryInput & { readonly execution: PlanExecution },
  events: readonly FoundryEventEnvelope[],
  receipts: readonly EvidenceReceipt[],
): RunFact[] {
  const { execution, report, proposal, request } = input
  switch (request.kind) {
    case 'summary': return compact([
      fact('lifecycle', 'Execution lifecycle', execution.status, 'proven', terminalEventIds(events)),
      report === undefined ? undefined : fact(
        'finding',
        'Conformance',
        report.state,
        'derived',
        findingEvidence(report),
        report.findings.map(item => item.findingId),
      ),
      fact(
        'evidence',
        'Verifier receipts',
        `${String(receipts.filter(item => item.result === 'pass').length)} pass, ${String(receipts.filter(item => item.result === 'fail').length)} fail, ${String(receipts.filter(item => item.result === 'unknown').length)} unknown`,
        'proven',
        receipts.flatMap(item => item.evidenceEventIds),
      ),
    ])
    case 'why-running': {
      if (isTerminalPlanExecutionStatus(execution.status)) {
        return [fact('lifecycle', 'Execution is terminal', execution.status, 'proven', terminalEventIds(events))]
      }
      const last = events.at(-1)
      return compact([
        fact(
          'lifecycle',
          'Current lifecycle',
          `${execution.status}; no authoritative terminal event is recorded through cursor ${String(request.throughCursor ?? last?.cursor ?? 0)}`,
          'derived',
          events.map(event => event.eventId),
        ),
        last === undefined ? undefined : fact(
          'lifecycle',
          'Last observed event',
          `${last.type} at ${new Date(last.occurredAt ?? last.observedAt).toISOString()}`,
          'proven',
          [last.eventId],
          [],
          last.taskId,
          last.attemptId,
        ),
      ])
    }
    case 'first-divergence': {
      const finding = report?.findings.find(item => item.findingId === report.firstProvableDivergenceId)
      return finding === undefined ? [] : [fact(
        'finding',
        'First provable divergence',
        finding.code,
        finding.certainty,
        finding.evidenceEventIds,
        [finding.findingId],
        finding.taskId,
        finding.attemptId,
      )]
    }
    case 'active-tasks': return execution.bindings
      .filter(binding => !['completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown'].includes(binding.status))
      .filter(binding => request.taskId === undefined || binding.taskId === request.taskId)
      .map(binding => fact(
        'attempt',
        'Active task attempt',
        binding.status,
        'proven',
        events.filter(event => event.attemptId === binding.attemptId).map(event => event.eventId),
        [],
        binding.taskId,
        binding.attemptId,
      ))
    case 'configuration': return events.flatMap(event => event.configuration === undefined ? [] : [fact(
      'configuration',
      event.authority === 'dsh' ? 'DSH-observed configuration' : 'Adapter-applied configuration',
      configurationValue(event.configuration),
      event.authority === 'dsh' ? 'proven' : 'derived',
      [event.eventId],
      [],
      event.taskId,
      event.attemptId,
    )])
    case 'cancel-impact': return compact([
      fact(
        'recovery',
        'Cancellation scope',
        isTerminalPlanExecutionStatus(execution.status)
          ? 'No cancellation is available for a terminal execution.'
          : 'When cancellation is available, its scope is the whole execution rather than one task.',
        'derived',
        events.map(event => event.eventId),
      ),
      proposal === undefined ? undefined : fact(
        'recovery',
        'Potentially affected tasks',
        proposal.affectedTaskIds.length === 0 ? 'none proven' : proposal.affectedTaskIds.join(', '),
        'derived',
        findingEvidence(report),
        proposal.divergenceIds,
      ),
    ])
    case 'recovery-impact': return proposal === undefined ? [] : compact([
      fact(
        'recovery',
        'Affected task closure',
        proposal.affectedTaskIds.length === 0 ? 'none proven' : proposal.affectedTaskIds.join(', '),
        'derived',
        findingEvidence(report),
        proposal.divergenceIds,
      ),
      fact(
        'recovery',
        'Reusable tasks',
        proposal.reusableTaskIds.length === 0 ? 'none proven' : proposal.reusableTaskIds.join(', '),
        'derived',
        findingEvidence(report),
        proposal.divergenceIds,
      ),
      ...proposal.actions.map(action => fact(
        'recovery',
        `Recovery ${action.kind}`,
        `${action.allowed ? 'executable after approval' : 'blocked'}: ${action.reasonCode}; effectSafe=${String(action.effectSafe)}; backendExecutable=${String(action.backendExecutable)}`,
        'derived',
        findingEvidence(report),
        proposal.divergenceIds,
        action.taskId,
      )),
    ])
    case 'evidence': return receipts.map(receipt => fact(
      'evidence',
      receipt.verifierId,
      `${receipt.result}: ${receipt.claim}`,
      receipt.authority === 'model-claim' ? 'hypothesis' : 'proven',
      receipt.evidenceEventIds,
      [],
      receipt.taskId,
      receipt.attemptId,
    ))
  }
}

function fact(
  category: RunFact['category'],
  label: string,
  value: string,
  certainty: RunFact['certainty'],
  evidenceEventIds: readonly string[] = [],
  findingIds: readonly string[] = [],
  taskId?: string,
  attemptId?: string,
): RunFact {
  const identity = JSON.stringify({ category, label, value, certainty, taskId, attemptId, evidenceEventIds, findingIds })
  return runFactSchema.parse({
    factId: sha256(identity),
    category,
    label,
    value,
    certainty,
    ...(taskId === undefined ? {} : { taskId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    evidenceEventIds: [...new Set(evidenceEventIds)].sort(),
    findingIds: [...new Set(findingIds)].sort(),
  })
}

function compact(values: readonly (RunFact | undefined)[]): RunFact[] {
  return values.filter((value): value is RunFact => value !== undefined)
}

function queryId(request: InspectRunRequest, throughCursor: number): string {
  return sha256(JSON.stringify({ ...request, throughCursor }))
}

function terminalEventIds(events: readonly FoundryEventEnvelope[]): string[] {
  return events.filter(event => event.type === 'execution-terminal').map(event => event.eventId)
}

function findingEvidence(report: ConformanceReport | undefined): string[] {
  return report?.findings.flatMap(finding => finding.evidenceEventIds) ?? []
}

function configurationValue(configuration: NonNullable<FoundryEventEnvelope['configuration']>): string {
  return Object.entries(configuration)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}
