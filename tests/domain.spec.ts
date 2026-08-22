import { describe, expect, it, vi } from 'vitest'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import {
  AdmissionCancelledError,
  AdmissionController,
  AdmissionQueueFullError,
  ProductSubagentLedger,
  type ExecutionObservation,
} from '../src/domain.js'

const observed: ExecutionObservation = {
  source: 'observed-tool',
  parentSessionId: 'parent',
  callId: 'call-1',
  toolName: 'subagent_codex',
  label: 'Review module status',
}

const owned: ExecutionObservation = {
  source: 'owned-tool',
  attemptId: '9ca58730-3f3c-4b45-9cb4-90de2ab9d97a',
  parentSessionId: 'parent',
  callId: 'call-owned',
  toolName: 'board_codex_safe',
  expectedProviderName: 'codex-safe',
  label: 'Review implementation',
  product: 'codex',
  displayName: 'Codex',
  instance: 'safe',
}

function startInfo(overrides: Partial<SubagentRunInfo> = {}): SubagentRunInfo {
  return {
    runId: 'run-1',
    provider: 'codex-safe',
    id: 'child-1',
    local: false,
    ...overrides,
  } as SubagentRunInfo
}

function endInfo(overrides: Partial<SubagentRunEndInfo> = {}): SubagentRunEndInfo {
  return {
    ...startInfo(),
    stopReason: 'completed',
    ...overrides,
  } as SubagentRunEndInfo
}

describe('AdmissionController', () => {
  it('enforces FIFO capacity, queue bounds, abort, and idempotent release', async () => {
    const admission = new AdmissionController(1, 1)
    const first = await admission.acquire(new AbortController().signal)
    const secondController = new AbortController()
    const second = admission.acquire(secondController.signal)
    await expect(admission.acquire(new AbortController().signal)).rejects.toBeInstanceOf(AdmissionQueueFullError)
    expect(admission.activeCount).toBe(1)
    expect(admission.queuedCount).toBe(1)

    first()
    const secondRelease = await second
    expect(admission.activeCount).toBe(1)
    expect(admission.queuedCount).toBe(0)
    secondRelease()
    secondRelease()
    expect(admission.activeCount).toBe(0)
  })

  it('rejects queued and future admission when the service closes', async () => {
    const admission = new AdmissionController(1, 2)
    const release = await admission.acquire(new AbortController().signal)
    const queued = admission.acquire(new AbortController().signal)
    admission.close()
    await expect(queued).rejects.toBeInstanceOf(AdmissionCancelledError)
    await expect(admission.acquire(new AbortController().signal)).rejects.toBeInstanceOf(AdmissionCancelledError)
    expect(admission.queuedCount).toBe(0)
    release()
    expect(admission.activeCount).toBe(0)
  })
})

describe('ProductSubagentLedger', () => {
  it('promotes an owned attempt atomically and settles the official run', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:00:00Z'))
    try {
      const ledger = new ProductSubagentLedger({ historyLimit: 50, maxObservedActive: 8 })
      ledger.createAttempt(owned, 'codex-safe')
      ledger.markStarting(owned.attemptId ?? '')
      expect(ledger.snapshot(['parent']).attempts[0]?.state).toBe('starting')

      vi.advanceTimersByTime(2_000)
      expect(ledger.publish(owned, startInfo())).toBe(true)
      let snapshot = ledger.snapshot(['parent'])
      expect(snapshot.attempts).toEqual([])
      expect(snapshot.runs).toMatchObject([{
        attemptId: owned.attemptId,
        toolName: 'board_codex_safe',
        providerName: 'codex-safe',
        providerMismatch: false,
        state: 'active',
      }])

      vi.advanceTimersByTime(3_000)
      ledger.settle(endInfo())
      snapshot = ledger.snapshot(['parent'])
      expect(snapshot.runs[0]).toMatchObject({ state: 'completed' })
      expect((snapshot.runs[0]?.finishedAt ?? 0) - (snapshot.runs[0]?.startedAt ?? 0)).toBe(3_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the attempt when malformed publication metadata is rejected', () => {
    const ledger = new ProductSubagentLedger({ historyLimit: 50, maxObservedActive: 8 })
    ledger.createAttempt(owned, 'codex-safe')
    ledger.markStarting(owned.attemptId ?? '')
    expect(() => ledger.publish(owned, startInfo({ provider: '   ' }))).toThrow(/provider name is blank/)
    expect(ledger.snapshot(['parent']).attempts).toHaveLength(1)
  })

  it('reports active-record truncation instead of presenting an apparently complete canvas', () => {
    const ledger = new ProductSubagentLedger({ historyLimit: 50, maxObservedActive: 1 })
    expect(ledger.publish(observed, startInfo())).toBe(true)
    expect(ledger.publish({ ...observed, callId: 'call-2' }, startInfo({
      runId: 'run-2' as SubagentRunInfo['runId'],
    }))).toBe(false)
    const snapshot = ledger.snapshot(['parent'])
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.diagnostics.droppedActiveRuns).toBe(1)
  })

  it('isolates parents, maps unknown stop reasons honestly, and never serializes private payloads', () => {
    const ledger = new ProductSubagentLedger({ historyLimit: 50, maxObservedActive: 8 })
    ledger.publish(observed, startInfo())
    ledger.settle({
      ...endInfo(),
      stopReason: 'future-stop-reason',
      lastAssistantMessage: [{ type: 'text', text: 'PRIVATE_OUTPUT_CANARY' }],
    } as unknown as SubagentRunEndInfo)
    expect(ledger.snapshot(['other']).runs).toEqual([])
    const serialized = JSON.stringify(ledger.snapshot(['parent']))
    expect(serialized).toContain('unknown')
    expect(serialized).not.toContain('PRIVATE_OUTPUT_CANARY')
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('cwd')
    expect(serialized).not.toContain('env')
  })

  it('trims attempts and runs through one combined terminal history bound', () => {
    const ledger = new ProductSubagentLedger({ historyLimit: 1, maxObservedActive: 8 })
    ledger.createAttempt(owned, 'codex-safe')
    ledger.settleAttempt(owned.attemptId ?? '', 'start-failed', false)
    ledger.publish(observed, startInfo())
    ledger.settle(endInfo())
    const snapshot = ledger.snapshot(['parent'])
    expect(snapshot.attempts).toEqual([])
    expect(snapshot.runs).toHaveLength(1)
  })
})
