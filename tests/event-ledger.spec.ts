import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FoundryEventConflictError,
  FoundryEventLedger,
  FoundryLedgerCapacityError,
} from '../src/event-ledger.js'
import { sha256 } from '../src/conformance.js'
import type { EvidenceReceipt } from '../src/foundry-types.js'
import { verifiedRun } from './foundry-fixtures.js'

const tempRoots: string[] = []

afterEach(() => {
  const safeRoot = resolve(tmpdir())
  for (const root of tempRoots.splice(0)) {
    const resolved = resolve(root)
    if (!resolved.startsWith(`${safeRoot}\\`) && !resolved.startsWith(`${safeRoot}/`)) {
      throw new Error(`refusing to remove temp path outside ${safeRoot}`)
    }
    rmSync(resolved, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = join(tmpdir(), `dsh-foundry-ledger-${randomUUID()}`)
  mkdirSync(root, { recursive: false })
  tempRoots.push(root)
  return root
}

function newEvent(sourceEventId: string) {
  return {
    source: 'test-adapter',
    sourceEventId,
    parentSessionId: 'parent-a',
    runId: 'run-a',
    type: 'execution-started' as const,
    authority: 'adapter' as const,
    observedAt: 100,
    causalParents: [],
    artifacts: [],
  }
}

function receipt(): EvidenceReceipt {
  return {
    schemaVersion: 1,
    receiptId: sha256('receipt-a'),
    parentSessionId: 'parent-a',
    runId: 'run-a',
    planId: '00000000-0000-4000-8000-000000000001',
    planRevision: 1,
    taskId: 'task-a',
    attemptId: 'attempt-a',
    verifierId: 'verify-a',
    verifierVersion: '1',
    verifierKind: 'test',
    claim: 'criteria-satisfied',
    result: 'pass',
    authority: 'verifier',
    observedAt: 200,
    evidenceEventIds: [sha256('event-a')],
    artifacts: [],
  }
}

describe('FoundryEventLedger', () => {
  it('exposes a non-mutating execution and lifecycle capacity boundary', () => {
    const eventBound = new FoundryEventLedger({
      storageDirectory: null,
      maxEvents: 2,
      maxExecutions: 2,
    })
    expect(() => eventBound.assertCanStartExecution(2)).not.toThrow()
    eventBound.recordEvent(newEvent('one'))
    expect(() => eventBound.assertCanStartExecution(2)).toThrow(FoundryLedgerCapacityError)
    expect(eventBound.eventCursor).toBe(1)
    expect(eventBound.listExecutionSnapshots()).toEqual([])

    const executionBound = new FoundryEventLedger({
      storageDirectory: null,
      maxEvents: 10,
      maxExecutions: 1,
    })
    executionBound.recordExecutionSnapshot(verifiedRun(20).execution)
    expect(() => executionBound.assertCanStartExecution()).toThrow(FoundryLedgerCapacityError)
    expect(executionBound.listExecutionSnapshots()).toHaveLength(1)

    const receiptBound = new FoundryEventLedger({
      storageDirectory: null,
      maxEvents: 4,
      maxReceipts: 1,
    })
    receiptBound.recordReceipt(receipt())
    expect(() => receiptBound.assertCanStartExecution(1, 1)).toThrow(FoundryLedgerCapacityError)

    const reserved = new FoundryEventLedger({ storageDirectory: null, maxEvents: 2 })
    const first = reserved.recordEvent(newEvent('reserved-one'))
    expect(reserved.recordEvent(newEvent('reserved-one'), 1)).toEqual(first)
    expect(() => reserved.recordEvent(newEvent('reserved-two'), 1)).toThrow(FoundryLedgerCapacityError)
  })

  it('deduplicates exact source events and rejects identity conflicts', () => {
    const ledger = new FoundryEventLedger({ storageDirectory: null, now: () => 10 })
    const first = ledger.recordEvent(newEvent('one'))
    const duplicate = ledger.recordEvent(newEvent('one'))
    expect(duplicate).toEqual(first)
    expect(ledger.revision).toBe(1)
    expect(ledger.eventCursor).toBe(1)

    expect(() => ledger.recordEvent({ ...newEvent('one'), observedAt: 101 }))
      .toThrow(FoundryEventConflictError)
  })

  it('persists and deterministically replays events and receipts', () => {
    const root = tempRoot()
    const first = new FoundryEventLedger({ storageDirectory: root, now: () => 10 })
    first.recordEvent(newEvent('one'))
    first.recordEvent({ ...newEvent('two'), parentSessionId: 'parent-b' })
    first.recordReceipt(receipt())
    const digest = first.projectionDigest(['parent-a'])
    first.dispose()

    const replayed = new FoundryEventLedger({ storageDirectory: root, now: () => 20 })
    expect(replayed.storageStatus).toBe('ready')
    expect(replayed.durability).toBe('disk')
    expect(replayed.eventCursor).toBe(2)
    expect(replayed.listEvents(['parent-a'])).toHaveLength(1)
    expect(replayed.listEvents(['parent-b'])).toHaveLength(1)
    expect(replayed.listReceipts(['parent-a'])).toEqual([receipt()])
    expect(replayed.projectionDigest(['parent-a'])).toBe(digest)
  })

  it('persists immutable plan revisions and monotonic execution snapshots', () => {
    const root = tempRoot()
    const source = verifiedRun(3)
    const {
      capabilityDigest: _capabilityDigest,
      acceptedWarningIds: _acceptedWarningIds,
      ...draftBase
    } = source.plan
    const draft = { ...draftBase, state: 'draft' as const, updatedAt: source.plan.createdAt }
    const {
      finishedAt: _executionFinishedAt,
      ...runningBase
    } = source.execution
    const running = {
      ...runningBase,
      status: 'running' as const,
      bindings: source.execution.bindings.map(binding => {
        const { finishedAt: _finishedAt, ...base } = binding
        return { ...base, status: 'running' as const }
      }),
    }
    const ledger = new FoundryEventLedger({ storageDirectory: root })
    ledger.recordPlanRevision(draft)
    ledger.recordPlanRevision(source.plan)
    ledger.recordExecutionSnapshot(running)
    ledger.recordExecutionSnapshot(source.execution)
    ledger.dispose()

    const replayed = new FoundryEventLedger({ storageDirectory: root })
    expect(replayed.listPlanRevisions()).toEqual([source.plan])
    expect(replayed.listExecutionSnapshots()).toEqual([source.execution])
    expect(() => replayed.recordExecutionSnapshot(running)).toThrow(FoundryEventConflictError)
    expect(() => replayed.recordExecutionSnapshot({
      ...source.execution,
      bindings: [],
    })).toThrow(FoundryEventConflictError)
  })

  it('preserves a partial crash tail and replays only complete records', () => {
    const root = tempRoot()
    const first = new FoundryEventLedger({ storageDirectory: root, now: () => 10 })
    first.recordEvent(newEvent('one'))
    const journal = join(root, 'events.jsonl')
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}{"partial":`, 'utf8')
    first.dispose()

    const replayed = new FoundryEventLedger({ storageDirectory: root, now: () => 20 })
    expect(replayed.storageStatus).toBe('ready')
    expect(replayed.listEvents(['parent-a'])).toHaveLength(1)
    expect(readFileSync(journal, 'utf8')).not.toContain('partial')
    expect(existsSync(root)).toBe(true)
    expect(readFileNames(root).some(name => name.startsWith('events.recovery-tail.'))).toBe(true)
  })

  it('quarantines a corrupt complete record and degrades to memory truthfully', () => {
    const root = tempRoot()
    const errors = vi.fn()
    writeFileSync(join(root, 'events.jsonl'), '{"invalid":true}\n', 'utf8')
    const ledger = new FoundryEventLedger({ storageDirectory: root, now: () => 30, onStorageError: errors })
    expect(ledger.storageStatus).toBe('degraded')
    expect(ledger.durability).toBe('memory')
    expect(ledger.listEvents(['parent-a'])).toEqual([])
    expect(readFileNames(root).some(name => name.startsWith('events.corrupt.'))).toBe(true)
    expect(errors).toHaveBeenCalled()

    ledger.recordEvent(newEvent('after-corruption'))
    expect(ledger.listEvents(['parent-a'])).toHaveLength(1)
    expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toBe('')
  })

  it('rejects arbitrary sensitive payload fields at the schema boundary', () => {
    const ledger = new FoundryEventLedger({ storageDirectory: null })
    expect(() => ledger.recordEvent({
      ...newEvent('unsafe'),
      prompt: 'secret prompt',
    } as never)).toThrow()
  })

  it('requires control results and rejects control metadata on unrelated events', () => {
    const ledger = new FoundryEventLedger({ storageDirectory: null })
    const controlBase = {
      ...newEvent('control-result'),
      type: 'control-result' as const,
      controlAction: 'cancel' as const,
      controlProposalId: sha256('proposal'),
      controlEventCursor: 1,
    }
    expect(() => ledger.recordEvent(controlBase)).toThrow()
    expect(() => ledger.recordEvent({ ...controlBase, controlResult: 'requested' })).not.toThrow()
    expect(() => ledger.recordEvent({
      ...newEvent('not-control'),
      controlResult: 'requested' as const,
    })).toThrow()
  })

  it('allows only one disk writer and never lets a contender rewrite the journal', () => {
    const root = tempRoot()
    const first = new FoundryEventLedger({ storageDirectory: root, now: () => 10 })
    first.recordEvent(newEvent('first'))

    const errors = vi.fn()
    const contender = new FoundryEventLedger({
      storageDirectory: root,
      now: () => 11,
      onStorageError: errors,
    })
    expect(contender.storageStatus).toBe('degraded')
    expect(contender.durability).toBe('memory')
    contender.recordEvent(newEvent('contender-memory-only'))
    expect(errors).toHaveBeenCalled()

    first.dispose()
    contender.dispose()
    const successor = new FoundryEventLedger({ storageDirectory: root, now: () => 12 })
    expect(successor.storageStatus).toBe('ready')
    expect(successor.listEvents(['parent-a']).map(event => event.sourceEventId)).toEqual(['first'])
    successor.dispose()
  })

  it('quarantines a journal with a skipped sequence number', () => {
    const root = tempRoot()
    const first = new FoundryEventLedger({ storageDirectory: root, now: () => 10 })
    first.recordEvent(newEvent('one'))
    first.dispose()
    const journal = join(root, 'events.jsonl')
    const original = readFileSync(journal, 'utf8')
    const record = JSON.parse(original.trim()) as Record<string, unknown>
    writeFileSync(journal, `${original}${JSON.stringify({ ...record, journalSeq: 3 })}\n`, 'utf8')

    const replayed = new FoundryEventLedger({ storageDirectory: root, now: () => 20 })
    expect(replayed.storageStatus).toBe('degraded')
    expect(replayed.listEvents(['parent-a'])).toEqual([])
    expect(readFileNames(root).some(name => name.startsWith('events.corrupt.'))).toBe(true)
    replayed.dispose()
  })

  it('detects schema-valid journal tampering through the record hash chain', () => {
    const root = tempRoot()
    const first = new FoundryEventLedger({ storageDirectory: root, now: () => 10 })
    first.recordEvent(newEvent('one'))
    first.dispose()
    const journal = join(root, 'events.jsonl')
    const record = JSON.parse(readFileSync(journal, 'utf8').trim()) as {
      value: { observedAt: number }
    }
    record.value.observedAt = 999
    writeFileSync(journal, `${JSON.stringify(record)}\n`, 'utf8')

    const replayed = new FoundryEventLedger({ storageDirectory: root, now: () => 20 })
    expect(replayed.storageStatus).toBe('degraded')
    expect(replayed.listEvents(['parent-a'])).toEqual([])
    replayed.dispose()
  })

  it('fails over to truthful memory durability before the journal exceeds its byte cap', () => {
    const root = tempRoot()
    const errors = vi.fn()
    const ledger = new FoundryEventLedger({
      storageDirectory: root,
      maxJournalBytes: 1_024,
      onStorageError: errors,
    })
    for (let index = 0; index < 20 && ledger.storageStatus === 'ready'; index += 1) {
      ledger.recordEvent(newEvent(`capacity-${String(index)}`))
    }

    expect(ledger.storageStatus).toBe('degraded')
    expect(ledger.durability).toBe('memory')
    expect(readFileSync(join(root, 'events.jsonl')).byteLength).toBeLessThanOrEqual(1_024)
    expect(errors).toHaveBeenCalled()
    ledger.dispose()
  })

  it('refuses to chmod or write into an unrelated configured directory', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'unrelated.txt'), 'keep me', 'utf8')
    const errors = vi.fn()

    const ledger = new FoundryEventLedger({ storageDirectory: root, onStorageError: errors })

    expect(ledger.storageStatus).toBe('degraded')
    expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(root, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(root, 'writer.lock'))).toBe(false)
    expect(errors).toHaveBeenCalled()
  })
})

function readFileNames(root: string): string[] {
  return [...new Set(readdirSync(root))]
}
