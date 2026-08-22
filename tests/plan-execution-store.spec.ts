import { describe, expect, it, vi } from 'vitest'
import {
  PlanExecutionCapacityError,
  PlanExecutionIdentityError,
  PlanExecutionOwnershipError,
  PlanExecutionSnapshotRepository,
} from '../src/plan-execution-store.js'
import type { PlanExecution, PlanExecutionStatus } from '../src/plan-types.js'

function execution(
  suffix: number,
  options: {
    readonly parentSessionId?: string
    readonly status?: PlanExecutionStatus
    readonly createdAt?: number
    readonly finishedAt?: number
  } = {},
): PlanExecution {
  const executionId = `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
  const status = options.status ?? 'running'
  return {
    executionId,
    planId: '00000000-0000-4000-8000-000000009999',
    planRevision: 1,
    parentSessionId: options.parentSessionId ?? 'parent-a',
    backend: 'workflow',
    capabilityDigest: 'capability-v1',
    status,
    cancellationRequested: false,
    createdAt: options.createdAt ?? suffix * 1_000,
    ...status === 'queued' ? {} : { startedAt: options.createdAt ?? suffix * 1_000 },
    ...options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt },
    bindings: [{
      planId: '00000000-0000-4000-8000-000000009999',
      planRevision: 1,
      executionId,
      taskId: 'task-a',
      attemptId: `00000000-0000-4000-8001-${String(suffix).padStart(12, '0')}`,
      attemptNumber: 1,
      status: status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'running',
      ...options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt },
    }],
  }
}

describe('Plan execution snapshot repository', () => {
  it('rejects malformed snapshots without mutating repository state', () => {
    const repository = new PlanExecutionSnapshotRepository()
    expect(() => repository.upsert({ ...execution(1), status: 'invented-state' })).toThrow()
    expect(repository.size).toBe(0)
    expect(repository.revision).toBe(0)
  })

  it('upserts detached schema-valid snapshots and does not bump for the same snapshot', () => {
    const repository = new PlanExecutionSnapshotRepository()
    const listener = vi.fn()
    repository.subscribe(listener)
    const original = execution(1)
    const saved = repository.upsert(original)
    expect(repository.revision).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    original.bindings[0]!.status = 'failed'
    saved.bindings[0]!.status = 'failed'
    expect(repository.get('parent-a', original.executionId)?.bindings[0]?.status).toBe('running')

    const identical = execution(1)
    repository.upsert(structuredClone(identical))
    expect(repository.revision).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    const completed: PlanExecution = {
      ...identical,
      status: 'succeeded',
      finishedAt: 2_000,
      bindings: identical.bindings.map(binding => ({
        ...binding,
        status: 'completed',
        finishedAt: 2_000,
      })),
    }
    repository.upsert(completed)
    expect(repository.revision).toBe(2)
    expect(repository.get('parent-a', original.executionId)).toEqual(completed)
  })

  it('isolates parent Sessions and rejects execution-id ownership changes', () => {
    const repository = new PlanExecutionSnapshotRepository()
    const first = execution(1)
    repository.upsert(first)
    expect(repository.get('parent-a', first.executionId)).toEqual(first)
    expect(() => repository.get('parent-b', first.executionId)).toThrow(PlanExecutionOwnershipError)
    expect(repository.list(['parent-b'])).toEqual([])
    expect(repository.list(['parent-a'])).toHaveLength(1)

    expect(() => repository.upsert({ ...first, parentSessionId: 'parent-b' }))
      .toThrow(PlanExecutionOwnershipError)
    expect(repository.revision).toBe(1)
  })

  it('evicts only the oldest terminal execution and never an active execution', () => {
    const repository = new PlanExecutionSnapshotRepository(3)
    const active = execution(1, { status: 'running', createdAt: 100 })
    const oldTerminal = execution(2, { status: 'succeeded', createdAt: 200, finishedAt: 500 })
    const newTerminal = execution(3, { status: 'cancelled', createdAt: 300, finishedAt: 900 })
    repository.upsert(active)
    repository.upsert(oldTerminal)
    repository.upsert(newTerminal)
    repository.upsert(execution(4, { status: 'running', createdAt: 400 }))

    expect(repository.size).toBe(3)
    expect(repository.get('parent-a', active.executionId)).toBeDefined()
    expect(repository.get('parent-a', oldTerminal.executionId)).toBeUndefined()
    expect(repository.get('parent-a', newTerminal.executionId)).toBeDefined()
    expect(repository.revision).toBe(4)
  })

  it('rejects a new execution when capacity contains only active executions', () => {
    const repository = new PlanExecutionSnapshotRepository(2)
    repository.upsert(execution(1, { status: 'queued' }))
    repository.upsert(execution(2, { status: 'stopping' }))
    expect(() => repository.upsert(execution(3))).toThrow(PlanExecutionCapacityError)
    expect(repository.size).toBe(2)
    expect(repository.revision).toBe(2)
  })

  it('contains listener failures, including failures in the error reporter', () => {
    const observed: number[] = []
    const repository = new PlanExecutionSnapshotRepository(10, Date.now, () => {
      throw new Error('reporter failed')
    })
    repository.subscribe(() => { throw new Error('listener failed') })
    repository.subscribe(revision => { observed.push(revision) })
    expect(() => repository.upsert(execution(1))).not.toThrow()
    expect(observed).toEqual([1])
  })

  it('lists only requested parents in deterministic newest-first order', () => {
    const repository = new PlanExecutionSnapshotRepository()
    const oldest = execution(1, { createdAt: 1_000 })
    const newest = execution(2, { createdAt: 3_000 })
    const middle = execution(3, { createdAt: 2_000 })
    const other = execution(4, { parentSessionId: 'parent-b', createdAt: 4_000 })
    for (const item of [oldest, newest, middle, other]) repository.upsert(item)

    expect(repository.list(['parent-a']).map(item => item.executionId)).toEqual([
      newest.executionId,
      middle.executionId,
      oldest.executionId,
    ])
    expect(repository.list(['parent-a', 'parent-b']).map(item => item.executionId)).toEqual([
      other.executionId,
      newest.executionId,
      middle.executionId,
      oldest.executionId,
    ])
    expect(repository.snapshot(['parent-a'])).toMatchObject({
      schemaVersion: 1,
      revision: 4,
      executions: expect.any(Array),
    })
  })

  it('keeps terminal records immutable and rejects attempt identity replacement', () => {
    const repository = new PlanExecutionSnapshotRepository()
    const active = execution(1)
    repository.upsert(active)
    expect(() => repository.upsert({
      ...active,
      bindings: active.bindings.map(binding => ({
        ...binding,
        attemptId: '00000000-0000-4000-8001-000000008888',
      })),
    })).toThrow(PlanExecutionIdentityError)

    const terminal = execution(2, { status: 'succeeded', finishedAt: 3_000 })
    repository.upsert(terminal)
    expect(() => repository.upsert({ ...terminal, cancellationRequested: true }))
      .toThrow(/terminal plan execution snapshot is immutable/)
  })
})
