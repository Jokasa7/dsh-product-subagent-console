import { describe, expect, it } from 'vitest'
import { buildConformanceReport, sha256 } from '../src/conformance.js'
import { buildRecoveryProposal } from '../src/recovery.js'
import {
  projectPlanContractV2,
  type EvidenceReceipt,
  type FoundryEventEnvelope,
} from '../src/foundry-types.js'
import type { AgentPlanRevision, PlanExecution } from '../src/plan-types.js'

const PLAN_ID = '00000000-0000-4000-8000-000000000001'
const EXECUTION_ID = '00000000-0000-4000-8000-000000000002'
const ATTEMPT_A = '00000000-0000-4000-8000-000000000003'
const ATTEMPT_B = '00000000-0000-4000-8000-000000000004'
const ATTEMPT_RETRY = '00000000-0000-4000-8000-000000000005'

function plan(): AgentPlanRevision {
  return {
    schemaVersion: 1,
    planId: PLAN_ID,
    parentSessionId: 'parent-a',
    revision: 1,
    state: 'approved',
    createdAt: 100,
    updatedAt: 110,
    capabilityDigest: 'capability-a',
    acceptedWarningIds: [],
    title: 'Review repository',
    objective: 'Review a repository with evidence.',
    successCriteria: ['The review is verified'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'Independent checks can run concurrently.',
      userOverride: false,
    },
    pattern: 'sequential-dag',
    optimizationTarget: 'quality',
    backendPreference: 'workflow',
    budget: { maxAgents: 2, maxConcurrent: 2, planTimeoutMs: 60_000 },
    roles: [{
      roleId: 'worker',
      name: 'Worker',
      responsibility: 'Inspect facts.',
      boundaries: [],
      transportProvider: 'spawn',
      llmProvider: 'openai',
      model: 'codex',
      reasoningEffort: 'high',
      contextMode: 'fresh',
      toolPolicy: { mode: 'allowlist', tools: ['read'] },
    }],
    tasks: [{
      taskId: 'task-a',
      title: 'Inspect',
      brief: 'Inspect source files.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'A factual report.' },
      completionCriteria: ['Report exists'],
      resourceClaims: ['src'],
      risk: 'low',
      approvalRequired: false,
      effect: { kind: 'pure' },
      verifiers: [{ verifierId: 'report-test', kind: 'test', description: 'Check report.', required: true }],
    }, {
      taskId: 'task-b',
      title: 'Summarize',
      brief: 'Summarize the report.',
      roleId: 'worker',
      dependsOn: [{ taskId: 'task-a', mode: 'context' }],
      expectedOutput: { description: 'A verified summary.' },
      completionCriteria: ['Summary exists'],
      resourceClaims: ['docs'],
      risk: 'low',
      approvalRequired: false,
      effect: { kind: 'unknown' },
      verifiers: [],
    }],
  }
}

function execution(status: PlanExecution['status'] = 'running'): PlanExecution {
  return {
    executionId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 1,
    parentSessionId: 'parent-a',
    backend: 'workflow',
    capabilityDigest: 'capability-a',
    status,
    cancellationRequested: false,
    createdAt: 200,
    startedAt: 210,
    ...(status === 'running' ? {} : { finishedAt: 500 }),
    bindings: [],
  }
}

function event(
  cursor: number,
  type: FoundryEventEnvelope['type'],
  options: Partial<FoundryEventEnvelope> = {},
): FoundryEventEnvelope {
  const sourceEventId = `${type}:${String(cursor)}`
  return {
    schemaVersion: 1,
    eventId: sha256(`test\u0000${sourceEventId}`),
    cursor,
    source: 'test',
    sourceEventId,
    parentSessionId: 'parent-a',
    runId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 1,
    type,
    authority: 'adapter',
    observedAt: 200 + cursor,
    causalParents: [],
    artifacts: [],
    ...options,
  }
}

function receipt(
  result: EvidenceReceipt['result'],
  evidenceEventId: EvidenceReceipt['evidenceEventIds'][number] = sha256('task-a-terminal'),
): EvidenceReceipt {
  return {
    schemaVersion: 1,
    receiptId: sha256(`receipt:${result}`),
    parentSessionId: 'parent-a',
    runId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 1,
    taskId: 'task-a',
    attemptId: ATTEMPT_A,
    verifierId: 'report-test',
    verifierVersion: '1',
    verifierKind: 'test',
    claim: 'criteria-satisfied',
    result,
    authority: 'verifier',
    observedAt: 450,
    evidenceEventIds: [evidenceEventId],
    artifacts: [],
  }
}

describe('Plan Contract V2 projection', () => {
  it('adds explicit truth and recovery contracts without exposing task briefs', () => {
    const contract = projectPlanContractV2(plan())
    expect(contract).toMatchObject({
      schemaVersion: 2,
      capabilityDigest: 'capability-a',
      roles: [{ reasoningEffort: 'high', toolPolicyMode: 'allowlist' }],
    })
    expect(contract.tasks[0]).toMatchObject({ effect: { kind: 'pure' }, verifiers: [{ verifierId: 'report-test' }] })
    expect(contract.tasks[1]).toMatchObject({ effect: { kind: 'unknown' }, verifiers: [] })
    expect(contract.tasks[0]).not.toHaveProperty('brief')
  })
})

describe('conformance report', () => {
  it('rejects an execution captured against a different capability contract', () => {
    expect(() => buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: { ...execution('running'), capabilityDigest: 'capability-b' },
      events: [],
      receipts: [],
      generatedAt: 300,
    })).toThrow('identities do not match')
  })

  it('does not invent missing tasks before the execution reaches a terminal state', () => {
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: execution('running'),
      events: [],
      receipts: [],
      generatedAt: 300,
    })
    expect(report.state).toBe('unknown')
    expect(report.findings).toEqual([])
    expect(report.tasks.every(task => task.state === 'unknown')).toBe(true)
  })

  it('reports missing planned work only after a factual terminal execution event', () => {
    const terminal = event(1, 'execution-terminal', { executionStatus: 'failed' })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: execution('failed'),
      events: [terminal],
      receipts: [],
      generatedAt: 501,
    })
    expect(report.state).toBe('deviated')
    expect(report.findings.map(finding => finding.code)).toEqual(['missing-planned', 'missing-planned'])
    expect(report.firstProvableDivergenceId).toBe(report.findings[0]?.findingId)
    expect(report.findings[0]?.evidenceEventIds).toEqual([terminal.eventId])
  })

  it('anchors a terminal execution fact to an incomplete task lifecycle finding', () => {
    const current = execution('failed')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'running',
      startedAt: 250,
    }]
    const started = event(1, 'attempt-started', { taskId: 'task-a', attemptId: ATTEMPT_A })
    const terminal = event(2, 'execution-terminal', { executionStatus: 'failed' })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events: [started, terminal],
      receipts: [],
      generatedAt: 501,
    })

    const finding = report.findings.find(item => item.code === 'lifecycle-incomplete')
    expect(finding?.certainty).toBe('proven')
    expect(finding?.evidenceEventIds).toEqual([terminal.eventId])
  })

  it.each(['failed', 'cancelled', 'rejected'] as const)(
    'turns a terminal %s attempt into a proven recovery target',
    (status) => {
      const current = execution('failed')
      current.bindings = [{
        planId: PLAN_ID,
        planRevision: 1,
        executionId: EXECUTION_ID,
        taskId: 'task-a',
        attemptId: ATTEMPT_A,
        attemptNumber: 1,
        status,
        startedAt: 250,
        finishedAt: 350,
      }, {
        planId: PLAN_ID,
        planRevision: 1,
        executionId: EXECUTION_ID,
        taskId: 'task-b',
        attemptId: ATTEMPT_B,
        attemptNumber: 1,
        status: 'completed',
        startedAt: 360,
        finishedAt: 480,
      }]
      const failedAttempt = event(1, 'attempt-terminal', {
        taskId: 'task-a',
        attemptId: ATTEMPT_A,
        attemptStatus: status,
        terminalReason: status,
      })
      const completedAttempt = event(2, 'attempt-terminal', {
        taskId: 'task-b', attemptId: ATTEMPT_B, attemptStatus: 'completed', terminalReason: 'completed',
      })
      const terminal = event(3, 'execution-terminal', { executionStatus: 'failed', terminalReason: 'failed' })
      const contract = projectPlanContractV2(plan())
      const report = buildConformanceReport({
        contract,
        execution: current,
        events: [failedAttempt, completedAttempt, terminal],
        receipts: [],
        generatedAt: 500,
      })

      expect(report.state).toBe('deviated')
      expect(report.firstProvableDivergenceId).toBeDefined()
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'attempt-unsuccessful',
          taskId: 'task-a',
          attemptId: ATTEMPT_A,
          certainty: 'proven',
          evidenceEventIds: [failedAttempt.eventId],
        }),
      ]))
      const proposal = buildRecoveryProposal({
        contract,
        execution: current,
        report,
        events: [failedAttempt, completedAttempt, terminal],
        receipts: [],
        capabilityDigest: current.capabilityDigest,
        now: 1_000,
      })
      expect(proposal.affectedTaskIds).toEqual(['task-a', 'task-b'])
    },
  )

  it('separates lifecycle completion from verifier-backed evidence', () => {
    const current = execution('succeeded')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 250,
      finishedAt: 400,
    }, {
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-b',
      attemptId: ATTEMPT_B,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 410,
      finishedAt: 480,
    }]
    const events = [
      event(1, 'attempt-started', { taskId: 'task-a', attemptId: ATTEMPT_A }),
      event(2, 'attempt-terminal', { taskId: 'task-a', attemptId: ATTEMPT_A, attemptStatus: 'completed' }),
      event(3, 'attempt-started', { taskId: 'task-b', attemptId: ATTEMPT_B }),
      event(4, 'execution-terminal', { executionStatus: 'succeeded' }),
    ]
    const missing = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events,
      receipts: [],
      generatedAt: 500,
    })
    expect(missing.findings.map(finding => finding.code)).toContain('evidence-missing')
    expect(missing.tasks.find(task => task.taskId === 'task-a')?.evidenceStatus).toBe('missing')

    const verified = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events,
      receipts: [receipt('pass', events[1]!.eventId)],
      generatedAt: 500,
    })
    expect(verified.findings).toEqual([])
    expect(verified.state).toBe('confirmed')
    expect(verified.tasks.find(task => task.taskId === 'task-a')?.evidenceStatus).toBe('verified')
  })

  it('rejects receipts with the wrong verifier kind, claim, or historical evidence cursor', () => {
    const current = execution('succeeded')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 250,
      finishedAt: 400,
    }, {
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-b',
      attemptId: ATTEMPT_B,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 410,
      finishedAt: 480,
    }]
    const terminal = event(1, 'attempt-terminal', {
      taskId: 'task-a', attemptId: ATTEMPT_A, attemptStatus: 'completed',
    })
    const later = event(2, 'evidence-recorded', { taskId: 'task-a', attemptId: ATTEMPT_A })
    const otherTask = event(3, 'attempt-terminal', {
      taskId: 'task-b', attemptId: ATTEMPT_B, attemptStatus: 'completed',
    })
    const base = receipt('pass', terminal.eventId)

    for (const invalid of [
      { ...base, verifierKind: 'manual' as const, claim: 'manual-accepted' as const },
      { ...base, claim: 'lifecycle-terminal' as const },
      { ...base, evidenceEventIds: [later.eventId] },
      { ...base, evidenceEventIds: [otherTask.eventId] },
    ]) {
      const report = buildConformanceReport({
        contract: projectPlanContractV2(plan()),
        execution: current,
        events: [terminal, later, otherTask],
        eventCursor: invalid.evidenceEventIds[0] === later.eventId ? 1 : 3,
        receipts: [invalid],
        generatedAt: 500,
      })
      expect(report.tasks.find(task => task.taskId === 'task-a')?.evidenceStatus).toBe('missing')
      expect(report.findings.map(finding => finding.code)).toContain('evidence-missing')
    }
  })

  it('does not let a previous retry receipt verify the current task attempt', () => {
    const current = execution('succeeded')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 220,
      finishedAt: 300,
    }, {
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_RETRY,
      attemptNumber: 2,
      retryOf: ATTEMPT_A,
      status: 'completed',
      startedAt: 310,
      finishedAt: 400,
    }, {
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-b',
      attemptId: ATTEMPT_B,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 410,
      finishedAt: 480,
    }]
    const oldTerminal = event(1, 'attempt-terminal', {
      taskId: 'task-a', attemptId: ATTEMPT_A, attemptStatus: 'completed',
    })
    const currentTerminal = event(2, 'attempt-terminal', {
      taskId: 'task-a', attemptId: ATTEMPT_RETRY, attemptStatus: 'completed',
    })
    const runTerminal = event(3, 'execution-terminal', { executionStatus: 'succeeded' })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events: [oldTerminal, currentTerminal, runTerminal],
      receipts: [receipt('pass', oldTerminal.eventId)],
      generatedAt: 500,
    })

    expect(report.tasks.find(task => task.taskId === 'task-a')).toMatchObject({
      attemptId: ATTEMPT_RETRY,
      evidenceStatus: 'missing',
    })
    expect(report.findings.map(finding => finding.code)).toContain('evidence-missing')
  })

  it('finds order and configuration deviations while preserving source evidence', () => {
    const current = execution('running')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'running',
      startedAt: 300,
    }, {
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-b',
      attemptId: ATTEMPT_B,
      attemptNumber: 1,
      status: 'running',
      startedAt: 250,
    }]
    const driftEvent = event(2, 'attempt-started', {
      taskId: 'task-b',
      attemptId: ATTEMPT_B,
      configuration: { transportProvider: 'spawn', llmProvider: 'openai', model: 'other-model' },
    })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events: [driftEvent],
      receipts: [],
      generatedAt: 400,
    })
    expect(report.findings.map(finding => finding.code)).toEqual(['configuration-drift', 'order-violation'])
    expect(report.findings[0]?.evidenceEventIds).toEqual([driftEvent.eventId])
    expect(report.firstProvableDivergenceId).toBe(report.findings[0]?.findingId)
  })

  it('keeps unbound official child events visible instead of guessing a task', () => {
    const child = event(1, 'child-published', { attemptId: 'native-child-a', authority: 'dsh' })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: execution('running'),
      events: [child],
      receipts: [],
      generatedAt: 300,
    })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ code: 'unbound-actual', certainty: 'proven' })
  })

  it('ignores events from another plan revision or an unrelated task attempt', () => {
    const current = execution('running')
    current.bindings = [{
      planId: PLAN_ID,
      planRevision: 1,
      executionId: EXECUTION_ID,
      taskId: 'task-a',
      attemptId: ATTEMPT_A,
      attemptNumber: 1,
      status: 'running',
      startedAt: 250,
    }]
    const foreignRevision = event(1, 'execution-terminal', {
      planRevision: 2,
      executionStatus: 'failed',
    })
    const foreignAttempt = event(2, 'attempt-started', {
      taskId: 'task-b',
      attemptId: ATTEMPT_A,
      configuration: { transportProvider: 'spawn', model: 'foreign-model' },
    })
    const report = buildConformanceReport({
      contract: projectPlanContractV2(plan()),
      execution: current,
      events: [foreignRevision, foreignAttempt],
      receipts: [],
      generatedAt: 400,
    })
    expect(report.eventCursor).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.state).toBe('unknown')
  })
})
