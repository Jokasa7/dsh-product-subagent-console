import { describe, expect, it } from 'vitest'
import { projectExecutionAtCursor } from '../src/temporal-execution.js'
import { sha256 } from '../src/conformance.js'
import { verifiedRun } from './foundry-fixtures.js'

describe('temporal execution projection', () => {
  it('does not expose a future attempt or terminal state while scrubbing history', () => {
    const run = verifiedRun(1)
    expect(projectExecutionAtCursor(run.execution, run.events, run.events[0]?.cursor ?? 0)).toMatchObject({
      status: 'running', bindings: [],
    })
    expect(projectExecutionAtCursor(run.execution, run.events, run.events[1]?.cursor ?? 0)).toMatchObject({
      status: 'running', bindings: [{ status: 'running' }],
    })
    expect(projectExecutionAtCursor(run.execution, run.events, run.events[3]?.cursor ?? 0)).toMatchObject({
      status: 'succeeded', bindings: [{ status: 'completed' }],
    })
    expect(projectExecutionAtCursor(run.execution, run.events, 0)).toBeUndefined()
  })

  it('projects one run from a 50k-event session inside a bounded interactive budget', () => {
    const run = verifiedRun(2)
    const noise = Array.from({ length: 50_000 - run.events.length }, (_, index) => ({
      ...run.events[0]!,
      eventId: sha256(`noise-event-${String(index)}`),
      cursor: index + 1,
      sourceEventId: `noise-${String(index)}`,
      runId: 'noise-run',
    }))
    const events = [...noise, ...run.events]
    const throughCursor = run.events.at(-1)?.cursor ?? 0
    const samples: number[] = []
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const startedAt = performance.now()
      const projected = projectExecutionAtCursor(run.execution, events, throughCursor)
      samples.push(performance.now() - startedAt)
      expect(projected?.status).toBe('succeeded')
    }
    const p95 = [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1] ?? 0
    expect(p95).toBeLessThan(250)
  })

  it('ignores same-run events from another plan revision or task binding', () => {
    const run = verifiedRun(3)
    const terminal = run.events.at(-1)!
    const foreignRevision = {
      ...terminal,
      eventId: sha256('foreign-revision-terminal'),
      sourceEventId: 'foreign-revision-terminal',
      cursor: terminal.cursor + 1,
      planRevision: run.execution.planRevision + 1,
      executionStatus: 'failed' as const,
    }
    const foreignBinding = {
      ...run.events[2]!,
      eventId: sha256('foreign-task-attempt'),
      sourceEventId: 'foreign-task-attempt',
      cursor: terminal.cursor + 2,
      taskId: 'foreign-task',
      attemptStatus: 'failed' as const,
    }
    expect(projectExecutionAtCursor(
      run.execution,
      [...run.events, foreignRevision, foreignBinding],
      foreignBinding.cursor,
    )).toMatchObject({ status: 'succeeded', bindings: [{ taskId: 'review', status: 'completed' }] })
  })
})
