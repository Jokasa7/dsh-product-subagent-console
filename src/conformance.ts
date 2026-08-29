import { createHash } from 'node:crypto'
import {
  conformanceFindingSchema,
  conformanceReportSchema,
  type ConformanceFinding,
  type ConformanceFindingCode,
  type ConformanceReport,
  type EvidenceReceipt,
  type FindingCertainty,
  type FoundryEventEnvelope,
  type PlanContractV2,
  type TaskConformance,
} from './foundry-types.js'
import {
  isTerminalPlanAttemptStatus,
  isTerminalPlanExecutionStatus,
} from './planner-execution.js'
import type { PlanExecution, PlanRunBinding } from './plan-types.js'

export interface BuildConformanceReportInput {
  readonly contract: PlanContractV2
  readonly execution: PlanExecution
  readonly events: readonly FoundryEventEnvelope[]
  readonly receipts: readonly EvidenceReceipt[]
  readonly eventCursor?: number
  readonly generatedAt?: number
}

interface FindingInput {
  readonly code: ConformanceFindingCode
  readonly severity: ConformanceFinding['severity']
  readonly certainty: FindingCertainty
  readonly taskId?: string
  readonly attemptId?: string
  readonly firstObservedAt: number
  readonly evidenceEventIds?: readonly string[]
  readonly detail?: ConformanceFinding['detail']
}

/**
 * Compare one approved plan contract with one factual execution snapshot.
 * The function is pure and deterministic when `generatedAt` is supplied.
 */
export function buildConformanceReport(input: BuildConformanceReportInput): ConformanceReport {
  assertMatchingIdentity(input.contract, input.execution)
  const bindingsByAttempt = new Map(input.execution.bindings.map(binding => [binding.attemptId, binding] as const))
  const bindings = new Map<string, PlanRunBinding>()
  for (const binding of input.execution.bindings) {
    const current = bindings.get(binding.taskId)
    if (
      current === undefined
      || binding.attemptNumber > current.attemptNumber
      || (binding.attemptNumber === current.attemptNumber && binding.attemptId.localeCompare(current.attemptId) > 0)
    ) bindings.set(binding.taskId, binding)
  }
  const tasks = new Map(input.contract.tasks.map(task => [task.taskId, task] as const))
  const scopedEvents = input.events
    .filter((event) => {
      if (
        event.parentSessionId !== input.contract.parentSessionId
        || event.runId !== input.execution.executionId
        || event.planId !== input.contract.planId
        || event.planRevision !== input.contract.revision
      ) return false
      if (event.taskId !== undefined && !tasks.has(event.taskId)) return false
      if (event.attemptId === undefined || event.taskId === undefined) return true
      const binding = bindingsByAttempt.get(event.attemptId)
      return binding?.taskId === event.taskId
    })
    .sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  const eventCursor = input.eventCursor ?? scopedEvents.at(-1)?.cursor ?? 0
  const events = scopedEvents.filter(event => event.cursor <= eventCursor)
  const evidenceEvents = new Map(events.map(event => [event.eventId, event] as const))
  const receipts = input.receipts.filter(receipt => (
    receipt.parentSessionId === input.contract.parentSessionId
    && receipt.runId === input.execution.executionId
    && receipt.planId === input.contract.planId
    && receipt.planRevision === input.contract.revision
    && bindingsByAttempt.get(receipt.attemptId)?.taskId === receipt.taskId
    && tasks.get(receipt.taskId)?.verifiers.some(verifier => (
      verifier.verifierId === receipt.verifierId && verifier.kind === receipt.verifierKind
    )) === true
    && receipt.evidenceEventIds.every((eventId) => {
      const event = evidenceEvents.get(eventId)
      return event !== undefined
        && event.parentSessionId === receipt.parentSessionId
        && event.runId === receipt.runId
        && event.planId === receipt.planId
        && event.planRevision === receipt.planRevision
        && event.taskId === receipt.taskId
        && event.attemptId === receipt.attemptId
    })
  ))
  const eventsByTask = new Map<string, FoundryEventEnvelope[]>()
  const eventsByAttempt = new Map<string, FoundryEventEnvelope[]>()
  for (const event of events) {
    if (event.taskId !== undefined) {
      const scoped = eventsByTask.get(event.taskId) ?? []
      scoped.push(event)
      eventsByTask.set(event.taskId, scoped)
    }
    if (event.attemptId !== undefined) {
      const scoped = eventsByAttempt.get(event.attemptId) ?? []
      scoped.push(event)
      eventsByAttempt.set(event.attemptId, scoped)
    }
  }
  const findings: ConformanceFinding[] = []

  const addFinding = (finding: FindingInput): void => {
    const detail = finding.detail === undefined ? undefined : canonicalDetail(finding.detail)
    const identity = [
      input.execution.executionId,
      finding.code,
      finding.taskId ?? '',
      finding.attemptId ?? '',
      detail === undefined ? '' : JSON.stringify(detail),
    ].join('\u0000')
    findings.push(conformanceFindingSchema.parse({
      schemaVersion: 1,
      findingId: sha256(identity),
      code: finding.code,
      status: 'open',
      severity: finding.severity,
      certainty: finding.certainty,
      parentSessionId: input.contract.parentSessionId,
      runId: input.execution.executionId,
      planId: input.contract.planId,
      planRevision: input.contract.revision,
      ...(finding.taskId === undefined ? {} : { taskId: finding.taskId }),
      ...(finding.attemptId === undefined ? {} : { attemptId: finding.attemptId }),
      firstObservedAt: finding.firstObservedAt,
      evidenceEventIds: [...new Set(finding.evidenceEventIds ?? [])].sort(),
      ...(detail === undefined ? {} : { detail }),
    }))
  }

  for (const event of events) {
    if (event.type !== 'child-published' || event.taskId !== undefined) continue
    addFinding({
      code: 'unbound-actual',
      severity: 'warning',
      certainty: 'proven',
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      firstObservedAt: event.occurredAt ?? event.observedAt,
      evidenceEventIds: [event.eventId],
    })
  }

  for (const task of input.contract.tasks) {
    const binding = bindings.get(task.taskId)
    const taskEvents = binding === undefined
      ? eventsByTask.get(task.taskId) ?? []
      : eventsByAttempt.get(binding.attemptId) ?? []
    const lastTaskEvent = taskEvents.at(-1)
    if (binding === undefined) {
      if (isTerminalPlanExecutionStatus(input.execution.status)) {
        addFinding({
          code: 'missing-planned',
          severity: 'blocking',
          certainty: 'proven',
          taskId: task.taskId,
          firstObservedAt: input.execution.finishedAt ?? lastTaskEvent?.observedAt ?? input.execution.createdAt,
          evidenceEventIds: terminalExecutionEventIds(events),
        })
      }
      continue
    }

    detectLifecycleFindings(input.execution, binding, taskEvents, events, addFinding)
    detectDependencyFindings(task.taskId, task.dependencies.map(dependency => dependency.taskId), binding, bindings, taskEvents, addFinding)
    detectConfigurationFindings(task.roleId, binding, taskEvents, input.contract, addFinding)
    detectEvidenceFindings(task.taskId, task.verifiers, binding, receipts, taskEvents, addFinding)
  }

  for (const binding of input.execution.bindings) {
    if (tasks.has(binding.taskId)) continue
    const bindingEvents = eventsByAttempt.get(binding.attemptId) ?? []
    addFinding({
      code: 'unexpected-actual',
      severity: 'blocking',
      certainty: 'proven',
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      firstObservedAt: binding.startedAt ?? bindingEvents[0]?.observedAt ?? input.execution.createdAt,
      evidenceEventIds: bindingEvents.map(event => event.eventId),
    })
  }

  findings.sort(compareFindings)
  const taskReports = input.contract.tasks.map(task => taskConformance(
    task.taskId,
    bindings.get(task.taskId),
    task.verifiers,
    receipts.filter(receipt => receipt.taskId === task.taskId),
    findings.filter(finding => finding.taskId === task.taskId),
    isTerminalPlanExecutionStatus(input.execution.status),
  ))
  const firstProvable = findings.find(finding => finding.status === 'open' && finding.certainty === 'proven')
  const state = findings.some(finding => finding.status === 'open' && finding.severity !== 'info')
    || taskReports.some(task => task.state === 'deviated')
    ? 'deviated'
    : taskReports.every(task => task.state === 'confirmed' || task.state === 'not-applicable')
      ? 'confirmed'
      : 'unknown'

  return conformanceReportSchema.parse({
    schemaVersion: 1,
    parentSessionId: input.contract.parentSessionId,
    runId: input.execution.executionId,
    planId: input.contract.planId,
    planRevision: input.contract.revision,
    eventCursor,
    generatedAt: input.generatedAt ?? Date.now(),
    state,
    ...(firstProvable === undefined ? {} : { firstProvableDivergenceId: firstProvable.findingId }),
    tasks: taskReports,
    findings,
  })
}

function detectLifecycleFindings(
  execution: PlanExecution,
  binding: PlanRunBinding,
  taskEvents: readonly FoundryEventEnvelope[],
  runEvents: readonly FoundryEventEnvelope[],
  add: (finding: FindingInput) => void,
): void {
  if (isTerminalPlanExecutionStatus(execution.status) && !isTerminalPlanAttemptStatus(binding.status)) {
    add({
      code: 'lifecycle-incomplete',
      severity: 'blocking',
      certainty: 'proven',
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      firstObservedAt: execution.finishedAt ?? runEvents.at(-1)?.observedAt ?? taskEvents.at(-1)?.observedAt ?? execution.createdAt,
      evidenceEventIds: terminalExecutionEventIds(runEvents),
      detail: { expected: 'terminal-attempt', actual: binding.status },
    })
  }
  if (binding.status === 'skipped') {
    add({
      code: 'missing-planned',
      severity: 'warning',
      certainty: 'proven',
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      firstObservedAt: binding.finishedAt ?? taskEvents.at(-1)?.observedAt ?? execution.createdAt,
      evidenceEventIds: taskEvents.map(event => event.eventId),
      detail: { expected: 'attempt-started', actual: 'skipped' },
    })
  }
  if (['failed', 'cancelled', 'rejected'].includes(binding.status)) {
    const terminalEvents = taskEvents.filter(event => (
      event.type === 'attempt-terminal'
      || event.type === 'child-terminal'
    ))
    add({
      code: 'attempt-unsuccessful',
      severity: 'blocking',
      certainty: terminalEvents.length > 0 ? 'proven' : 'derived',
      taskId: binding.taskId,
      attemptId: binding.attemptId,
      firstObservedAt: binding.finishedAt ?? terminalEvents.at(-1)?.observedAt ?? execution.finishedAt ?? execution.createdAt,
      evidenceEventIds: terminalEvents.map(event => event.eventId),
      detail: { expected: 'completed', actual: binding.status },
    })
  }
}

function detectDependencyFindings(
  taskId: string,
  dependencies: readonly string[],
  binding: PlanRunBinding,
  bindings: ReadonlyMap<string, PlanRunBinding>,
  events: readonly FoundryEventEnvelope[],
  add: (finding: FindingInput) => void,
): void {
  if (binding.startedAt === undefined) return
  for (const dependencyTaskId of dependencies) {
    const dependency = bindings.get(dependencyTaskId)
    if (
      dependency?.status === 'completed'
      && dependency.finishedAt !== undefined
      && dependency.finishedAt <= binding.startedAt
    ) continue
    add({
      code: 'order-violation',
      severity: 'blocking',
      certainty: 'derived',
      taskId,
      attemptId: binding.attemptId,
      firstObservedAt: binding.startedAt,
      evidenceEventIds: events.map(event => event.eventId),
      detail: { dependencyTaskId, expected: 'dependency-completed', actual: dependency?.status ?? 'missing' },
    })
  }
}

function detectConfigurationFindings(
  roleId: string,
  binding: PlanRunBinding,
  events: readonly FoundryEventEnvelope[],
  contract: PlanContractV2,
  add: (finding: FindingInput) => void,
): void {
  const expected = contract.roles.find(role => role.roleId === roleId)
  if (expected === undefined) return
  for (const event of events) {
    const actual = event.configuration
    if (actual === undefined) continue
    const comparisons: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
      ['transport-provider', expected.transportProvider, actual.transportProvider],
      ['llm-provider', expected.llmProvider, actual.llmProvider],
      ['model', expected.model, actual.model],
      ['reasoning-effort', expected.reasoningEffort, actual.reasoningEffort],
      ['tool-policy', expected.toolPolicyMode, actual.toolPolicyMode],
    ]
    for (const [name, wanted, observed] of comparisons) {
      if (wanted === undefined || observed === undefined || wanted === observed) continue
      add({
        code: 'configuration-drift',
        severity: 'blocking',
        certainty: 'proven',
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        firstObservedAt: event.occurredAt ?? event.observedAt,
        evidenceEventIds: [event.eventId],
        detail: { expected: `${name}:${wanted}`, actual: `${name}:${observed}` },
      })
    }
  }
}

function detectEvidenceFindings(
  taskId: string,
  verifiers: PlanContractV2['tasks'][number]['verifiers'],
  binding: PlanRunBinding,
  receipts: readonly EvidenceReceipt[],
  events: readonly FoundryEventEnvelope[],
  add: (finding: FindingInput) => void,
): void {
  if (binding.status !== 'completed') return
  const authoritative = receipts.filter(receipt => receipt.authority !== 'model-claim')
  for (const verifier of verifiers.filter(item => item.required)) {
    const candidates = authoritative.filter(receipt => (
      receipt.taskId === taskId
      && receipt.attemptId === binding.attemptId
      && receipt.verifierId === verifier.verifierId
      && receipt.verifierKind === verifier.kind
      && receiptClaimMatchesVerifier(receipt.claim, verifier.kind)
    ))
    const failed = candidates.find(receipt => receipt.result === 'fail')
    if (failed !== undefined) {
      add({
        code: 'verifier-failed',
        severity: 'blocking',
        certainty: 'proven',
        taskId,
        attemptId: binding.attemptId,
        firstObservedAt: failed.observedAt,
        evidenceEventIds: failed.evidenceEventIds,
        detail: { verifierId: verifier.verifierId, expected: 'pass', actual: 'fail' },
      })
      continue
    }
    if (!candidates.some(receipt => receipt.result === 'pass')) {
      add({
        code: 'evidence-missing',
        severity: 'warning',
        certainty: 'proven',
        taskId,
        attemptId: binding.attemptId,
        firstObservedAt: binding.finishedAt ?? events.at(-1)?.observedAt ?? 0,
        evidenceEventIds: events.map(event => event.eventId),
        detail: { verifierId: verifier.verifierId, expected: 'pass', actual: 'missing' },
      })
    }
  }
}

function taskConformance(
  taskId: string,
  binding: PlanRunBinding | undefined,
  verifiers: PlanContractV2['tasks'][number]['verifiers'],
  receipts: readonly EvidenceReceipt[],
  findings: readonly ConformanceFinding[],
  executionTerminal: boolean,
): TaskConformance {
  const required = verifiers.filter(verifier => verifier.required)
  const authoritative = receipts.filter(receipt => receipt.authority !== 'model-claim')
  const matching = (verifier: PlanContractV2['tasks'][number]['verifiers'][number]) => (
    binding === undefined ? [] : authoritative.filter(receipt => (
      receipt.attemptId === binding.attemptId
      && receipt.verifierId === verifier.verifierId
      && receipt.verifierKind === verifier.kind
      && receiptClaimMatchesVerifier(receipt.claim, verifier.kind)
    ))
  )
  const failed = required.some(verifier => matching(verifier).some(receipt => receipt.result === 'fail'))
  const verified = required.length > 0 && required.every(verifier => (
    matching(verifier).some(receipt => receipt.result === 'pass')
  ))
  const evidenceStatus = required.length === 0
    ? 'not-required'
    : failed
      ? 'failed'
      : verified
        ? 'verified'
        : binding?.status === 'completed'
          ? 'missing'
          : 'unknown'
  const hasDeviation = findings.some(finding => finding.status === 'open' && finding.severity !== 'info')
  let state: TaskConformance['state']
  if (hasDeviation) state = 'deviated'
  else if (binding === undefined) state = executionTerminal ? 'deviated' : 'unknown'
  else if (binding.status === 'unknown') state = 'unknown'
  else if (['failed', 'cancelled', 'rejected', 'skipped'].includes(binding.status)) state = 'deviated'
  else state = 'confirmed'
  return {
    taskId,
    state,
    ...(binding === undefined ? {} : {
      attemptId: binding.attemptId,
      lifecycleStatus: binding.status,
    }),
    evidenceStatus,
    findingIds: findings.map(finding => finding.findingId),
  }
}

function receiptClaimMatchesVerifier(
  claim: EvidenceReceipt['claim'],
  kind: PlanContractV2['tasks'][number]['verifiers'][number]['kind'],
): boolean {
  if (kind === 'lifecycle') return claim === 'lifecycle-terminal'
  if (kind === 'manual') return claim === 'manual-accepted'
  return claim === 'criteria-satisfied' || claim === 'artifact-produced'
}

function terminalExecutionEventIds(events: readonly FoundryEventEnvelope[]): string[] {
  return events.filter(event => event.type === 'execution-terminal').map(event => event.eventId)
}

function compareFindings(left: ConformanceFinding, right: ConformanceFinding): number {
  const severityRank = { blocking: 0, warning: 1, info: 2 } as const
  return left.firstObservedAt - right.firstObservedAt
    || severityRank[left.severity] - severityRank[right.severity]
    || left.findingId.localeCompare(right.findingId)
}

function canonicalDetail(detail: NonNullable<ConformanceFinding['detail']>): NonNullable<ConformanceFinding['detail']> {
  return {
    ...(detail.expected === undefined ? {} : { expected: detail.expected }),
    ...(detail.actual === undefined ? {} : { actual: detail.actual }),
    ...(detail.dependencyTaskId === undefined ? {} : { dependencyTaskId: detail.dependencyTaskId }),
    ...(detail.verifierId === undefined ? {} : { verifierId: detail.verifierId }),
  }
}

function assertMatchingIdentity(contract: PlanContractV2, execution: PlanExecution): void {
  if (
    contract.parentSessionId !== execution.parentSessionId
    || contract.planId !== execution.planId
    || contract.revision !== execution.planRevision
    || contract.capabilityDigest !== execution.capabilityDigest
  ) throw new Error('plan contract and execution identities do not match')
}

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
