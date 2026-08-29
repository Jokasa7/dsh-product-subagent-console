import {
  recoveryProposalSchema,
  type ConformanceReport,
  type EvidenceReceipt,
  type FoundryEventEnvelope,
  type PlanContractV2,
  type RecoveryAction,
  type RecoveryProposal,
} from './foundry-types.js'
import type { PlanExecution } from './plan-types.js'
import { sha256 } from './conformance.js'

export interface BuildRecoveryProposalInput {
  readonly contract: PlanContractV2
  readonly execution: PlanExecution
  readonly report: ConformanceReport
  readonly events?: readonly FoundryEventEnvelope[]
  readonly receipts?: readonly EvidenceReceipt[]
  readonly capabilityDigest: string
  readonly now?: number
  readonly ttlMs?: number
  readonly controlSupport?: Readonly<{
    retry: 'enforced' | 'advisory' | 'unsupported' | 'unknown'
    fork: 'enforced' | 'advisory' | 'unsupported' | 'unknown'
  }>
}

/** Build an immutable preview. This function never performs a runtime action. */
export function buildRecoveryProposal(input: BuildRecoveryProposalInput): RecoveryProposal {
  assertMatchingIdentity(input)
  const affected = affectedClosure(input.contract, input.report)
  const reportByTask = new Map(input.report.tasks.map(task => [task.taskId, task] as const))
  const contractByTask = new Map(input.contract.tasks.map(task => [task.taskId, task] as const))
  const bindingByTaskAttempt = new Map(input.execution.bindings.map(binding => [
    recoveryTaskAttemptKey(binding.taskId, binding.attemptId),
    binding,
  ] as const))
  const exactEventsById = new Map((input.events ?? []).filter(event => (
    event.parentSessionId === input.execution.parentSessionId
    && event.runId === input.execution.executionId
    && event.planId === input.execution.planId
    && event.planRevision === input.execution.planRevision
    && event.cursor <= input.report.eventCursor
  )).map(event => [event.eventId, event] as const))
  const verifiedReceiptClaims = new Map<string, Set<EvidenceReceipt['claim']>>()
  for (const receipt of input.receipts ?? []) {
    if (
      receipt.parentSessionId !== input.execution.parentSessionId
      || receipt.runId !== input.execution.executionId
      || receipt.planId !== input.execution.planId
      || receipt.planRevision !== input.execution.planRevision
      || receipt.result !== 'pass'
      || receipt.authority === 'model-claim'
      || !receipt.evidenceEventIds.every((eventId) => {
        const event = exactEventsById.get(eventId)
        return event?.taskId === receipt.taskId && event.attemptId === receipt.attemptId
      })
    ) continue
    const key = recoveryReceiptKey(
      receipt.taskId,
      receipt.attemptId,
      receipt.verifierId,
      receipt.verifierKind,
    )
    const claims = verifiedReceiptClaims.get(key) ?? new Set<EvidenceReceipt['claim']>()
    claims.add(receipt.claim)
    verifiedReceiptClaims.set(key, claims)
  }
  const reusable = input.contract.tasks
    .filter(task => !affected.has(task.taskId))
    .filter(task => {
      const report = reportByTask.get(task.taskId)
      const contractTask = contractByTask.get(task.taskId)
      const binding = report?.attemptId === undefined
        ? undefined
        : bindingByTaskAttempt.get(recoveryTaskAttemptKey(task.taskId, report.attemptId))
      if (
        report?.state !== 'confirmed'
        || report.lifecycleStatus !== 'completed'
        || report.attemptId === undefined
        || binding?.status !== 'completed'
        || contractTask === undefined
      ) return false
      const requiredVerifiers = contractTask.verifiers.filter(verifier => verifier.required)
      if (requiredVerifiers.length === 0) return report.evidenceStatus === 'not-required'
      if (report.evidenceStatus !== 'verified') return false
      return requiredVerifiers.every((verifier) => {
        const claims = verifiedReceiptClaims.get(recoveryReceiptKey(
          task.taskId,
          report.attemptId as string,
          verifier.verifierId,
          verifier.kind,
        ))
        return claims !== undefined && [...claims].some(claim => recoveryReceiptClaimMatches(claim, verifier.kind))
      })
    })
    .map(task => task.taskId)
    .sort()
  const actions = [...affected]
    .sort()
    .map(taskId => recoveryAction(input.contract, taskId, input.execution, input.controlSupport))
  const blockedReasonCodes = [...new Set(actions.filter(action => !action.allowed).map(action => action.reasonCode))].sort()
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 10 * 60_000
  const createdAt = Math.floor(now / ttlMs) * ttlMs
  const expiresAt = createdAt + ttlMs
  const divergenceIds = input.report.findings
    .filter(finding => finding.status === 'open')
    .map(finding => finding.findingId)
    .sort()
  const identity = JSON.stringify({
    parentSessionId: input.contract.parentSessionId,
    runId: input.execution.executionId,
    planId: input.contract.planId,
    planRevision: input.contract.revision,
    capabilityDigest: input.capabilityDigest,
    eventCursor: input.report.eventCursor,
    divergenceIds,
    affectedTaskIds: [...affected].sort(),
    reusableTaskIds: reusable,
    actions,
    createdAt,
    expiresAt,
  })
  return recoveryProposalSchema.parse({
    schemaVersion: 1,
    proposalId: sha256(identity),
    parentSessionId: input.contract.parentSessionId,
    runId: input.execution.executionId,
    planId: input.contract.planId,
    planRevision: input.contract.revision,
    capabilityDigest: input.capabilityDigest,
    eventCursor: input.report.eventCursor,
    createdAt,
    expiresAt,
    divergenceIds,
    affectedTaskIds: [...affected].sort(),
    reusableTaskIds: reusable,
    actions,
    blockedReasonCodes,
    requiresApproval: true,
  })
}

function recoveryTaskAttemptKey(taskId: string, attemptId: string): string {
  return `${taskId}\u0000${attemptId}`
}

function recoveryReceiptKey(
  taskId: string,
  attemptId: string,
  verifierId: string,
  verifierKind: EvidenceReceipt['verifierKind'],
): string {
  return `${taskId}\u0000${attemptId}\u0000${verifierId}\u0000${verifierKind}`
}

function affectedClosure(contract: PlanContractV2, report: ConformanceReport): Set<string> {
  const knownTasks = new Set(contract.tasks.map(task => task.taskId))
  const affected = new Set(report.findings
    .filter(finding => finding.status === 'open' && finding.taskId !== undefined && knownTasks.has(finding.taskId))
    .map(finding => finding.taskId as string))
  let changed = true
  while (changed) {
    changed = false
    for (const task of contract.tasks) {
      if (affected.has(task.taskId)) continue
      if (task.dependencies.some(dependency => affected.has(dependency.taskId))) {
        affected.add(task.taskId)
        changed = true
      }
    }
  }
  return affected
}

function recoveryAction(
  contract: PlanContractV2,
  taskId: string,
  execution: PlanExecution,
  controlSupport: BuildRecoveryProposalInput['controlSupport'],
): RecoveryAction {
  const task = contract.tasks.find(candidate => candidate.taskId === taskId)
  if (task === undefined) throw new Error(`recovery task ${taskId} is absent from the plan contract`)
  const binding = execution.bindings.find(candidate => candidate.taskId === taskId)
  const actionId = sha256([execution.executionId, taskId, 'retry', task.effect.kind].join('\u0000'))
  const withBackend = (
    kind: RecoveryAction['kind'],
    effectSafe: boolean,
    effectReason: RecoveryAction['reasonCode'],
  ): RecoveryAction => {
    const support = kind === 'fork'
      ? controlSupport?.fork ?? 'unsupported'
      : controlSupport?.retry ?? 'unsupported'
    const backendExecutable = support === 'enforced'
    return {
      actionId,
      kind,
      taskId,
      effectSafe,
      backendExecutable,
      support,
      allowed: effectSafe && backendExecutable,
      requiresApproval: true,
      reasonCode: !effectSafe ? effectReason : backendExecutable ? 'supported-read-only' : 'backend-unsupported',
    }
  }
  if (task.effect.kind === 'pure') {
    return withBackend('retry', true, 'supported-read-only')
  }
  if (task.effect.kind === 'idempotent') {
    return withBackend('retry', task.effect.idempotencyScope !== undefined, 'idempotency-required')
  }
  if (task.effect.kind === 'compensatable') {
    return withBackend(binding === undefined ? 'retry' : 'fork', false, 'compensation-required')
  }
  if (task.effect.kind === 'irreversible') {
    return withBackend('fork', false, 'irreversible-effect')
  }
  return withBackend('retry', false, 'unknown-effect')
}

function assertMatchingIdentity(input: BuildRecoveryProposalInput): void {
  const contractTaskIds = new Set(input.contract.tasks.map(task => task.taskId))
  const findingById = new Map(input.report.findings.map(finding => [finding.findingId, finding] as const))
  const reportTaskIds = new Set<string>()
  const invalidReportTask = input.report.tasks.some((task) => {
    if (reportTaskIds.has(task.taskId) || !contractTaskIds.has(task.taskId)) return true
    reportTaskIds.add(task.taskId)
    if (task.attemptId !== undefined && !input.execution.bindings.some(binding => (
      binding.taskId === task.taskId && binding.attemptId === task.attemptId
    ))) return true
    return task.findingIds.some((findingId) => {
      const finding = findingById.get(findingId)
      return finding === undefined || finding.taskId !== task.taskId
    })
  })
  if (
    input.contract.parentSessionId !== input.execution.parentSessionId
    || input.report.parentSessionId !== input.contract.parentSessionId
    || input.contract.planId !== input.execution.planId
    || input.contract.revision !== input.execution.planRevision
    || input.report.runId !== input.execution.executionId
    || input.report.planId !== input.contract.planId
    || input.report.planRevision !== input.contract.revision
    || input.capabilityDigest !== input.contract.capabilityDigest
    || input.capabilityDigest !== input.execution.capabilityDigest
    || findingById.size !== input.report.findings.length
    || invalidReportTask
    || reportTaskIds.size !== contractTaskIds.size
    || (input.report.firstProvableDivergenceId !== undefined && !findingById.has(input.report.firstProvableDivergenceId))
    || input.report.findings.some(finding => (
      finding.parentSessionId !== input.execution.parentSessionId
      || finding.runId !== input.execution.executionId
      || finding.planId !== input.execution.planId
      || finding.planRevision !== input.execution.planRevision
      || (finding.taskId !== undefined && !contractTaskIds.has(finding.taskId))
      || (finding.attemptId !== undefined && !input.execution.bindings.some(binding => (
        binding.attemptId === finding.attemptId
        && (finding.taskId === undefined || binding.taskId === finding.taskId)
      )))
    ))
  ) throw new Error('recovery inputs do not describe the same run')
}

function recoveryReceiptClaimMatches(
  claim: EvidenceReceipt['claim'],
  kind: PlanContractV2['tasks'][number]['verifiers'][number]['kind'],
): boolean {
  if (kind === 'lifecycle') return claim === 'lifecycle-terminal'
  if (kind === 'manual') return claim === 'manual-accepted'
  return claim === 'criteria-satisfied' || claim === 'artifact-produced'
}
