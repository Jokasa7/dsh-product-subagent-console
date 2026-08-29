import { buildConformanceReport, sha256 } from '../src/conformance.js'
import {
  projectPlanContractV2,
  type ConformanceReport,
  type EvidenceReceipt,
  type FoundryEventEnvelope,
} from '../src/foundry-types.js'
import type { AgentPlanRevision, PlanExecution } from '../src/plan-types.js'

export interface VerifiedRunFixture {
  readonly plan: AgentPlanRevision
  readonly execution: PlanExecution
  readonly events: readonly FoundryEventEnvelope[]
  readonly receipt: EvidenceReceipt
  readonly report: ConformanceReport
}

export function fixtureUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

export function verifiedRun(
  index: number,
  pattern: AgentPlanRevision['pattern'] = 'parallel-fanout-fanin',
): VerifiedRunFixture {
  const planId = fixtureUuid(index * 10 + 1)
  const executionId = fixtureUuid(index * 10 + 2)
  const attemptId = fixtureUuid(index * 10 + 3)
  const start = index * 1_000
  const plan: AgentPlanRevision = {
    schemaVersion: 1,
    planId,
    parentSessionId: 'parent-a',
    revision: 1,
    state: 'approved',
    createdAt: start,
    updatedAt: start + 1,
    capabilityDigest: 'capability-a',
    acceptedWarningIds: [],
    title: 'Verified repository review',
    objective: 'Review the same repository with the same acceptance criteria.',
    successCriteria: ['The report lifecycle verifier passes'],
    recommendation: {
      useMultiAgent: pattern !== 'single-agent',
      rationale: 'Fixture coordination.',
      userOverride: false,
    },
    pattern,
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 3, maxConcurrent: 2, planTimeoutMs: 60_000 },
    roles: [{
      roleId: 'worker',
      name: 'Worker',
      responsibility: 'Produce a bounded report.',
      boundaries: ['Do not write files'],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'review',
      title: 'Review',
      brief: 'Inspect the fixture and return a bounded report.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'One bounded report.' },
      completionCriteria: ['The report is returned'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
      effect: { kind: 'pure' },
      verifiers: [{
        verifierId: 'lifecycle-complete',
        kind: 'lifecycle',
        description: 'The authoritative attempt lifecycle completes.',
        required: true,
      }],
    }],
  }
  const execution: PlanExecution = {
    executionId,
    planId,
    planRevision: 1,
    parentSessionId: 'parent-a',
    backend: 'workflow',
    capabilityDigest: 'capability-a',
    status: 'succeeded',
    cancellationRequested: false,
    createdAt: start + 10,
    startedAt: start + 20,
    finishedAt: start + 120,
    bindings: [{
      planId,
      planRevision: 1,
      executionId,
      taskId: 'review',
      attemptId,
      attemptNumber: 1,
      status: 'completed',
      workflowSeq: 0,
      childId: `child-${String(index)}`,
      startedAt: start + 30,
      finishedAt: start + 110,
    }],
  }
  const cursorBase = index * 10
  const events = [
    event(cursorBase + 1, executionId, planId, 'execution-started', {
      executionStatus: 'running', observedAt: start + 20,
    }),
    event(cursorBase + 2, executionId, planId, 'attempt-started', {
      taskId: 'review', attemptId, attemptStatus: 'running', observedAt: start + 30,
    }),
    event(cursorBase + 3, executionId, planId, 'attempt-terminal', {
      taskId: 'review', attemptId, attemptStatus: 'completed', terminalReason: 'completed', observedAt: start + 110,
    }),
    event(cursorBase + 4, executionId, planId, 'execution-terminal', {
      executionStatus: 'succeeded', terminalReason: 'completed', observedAt: start + 120,
    }),
  ] as const
  const receipt: EvidenceReceipt = {
    schemaVersion: 1,
    receiptId: sha256(`${executionId}:receipt`),
    parentSessionId: 'parent-a',
    runId: executionId,
    planId,
    planRevision: 1,
    taskId: 'review',
    attemptId,
    verifierId: 'lifecycle-complete',
    verifierVersion: 'lifecycle-v1',
    verifierKind: 'lifecycle',
    claim: 'lifecycle-terminal',
    result: 'pass',
    authority: 'adapter',
    observedAt: start + 110,
    evidenceEventIds: [events[2].eventId],
    artifacts: [],
  }
  const report = buildConformanceReport({
    contract: projectPlanContractV2(plan),
    execution,
    events,
    receipts: [receipt],
    eventCursor: events[3].cursor,
    generatedAt: start + 120,
  })
  return { plan, execution, events, receipt, report }
}

/** Same terminal workload as verifiedRun, but with one additional materialized preparation Agent. */
export function verifiedMultiRun(index: number): VerifiedRunFixture {
  const source = verifiedRun(index, 'parallel-fanout-fanin')
  const executionId = source.execution.executionId
  const planId = source.plan.planId
  const start = index * 1_000
  const prepAttemptId = fixtureUuid(index * 10 + 4)
  const reviewTask = source.plan.tasks[0]!
  const plan: AgentPlanRevision = {
    ...source.plan,
    recommendation: { ...source.plan.recommendation, useMultiAgent: true },
    tasks: [{
      taskId: 'prepare',
      title: 'Prepare bounded context',
      brief: 'Collect only the bounded context required by the final review.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'Bounded review context.' },
      completionCriteria: ['The bounded context is returned'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
      effect: { kind: 'pure' },
      verifiers: [],
    }, {
      ...reviewTask,
      dependsOn: [{ taskId: 'prepare', mode: 'context' }],
    }],
  }
  const reviewBinding = source.execution.bindings[0]!
  const execution: PlanExecution = {
    ...source.execution,
    bindings: [{
      planId,
      planRevision: 1,
      executionId,
      taskId: 'prepare',
      attemptId: prepAttemptId,
      attemptNumber: 1,
      status: 'completed',
      workflowSeq: 0,
      childId: `child-${String(index)}-prepare`,
      startedAt: start + 25,
      finishedAt: start + 60,
    }, {
      ...reviewBinding,
      workflowSeq: 1,
      childId: `child-${String(index)}-review`,
      startedAt: start + 65,
    }],
  }
  const cursorBase = index * 10
  const events = [
    event(cursorBase + 1, executionId, planId, 'execution-started', {
      executionStatus: 'running', observedAt: start + 20,
    }),
    event(cursorBase + 2, executionId, planId, 'attempt-started', {
      taskId: 'prepare', attemptId: prepAttemptId, attemptStatus: 'running', observedAt: start + 25,
    }),
    event(cursorBase + 3, executionId, planId, 'attempt-terminal', {
      taskId: 'prepare', attemptId: prepAttemptId, attemptStatus: 'completed', terminalReason: 'completed', observedAt: start + 60,
    }),
    event(cursorBase + 4, executionId, planId, 'attempt-started', {
      taskId: 'review', attemptId: reviewBinding.attemptId, attemptStatus: 'running', observedAt: start + 65,
    }),
    event(cursorBase + 5, executionId, planId, 'attempt-terminal', {
      taskId: 'review', attemptId: reviewBinding.attemptId, attemptStatus: 'completed', terminalReason: 'completed', observedAt: start + 110,
    }),
    event(cursorBase + 6, executionId, planId, 'execution-terminal', {
      executionStatus: 'succeeded', terminalReason: 'completed', observedAt: start + 120,
    }),
  ] as const
  const receipt: EvidenceReceipt = {
    ...source.receipt,
    evidenceEventIds: [events[4].eventId],
  }
  const report = buildConformanceReport({
    contract: projectPlanContractV2(plan),
    execution,
    events,
    receipts: [receipt],
    eventCursor: events[5].cursor,
    generatedAt: start + 120,
  })
  return { plan, execution, events, receipt, report }
}

function event(
  cursor: number,
  runId: string,
  planId: string,
  type: FoundryEventEnvelope['type'],
  overrides: Partial<FoundryEventEnvelope>,
): FoundryEventEnvelope {
  const sourceEventId = `${runId}:${type}:${String(cursor)}`
  return {
    schemaVersion: 1,
    eventId: sha256(`fixture\u0000${sourceEventId}`),
    cursor,
    source: 'fixture',
    sourceEventId,
    parentSessionId: 'parent-a',
    runId,
    planId,
    planRevision: 1,
    type,
    authority: 'adapter',
    observedAt: cursor,
    causalParents: [],
    artifacts: [],
    ...overrides,
  }
}
