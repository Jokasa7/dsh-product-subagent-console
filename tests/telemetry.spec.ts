import { describe, expect, it } from 'vitest'
import { buildTelemetryPreview } from '../src/telemetry.js'
import { sha256 } from '../src/conformance.js'
import { verifiedRun } from './foundry-fixtures.js'

describe('neutral telemetry preview', () => {
  it('is disabled by default and never exports content fields', () => {
    const run = verifiedRun(1)
    expect(buildTelemetryPreview({ enabled: false, events: run.events, serviceVersion: '0.9.0' }))
      .toEqual({ enabled: false, format: 'otlp-json-preview', payload: '' })
    const enabled = buildTelemetryPreview({
      enabled: true,
      execution: run.execution,
      report: run.report,
      events: run.events,
      serviceVersion: '0.9.0',
    })
    expect(enabled.payload).toContain('agent.execution')
    expect(enabled.payload).not.toContain(run.execution.executionId)
    expect(enabled.payload).not.toContain(run.execution.bindings[0]!.attemptId)
    expect(enabled.payload).not.toContain('"agent.task.id"')
    expect(enabled.payload).not.toContain('"review"')
    expect(enabled.payload).not.toMatch(/prompt|raw-output|stderr|environment|reasoning/iu)
  })

  it('marks failed execution and attempt spans as OTLP errors', () => {
    const run = verifiedRun(2)
    const result = buildTelemetryPreview({
      enabled: true,
      execution: {
        ...run.execution,
        status: 'failed',
        bindings: run.execution.bindings.map(binding => ({ ...binding, status: 'failed' as const })),
      },
      report: run.report,
      events: run.events,
      serviceVersion: '0.9.0',
    })
    const payload = JSON.parse(result.payload) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }>
    }
    expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans.map(span => span.status.code)).toEqual([2, 2])
  })

  it('uses OTLP UNSET, OK, and ERROR consistently for every lifecycle state', () => {
    const run = verifiedRun(4)
    const executionCases = [
      ['queued', 0], ['running', 0], ['stopping', 0], ['succeeded', 1],
      ['partial', 2], ['failed', 2], ['cancelled', 2], ['unknown', 2],
    ] as const
    for (const [status, expected] of executionCases) {
      const result = buildTelemetryPreview({
        enabled: true,
        execution: { ...run.execution, status },
        events: run.events,
        serviceVersion: '0.9.0',
      })
      expect(spanStatusCodes(result.payload)[0], status).toBe(expected)
    }
    const attemptCases = [
      ['queued', 0], ['starting', 0], ['running', 0], ['waiting', 0], ['stopping', 0],
      ['skipped', 0], ['completed', 1], ['failed', 2], ['cancelled', 2], ['rejected', 2], ['unknown', 2],
    ] as const
    for (const [status, expected] of attemptCases) {
      const result = buildTelemetryPreview({
        enabled: true,
        execution: {
          ...run.execution,
          bindings: run.execution.bindings.map(binding => ({ ...binding, status })),
        },
        events: run.events,
        serviceVersion: '0.9.0',
      })
      expect(spanStatusCodes(result.payload)[1], status).toBe(expected)
    }
  })

  it('does not attach a conformance report from another execution identity', () => {
    const run = verifiedRun(3)
    const result = buildTelemetryPreview({
      enabled: true,
      execution: run.execution,
      report: { ...run.report, planRevision: run.report.planRevision + 1, state: 'deviated' },
      events: run.events,
      serviceVersion: '0.9.0',
    })
    expect(result.payload).toContain('"unknown"')
    expect(result.payload).not.toContain('"deviated"')
  })

  it('ignores foreign nested findings and same-run events from another plan revision', () => {
    const run = verifiedRun(5)
    const findingId = sha256('foreign-telemetry-finding')
    const report = {
      ...run.report,
      state: 'deviated' as const,
      firstProvableDivergenceId: findingId,
      findings: [{
        schemaVersion: 1 as const,
        findingId,
        code: 'lifecycle-incomplete' as const,
        status: 'open' as const,
        severity: 'blocking' as const,
        certainty: 'proven' as const,
        parentSessionId: 'foreign-parent',
        runId: run.execution.executionId,
        planId: run.execution.planId,
        planRevision: run.execution.planRevision,
        taskId: 'review',
        attemptId: run.execution.bindings[0]!.attemptId,
        firstObservedAt: run.execution.finishedAt ?? run.execution.createdAt,
        evidenceEventIds: [run.events[2]!.eventId],
      }],
    }
    const last = run.events.at(-1)!
    const foreignEvent = {
      ...last,
      eventId: sha256('foreign-telemetry-event'),
      sourceEventId: 'foreign-telemetry-event',
      cursor: last.cursor + 1,
      planRevision: run.execution.planRevision + 1,
      observedAt: 9_999_999,
    }
    const result = buildTelemetryPreview({
      enabled: true,
      execution: { ...run.execution, status: 'running', finishedAt: undefined },
      report,
      events: [...run.events, foreignEvent],
      serviceVersion: '0.9.0',
    })
    expect(result.payload).toContain('"unknown"')
    expect(result.payload).not.toContain('"deviated"')
    const parsed = JSON.parse(result.payload) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ endTimeUnixNano: string }> }> }>
    }
    expect(parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.endTimeUnixNano)
      .toBe(String(BigInt(last.observedAt) * 1_000_000n))
  })
})

function spanStatusCodes(payload: string): number[] {
  const parsed = JSON.parse(payload) as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }>
  }
  return parsed.resourceSpans[0]?.scopeSpans[0]?.spans.map(span => span.status.code) ?? []
}
