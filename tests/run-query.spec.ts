import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/conformance.js'
import { buildRunQuery } from '../src/run-query.js'
import { buildRecoveryProposal } from '../src/recovery.js'
import { projectPlanContractV2, type RunQueryKind } from '../src/foundry-types.js'
import { verifiedRun } from './foundry-fixtures.js'

describe('Ask the Run factual query builder', () => {
  it('answers every supported query kind without invoking or inventing a model hypothesis', () => {
    const source = verifiedRun(1)
    const configurationEvent = {
      ...source.events[1]!,
      configuration: { transportProvider: 'spawn', reasoningEffort: 'unknown' as const },
    }
    const events = [source.events[0]!, configurationEvent, ...source.events.slice(2)]
    const proposal = buildRecoveryProposal({
      contract: projectPlanContractV2(source.plan),
      execution: source.execution,
      report: source.report,
      capabilityDigest: source.execution.capabilityDigest,
      now: source.execution.finishedAt ?? 10_000,
      controlSupport: { retry: 'unsupported', fork: 'unsupported' },
    })
    const kinds: readonly RunQueryKind[] = [
      'summary', 'why-running', 'first-divergence', 'active-tasks',
      'configuration', 'cancel-impact', 'recovery-impact', 'evidence',
    ]

    for (const kind of kinds) {
      const result = buildRunQuery({
        request: {
          parentSessionId: source.execution.parentSessionId,
          runId: source.execution.executionId,
          kind,
        },
        execution: source.execution,
        report: source.report,
        proposal,
        events,
        receipts: [source.receipt],
      })
      expect(result.kind).toBe(kind)
      expect(result.hypotheses).toEqual([])
      expect(result.facts.every(fact => fact.factId.startsWith('sha256:'))).toBe(true)
      expect(['facts-available', 'insufficient-evidence']).toContain(result.answerCode)
    }
  })

  it('honors the event cursor for evidence and returns a bounded missing-run result', () => {
    const source = verifiedRun(2)
    const beforeEvidence = source.events[1]!.cursor
    const historical = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'evidence',
        throughCursor: beforeEvidence,
      },
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [source.receipt],
    })
    expect(historical.answerCode).toBe('insufficient-evidence')
    expect(historical.facts).toEqual([])

    const missing = buildRunQuery({
      request: { parentSessionId: 'parent-a', runId: 'missing-run', kind: 'summary' },
      events: source.events,
      receipts: [source.receipt],
    })
    expect(missing).toMatchObject({ answerCode: 'run-not-found', facts: [], hypotheses: [] })
  })

  it('rejects receipts whose Evidence Event does not close over the same task attempt', () => {
    const source = verifiedRun(5)
    const evidenceEventId = source.receipt.evidenceEventIds[0]!
    const events = source.events.map(event => event.eventId === evidenceEventId
      ? { ...event, taskId: 'foreign-task' }
      : event)
    const result = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'evidence',
      },
      execution: source.execution,
      report: source.report,
      events,
      receipts: [source.receipt],
    })

    expect(result).toMatchObject({ answerCode: 'insufficient-evidence', facts: [] })
  })

  it('does not include same-run events from another plan revision or task in factual answers', () => {
    const source = verifiedRun(6)
    const last = source.events.at(-1)!
    const foreignRevision = {
      ...source.events[1]!,
      eventId: sha256('foreign-query-revision'),
      sourceEventId: 'foreign-query-revision',
      cursor: last.cursor + 1,
      planRevision: source.execution.planRevision + 1,
      configuration: { transportProvider: 'spawn', model: 'foreign-model' },
    }
    const foreignTask = {
      ...source.events[1]!,
      eventId: sha256('foreign-query-task'),
      sourceEventId: 'foreign-query-task',
      cursor: last.cursor + 2,
      taskId: 'foreign-task',
      attemptId: undefined,
      configuration: { transportProvider: 'spawn', model: 'foreign-task-model' },
    }
    const events = [...source.events, foreignRevision, foreignTask]
    const configuration = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'configuration',
      },
      execution: source.execution,
      report: source.report,
      events,
      receipts: [source.receipt],
    })
    expect(configuration.facts.map(fact => fact.value).join(' ')).not.toContain('foreign')
    expect(configuration.throughCursor).toBe(last.cursor)
  })

  it('ignores foreign and future report or recovery projections', () => {
    const source = verifiedRun(3)
    const foreign = verifiedRun(4)
    const foreignProposal = buildRecoveryProposal({
      contract: projectPlanContractV2(foreign.plan),
      execution: foreign.execution,
      report: foreign.report,
      capabilityDigest: foreign.execution.capabilityDigest,
      now: foreign.execution.finishedAt ?? 10_000,
      controlSupport: { retry: 'unsupported', fork: 'unsupported' },
    })

    const foreignSummary = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'summary',
      },
      execution: source.execution,
      report: foreign.report,
      proposal: foreignProposal,
      events: source.events,
      receipts: [source.receipt],
    })
    expect(foreignSummary.state).toBe('unknown')
    expect(foreignSummary.facts.map(fact => fact.label)).not.toContain('Conformance')

    const foreignFindingId = sha256('foreign-finding')
    const foreignFindingReport = {
      ...source.report,
      state: 'deviated' as const,
      firstProvableDivergenceId: foreignFindingId,
      findings: [{
        schemaVersion: 1 as const,
        findingId: foreignFindingId,
        code: 'lifecycle-incomplete' as const,
        status: 'open' as const,
        severity: 'blocking' as const,
        certainty: 'proven' as const,
        parentSessionId: 'foreign-parent',
        runId: source.execution.executionId,
        planId: source.execution.planId,
        planRevision: source.execution.planRevision,
        taskId: 'review',
        attemptId: source.execution.bindings[0]!.attemptId,
        firstObservedAt: source.execution.finishedAt ?? source.execution.createdAt,
        evidenceEventIds: [source.events[2]!.eventId],
      }],
    }
    const foreignFindingSummary = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'summary',
      },
      execution: source.execution,
      report: foreignFindingReport,
      events: source.events,
      receipts: [source.receipt],
    })
    expect(foreignFindingSummary.state).toBe('unknown')
    expect(foreignFindingSummary.facts.map(fact => fact.label)).not.toContain('Conformance')

    const evidenceEventId = source.events[2]!.eventId
    const mismatchedEvidenceEvents = source.events.map(event => event.eventId === evidenceEventId
      ? { ...event, taskId: 'foreign-task' }
      : event)
    const findingId = sha256('mismatched-finding-evidence')
    const mismatchedEvidenceReport = {
      ...source.report,
      state: 'deviated' as const,
      firstProvableDivergenceId: findingId,
      findings: [{
        schemaVersion: 1 as const,
        findingId,
        code: 'lifecycle-incomplete' as const,
        status: 'open' as const,
        severity: 'blocking' as const,
        certainty: 'proven' as const,
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        planId: source.execution.planId,
        planRevision: source.execution.planRevision,
        taskId: 'review',
        attemptId: source.execution.bindings[0]!.attemptId,
        firstObservedAt: source.execution.finishedAt ?? source.execution.createdAt,
        evidenceEventIds: [evidenceEventId],
      }],
    }
    const mismatchedEvidenceSummary = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'summary',
      },
      execution: source.execution,
      report: mismatchedEvidenceReport,
      events: mismatchedEvidenceEvents,
      receipts: [source.receipt],
    })
    expect(mismatchedEvidenceSummary.state).toBe('unknown')
    expect(mismatchedEvidenceSummary.facts.map(fact => fact.label)).not.toContain('Conformance')

    const foreignRecovery = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'recovery-impact',
      },
      execution: source.execution,
      report: source.report,
      proposal: foreignProposal,
      events: source.events,
      receipts: [source.receipt],
    })
    expect(foreignRecovery).toMatchObject({ state: source.report.state, facts: [] })

    const historical = buildRunQuery({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        kind: 'summary',
        throughCursor: Math.max(0, source.report.eventCursor - 1),
      },
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [source.receipt],
    })
    expect(historical.state).toBe('unknown')
    expect(historical.facts.map(fact => fact.label)).not.toContain('Conformance')
  })
})
