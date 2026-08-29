import { z } from 'zod'
import {
  agentPlanContentSchema,
  agentPlanRevisionSchema,
  planExecutionSchema,
  planPreflightResultSchema,
  type AgentPlanRevision,
  type PlanAttemptStatus,
  type PlanExecutionStatus,
} from './plan-types.js'

const identifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const boundedLabelSchema = z.string().trim().min(1).max(256)
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const foundryAuthoritySchema = z.enum([
  'dsh',
  'adapter',
  'verifier',
  'derived',
  'user',
  'model-claim',
])
export type FoundryAuthority = z.infer<typeof foundryAuthoritySchema>

export const findingCertaintySchema = z.enum(['proven', 'derived', 'hypothesis', 'unknown'])
export type FindingCertainty = z.infer<typeof findingCertaintySchema>

export const conformanceStateSchema = z.enum(['confirmed', 'deviated', 'unknown', 'not-applicable'])
export type ConformanceState = z.infer<typeof conformanceStateSchema>

export const taskEffectSchema = z.object({
  kind: z.enum(['pure', 'idempotent', 'compensatable', 'irreversible', 'unknown']),
  idempotencyScope: boundedLabelSchema.optional(),
  compensationRef: boundedLabelSchema.optional(),
}).strict()
export type TaskEffect = z.infer<typeof taskEffectSchema>

export const verifierContractSchema = z.object({
  verifierId: identifierSchema,
  kind: z.enum(['lifecycle', 'schema', 'test', 'manual']),
  description: z.string().trim().min(1).max(1_000),
  required: z.boolean(),
}).strict()
export type VerifierContract = z.infer<typeof verifierContractSchema>

export const planContractTaskV2Schema = z.object({
  taskId: identifierSchema,
  title: z.string().trim().min(1).max(160),
  roleId: identifierSchema,
  dependencies: z.array(z.object({
    taskId: identifierSchema,
    mode: z.enum(['order-only', 'context']),
  }).strict()).max(64),
  expectedOutputDescription: z.string().trim().min(1).max(2_000),
  completionCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(16),
  resourceClaims: z.array(z.string().trim().min(1).max(256)).max(32),
  effect: taskEffectSchema,
  verifiers: z.array(verifierContractSchema).max(16),
}).strict()
export type PlanContractTaskV2 = z.infer<typeof planContractTaskV2Schema>

export const planContractV2Schema = z.object({
  schemaVersion: z.literal(2),
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  parentSessionId: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(8_000),
  pattern: z.enum([
    'single-agent',
    'manager-workers',
    'parallel-fanout-fanin',
    'sequential-dag',
    'competing-hypotheses',
    'peer-team',
  ]),
  capabilityDigest: z.string().min(1).max(256).optional(),
  tasks: z.array(planContractTaskV2Schema).min(1).max(128),
  roles: z.array(z.object({
    roleId: identifierSchema,
    name: z.string().trim().min(1).max(80),
    transportProvider: boundedLabelSchema,
    llmProvider: boundedLabelSchema.optional(),
    model: boundedLabelSchema.optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']).optional(),
    toolPolicyMode: z.enum(['inherit', 'allowlist']),
  }).strict()).min(1).max(32),
}).strict()
export type PlanContractV2 = z.infer<typeof planContractV2Schema>

export function projectPlanContractV2(plan: AgentPlanRevision): PlanContractV2 {
  return planContractV2Schema.parse({
    schemaVersion: 2,
    planId: plan.planId,
    revision: plan.revision,
    parentSessionId: plan.parentSessionId,
    title: plan.title,
    objective: plan.objective,
    pattern: plan.pattern,
    ...(plan.capabilityDigest === undefined ? {} : { capabilityDigest: plan.capabilityDigest }),
    roles: plan.roles.map(role => ({
      roleId: role.roleId,
      name: role.name,
      transportProvider: role.transportProvider,
      ...(role.llmProvider === undefined ? {} : { llmProvider: role.llmProvider }),
      ...(role.model === undefined ? {} : { model: role.model }),
      ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
      toolPolicyMode: role.toolPolicy.mode,
    })),
    tasks: plan.tasks.map(task => ({
      taskId: task.taskId,
      title: task.title,
      roleId: task.roleId,
      dependencies: task.dependsOn,
      expectedOutputDescription: task.expectedOutput.description,
      completionCriteria: task.completionCriteria,
      resourceClaims: task.resourceClaims,
      effect: task.effect ?? { kind: 'unknown' },
      verifiers: task.verifiers ?? [],
    })),
  })
}

export const artifactReferenceSchema = z.object({
  artifactId: identifierSchema,
  kind: z.enum(['input', 'output', 'report', 'test', 'patch', 'other']),
  digest: digestSchema,
  mediaType: z.string().trim().min(1).max(128).optional(),
  label: boundedLabelSchema.optional(),
  producerTaskId: identifierSchema.optional(),
}).strict()
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>

export const foundryEventTypeSchema = z.enum([
  'plan-saved',
  'plan-approved',
  'execution-queued',
  'execution-started',
  'execution-stopping',
  'execution-terminal',
  'attempt-started',
  'attempt-waiting',
  'attempt-stopping',
  'attempt-terminal',
  'child-published',
  'child-terminal',
  'evidence-recorded',
  'control-requested',
  'control-consumed',
  'control-expired',
  'control-result',
])
export type FoundryEventType = z.infer<typeof foundryEventTypeSchema>

export const foundryEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: digestSchema,
  cursor: z.number().int().positive(),
  source: identifierSchema,
  sourceEventId: z.string().min(1).max(512),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  planId: z.string().uuid().optional(),
  planRevision: z.number().int().positive().optional(),
  taskId: identifierSchema.optional(),
  attemptId: z.string().min(1).max(256).optional(),
  type: foundryEventTypeSchema,
  authority: foundryAuthoritySchema,
  observedAt: z.number().finite().nonnegative(),
  occurredAt: z.number().finite().nonnegative().optional(),
  causalParents: z.array(digestSchema).max(64),
  executionStatus: z.custom<PlanExecutionStatus>((value) => (
    typeof value === 'string'
    && ['queued', 'running', 'stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(value)
  )).optional(),
  attemptStatus: z.custom<PlanAttemptStatus>((value) => (
    typeof value === 'string'
    && ['queued', 'starting', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown'].includes(value)
  )).optional(),
  terminalReason: z.enum([
    'completed',
    'failed',
    'cancelled',
    'rejected',
    'skipped',
    'max-tokens',
    'refusal',
    'missing-terminal',
    'host-restarted',
    'unknown',
  ]).optional(),
  controlAction: z.literal('cancel').optional(),
  controlProposalId: digestSchema.optional(),
  controlEventCursor: z.number().int().nonnegative().optional(),
  controlResult: z.enum([
    'requested',
    'not-found',
    'already-terminal',
    'already-requested',
    'stale-state',
    'host-unloaded',
    'host-restarted',
    'interrupted',
  ]).optional(),
  configuration: z.object({
    transportProvider: boundedLabelSchema.optional(),
    llmProvider: boundedLabelSchema.optional(),
    model: boundedLabelSchema.optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']).optional(),
    toolPolicyMode: z.enum(['inherit', 'allowlist', 'unknown']).optional(),
  }).strict().optional(),
  artifacts: z.array(artifactReferenceSchema).max(64),
}).strict().superRefine((event, context) => {
  const isControl = [
    'control-requested', 'control-consumed', 'control-expired', 'control-result',
  ].includes(event.type)
  if (isControl) {
    for (const [field, value] of [
      ['controlAction', event.controlAction],
      ['controlProposalId', event.controlProposalId],
      ['controlEventCursor', event.controlEventCursor],
    ] as const) {
      if (value !== undefined) continue
      context.addIssue({ code: 'custom', path: [field], message: `${field} is required for control events` })
    }
  } else if (
    event.controlAction !== undefined
    || event.controlProposalId !== undefined
    || event.controlEventCursor !== undefined
  ) {
    context.addIssue({ code: 'custom', path: ['controlAction'], message: 'control metadata is only valid on control events' })
  }
  if (event.type === 'control-result' && event.controlResult === undefined) {
    context.addIssue({ code: 'custom', path: ['controlResult'], message: 'controlResult is required for control-result events' })
  } else if (event.type !== 'control-result' && event.controlResult !== undefined) {
    context.addIssue({ code: 'custom', path: ['controlResult'], message: 'controlResult is only valid on control-result events' })
  }
})
export type FoundryEventEnvelope = z.infer<typeof foundryEventEnvelopeSchema>

export const evidenceReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: digestSchema,
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  taskId: identifierSchema,
  attemptId: z.string().min(1).max(256),
  verifierId: identifierSchema,
  verifierVersion: boundedLabelSchema,
  verifierKind: z.enum(['lifecycle', 'schema', 'test', 'manual']),
  claim: z.enum(['lifecycle-terminal', 'criteria-satisfied', 'artifact-produced', 'manual-accepted']),
  result: z.enum(['pass', 'fail', 'unknown']),
  authority: z.enum(['dsh', 'adapter', 'verifier', 'user', 'model-claim']),
  observedAt: z.number().finite().nonnegative(),
  evidenceEventIds: z.array(digestSchema).min(1).max(64),
  artifacts: z.array(artifactReferenceSchema).max(64),
}).strict()
export type EvidenceReceipt = z.infer<typeof evidenceReceiptSchema>

export const conformanceFindingCodeSchema = z.enum([
  'unexpected-actual',
  'missing-planned',
  'order-violation',
  'configuration-drift',
  'handoff-mismatch',
  'evidence-missing',
  'verifier-failed',
  'lifecycle-incomplete',
  'attempt-unsuccessful',
  'unbound-actual',
  'unknown',
])
export type ConformanceFindingCode = z.infer<typeof conformanceFindingCodeSchema>

export const conformanceFindingSchema = z.object({
  schemaVersion: z.literal(1),
  findingId: digestSchema,
  code: conformanceFindingCodeSchema,
  status: z.enum(['open', 'resolved']),
  severity: z.enum(['info', 'warning', 'blocking']),
  certainty: findingCertaintySchema,
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  taskId: identifierSchema.optional(),
  attemptId: z.string().min(1).max(256).optional(),
  firstObservedAt: z.number().finite().nonnegative(),
  evidenceEventIds: z.array(digestSchema).max(64),
  detail: z.object({
    expected: boundedLabelSchema.optional(),
    actual: boundedLabelSchema.optional(),
    dependencyTaskId: identifierSchema.optional(),
    verifierId: identifierSchema.optional(),
  }).strict().optional(),
}).strict()
export type ConformanceFinding = z.infer<typeof conformanceFindingSchema>

export const taskConformanceSchema = z.object({
  taskId: identifierSchema,
  state: conformanceStateSchema,
  attemptId: z.string().min(1).max(256).optional(),
  lifecycleStatus: z.string().min(1).max(64).optional(),
  evidenceStatus: z.enum(['verified', 'failed', 'missing', 'not-required', 'unknown']),
  findingIds: z.array(digestSchema).max(64),
}).strict()
export type TaskConformance = z.infer<typeof taskConformanceSchema>

export const conformanceReportSchema = z.object({
  schemaVersion: z.literal(1),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  eventCursor: z.number().int().nonnegative(),
  generatedAt: z.number().finite().nonnegative(),
  state: conformanceStateSchema,
  firstProvableDivergenceId: digestSchema.optional(),
  tasks: z.array(taskConformanceSchema).max(128),
  findings: z.array(conformanceFindingSchema).max(1_024),
}).strict()
export type ConformanceReport = z.infer<typeof conformanceReportSchema>

export const recoveryActionSchema = z.object({
  actionId: digestSchema,
  kind: z.enum(['resume', 'retry', 'replay', 'fork', 'reassign']),
  taskId: identifierSchema,
  effectSafe: z.boolean(),
  backendExecutable: z.boolean(),
  support: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  reasonCode: z.enum([
    'supported-read-only',
    'idempotency-required',
    'compensation-required',
    'irreversible-effect',
    'unknown-effect',
    'backend-unsupported',
    'already-verified',
  ]),
}).strict()
export type RecoveryAction = z.infer<typeof recoveryActionSchema>

export const recoveryProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: digestSchema,
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  capabilityDigest: z.string().min(1).max(256),
  eventCursor: z.number().int().nonnegative(),
  createdAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative(),
  divergenceIds: z.array(digestSchema).max(1_024),
  affectedTaskIds: z.array(identifierSchema).max(128),
  reusableTaskIds: z.array(identifierSchema).max(128),
  actions: z.array(recoveryActionSchema).max(256),
  blockedReasonCodes: z.array(z.string().min(1).max(128)).max(256),
  requiresApproval: z.literal(true),
}).strict()
export type RecoveryProposal = z.infer<typeof recoveryProposalSchema>

export const adapterFactSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  adapterId: z.enum(['workflow', 'agent-team']),
  adapterVersion: boundedLabelSchema,
  capturedAt: z.number().finite().nonnegative(),
  available: z.boolean(),
  lifecycleAuthority: z.enum(['dsh-public-events', 'unavailable']),
  bindingMode: z.enum(['exact-contract-id', 'unavailable']),
  controlSupport: z.object({
    cancel: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
    resume: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
    retry: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
    replay: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
    fork: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
    reassign: z.enum(['enforced', 'advisory', 'unsupported', 'unknown']),
  }).strict(),
}).strict()
export type AdapterFactSnapshot = z.infer<typeof adapterFactSnapshotSchema>

export const foundrySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().uuid(),
  hostStartedAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  eventCursor: z.number().int().nonnegative(),
  capturedAt: z.number().finite(),
  durability: z.enum(['disk', 'memory']),
  storageStatus: z.enum(['ready', 'disabled', 'degraded']),
  projectionDigest: digestSchema,
  adapterFacts: z.array(adapterFactSnapshotSchema).max(8),
  plans: z.array(agentPlanRevisionSchema).max(5_000),
  executions: z.array(planExecutionSchema).max(5_000),
  events: z.array(foundryEventEnvelopeSchema).max(50_000),
  receipts: z.array(evidenceReceiptSchema).max(10_000),
  reports: z.array(conformanceReportSchema).max(5_000),
  recoveryProposals: z.array(recoveryProposalSchema).max(5_000),
}).strict()
export type FoundrySnapshot = z.infer<typeof foundrySnapshotSchema>

export const listFoundryRunsRequestSchema = z.object({
  parentSessionIds: z.array(z.string().min(1).max(256)).min(1).max(64),
}).strict()
export type ListFoundryRunsRequest = z.infer<typeof listFoundryRunsRequestSchema>

export const watchFoundryRunsRequestSchema = listFoundryRunsRequestSchema.extend({
  hostInstanceId: z.string().uuid().optional(),
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(25_000),
}).strict()
export type WatchFoundryRunsRequest = z.infer<typeof watchFoundryRunsRequestSchema>

export const LIST_FOUNDRY_RUNS_ENDPOINT = 'foundry.list'
export const WATCH_FOUNDRY_RUNS_ENDPOINT = 'foundry.watch'

export const runQueryKindSchema = z.enum([
  'summary',
  'why-running',
  'first-divergence',
  'active-tasks',
  'configuration',
  'cancel-impact',
  'recovery-impact',
  'evidence',
])
export type RunQueryKind = z.infer<typeof runQueryKindSchema>

export const inspectRunRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  kind: runQueryKindSchema,
  taskId: identifierSchema.optional(),
  throughCursor: z.number().int().nonnegative().optional(),
}).strict()
export type InspectRunRequest = z.infer<typeof inspectRunRequestSchema>

export const runFactSchema = z.object({
  factId: digestSchema,
  category: z.enum(['lifecycle', 'plan', 'attempt', 'finding', 'evidence', 'recovery', 'configuration']),
  label: boundedLabelSchema,
  value: z.string().trim().min(1).max(2_000),
  certainty: findingCertaintySchema,
  taskId: identifierSchema.optional(),
  attemptId: z.string().min(1).max(256).optional(),
  evidenceEventIds: z.array(digestSchema).max(64),
  findingIds: z.array(digestSchema).max(64),
}).strict()
export type RunFact = z.infer<typeof runFactSchema>

export const inspectRunResultSchema = z.object({
  schemaVersion: z.literal(1),
  queryId: digestSchema,
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  kind: runQueryKindSchema,
  throughCursor: z.number().int().nonnegative(),
  state: conformanceStateSchema,
  answerCode: z.enum(['facts-available', 'insufficient-evidence', 'run-not-found']),
  facts: z.array(runFactSchema).max(128),
  hypotheses: z.array(z.object({
    text: z.string().trim().min(1).max(2_000),
    certainty: z.literal('hypothesis'),
  }).strict()).max(16),
}).strict()
export type InspectRunResult = z.infer<typeof inspectRunResultSchema>

export const INSPECT_FOUNDRY_RUN_ENDPOINT = 'foundry.inspect'

export const exportRunCapsuleRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  includeObjective: z.boolean().default(false),
  includeTaskBriefs: z.boolean().default(false),
}).strict()
export type ExportRunCapsuleRequest = z.infer<typeof exportRunCapsuleRequestSchema>

export const runCapsuleManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generator: z.object({
    name: z.literal('dsh-product-subagent-console'),
    version: boundedLabelSchema,
  }).strict(),
  createdAt: z.number().finite().nonnegative(),
  policy: z.object({
    includeObjective: z.boolean(),
    includeTaskBriefs: z.boolean(),
    redactedFields: z.array(z.enum([
      'prompt', 'raw-output', 'stderr', 'environment', 'absolute-path', 'credential', 'reasoning',
    ])).min(1).max(16),
    limits: z.object({
      maxEvents: z.literal(500),
      maxReceipts: z.literal(100),
      maxFindings: z.literal(100),
      maxArtifactsPerRecord: z.literal(4),
      sourceEvents: z.number().int().nonnegative(),
      sourceReceipts: z.number().int().nonnegative(),
      sourceFindings: z.number().int().nonnegative(),
      sourceArtifacts: z.number().int().nonnegative(),
      exportedEvents: z.number().int().nonnegative(),
      exportedReceipts: z.number().int().nonnegative(),
      exportedFindings: z.number().int().nonnegative(),
      exportedArtifacts: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }).strict(),
  }).strict(),
  run: z.object({
    parentSessionDigest: digestSchema,
    runDigest: digestSchema,
    planDigest: digestSchema,
    planRevision: z.number().int().positive(),
    eventCursor: z.number().int().nonnegative(),
    projectionDigest: digestSchema,
  }).strict(),
  plan: z.object({
    title: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(8_000).optional(),
    pattern: planContractV2Schema.shape.pattern,
    roles: z.array(z.object({
      roleId: digestSchema,
      name: z.string().trim().min(1).max(80),
      transportProvider: boundedLabelSchema,
      reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']).optional(),
      toolPolicy: z.object({
        mode: z.enum(['inherit', 'allowlist']),
        tools: z.array(boundedLabelSchema).max(128),
      }).strict(),
    }).strict()).min(1).max(32),
    tasks: z.array(z.object({
      taskId: digestSchema,
      title: z.string().trim().min(1).max(160),
      roleId: digestSchema,
      dependencies: z.array(z.object({
        taskId: digestSchema,
        mode: z.enum(['order-only', 'context']),
      }).strict()).max(64),
      effectKind: taskEffectSchema.shape.kind,
      verifiers: z.array(z.object({
        verifierId: digestSchema,
        kind: verifierContractSchema.shape.kind,
        required: z.boolean(),
      }).strict()).max(16),
      brief: z.string().trim().min(1).max(8_000).optional(),
    }).strict()).min(1).max(128),
  }).strict(),
  execution: z.object({
    status: z.custom<PlanExecutionStatus>((value) => (
      typeof value === 'string'
      && ['queued', 'running', 'stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(value)
    )),
    cancellationRequested: z.boolean(),
    durationMs: z.number().finite().nonnegative().optional(),
    bindings: z.array(z.object({
      taskId: digestSchema,
      attemptId: digestSchema,
      attemptNumber: z.number().int().positive(),
      status: z.custom<PlanAttemptStatus>((value) => (
        typeof value === 'string'
        && ['queued', 'starting', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown'].includes(value)
      )),
      childId: digestSchema.optional(),
      durationMs: z.number().finite().nonnegative().optional(),
    }).strict()).max(512),
  }).strict(),
  report: z.object({
    state: conformanceStateSchema,
    eventCursor: z.number().int().nonnegative(),
    firstProvableDivergenceId: digestSchema.optional(),
    tasks: z.array(z.object({
      taskId: digestSchema,
      state: conformanceStateSchema,
      lifecycleStatus: z.string().min(1).max(64).optional(),
      evidenceStatus: z.enum(['verified', 'failed', 'missing', 'not-required', 'unknown']),
      findingIds: z.array(digestSchema).max(64),
    }).strict()).max(128),
    findings: z.array(z.object({
      findingId: digestSchema,
      code: conformanceFindingCodeSchema,
      status: z.enum(['open', 'resolved']),
      severity: z.enum(['info', 'warning', 'blocking']),
      certainty: findingCertaintySchema,
      taskId: digestSchema.optional(),
      attemptId: digestSchema.optional(),
      evidenceEventIds: z.array(digestSchema).max(64),
    }).strict()).max(100),
  }).strict(),
  recoveryProposal: z.object({
    proposalId: digestSchema,
    eventCursor: z.number().int().nonnegative(),
    affectedTaskIds: z.array(digestSchema).max(128),
    reusableTaskIds: z.array(digestSchema).max(128),
    actions: z.array(z.object({
      actionId: digestSchema,
      kind: recoveryActionSchema.shape.kind,
      taskId: digestSchema,
      allowed: z.boolean(),
      requiresApproval: z.boolean(),
      reasonCode: recoveryActionSchema.shape.reasonCode,
    }).strict()).max(256),
    blockedReasonCodes: z.array(z.string().min(1).max(128)).max(256),
    requiresApproval: z.literal(true),
  }).strict().optional(),
  events: z.array(z.object({
    eventId: digestSchema,
    cursor: z.number().int().positive(),
    type: foundryEventTypeSchema,
    authority: foundryAuthoritySchema,
    occurredOffsetMs: z.number().finite().optional(),
    taskId: digestSchema.optional(),
    attemptId: digestSchema.optional(),
    executionStatus: z.custom<PlanExecutionStatus>((value) => (
      typeof value === 'string'
      && ['queued', 'running', 'stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(value)
    )).optional(),
    attemptStatus: z.custom<PlanAttemptStatus>((value) => (
      typeof value === 'string'
      && ['queued', 'starting', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown'].includes(value)
    )).optional(),
    terminalReason: foundryEventEnvelopeSchema.shape.terminalReason,
    controlResult: foundryEventEnvelopeSchema.shape.controlResult,
    artifacts: z.array(z.object({
      artifactId: digestSchema,
      kind: artifactReferenceSchema.shape.kind,
      digest: digestSchema,
      mediaType: z.string().trim().min(1).max(128).optional(),
    }).strict()).max(4),
  }).strict()).max(500),
  receipts: z.array(z.object({
    receiptId: digestSchema,
    taskId: digestSchema,
    attemptId: digestSchema,
    verifierId: digestSchema,
    verifierVersion: boundedLabelSchema,
    verifierKind: evidenceReceiptSchema.shape.verifierKind,
    claim: evidenceReceiptSchema.shape.claim,
    result: evidenceReceiptSchema.shape.result,
    authority: evidenceReceiptSchema.shape.authority,
    observedOffsetMs: z.number().finite(),
    evidenceEventIds: z.array(digestSchema).min(1).max(64),
    artifacts: z.array(z.object({
      artifactId: digestSchema,
      kind: artifactReferenceSchema.shape.kind,
      digest: digestSchema,
      mediaType: z.string().trim().min(1).max(128).optional(),
    }).strict()).max(4),
  }).strict()).max(100),
  manifestDigest: digestSchema,
}).strict().superRefine((manifest, context) => {
  const issue = (path: readonly (string | number)[], message: string): void => {
    context.addIssue({ code: 'custom', path: [...path], message })
  }
  const unique = (values: readonly string[], path: readonly (string | number)[]): Set<string> => {
    const seen = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) issue([...path, index], 'identity must be unique')
      seen.add(value)
    }
    return seen
  }
  const roles = unique(manifest.plan.roles.map(role => role.roleId), ['plan', 'roles'])
  const tasks = unique(manifest.plan.tasks.map(task => task.taskId), ['plan', 'tasks'])
  const attempts = unique(manifest.execution.bindings.map(binding => binding.attemptId), ['execution', 'bindings'])
  const findings = unique(manifest.report.findings.map(finding => finding.findingId), ['report', 'findings'])
  const events = unique(manifest.events.map(event => event.eventId), ['events'])
  unique(manifest.receipts.map(receipt => receipt.receiptId), ['receipts'])
  const reportTasks = unique(manifest.report.tasks.map(task => task.taskId), ['report', 'tasks'])
  const bindingsByAttempt = new Map(manifest.execution.bindings.map(binding => [binding.attemptId, binding] as const))
  const eventsById = new Map(manifest.events.map(event => [event.eventId, event] as const))
  const findingsById = new Map(manifest.report.findings.map(finding => [finding.findingId, finding] as const))
  const reportTasksById = new Map(manifest.report.tasks.map(task => [task.taskId, task] as const))
  const maxEventCursor = manifest.events.reduce((maximum, event) => Math.max(maximum, event.cursor), 0)
  if (
    manifest.run.eventCursor !== manifest.report.eventCursor
    || manifest.run.eventCursor !== maxEventCursor
  ) issue(['run', 'eventCursor'], 'run, report, and exported Event cursors must match')
  if (reportTasks.size !== tasks.size || [...tasks].some(taskId => !reportTasks.has(taskId))) {
    issue(['report', 'tasks'], 'report tasks must cover every plan task exactly once')
  }

  for (const [index, task] of manifest.plan.tasks.entries()) {
    if (!roles.has(task.roleId)) issue(['plan', 'tasks', index, 'roleId'], 'roleId must resolve')
    for (const [dependencyIndex, dependency] of task.dependencies.entries()) {
      if (!tasks.has(dependency.taskId)) issue(['plan', 'tasks', index, 'dependencies', dependencyIndex, 'taskId'], 'dependency taskId must resolve')
      if (dependency.taskId === task.taskId) issue(['plan', 'tasks', index, 'dependencies', dependencyIndex, 'taskId'], 'task cannot depend on itself')
    }
  }
  for (const [index, role] of manifest.plan.roles.entries()) {
    if (role.toolPolicy.mode === 'inherit' && role.toolPolicy.tools.length > 0) {
      issue(['plan', 'roles', index, 'toolPolicy', 'tools'], 'inherit tool policy cannot contain explicit tools')
    }
  }
  const attemptNumbersByTask = new Map<string, Set<number>>()
  for (const [index, binding] of manifest.execution.bindings.entries()) {
    if (!tasks.has(binding.taskId)) issue(['execution', 'bindings', index, 'taskId'], 'binding taskId must resolve')
    const numbers = attemptNumbersByTask.get(binding.taskId) ?? new Set<number>()
    if (numbers.has(binding.attemptNumber)) {
      issue(['execution', 'bindings', index, 'attemptNumber'], 'attemptNumber must be unique within one task')
    }
    numbers.add(binding.attemptNumber)
    attemptNumbersByTask.set(binding.taskId, numbers)
  }
  for (const [index, event] of manifest.events.entries()) {
    if (index > 0 && event.cursor <= manifest.events[index - 1]!.cursor) {
      issue(['events', index, 'cursor'], 'Event cursors must be unique and strictly increasing')
    }
    if (event.taskId !== undefined && !tasks.has(event.taskId)) issue(['events', index, 'taskId'], 'Event taskId must resolve')
    if (event.attemptId !== undefined && !attempts.has(event.attemptId)) issue(['events', index, 'attemptId'], 'Event attemptId must resolve')
    if (
      event.taskId !== undefined
      && event.attemptId !== undefined
      && bindingsByAttempt.get(event.attemptId)?.taskId !== event.taskId
    ) issue(['events', index], 'Event task and attempt must resolve to the same binding')
  }
  for (const [index, task] of manifest.report.tasks.entries()) {
    if (!tasks.has(task.taskId)) issue(['report', 'tasks', index, 'taskId'], 'report taskId must resolve')
    const taskFindingIds = unique(task.findingIds, ['report', 'tasks', index, 'findingIds'])
    for (const [findingIndex, findingId] of task.findingIds.entries()) {
      if (!findings.has(findingId)) issue(['report', 'tasks', index, 'findingIds', findingIndex], 'findingId must resolve')
      if (findingsById.get(findingId)?.taskId !== task.taskId) {
        issue(['report', 'tasks', index, 'findingIds', findingIndex], 'findingId must belong to the same report task')
      }
    }
    if (taskFindingIds.size !== task.findingIds.length) issue(['report', 'tasks', index, 'findingIds'], 'findingIds must be unique')
  }
  if (manifest.report.firstProvableDivergenceId !== undefined) {
    const first = findingsById.get(manifest.report.firstProvableDivergenceId)
    if (first === undefined || first.status !== 'open' || first.certainty !== 'proven') {
      issue(['report', 'firstProvableDivergenceId'], 'first divergence must resolve to an open proven finding')
    }
  }
  for (const [index, finding] of manifest.report.findings.entries()) {
    if (finding.taskId !== undefined && !tasks.has(finding.taskId)) issue(['report', 'findings', index, 'taskId'], 'finding taskId must resolve')
    if (finding.taskId !== undefined && reportTasksById.get(finding.taskId)?.findingIds.includes(finding.findingId) !== true) {
      issue(['report', 'findings', index, 'findingId'], 'task-scoped finding must be owned by its report task')
    }
    if (finding.attemptId !== undefined && !attempts.has(finding.attemptId)) issue(['report', 'findings', index, 'attemptId'], 'finding attemptId must resolve')
    if (
      finding.attemptId !== undefined
      && finding.taskId !== undefined
      && bindingsByAttempt.get(finding.attemptId)?.taskId !== finding.taskId
    ) issue(['report', 'findings', index], 'finding task and attempt must resolve to the same binding')
    for (const [eventIndex, eventId] of finding.evidenceEventIds.entries()) {
      if (!events.has(eventId)) issue(['report', 'findings', index, 'evidenceEventIds', eventIndex], 'evidence event must resolve')
      const event = eventsById.get(eventId)
      if (event?.taskId !== undefined && finding.taskId !== undefined && event.taskId !== finding.taskId) {
        issue(['report', 'findings', index, 'evidenceEventIds', eventIndex], 'finding Evidence Event task must match')
      }
      if (event?.attemptId !== undefined && finding.attemptId !== undefined && event.attemptId !== finding.attemptId) {
        issue(['report', 'findings', index, 'evidenceEventIds', eventIndex], 'finding Evidence Event attempt must match')
      }
    }
  }
  for (const [index, receipt] of manifest.receipts.entries()) {
    if (!tasks.has(receipt.taskId)) issue(['receipts', index, 'taskId'], 'receipt taskId must resolve')
    if (!attempts.has(receipt.attemptId)) issue(['receipts', index, 'attemptId'], 'receipt attemptId must resolve')
    if (bindingsByAttempt.get(receipt.attemptId)?.taskId !== receipt.taskId) {
      issue(['receipts', index], 'receipt task and attempt must resolve to the same binding')
    }
    const verifier = manifest.plan.tasks
      .find(task => task.taskId === receipt.taskId)
      ?.verifiers.find(candidate => candidate.verifierId === receipt.verifierId)
    if (verifier === undefined || verifier.kind !== receipt.verifierKind) {
      issue(['receipts', index, 'verifierId'], 'receipt verifier must resolve with the same kind')
    } else if (!capsuleReceiptClaimMatches(receipt.claim, verifier.kind)) {
      issue(['receipts', index, 'claim'], 'receipt claim does not match verifier kind')
    }
    for (const [eventIndex, eventId] of receipt.evidenceEventIds.entries()) {
      if (!events.has(eventId)) issue(['receipts', index, 'evidenceEventIds', eventIndex], 'evidence event must resolve')
      const event = eventsById.get(eventId)
      if (event?.taskId !== receipt.taskId || event.attemptId !== receipt.attemptId) {
        issue(['receipts', index, 'evidenceEventIds', eventIndex], 'receipt Evidence Event must match task and attempt')
      }
    }
  }
  if (manifest.recoveryProposal !== undefined) {
    if (manifest.recoveryProposal.eventCursor !== manifest.run.eventCursor) {
      issue(['recoveryProposal', 'eventCursor'], 'recovery proposal cursor must match the exported run')
    }
    const affected = new Set(manifest.recoveryProposal.affectedTaskIds)
    for (const [index, taskId] of manifest.recoveryProposal.affectedTaskIds.entries()) {
      if (!tasks.has(taskId)) issue(['recoveryProposal', 'affectedTaskIds', index], 'affected taskId must resolve')
    }
    for (const [index, taskId] of manifest.recoveryProposal.reusableTaskIds.entries()) {
      if (!tasks.has(taskId)) issue(['recoveryProposal', 'reusableTaskIds', index], 'reusable taskId must resolve')
      if (affected.has(taskId)) issue(['recoveryProposal', 'reusableTaskIds', index], 'reusable and affected tasks must be disjoint')
    }
    for (const [index, action] of manifest.recoveryProposal.actions.entries()) {
      if (!tasks.has(action.taskId)) issue(['recoveryProposal', 'actions', index, 'taskId'], 'action taskId must resolve')
      if (!affected.has(action.taskId)) issue(['recoveryProposal', 'actions', index, 'taskId'], 'recovery action task must be affected')
      if (!action.requiresApproval) issue(['recoveryProposal', 'actions', index, 'requiresApproval'], 'recovery actions require approval')
    }
  }
  const limits = manifest.policy.limits
  const exportedArtifacts = manifest.events.reduce((sum, event) => sum + event.artifacts.length, 0)
    + manifest.receipts.reduce((sum, receipt) => sum + receipt.artifacts.length, 0)
  if (
    limits.exportedEvents !== manifest.events.length
    || limits.exportedReceipts !== manifest.receipts.length
    || limits.exportedFindings !== manifest.report.findings.length
    || limits.exportedArtifacts !== exportedArtifacts
  ) {
    issue(['policy', 'limits'], 'exported counts must match manifest contents')
  }
  if (manifest.events.length > limits.maxEvents || manifest.receipts.length > limits.maxReceipts || manifest.report.findings.length > limits.maxFindings) {
    issue(['policy', 'limits'], 'manifest exceeds its declared export limits')
  }
  if (
    limits.sourceEvents < limits.exportedEvents
    || limits.sourceReceipts < limits.exportedReceipts
    || limits.sourceFindings < limits.exportedFindings
    || limits.sourceArtifacts < limits.exportedArtifacts
  ) {
    issue(['policy', 'limits'], 'source counts cannot be smaller than exported counts')
  }
  const actuallyTruncated = limits.sourceEvents > limits.exportedEvents
    || limits.sourceReceipts > limits.exportedReceipts
    || limits.sourceFindings > limits.exportedFindings
    || limits.sourceArtifacts > limits.exportedArtifacts
  if (limits.truncated !== actuallyTruncated) {
    issue(['policy', 'limits', 'truncated'], 'truncated must match the recorded source and exported counts')
  }
  if (manifest.policy.includeObjective !== (manifest.plan.objective !== undefined)) {
    issue(['policy', 'includeObjective'], 'includeObjective must match objective presence')
  }
  const hasEveryTaskBrief = manifest.plan.tasks.every(task => task.brief !== undefined)
  const hasAnyTaskBrief = manifest.plan.tasks.some(task => task.brief !== undefined)
  if (
    (manifest.policy.includeTaskBriefs && !hasEveryTaskBrief)
    || (!manifest.policy.includeTaskBriefs && hasAnyTaskBrief)
  ) {
    issue(['policy', 'includeTaskBriefs'], 'includeTaskBriefs must match task brief presence')
  }
  const expectedRedactions = [
    'absolute-path', 'credential', 'environment', 'prompt', 'raw-output', 'reasoning', 'stderr',
  ]
  const actualRedactions = [...new Set(manifest.policy.redactedFields)].sort()
  if (
    actualRedactions.length !== manifest.policy.redactedFields.length
    || actualRedactions.join('\u0000') !== expectedRedactions.join('\u0000')
  ) {
    issue(['policy', 'redactedFields'], 'redactedFields must contain the complete policy exactly once')
  }
})
export type RunCapsuleManifest = z.infer<typeof runCapsuleManifestSchema>

function capsuleReceiptClaimMatches(
  claim: z.infer<typeof evidenceReceiptSchema>['claim'],
  kind: z.infer<typeof verifierContractSchema>['kind'],
): boolean {
  if (kind === 'lifecycle') return claim === 'lifecycle-terminal'
  if (kind === 'manual') return claim === 'manual-accepted'
  return claim === 'criteria-satisfied' || claim === 'artifact-produced'
}

export const exportRunCapsuleResultSchema = z.object({
  fileName: z.string().min(1).max(256),
  manifest: runCapsuleManifestSchema,
  html: z.string().min(1).max(8 * 1024 * 1024),
}).strict()
export type ExportRunCapsuleResult = z.infer<typeof exportRunCapsuleResultSchema>
export const EXPORT_RUN_CAPSULE_ENDPOINT = 'foundry.capsule.export'

export const recipeCandidateRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  executionIds: z.array(z.string().uuid()).min(3).max(50),
}).strict()
export type RecipeCandidateRequest = z.infer<typeof recipeCandidateRequestSchema>

export const recipeCandidateSchema = z.object({
  schemaVersion: z.literal(2),
  candidateId: digestSchema,
  createdAt: z.number().finite().nonnegative(),
  status: z.literal('tested'),
  title: z.string().trim().min(1).max(160),
  planFingerprint: digestSchema,
  capabilityDigest: z.string().min(1).max(256),
  verifierFingerprint: digestSchema,
  sourceRunDigests: z.array(digestSchema).min(3).max(50),
  validation: z.object({
    kind: z.literal('historical-verified-runs'),
    passed: z.literal(true),
    runCount: z.number().int().min(3).max(50),
    permissionStatus: z.enum(['explicit-not-attested', 'inherited-unresolved']),
    reasonCodes: z.array(z.enum([
      'explicit-tools-not-attested',
      'inherits-parent-tools',
    ])).min(1).max(8),
  }).strict(),
  parameters: z.array(z.object({
    name: identifierSchema,
    target: z.enum(['objective']),
    required: z.boolean(),
    description: z.string().trim().min(1).max(1_000),
  }).strict()).max(16),
  permissionProfile: z.object({
    roles: z.array(z.object({
      roleId: identifierSchema,
      transportProvider: boundedLabelSchema,
      contextMode: z.enum(['fresh', 'fork']),
      toolPolicy: z.object({
        mode: z.enum(['inherit', 'allowlist']),
        tools: z.array(boundedLabelSchema).max(64),
      }).strict(),
      authority: z.enum(['explicit', 'inherited-unresolved']),
    }).strict()).min(1).max(32),
  }).strict(),
  capabilityRequirements: z.object({
    backendPreference: z.enum(['auto', 'workflow', 'agent-team']),
    transportProviders: z.array(boundedLabelSchema).max(32),
    verifiers: z.array(z.object({
      taskId: identifierSchema,
      verifierId: identifierSchema,
      kind: z.enum(['lifecycle', 'schema', 'test', 'manual']),
      required: z.boolean(),
    }).strict()).max(2_048),
  }).strict(),
  budgetEnvelope: agentPlanContentSchema.shape.budget,
  planTemplate: agentPlanContentSchema.omit({ objective: true }).extend({
    objective: z.literal('{{objective}}'),
  }),
  exportApprovalDigest: digestSchema,
}).strict()
export type RecipeCandidate = z.infer<typeof recipeCandidateSchema>

export const exportRecipeRequestSchema = recipeCandidateRequestSchema.extend({
  candidateId: digestSchema,
  approvalDigest: digestSchema,
}).strict()
export type ExportRecipeRequest = z.infer<typeof exportRecipeRequestSchema>

export const exportRecipeResultSchema = z.object({
  fileName: z.string().min(1).max(256),
  recipeJson: z.string().min(1).max(2 * 1024 * 1024),
  skillFiles: z.array(z.object({
    path: z.string().min(1).max(256),
    content: z.string().max(2 * 1024 * 1024),
    digest: digestSchema,
  }).strict()).min(2).max(8),
}).strict()
export type ExportRecipeResult = z.infer<typeof exportRecipeResultSchema>
export const PREVIEW_RECIPE_ENDPOINT = 'foundry.recipe.preview'
export const EXPORT_RECIPE_ENDPOINT = 'foundry.recipe.export'

export const instantiateRecipeRequestSchema = recipeCandidateRequestSchema.extend({
  candidateId: digestSchema,
  objective: z.string().trim().min(1).max(8_000),
}).strict()
export type InstantiateRecipeRequest = z.infer<typeof instantiateRecipeRequestSchema>

export const instantiateRecipeResultSchema = z.object({
  plan: agentPlanRevisionSchema,
  preflight: planPreflightResultSchema,
}).strict()
export type InstantiateRecipeResult = z.infer<typeof instantiateRecipeResultSchema>
export const INSTANTIATE_RECIPE_ENDPOINT = 'foundry.recipe.instantiate'

export const compareRunsRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  executionIds: z.array(z.string().uuid()).min(2).max(100),
}).strict()
export type CompareRunsRequest = z.infer<typeof compareRunsRequestSchema>

export const runAdvisorResultSchema = z.object({
  schemaVersion: z.literal(1),
  comparisonId: digestSchema,
  status: z.enum(['sufficient', 'insufficient-evidence']),
  reasonCodes: z.array(z.enum([
    'non-comparable-contracts',
    'capability-mismatch',
    'verifier-mismatch',
    'too-few-single-agent-runs',
    'too-few-multi-agent-runs',
    'ambiguous-agent-count',
    'unverified-runs',
  ])).max(16),
  groups: z.array(z.object({
    kind: z.enum(['single-agent', 'multi-agent']),
    executionIds: z.array(z.string().uuid()).max(100),
    verifiedRuns: z.number().int().nonnegative(),
    medianDurationMs: z.number().finite().nonnegative().optional(),
    verifierPassRate: z.number().min(0).max(1).optional(),
  }).strict()).max(2),
  recommendation: z.enum(['single-agent', 'multi-agent', 'no-claim']),
}).strict()
export type RunAdvisorResult = z.infer<typeof runAdvisorResultSchema>
export const COMPARE_FOUNDRY_RUNS_ENDPOINT = 'foundry.compare'

export const exportTelemetryRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().uuid(),
}).strict()
export type ExportTelemetryRequest = z.infer<typeof exportTelemetryRequestSchema>
export const exportTelemetryResultSchema = z.object({
  enabled: z.boolean(),
  format: z.literal('otlp-json-preview'),
  payload: z.string().max(4 * 1024 * 1024),
}).strict()
export type ExportTelemetryResult = z.infer<typeof exportTelemetryResultSchema>
export const EXPORT_TELEMETRY_ENDPOINT = 'foundry.telemetry.export'

export const issueCancelGrantRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().uuid(),
  proposalId: digestSchema,
  eventCursor: z.number().int().nonnegative(),
}).strict()
export type IssueCancelGrantRequest = z.infer<typeof issueCancelGrantRequestSchema>

export const foundryControlGrantSchema = z.object({
  grantId: z.string().uuid(),
  action: z.literal('cancel'),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().uuid(),
  proposalId: digestSchema,
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  capabilityDigest: z.string().min(1).max(256),
  issuedCursor: z.number().int().positive(),
  expiresAt: z.number().finite().nonnegative(),
}).strict()
export type FoundryControlGrant = z.infer<typeof foundryControlGrantSchema>

export const executeCancelControlRequestSchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().uuid(),
  grantId: z.string().uuid(),
}).strict()
export type ExecuteCancelControlRequest = z.infer<typeof executeCancelControlRequestSchema>

export const executeCancelControlResultSchema = z.object({
  status: z.enum(['requested', 'already-terminal', 'already-requested', 'not-found', 'stale-grant', 'interrupted']),
}).strict()
export type ExecuteCancelControlResult = z.infer<typeof executeCancelControlResultSchema>

export const ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT = 'foundry.control.cancel.grant'
export const EXECUTE_CANCEL_CONTROL_ENDPOINT = 'foundry.control.cancel.execute'
