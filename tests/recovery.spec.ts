import { describe, expect, it } from 'vitest'
import { buildRecoveryProposal } from '../src/recovery.js'
import type { ConformanceReport, PlanContractV2 } from '../src/foundry-types.js'
import { sha256 } from '../src/conformance.js'
import type { PlanExecution } from '../src/plan-types.js'

const PLAN_ID = '00000000-0000-4000-8000-000000000011'
const EXECUTION_ID = '00000000-0000-4000-8000-000000000012'
const READ_ATTEMPT_ID = '00000000-0000-4000-8000-000000000013'

function contract(): PlanContractV2 {
  return {
    schemaVersion: 2,
    planId: PLAN_ID,
    revision: 2,
    parentSessionId: 'parent-a',
    title: 'Recovery plan',
    objective: 'Recover safely.',
    pattern: 'sequential-dag',
    capabilityDigest: 'capability-a',
    roles: [{ roleId: 'worker', name: 'Worker', transportProvider: 'spawn', toolPolicyMode: 'inherit' }],
    tasks: [{
      taskId: 'read',
      title: 'Read',
      roleId: 'worker',
      dependencies: [],
      expectedOutputDescription: 'Facts',
      completionCriteria: ['Facts exist'],
      resourceClaims: [],
      effect: { kind: 'pure' },
      verifiers: [],
    }, {
      taskId: 'write',
      title: 'Write',
      roleId: 'worker',
      dependencies: [{ taskId: 'read', mode: 'context' }],
      expectedOutputDescription: 'Change',
      completionCriteria: ['Change exists'],
      resourceClaims: ['src'],
      effect: { kind: 'unknown' },
      verifiers: [],
    }, {
      taskId: 'review',
      title: 'Review',
      roleId: 'worker',
      dependencies: [{ taskId: 'write', mode: 'context' }],
      expectedOutputDescription: 'Review',
      completionCriteria: ['Review exists'],
      resourceClaims: [],
      effect: { kind: 'pure' },
      verifiers: [],
    }],
  }
}

function execution(): PlanExecution {
  return {
    executionId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 2,
    parentSessionId: 'parent-a',
    backend: 'workflow',
    capabilityDigest: 'capability-a',
    status: 'failed',
    cancellationRequested: false,
    createdAt: 100,
    startedAt: 110,
    finishedAt: 500,
    bindings: [{
      planId: PLAN_ID,
      planRevision: 2,
      executionId: EXECUTION_ID,
      taskId: 'read',
      attemptId: READ_ATTEMPT_ID,
      attemptNumber: 1,
      status: 'completed',
      startedAt: 110,
      finishedAt: 200,
    }],
  }
}

function report(): ConformanceReport {
  const findingId = sha256('write-failed')
  return {
    schemaVersion: 1,
    parentSessionId: 'parent-a',
    runId: EXECUTION_ID,
    planId: PLAN_ID,
    planRevision: 2,
    eventCursor: 9,
    generatedAt: 500,
    state: 'deviated',
    firstProvableDivergenceId: findingId,
    tasks: [{
      taskId: 'read',
      state: 'confirmed',
      attemptId: READ_ATTEMPT_ID,
      lifecycleStatus: 'completed',
      evidenceStatus: 'not-required',
      findingIds: [],
    }, {
      taskId: 'write', state: 'deviated', evidenceStatus: 'unknown', findingIds: [findingId],
    }, {
      taskId: 'review', state: 'unknown', evidenceStatus: 'unknown', findingIds: [],
    }],
    findings: [{
      schemaVersion: 1,
      findingId,
      code: 'lifecycle-incomplete',
      status: 'open',
      severity: 'blocking',
      certainty: 'proven',
      parentSessionId: 'parent-a',
      runId: EXECUTION_ID,
      planId: PLAN_ID,
      planRevision: 2,
      taskId: 'write',
      firstObservedAt: 400,
      evidenceEventIds: [],
    }],
  }
}

describe('Recovery Preview', () => {
  it('propagates the affected closure and fails closed for unknown effects', () => {
    const proposal = buildRecoveryProposal({
      contract: contract(),
      execution: execution(),
      report: report(),
      capabilityDigest: 'capability-a',
      now: 1_000,
      ttlMs: 5_000,
      controlSupport: { retry: 'unsupported', fork: 'unsupported' },
    })
    expect(proposal).toMatchObject({
      eventCursor: 9,
      affectedTaskIds: ['review', 'write'],
      reusableTaskIds: ['read'],
      requiresApproval: true,
      createdAt: 0,
      expiresAt: 5_000,
    })
    expect(proposal.actions).toEqual([
      expect.objectContaining({
        taskId: 'review', effectSafe: true, backendExecutable: false,
        allowed: false, reasonCode: 'backend-unsupported',
      }),
      expect.objectContaining({ taskId: 'write', allowed: false, reasonCode: 'unknown-effect' }),
    ])
    expect(proposal.blockedReasonCodes).toEqual(['backend-unsupported', 'unknown-effect'])
  })

  it('rotates immutable proposal identities at TTL windows and enables only enforced safe actions', () => {
    const first = buildRecoveryProposal({
      contract: contract(), execution: execution(), report: report(),
      capabilityDigest: 'capability-a', now: 4_999, ttlMs: 5_000,
      controlSupport: { retry: 'enforced', fork: 'unsupported' },
    })
    const next = buildRecoveryProposal({
      contract: contract(), execution: execution(), report: report(),
      capabilityDigest: 'capability-a', now: 5_000, ttlMs: 5_000,
      controlSupport: { retry: 'enforced', fork: 'unsupported' },
    })
    expect(first.proposalId).not.toBe(next.proposalId)
    expect(first.expiresAt).toBe(5_000)
    expect(next.createdAt).toBe(5_000)
    expect(first.actions.find(action => action.taskId === 'review')).toMatchObject({
      effectSafe: true, backendExecutable: true, allowed: true,
    })

    const noReuseReport = report()
    noReuseReport.tasks = noReuseReport.tasks.map(task => task.taskId === 'read'
      ? { ...task, evidenceStatus: 'unknown' as const }
      : task)
    const noReuse = buildRecoveryProposal({
      contract: contract(), execution: execution(), report: noReuseReport,
      capabilityDigest: 'capability-a', now: 4_999, ttlMs: 5_000,
      controlSupport: { retry: 'enforced', fork: 'unsupported' },
    })
    expect(noReuse.reusableTaskIds).not.toEqual(first.reusableTaskIds)
    expect(noReuse.proposalId).not.toBe(first.proposalId)
  })

  it('never marks a queued or running task as reusable even when its report has no deviation', () => {
    const activeExecution = execution()
    activeExecution.status = 'running'
    activeExecution.finishedAt = undefined
    activeExecution.bindings = activeExecution.bindings.map(binding => ({
      ...binding,
      status: 'running',
      finishedAt: undefined,
    }))
    const activeReport = report()
    activeReport.tasks = activeReport.tasks.map(task => task.taskId === 'read'
      ? { ...task, lifecycleStatus: 'running' }
      : task)

    const proposal = buildRecoveryProposal({
      contract: contract(), execution: activeExecution, report: activeReport,
      capabilityDigest: 'capability-a',
    })
    expect(proposal.reusableTaskIds).not.toContain('read')
  })

  it('rejects mismatched run identities', () => {
    const mismatched = report()
    mismatched.runId = 'another-run'
    expect(() => buildRecoveryProposal({
      contract: contract(),
      execution: execution(),
      report: mismatched,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')

    const wrongParent = report()
    wrongParent.parentSessionId = 'another-parent'
    expect(() => buildRecoveryProposal({
      contract: contract(), execution: execution(), report: wrongParent,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')

    const foreignFinding = report()
    foreignFinding.findings = foreignFinding.findings.map(finding => ({
      ...finding, parentSessionId: 'another-parent',
    }))
    expect(() => buildRecoveryProposal({
      contract: contract(), execution: execution(), report: foreignFinding,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')
  })

  it('rejects malformed report task and finding relationships', () => {
    const duplicateTask = report()
    duplicateTask.tasks = [...duplicateTask.tasks, duplicateTask.tasks[0]!]
    expect(() => buildRecoveryProposal({
      contract: contract(), execution: execution(), report: duplicateTask,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')

    const wrongAttempt = report()
    wrongAttempt.tasks = wrongAttempt.tasks.map(task => task.taskId === 'read'
      ? { ...task, attemptId: '00000000-0000-4000-8000-000000000099' }
      : task)
    expect(() => buildRecoveryProposal({
      contract: contract(), execution: execution(), report: wrongAttempt,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')

    const danglingFinding = report()
    danglingFinding.tasks = danglingFinding.tasks.map(task => task.taskId === 'read'
      ? { ...task, findingIds: [sha256('missing-finding')] }
      : task)
    expect(() => buildRecoveryProposal({
      contract: contract(), execution: execution(), report: danglingFinding,
      capabilityDigest: 'capability-a',
    })).toThrow('same run')
  })

  it('does not reuse a verifier-gated task without closed authoritative evidence', () => {
    const guardedContract = contract()
    guardedContract.tasks = guardedContract.tasks.map(task => task.taskId === 'read'
      ? {
          ...task,
          verifiers: [{
            verifierId: 'lifecycle-complete',
            kind: 'lifecycle' as const,
            description: 'The attempt must terminate.',
            required: true,
          }],
        }
      : task)
    const claimed = report()
    claimed.tasks = claimed.tasks.map(task => task.taskId === 'read'
      ? { ...task, evidenceStatus: 'verified' as const }
      : task)
    const proposal = buildRecoveryProposal({
      contract: guardedContract,
      execution: execution(),
      report: claimed,
      capabilityDigest: 'capability-a',
    })
    expect(proposal.reusableTaskIds).not.toContain('read')
  })
})
