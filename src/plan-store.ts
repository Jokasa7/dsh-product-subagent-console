import { randomUUID } from 'node:crypto'
import {
  agentPlanContentSchema,
  agentPlanRevisionSchema,
  MAX_PLAN_BYTES,
  type AgentPlanContent,
  type AgentPlanRevision,
  type PlanPreflightResult,
} from './plan-types.js'

/** Optimistic-concurrency failure raised instead of overwriting another saved revision. */
export class PlanRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`agent plan revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`)
    this.name = 'PlanRevisionConflictError'
  }
}

/** Ownership failure raised when a Session attempts to access another Session's plan. */
export class PlanOwnershipError extends Error {
  constructor() {
    super('agent plan does not belong to the calling Session')
    this.name = 'PlanOwnershipError'
  }
}

/** Approval failure raised when the exact draft has not passed a current preflight. */
export class PlanApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanApprovalError'
  }
}

export interface SavePlanDraftInput {
  readonly parentSessionId: string
  readonly content: AgentPlanContent
  readonly planId?: string
  /** Zero for a new plan; exact latest revision for an existing plan. */
  readonly expectedRevision: number
}

interface PlanRecord {
  readonly parentSessionId: string
  readonly revisions: AgentPlanRevision[]
}

/**
 * Bounded, immutable-revision plan repository.
 * Persistence is intentionally adapter-owned; DSH Session logs cannot accept out-of-repo event types safely.
 */
export class AgentPlanRepository {
  private readonly records = new Map<string, PlanRecord>()
  private revisionValue = 0
  private totalBytes = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly maxPlans = 100,
    private readonly maxRevisionsPerPlan = 50,
    private readonly maxTotalBytes = 16 * 1024 * 1024,
    private readonly maxPlansPerSession = 20,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(maxPlans) || maxPlans < 1 || maxPlans > 10_000) {
      throw new Error('maxPlans must be an integer from 1 to 10000')
    }
    if (!Number.isInteger(maxRevisionsPerPlan) || maxRevisionsPerPlan < 1 || maxRevisionsPerPlan > 1_000) {
      throw new Error('maxRevisionsPerPlan must be an integer from 1 to 1000')
    }
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < MAX_PLAN_BYTES || maxTotalBytes > 256 * 1024 * 1024) {
      throw new Error(`maxTotalBytes must be an integer from ${String(MAX_PLAN_BYTES)} to 268435456`)
    }
    if (!Number.isInteger(maxPlansPerSession) || maxPlansPerSession < 1 || maxPlansPerSession > maxPlans) {
      throw new Error('maxPlansPerSession must be a positive integer no greater than maxPlans')
    }
  }

  get revision(): number { return this.revisionValue }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Save a new draft revision using exact compare-and-swap semantics. */
  saveDraft(input: SavePlanDraftInput): AgentPlanRevision {
    const content = agentPlanContentSchema.parse(input.content)
    if (encodedBytes(content) > MAX_PLAN_BYTES) {
      throw new Error(`agent plan exceeds ${String(MAX_PLAN_BYTES)} encoded bytes`)
    }
    const planId = input.planId ?? randomUUID()
    const record = this.records.get(planId)
    if (record === undefined) {
      if (input.expectedRevision !== 0) throw new PlanRevisionConflictError(input.expectedRevision, 0)
      if (this.records.size >= this.maxPlans) throw new Error('agent plan repository capacity reached')
      const sessionPlanCount = [...this.records.values()]
        .filter(candidate => candidate.parentSessionId === input.parentSessionId).length
      if (sessionPlanCount >= this.maxPlansPerSession) {
        throw new Error('agent plan per-Session capacity reached')
      }
      const now = Date.now()
      const revision = agentPlanRevisionSchema.parse({
        ...content,
        schemaVersion: 1,
        planId,
        parentSessionId: input.parentSessionId,
        revision: 1,
        state: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      const revisionBytes = encodedBytes(revision)
      this.assertTotalCapacity(revisionBytes)
      this.records.set(planId, { parentSessionId: input.parentSessionId, revisions: [revision] })
      this.totalBytes += revisionBytes
      this.changed()
      return structuredClone(revision)
    }
    if (record.parentSessionId !== input.parentSessionId) throw new PlanOwnershipError()
    const latest = record.revisions.at(-1)
    if (latest === undefined) throw new Error('agent plan record has no revisions')
    if (latest.revision !== input.expectedRevision) {
      throw new PlanRevisionConflictError(input.expectedRevision, latest.revision)
    }
    if (record.revisions.length >= this.maxRevisionsPerPlan) {
      throw new Error('agent plan revision capacity reached')
    }
    const now = Date.now()
    const superseded = latest.state === 'draft' ? {
        ...latest,
        state: 'superseded',
        updatedAt: now,
      } as AgentPlanRevision : undefined
    const revision = agentPlanRevisionSchema.parse({
      ...content,
      schemaVersion: 1,
      planId,
      parentSessionId: input.parentSessionId,
      revision: latest.revision + 1,
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    const delta = encodedBytes(revision)
      + (superseded === undefined ? 0 : encodedBytes(superseded) - encodedBytes(latest))
    this.assertTotalCapacity(delta)
    if (superseded !== undefined) record.revisions[record.revisions.length - 1] = superseded
    record.revisions.push(revision)
    this.totalBytes += delta
    this.changed()
    return structuredClone(revision)
  }

  /** Approve one exact latest draft after every current warning has been explicitly accepted. */
  approve(input: {
    readonly parentSessionId: string
    readonly planId: string
    readonly revision: number
    readonly preflight: PlanPreflightResult
    readonly acceptedWarningCodes: readonly string[]
  }): AgentPlanRevision {
    const record = this.ownedRecord(input.parentSessionId, input.planId)
    const latest = record.revisions.at(-1)
    if (latest === undefined || latest.revision !== input.revision) {
      throw new PlanRevisionConflictError(input.revision, latest?.revision ?? 0)
    }
    if (latest.state !== 'draft') throw new PlanApprovalError('only the latest draft can be approved')
    if (
      input.preflight.planId !== latest.planId
      || input.preflight.revision !== latest.revision
      || input.preflight.capabilityDigest.length === 0
    ) {
      throw new PlanApprovalError('preflight does not match the exact plan revision')
    }
    if (!input.preflight.valid || input.preflight.diagnostics.some(item => item.severity === 'error')) {
      throw new PlanApprovalError('plan has blocking preflight errors')
    }
    const accepted = new Set(input.acceptedWarningCodes)
    const unaccepted = input.preflight.diagnostics
      .filter(item => item.severity === 'warning' && !accepted.has(item.code))
      .map(item => item.code)
    if (unaccepted.length > 0) {
      throw new PlanApprovalError(`unaccepted plan warnings: ${unaccepted.join(', ')}`)
    }
    const approved = agentPlanRevisionSchema.parse({
      ...latest,
      state: 'approved',
      updatedAt: Date.now(),
      capabilityDigest: input.preflight.capabilityDigest,
      acceptedWarningCodes: [...accepted].sort(),
    })
    const delta = encodedBytes(approved) - encodedBytes(latest)
    this.assertTotalCapacity(delta)
    record.revisions[record.revisions.length - 1] = approved
    this.totalBytes += delta
    this.changed()
    return structuredClone(approved)
  }

  /** Read one exact revision after checking Session ownership. */
  get(parentSessionId: string, planId: string, revision?: number): AgentPlanRevision | undefined {
    const record = this.records.get(planId)
    if (record === undefined) return undefined
    if (record.parentSessionId !== parentSessionId) throw new PlanOwnershipError()
    const found = revision === undefined
      ? record.revisions.at(-1)
      : record.revisions.find(candidate => candidate.revision === revision)
    return found === undefined ? undefined : structuredClone(found)
  }

  /** Return detached revisions for only the requested parent Sessions. */
  list(parentSessionIds: readonly string[]): readonly AgentPlanRevision[] {
    const allowed = new Set(parentSessionIds)
    return [...this.records.values()]
      .filter(record => allowed.has(record.parentSessionId))
      .flatMap(record => record.revisions.map(revision => structuredClone(revision)))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision)
  }

  private ownedRecord(parentSessionId: string, planId: string): PlanRecord {
    const record = this.records.get(planId)
    if (record === undefined) throw new Error(`agent plan ${planId} does not exist`)
    if (record.parentSessionId !== parentSessionId) throw new PlanOwnershipError()
    return record
  }

  private changed(): void {
    this.revisionValue += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error: unknown) {
        this.onListenerError(error)
      }
    }
  }

  private assertTotalCapacity(delta: number): void {
    if (this.totalBytes + delta > this.maxTotalBytes) {
      throw new Error('agent plan repository byte capacity reached')
    }
  }
}

function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('agent plan is not JSON serializable')
  return new TextEncoder().encode(encoded).byteLength
}
