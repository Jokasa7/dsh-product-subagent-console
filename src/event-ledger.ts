import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { sha256 } from './conformance.js'
import {
  evidenceReceiptSchema,
  foundryEventEnvelopeSchema,
  type EvidenceReceipt,
  type FoundryEventEnvelope,
} from './foundry-types.js'
import {
  agentPlanRevisionSchema,
  planExecutionSchema,
  type AgentPlanRevision,
  type PlanExecution,
} from './plan-types.js'
import { planExecutionTransitionError } from './plan-execution-transition.js'

const journalRecordSchema = z.discriminatedUnion('recordType', [
  z.object({
    recordType: z.literal('event'),
    journalSeq: z.number().int().positive(),
    previousRecordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    recordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    value: foundryEventEnvelopeSchema,
  }).strict(),
  z.object({
    recordType: z.literal('receipt'),
    journalSeq: z.number().int().positive(),
    previousRecordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    recordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    value: evidenceReceiptSchema,
  }).strict(),
  z.object({
    recordType: z.literal('plan-revision'),
    journalSeq: z.number().int().positive(),
    previousRecordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    recordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    value: agentPlanRevisionSchema,
  }).strict(),
  z.object({
    recordType: z.literal('execution-snapshot'),
    journalSeq: z.number().int().positive(),
    previousRecordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    recordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    value: planExecutionSchema,
  }).strict(),
])
type JournalRecord = z.infer<typeof journalRecordSchema>
type NewJournalRecord =
  | { readonly recordType: 'event'; readonly value: FoundryEventEnvelope }
  | { readonly recordType: 'receipt'; readonly value: EvidenceReceipt }
  | { readonly recordType: 'plan-revision'; readonly value: AgentPlanRevision }
  | { readonly recordType: 'execution-snapshot'; readonly value: PlanExecution }

export type NewFoundryEvent = Omit<FoundryEventEnvelope, 'schemaVersion' | 'eventId' | 'cursor'>

export interface FoundryEventLedgerOptions {
  /** Null creates a memory-only ledger, primarily for tests and explicitly ephemeral profiles. */
  readonly storageDirectory?: string | null
  readonly maxEvents?: number
  readonly maxReceipts?: number
  readonly maxPlanRevisions?: number
  readonly maxExecutions?: number
  readonly maxJournalBytes?: number
  readonly maxJournalRecords?: number
  readonly now?: () => number
  readonly onStorageError?: (error: unknown) => void
}

export class FoundryEventConflictError extends Error {
  constructor(readonly identity: string) {
    super(`foundry event identity conflict: ${identity}`)
    this.name = 'FoundryEventConflictError'
  }
}

export class FoundryLedgerCapacityError extends Error {
  constructor(recordType: 'event' | 'receipt' | 'plan-revision' | 'execution') {
    super(`foundry ${recordType} capacity reached`)
    this.name = 'FoundryLedgerCapacityError'
  }
}

/**
 * Privacy-safe append-only journal for Foundry facts. It accepts only schema
 * fields and deliberately has no generic payload bag.
 */
export class FoundryEventLedger {
  readonly hostInstanceId = randomUUID()
  readonly hostStartedAt: number
  private readonly eventsById = new Map<string, FoundryEventEnvelope>()
  private readonly eventIdentity = new Map<string, string>()
  private readonly receiptsById = new Map<string, EvidenceReceipt>()
  private readonly planRevisionsByKey = new Map<string, AgentPlanRevision>()
  private readonly executionSnapshotsById = new Map<string, PlanExecution>()
  private readonly listeners = new Set<(revision: number, parentSessionId: string) => void>()
  private readonly sessionRevisionById = new Map<string, number>()
  private readonly storageDirectory: string | null
  private readonly journalPath: string | null
  private readonly lockPath: string | null
  private readonly maxEvents: number
  private readonly maxReceipts: number
  private readonly maxPlanRevisions: number
  private readonly maxExecutions: number
  private readonly maxJournalBytes: number
  private readonly maxJournalRecords: number
  private readonly now: () => number
  private readonly onStorageError: (error: unknown) => void
  private revisionValue = 0
  private eventCursorValue = 0
  private journalSeqValue = 0
  private journalBytesValue = 0
  private lastRecordDigestValue: `sha256:${string}` | null = null
  private storageState: 'ready' | 'disabled' | 'degraded'
  private ownsStorageLock = false
  private disposed = false

  constructor(options: FoundryEventLedgerOptions = {}) {
    this.maxEvents = options.maxEvents ?? 50_000
    this.maxReceipts = options.maxReceipts ?? 10_000
    this.maxPlanRevisions = options.maxPlanRevisions ?? 5_000
    this.maxExecutions = options.maxExecutions ?? 5_000
    this.maxJournalBytes = options.maxJournalBytes ?? 64 * 1024 * 1024
    this.maxJournalRecords = options.maxJournalRecords ?? 100_000
    this.now = options.now ?? Date.now
    this.onStorageError = options.onStorageError ?? (() => {})
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > 250_000) {
      throw new Error('foundry maxEvents must be an integer from 1 to 250000')
    }
    if (!Number.isInteger(this.maxReceipts) || this.maxReceipts < 1 || this.maxReceipts > 100_000) {
      throw new Error('foundry maxReceipts must be an integer from 1 to 100000')
    }
    if (!Number.isInteger(this.maxPlanRevisions) || this.maxPlanRevisions < 1 || this.maxPlanRevisions > 50_000) {
      throw new Error('foundry maxPlanRevisions must be an integer from 1 to 50000')
    }
    if (!Number.isInteger(this.maxExecutions) || this.maxExecutions < 1 || this.maxExecutions > 50_000) {
      throw new Error('foundry maxExecutions must be an integer from 1 to 50000')
    }
    if (!Number.isInteger(this.maxJournalBytes) || this.maxJournalBytes < 1_024 || this.maxJournalBytes > 1024 * 1024 * 1024) {
      throw new Error('foundry maxJournalBytes must be an integer from 1024 to 1073741824')
    }
    if (!Number.isInteger(this.maxJournalRecords) || this.maxJournalRecords < 16 || this.maxJournalRecords > 1_000_000) {
      throw new Error('foundry maxJournalRecords must be an integer from 16 to 1000000')
    }
    this.hostStartedAt = this.now()
    const configuredDirectory = options.storageDirectory === undefined
      ? dshHomePath('plugins', 'dsh-product-subagent-console', 'foundry-v1')
      : options.storageDirectory
    this.storageDirectory = configuredDirectory === null ? null : resolve(configuredDirectory)
    this.journalPath = this.storageDirectory === null ? null : join(this.storageDirectory, 'events.jsonl')
    this.lockPath = this.storageDirectory === null ? null : join(this.storageDirectory, 'writer.lock')
    this.storageState = this.journalPath === null ? 'disabled' : 'ready'
    if (this.journalPath !== null && this.acquireStorageLock()) this.loadJournal()
  }

  get revision(): number { return this.revisionValue }
  get eventCursor(): number { return this.eventCursorValue }
  get durability(): 'disk' | 'memory' { return this.storageState === 'ready' ? 'disk' : 'memory' }
  get storageStatus(): 'ready' | 'disabled' | 'degraded' { return this.storageState }

  /**
   * Assert that a new execution and its minimum lifecycle envelope fit before
   * the external Workflow engine is allowed to start. This check is read-only.
   */
  assertCanStartExecution(requiredEventSlots = 1, requiredReceiptSlots = 0): void {
    this.assertOpen()
    if (this.executionSnapshotsById.size >= this.maxExecutions) {
      throw new FoundryLedgerCapacityError('execution')
    }
    this.assertCanRecordFacts(requiredEventSlots, requiredReceiptSlots)
  }

  /** Check bounded Event/Receipt capacity without mutating the journal. */
  assertCanRecordFacts(requiredEventSlots = 0, requiredReceiptSlots = 0): void {
    this.assertOpen()
    if (!Number.isInteger(requiredEventSlots) || requiredEventSlots < 0) {
      throw new Error('requiredEventSlots must be a nonnegative integer')
    }
    if (!Number.isInteger(requiredReceiptSlots) || requiredReceiptSlots < 0) {
      throw new Error('requiredReceiptSlots must be a nonnegative integer')
    }
    if (this.eventsById.size + requiredEventSlots > this.maxEvents) {
      throw new FoundryLedgerCapacityError('event')
    }
    if (this.receiptsById.size + requiredReceiptSlots > this.maxReceipts) {
      throw new FoundryLedgerCapacityError('receipt')
    }
  }

  scopedRevision(parentSessionIds: readonly string[]): number {
    return [...new Set(parentSessionIds)].reduce(
      (total, parentSessionId) => total + (this.sessionRevisionById.get(parentSessionId) ?? 0),
      0,
    )
  }

  subscribe(listener: (revision: number, parentSessionId: string) => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release the cooperative single-writer lock owned by this Host generation. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    if (!this.ownsStorageLock || this.lockPath === null) return
    try {
      const lock = storageLockSchema.safeParse(JSON.parse(readFileSync(this.lockPath, 'utf8')))
      if (lock.success && lock.data.hostInstanceId === this.hostInstanceId) unlinkSync(this.lockPath)
    } catch (error: unknown) {
      if (existsSync(this.lockPath)) {
        try { this.onStorageError(error) } catch { /* contained */ }
      }
    } finally {
      this.ownsStorageLock = false
    }
  }

  recordEvent(input: NewFoundryEvent, reservedEventSlots = 0): FoundryEventEnvelope {
    this.assertOpen()
    if (!Number.isInteger(reservedEventSlots) || reservedEventSlots < 0) {
      throw new Error('reservedEventSlots must be a nonnegative integer')
    }
    const identity = `${input.source}\u0000${input.sourceEventId}`
    const eventId = sha256(identity)
    const existing = this.eventsById.get(eventId)
    if (existing !== undefined) {
      const candidate = foundryEventEnvelopeSchema.parse({
        ...input,
        schemaVersion: 1,
        eventId,
        cursor: existing.cursor,
      })
      if (JSON.stringify(candidate) !== JSON.stringify(existing)) throw new FoundryEventConflictError(identity)
      return structuredClone(existing)
    }
    if (this.eventsById.size + reservedEventSlots >= this.maxEvents) {
      throw new FoundryLedgerCapacityError('event')
    }
    const event = foundryEventEnvelopeSchema.parse({
      ...input,
      schemaVersion: 1,
      eventId,
      cursor: this.eventCursorValue + 1,
    })
    this.eventCursorValue = event.cursor
    this.eventsById.set(event.eventId, event)
    this.eventIdentity.set(identity, event.eventId)
    this.append({ recordType: 'event', value: event })
    this.changed(event.parentSessionId)
    return structuredClone(event)
  }

  hasEventIdentity(source: string, sourceEventId: string): boolean {
    return this.eventIdentity.has(`${source}\u0000${sourceEventId}`)
  }

  recordReceipt(rawReceipt: unknown, reservedReceiptSlots = 0): EvidenceReceipt {
    this.assertOpen()
    if (!Number.isInteger(reservedReceiptSlots) || reservedReceiptSlots < 0) {
      throw new Error('reservedReceiptSlots must be a nonnegative integer')
    }
    const receipt = evidenceReceiptSchema.parse(rawReceipt)
    const existing = this.receiptsById.get(receipt.receiptId)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
        throw new FoundryEventConflictError(receipt.receiptId)
      }
      return structuredClone(existing)
    }
    if (this.receiptsById.size + reservedReceiptSlots >= this.maxReceipts) {
      throw new FoundryLedgerCapacityError('receipt')
    }
    this.receiptsById.set(receipt.receiptId, receipt)
    this.append({ recordType: 'receipt', value: receipt })
    this.changed(receipt.parentSessionId)
    return structuredClone(receipt)
  }

  hasReceipt(receiptId: string): boolean {
    return this.receiptsById.has(receiptId)
  }

  /** Persist one immutable plan revision or its single draft state transition. */
  recordPlanRevision(rawRevision: unknown): AgentPlanRevision {
    this.assertOpen()
    const revision = structuredClone(agentPlanRevisionSchema.parse(rawRevision))
    const key = planRevisionKey(revision)
    const existing = this.planRevisionsByKey.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(revision)) return structuredClone(existing)
      assertPlanRevisionTransition(existing, revision)
    } else if (this.planRevisionsByKey.size >= this.maxPlanRevisions) {
      throw new FoundryLedgerCapacityError('plan-revision')
    }
    this.planRevisionsByKey.set(key, revision)
    this.append({ recordType: 'plan-revision', value: revision })
    this.changed(revision.parentSessionId)
    return structuredClone(revision)
  }

  /** Persist the latest safe projection of one execution without rewriting history. */
  recordExecutionSnapshot(rawExecution: unknown): PlanExecution {
    this.assertOpen()
    const execution = structuredClone(planExecutionSchema.parse(rawExecution))
    const existing = this.executionSnapshotsById.get(execution.executionId)
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(execution)) return structuredClone(existing)
      assertExecutionSnapshotTransition(existing, execution)
    } else if (this.executionSnapshotsById.size >= this.maxExecutions) {
      throw new FoundryLedgerCapacityError('execution')
    }
    this.executionSnapshotsById.set(execution.executionId, execution)
    this.append({
      recordType: 'execution-snapshot',
      value: execution,
    })
    this.changed(execution.parentSessionId)
    return structuredClone(execution)
  }

  listEvents(parentSessionIds: readonly string[], throughCursor = this.eventCursorValue): FoundryEventEnvelope[] {
    const allowed = new Set(parentSessionIds)
    return [...this.eventsById.values()]
      .filter(event => allowed.has(event.parentSessionId) && event.cursor <= throughCursor)
      .sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
      .map(event => structuredClone(event))
  }

  /** Read all privacy-safe Event envelopes for deterministic Host reconciliation. */
  listAllEvents(throughCursor = this.eventCursorValue): FoundryEventEnvelope[] {
    return [...this.eventsById.values()]
      .filter(event => event.cursor <= throughCursor)
      .sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
      .map(event => structuredClone(event))
  }

  listReceipts(parentSessionIds: readonly string[]): EvidenceReceipt[] {
    const allowed = new Set(parentSessionIds)
    return [...this.receiptsById.values()]
      .filter(receipt => allowed.has(receipt.parentSessionId))
      .sort((left, right) => left.observedAt - right.observedAt || left.receiptId.localeCompare(right.receiptId))
      .map(receipt => structuredClone(receipt))
  }

  listPlanRevisions(parentSessionIds?: readonly string[]): AgentPlanRevision[] {
    const allowed = parentSessionIds === undefined ? undefined : new Set(parentSessionIds)
    return [...this.planRevisionsByKey.values()]
      .filter(revision => allowed === undefined || allowed.has(revision.parentSessionId))
      .sort((left, right) => (
        left.planId.localeCompare(right.planId)
        || left.revision - right.revision
      ))
      .map(revision => structuredClone(revision))
  }

  listExecutionSnapshots(parentSessionIds?: readonly string[]): PlanExecution[] {
    const allowed = parentSessionIds === undefined ? undefined : new Set(parentSessionIds)
    return [...this.executionSnapshotsById.values()]
      .filter(execution => allowed === undefined || allowed.has(execution.parentSessionId))
      .sort((left, right) => (
        left.createdAt - right.createdAt
        || left.executionId.localeCompare(right.executionId)
      ))
      .map(execution => structuredClone(execution))
  }

  projectionDigest(parentSessionIds: readonly string[], throughCursor = this.eventCursorValue): string {
    return sha256(JSON.stringify({
      plans: this.listPlanRevisions(parentSessionIds),
      executions: this.listExecutionSnapshots(parentSessionIds),
      events: this.listEvents(parentSessionIds, throughCursor),
      receipts: this.listReceipts(parentSessionIds),
    }))
  }

  private loadJournal(): void {
    const journalPath = this.journalPath
    if (journalPath === null) return
    try {
      mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 })
      if (!existsSync(journalPath)) {
        writeFileSync(journalPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        return
      }
      restrictMode(journalPath, 0o600, this.onStorageError)
      const bytes = readFileSync(journalPath)
      if (bytes.length > this.maxJournalBytes) throw new Error('foundry journal byte capacity exceeded')
      const lastNewline = bytes.lastIndexOf(0x0a)
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1
      if (completeLength < bytes.length) {
        const tailPath = join(
          dirname(journalPath),
          `events.recovery-tail.${String(this.now())}.${randomUUID()}.json`,
        )
        writeFileSync(tailPath, bytes.subarray(completeLength), { flag: 'wx', mode: 0o600 })
        truncateSync(journalPath, completeLength)
      }
      const complete = bytes.subarray(0, completeLength).toString('utf8')
      if (complete.length === 0) return
      const lines = complete.split('\n').filter(line => line.length > 0)
      if (lines.length > this.maxJournalRecords) throw new Error('foundry journal record capacity exceeded')
      for (const line of lines) this.loadRecord(journalRecordSchema.parse(JSON.parse(line)))
      this.journalBytesValue = completeLength
    } catch (error: unknown) {
      this.quarantineCorruptJournal(error)
    }
  }

  private loadRecord(record: JournalRecord): void {
    if (record.journalSeq !== this.journalSeqValue + 1) {
      throw new Error('foundry journal sequence is not contiguous')
    }
    if (record.previousRecordDigest !== this.lastRecordDigestValue) {
      throw new Error('foundry journal hash chain is not contiguous')
    }
    const expectedDigest = journalRecordDigest(
      record.recordType,
      record.journalSeq,
      record.previousRecordDigest,
      record.value,
    )
    if (record.recordDigest !== expectedDigest) throw new Error('foundry journal record digest mismatch')
    this.journalSeqValue = record.journalSeq
    this.lastRecordDigestValue = record.recordDigest as `sha256:${string}`
    if (record.recordType === 'event') {
      if (this.eventsById.size >= this.maxEvents) throw new FoundryLedgerCapacityError('event')
      const identity = `${record.value.source}\u0000${record.value.sourceEventId}`
      if (record.value.eventId !== sha256(identity)) throw new Error('foundry journal event digest mismatch')
      if (record.value.cursor !== this.eventCursorValue + 1) {
        throw new Error('foundry event cursor is not contiguous')
      }
      const duplicate = this.eventIdentity.get(identity)
      if (duplicate !== undefined) throw new FoundryEventConflictError(identity)
      this.eventsById.set(record.value.eventId, record.value)
      this.eventIdentity.set(identity, record.value.eventId)
      this.eventCursorValue = record.value.cursor
      return
    }
    if (record.recordType === 'receipt') {
      if (this.receiptsById.size >= this.maxReceipts) throw new FoundryLedgerCapacityError('receipt')
      if (this.receiptsById.has(record.value.receiptId)) throw new FoundryEventConflictError(record.value.receiptId)
      this.receiptsById.set(record.value.receiptId, record.value)
      return
    }
    if (record.recordType === 'plan-revision') {
      const key = planRevisionKey(record.value)
      const existing = this.planRevisionsByKey.get(key)
      if (existing === undefined) {
        if (this.planRevisionsByKey.size >= this.maxPlanRevisions) {
          throw new FoundryLedgerCapacityError('plan-revision')
        }
      } else {
        assertPlanRevisionTransition(existing, record.value)
      }
      this.planRevisionsByKey.set(key, record.value)
      return
    }
    const existing = this.executionSnapshotsById.get(record.value.executionId)
    if (existing === undefined) {
      if (this.executionSnapshotsById.size >= this.maxExecutions) {
        throw new FoundryLedgerCapacityError('execution')
      }
    } else {
      assertExecutionSnapshotTransition(existing, record.value)
    }
    this.executionSnapshotsById.set(record.value.executionId, record.value)
  }

  private quarantineCorruptJournal(error: unknown): void {
    const journalPath = this.journalPath
    this.eventsById.clear()
    this.eventIdentity.clear()
    this.receiptsById.clear()
    this.planRevisionsByKey.clear()
    this.executionSnapshotsById.clear()
    this.eventCursorValue = 0
    this.journalSeqValue = 0
    this.journalBytesValue = 0
    this.lastRecordDigestValue = null
    this.storageState = 'degraded'
    try {
      if (journalPath !== null && existsSync(journalPath)) {
        const quarantinePath = join(
          dirname(journalPath),
          `events.corrupt.${String(this.now())}.${randomUUID()}.jsonl`,
        )
        renameSync(journalPath, quarantinePath)
        writeFileSync(journalPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      }
    } catch (quarantineError: unknown) {
      try { this.onStorageError(quarantineError) } catch { /* contained */ }
    }
    try { this.onStorageError(error) } catch { /* contained */ }
  }

  private append(input: NewJournalRecord): void {
    const journalSeq = this.journalSeqValue + 1
    const previousRecordDigest = this.lastRecordDigestValue
    const recordDigest = journalRecordDigest(
      input.recordType,
      journalSeq,
      previousRecordDigest,
      input.value,
    )
    const record = journalRecordSchema.parse({
      ...input,
      journalSeq,
      previousRecordDigest,
      recordDigest,
    })
    this.journalSeqValue = record.journalSeq
    this.lastRecordDigestValue = record.recordDigest as `sha256:${string}`
    const journalPath = this.journalPath
    if (journalPath === null || this.storageState === 'degraded') return
    const line = `${JSON.stringify(record)}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (
      record.journalSeq > this.maxJournalRecords
      || this.journalBytesValue + lineBytes > this.maxJournalBytes
    ) {
      this.storageState = 'degraded'
      try { this.onStorageError(new Error('Foundry journal capacity reached; continuing in memory')) } catch { /* contained */ }
      return
    }
    try {
      appendFileSync(journalPath, line, { encoding: 'utf8' })
      this.journalBytesValue += lineBytes
    } catch (error: unknown) {
      this.storageState = 'degraded'
      try { this.onStorageError(error) } catch { /* contained */ }
    }
  }

  private changed(parentSessionId: string): void {
    this.revisionValue += 1
    this.sessionRevisionById.set(
      parentSessionId,
      (this.sessionRevisionById.get(parentSessionId) ?? 0) + 1,
    )
    for (const listener of [...this.listeners]) {
      try {
        listener(this.revisionValue, parentSessionId)
      } catch (error: unknown) {
        try { this.onStorageError(error) } catch { /* contained */ }
      }
    }
  }

  private acquireStorageLock(): boolean {
    const storageDirectory = this.storageDirectory
    const lockPath = this.lockPath
    if (storageDirectory === null || lockPath === null) return false
    try {
      const existed = existsSync(storageDirectory)
      mkdirSync(storageDirectory, { recursive: true, mode: 0o700 })
      this.claimStorageDirectory(storageDirectory, existed)
      restrictMode(storageDirectory, 0o700, this.onStorageError)
      this.writeStorageLock(lockPath)
      this.ownsStorageLock = true
      return true
    } catch (error: unknown) {
      if (isAlreadyExistsError(error) && this.recoverStaleStorageLock(lockPath)) {
        try {
          this.writeStorageLock(lockPath)
          this.ownsStorageLock = true
          return true
        } catch (retryError: unknown) {
          this.storageState = 'degraded'
          try { this.onStorageError(retryError) } catch { /* contained */ }
          return false
        }
      }
      this.storageState = 'degraded'
      try { this.onStorageError(error) } catch { /* contained */ }
      return false
    }
  }

  private claimStorageDirectory(storageDirectory: string, existed: boolean): void {
    const markerPath = join(storageDirectory, 'storage.owner.json')
    if (existsSync(markerPath)) {
      const marker = storageOwnerSchema.parse(JSON.parse(readFileSync(markerPath, 'utf8')))
      if (marker.product !== 'dsh-product-subagent-console') throw new Error('Foundry storage owner mismatch')
      restrictMode(markerPath, 0o600, this.onStorageError)
      return
    }
    const entries = readdirSync(storageDirectory)
    if (existed && entries.some(entry => !isLegacyFoundryStorageEntry(entry))) {
      throw new Error('Foundry storage directory is not an owned or empty plugin directory')
    }
    try {
      writeFileSync(markerPath, `${JSON.stringify({
        schemaVersion: 1,
        product: 'dsh-product-subagent-console',
      })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error
      storageOwnerSchema.parse(JSON.parse(readFileSync(markerPath, 'utf8')))
    }
  }

  private writeStorageLock(lockPath: string): void {
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostInstanceId: this.hostInstanceId,
      createdAt: this.hostStartedAt,
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }

  private recoverStaleStorageLock(lockPath: string): boolean {
    try {
      const parsed = storageLockSchema.safeParse(JSON.parse(readFileSync(lockPath, 'utf8')))
      if (!parsed.success || processIsAlive(parsed.data.pid)) return false
      const stalePath = join(
        dirname(lockPath),
        `writer.stale.${String(this.now())}.${parsed.data.hostInstanceId}.lock`,
      )
      renameSync(lockPath, stalePath)
      restrictMode(stalePath, 0o600, this.onStorageError)
      return true
    } catch {
      return false
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Foundry event ledger is disposed')
  }
}

const storageLockSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  hostInstanceId: z.string().uuid(),
  createdAt: z.number().finite().nonnegative(),
}).strict()

const storageOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal('dsh-product-subagent-console'),
}).strict()

function isLegacyFoundryStorageEntry(entry: string): boolean {
  return entry === 'events.jsonl'
    || entry === 'writer.lock'
    || entry.startsWith('events.recovery-tail.')
    || entry.startsWith('events.corrupt.')
    || entry.startsWith('writer.stale.')
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
  }
}

function restrictMode(path: string, mode: number, onError: (error: unknown) => void): void {
  try {
    chmodSync(path, mode)
  } catch (error: unknown) {
    if (process.platform !== 'win32') {
      try { onError(error) } catch { /* contained */ }
    }
  }
}

function planRevisionKey(revision: Pick<AgentPlanRevision, 'planId' | 'revision'>): string {
  return `${revision.planId}:${String(revision.revision)}`
}

function journalRecordDigest(
  recordType: JournalRecord['recordType'],
  journalSeq: number,
  previousRecordDigest: `sha256:${string}` | null,
  value: JournalRecord['value'],
): `sha256:${string}` {
  return sha256(JSON.stringify({ recordType, journalSeq, previousRecordDigest, value }))
}

function assertPlanRevisionTransition(previous: AgentPlanRevision, next: AgentPlanRevision): void {
  if (previous.state !== 'draft' || !['approved', 'superseded'].includes(next.state)) {
    throw new FoundryEventConflictError(planRevisionKey(next))
  }
  const mutableKeys = new Set(['state', 'updatedAt', 'capabilityDigest', 'acceptedWarningIds'])
  const previousImmutable = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !mutableKeys.has(key)),
  )
  const nextImmutable = Object.fromEntries(
    Object.entries(next).filter(([key]) => !mutableKeys.has(key)),
  )
  if (JSON.stringify(previousImmutable) !== JSON.stringify(nextImmutable)) {
    throw new FoundryEventConflictError(planRevisionKey(next))
  }
  if (next.updatedAt < previous.updatedAt) {
    throw new FoundryEventConflictError(planRevisionKey(next))
  }
}

function assertExecutionSnapshotTransition(previous: PlanExecution, next: PlanExecution): void {
  if (isTerminalExecutionStatus(previous.status)) {
    throw new FoundryEventConflictError(next.executionId)
  }
  if (planExecutionTransitionError(previous, next) !== undefined) {
    throw new FoundryEventConflictError(next.executionId)
  }
}

function isTerminalExecutionStatus(status: PlanExecution['status']): boolean {
  return ['succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(status)
}
