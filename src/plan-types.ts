import { z } from 'zod'

const identifierSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const boundedNameSchema = z.string().trim().min(1).max(128)
const boundedTextSchema = z.string().trim().min(1).max(8_000)

function canonicalResourceClaim(value: string): string {
  const segments = value.trim().replaceAll('\\', '/').split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  return segments.length === 0 ? '.' : segments.join('/')
}

const resourceClaimSchema = z.string().trim().min(1).max(256).superRefine((value, context) => {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').includes('..')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'resource claims must be relative identifiers without parent traversal',
    })
  }
}).transform(canonicalResourceClaim)

export const capabilitySupportSchema = z.enum(['enforced', 'advisory', 'unsupported', 'unknown'])
export type CapabilitySupport = z.infer<typeof capabilitySupportSchema>

/** Safe machine reasons carried in the bounded prefix of planner command errors. */
export const plannerRpcReasonSchema = z.enum([
  'agent-scope-unavailable',
  'already-active',
  'capacity-reached',
  'execution-tool-unavailable',
  'forbidden',
  'invalid-request',
  'not-approved',
  'not-found',
  'preflight-blocked',
  'revision-conflict',
  'stale-capabilities',
  'workflow-unavailable',
])
export type PlannerRpcReason = z.infer<typeof plannerRpcReasonSchema>

/** Values accepted inside task output schemas and across the planner RPC boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isBoundedJsonValue(value: unknown): value is JsonValue {
  try {
    assertBoundedJsonValue(value)
    return true
  } catch {
    return false
  }
}

/** Validate without reconstructing objects so JSON Schema property names remain byte-for-byte intact. */
export const jsonValueSchema = z.unknown()
  .refine(isBoundedJsonValue, 'expected a bounded JSON value') as z.ZodType<JsonValue>

const jsonObjectSchema = z.unknown().refine(
  (value): value is { [key: string]: JsonValue } => (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && isBoundedJsonValue(value)
  ),
  'expected a bounded JSON object',
) as z.ZodType<{ [key: string]: JsonValue }>

export const planPatternSchema = z.enum([
  'single-agent',
  'manager-workers',
  'parallel-fanout-fanin',
  'sequential-dag',
  'competing-hypotheses',
  'peer-team',
])
export type PlanPattern = z.infer<typeof planPatternSchema>

export const planBackendSchema = z.enum(['workflow', 'agent-team'])
export type PlanBackend = z.infer<typeof planBackendSchema>

export const dependencyModeSchema = z.enum(['order-only', 'context'])
export type DependencyMode = z.infer<typeof dependencyModeSchema>

export const toolPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({
    mode: z.literal('allowlist'),
    tools: z.array(boundedNameSchema).max(64),
  }).strict(),
])
export type ToolPolicy = z.infer<typeof toolPolicySchema>

export const planBudgetSchema = z.object({
  maxAgents: z.number().int().min(1).max(32).default(5),
  maxConcurrent: z.number().int().min(1).max(16).default(4),
  planTimeoutMs: z.number().int().min(60_000).max(7_200_000).default(1_800_000),
  maxRequests: z.number().int().positive().max(10_000).optional(),
  maxTokens: z.number().int().positive().max(100_000_000).optional(),
  maxCostUsd: z.number().positive().max(100_000).optional(),
}).strict()
export type PlanBudget = z.infer<typeof planBudgetSchema>

export const planRoleSchema = z.object({
  roleId: identifierSchema,
  name: z.string().trim().min(1).max(80),
  responsibility: boundedTextSchema,
  boundaries: z.array(z.string().trim().min(1).max(1_000)).max(16).default([]),
  transportProvider: boundedNameSchema,
  llmProvider: boundedNameSchema.optional(),
  model: boundedNameSchema.optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']).optional(),
  agentPreset: boundedNameSchema.optional(),
  contextMode: z.enum(['fresh', 'fork']).default('fresh'),
  toolPolicy: toolPolicySchema.default({ mode: 'inherit' }),
}).strict()
export type PlanRole = z.infer<typeof planRoleSchema>

export const planDependencySchema = z.object({
  taskId: identifierSchema,
  mode: dependencyModeSchema,
}).strict()
export type PlanDependency = z.infer<typeof planDependencySchema>

export const planTaskSchema = z.object({
  taskId: identifierSchema,
  title: z.string().trim().min(1).max(160),
  brief: boundedTextSchema,
  roleId: identifierSchema,
  dependsOn: z.array(planDependencySchema).max(64).default([]),
  expectedOutput: z.object({
    description: z.string().trim().min(1).max(2_000),
    schema: jsonObjectSchema.optional(),
  }).strict(),
  completionCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(16),
  resourceClaims: z.array(resourceClaimSchema).max(32).default([]),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  approvalRequired: z.boolean().default(false),
  effect: z.object({
    kind: z.enum(['pure', 'idempotent', 'compensatable', 'irreversible', 'unknown']),
    idempotencyScope: z.string().trim().min(1).max(256).optional(),
    compensationRef: z.string().trim().min(1).max(256).optional(),
  }).strict().optional(),
  verifiers: z.array(z.object({
    verifierId: identifierSchema,
    kind: z.enum(['lifecycle', 'schema', 'test', 'manual']),
    description: z.string().trim().min(1).max(1_000),
    required: z.boolean().default(true),
  }).strict()).max(16).optional(),
  budgetHint: z.object({
    maxTokens: z.number().int().positive().max(10_000_000).optional(),
    maxCostUsd: z.number().positive().max(10_000).optional(),
  }).strict().optional(),
}).strict()
export type PlanTask = z.infer<typeof planTaskSchema>

export const agentPlanContentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  objective: boundedTextSchema,
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(24),
  recommendation: z.object({
    useMultiAgent: z.boolean(),
    rationale: z.string().trim().min(1).max(2_000),
    singleAgentAlternative: z.string().trim().min(1).max(2_000).optional(),
    userOverride: z.boolean().default(false),
  }).strict(),
  pattern: planPatternSchema,
  optimizationTarget: z.enum(['balanced', 'quality', 'latency', 'cost']).default('balanced'),
  backendPreference: z.enum(['auto', 'workflow', 'agent-team']).default('auto'),
  budget: planBudgetSchema,
  roles: z.array(planRoleSchema).min(1).max(32),
  tasks: z.array(planTaskSchema).min(1).max(128),
}).strict()
export type AgentPlanContent = z.infer<typeof agentPlanContentSchema>

export const planRevisionStateSchema = z.enum(['draft', 'approved', 'superseded'])
export type PlanRevisionState = z.infer<typeof planRevisionStateSchema>

export const agentPlanRevisionSchema = agentPlanContentSchema.extend({
  schemaVersion: z.literal(1),
  planId: z.string().uuid(),
  parentSessionId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  state: planRevisionStateSchema,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  capabilityDigest: z.string().min(1).max(256).optional(),
  acceptedWarningIds: z.array(z.string().min(1).max(256)).max(512).optional(),
}).strict()
export type AgentPlanRevision = z.infer<typeof agentPlanRevisionSchema>

export const planExecutionStatusSchema = z.enum([
  'queued',
  'running',
  'stopping',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'unknown',
])
export type PlanExecutionStatus = z.infer<typeof planExecutionStatusSchema>

export const planAttemptStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'waiting',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'skipped',
  'unknown',
])
export type PlanAttemptStatus = z.infer<typeof planAttemptStatusSchema>

export const planRunBindingSchema = z.object({
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  executionId: z.string().uuid(),
  taskId: identifierSchema,
  attemptId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  retryOf: z.string().uuid().optional(),
  status: planAttemptStatusSchema,
  workflowSeq: z.number().int().nonnegative().optional(),
  childId: z.string().min(1).max(256).optional(),
  teamMemberId: z.string().min(1).max(256).optional(),
  teamTaskId: z.string().min(1).max(256).optional(),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
}).strict()
export type PlanRunBinding = z.infer<typeof planRunBindingSchema>

export const planExecutionSchema = z.object({
  executionId: z.string().uuid(),
  planId: z.string().uuid(),
  planRevision: z.number().int().positive(),
  parentSessionId: z.string().min(1).max(256),
  backend: planBackendSchema,
  capabilityDigest: z.string().min(1).max(256),
  status: planExecutionStatusSchema,
  cancellationRequested: z.boolean().default(false),
  createdAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
  bindings: z.array(planRunBindingSchema).max(512).default([]),
}).strict().superRefine((execution, context) => {
  const terminalExecution = ['succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(execution.status)
  if (terminalExecution !== (execution.finishedAt !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: terminalExecution
        ? 'terminal executions require finishedAt'
        : 'nonterminal executions cannot contain finishedAt',
    })
  }
  if (execution.startedAt !== undefined && execution.startedAt < execution.createdAt) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt cannot precede createdAt' })
  }
  if (
    execution.finishedAt !== undefined
    && execution.startedAt !== undefined
    && execution.finishedAt < execution.startedAt
  ) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt cannot precede startedAt' })
  }
  const attemptIds = new Set<string>()
  const taskAttempts = new Map<string, Map<number, string>>()
  for (const [index, binding] of execution.bindings.entries()) {
    if (
      binding.planId !== execution.planId
      || binding.planRevision !== execution.planRevision
      || binding.executionId !== execution.executionId
    ) {
      context.addIssue({ code: 'custom', path: ['bindings', index], message: 'binding identity must match its execution' })
    }
    if (attemptIds.has(binding.attemptId)) {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'attemptId'], message: 'attemptId must be unique' })
    }
    attemptIds.add(binding.attemptId)
    const attempts = taskAttempts.get(binding.taskId) ?? new Map<number, string>()
    if (attempts.has(binding.attemptNumber)) {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'attemptNumber'], message: 'task attempt numbers must be unique' })
    }
    attempts.set(binding.attemptNumber, binding.attemptId)
    taskAttempts.set(binding.taskId, attempts)
    const terminalAttempt = [
      'completed', 'failed', 'cancelled', 'rejected', 'skipped', 'unknown',
    ].includes(binding.status)
    if (terminalAttempt !== (binding.finishedAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['bindings', index, 'finishedAt'],
        message: terminalAttempt
          ? 'terminal attempts require finishedAt'
          : 'nonterminal attempts cannot contain finishedAt',
      })
    }
    if (
      binding.finishedAt !== undefined
      && binding.startedAt !== undefined
      && binding.finishedAt < binding.startedAt
    ) {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'finishedAt'], message: 'attempt finishedAt cannot precede startedAt' })
    }
  }
  for (const [index, binding] of execution.bindings.entries()) {
    if (binding.retryOf === undefined) continue
    const previous = execution.bindings.find(candidate => candidate.attemptId === binding.retryOf)
    if (
      previous === undefined
      || previous.taskId !== binding.taskId
      || previous.attemptNumber >= binding.attemptNumber
    ) {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'retryOf'], message: 'retryOf must reference an earlier attempt for the same task' })
    }
  }
})
export type PlanExecution = z.infer<typeof planExecutionSchema>

export const transportProviderCapabilitySchema = z.object({
  name: boundedNameSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
  inheritsParentContext: z.boolean(),
  outputSchema: z.boolean(),
  depthLimit: z.boolean(),
  toolFilter: z.boolean(),
  persona: z.boolean(),
  continuable: z.boolean(),
  modelRouting: capabilitySupportSchema,
  maxTokens: capabilitySupportSchema,
}).strict()
export type TransportProviderCapability = z.infer<typeof transportProviderCapabilitySchema>

export const executionCapabilitySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.number().finite(),
  digest: z.string().min(1).max(256),
  catalogDigest: z.string().min(1).max(256),
  scopeStatus: z.enum(['available', 'unavailable']),
  adapters: z.object({
    workflow: z.boolean(),
    agentTeam: z.boolean(),
  }).strict(),
  transportProviders: z.array(transportProviderCapabilitySchema).max(128),
  llmRoutes: z.array(z.object({
    provider: boundedNameSchema,
    models: z.array(boundedNameSchema).max(512),
    catalogStatus: z.enum(['available', 'incomplete', 'unavailable']),
  }).strict()).max(128),
  agentPresets: z.array(boundedNameSchema).max(256),
  tools: z.array(boundedNameSchema).max(1_024),
  plannerTools: z.object({
    design: z.array(boundedNameSchema).max(32),
    execute: z.array(boundedNameSchema).max(32),
  }).strict().optional(),
  budgetSupport: z.object({
    maxAgents: capabilitySupportSchema,
    maxConcurrent: capabilitySupportSchema,
    planTimeout: capabilitySupportSchema,
    requests: capabilitySupportSchema,
    tokens: capabilitySupportSchema,
    cost: capabilitySupportSchema,
  }).strict(),
  contractSupport: z.object({
    reasoningEffort: capabilitySupportSchema,
    verifiers: z.object({
      lifecycle: capabilitySupportSchema,
      schema: capabilitySupportSchema,
      test: capabilitySupportSchema,
      manual: capabilitySupportSchema,
    }).strict(),
  }).strict(),
  limits: z.object({
    maxAgents: z.number().int().min(1).max(32),
    maxConcurrent: z.number().int().min(1).max(16),
  }).strict(),
  experimentalAgentTeam: z.boolean(),
}).strict()
export type ExecutionCapabilitySnapshot = z.infer<typeof executionCapabilitySnapshotSchema>

export const planDiagnosticSchema = z.object({
  diagnosticId: z.string().min(1).max(256),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2_000),
  nodeIds: z.array(identifierSchema).max(64).default([]),
  fixHint: z.string().min(1).max(2_000).optional(),
  support: capabilitySupportSchema.optional(),
}).strict()
export type PlanDiagnostic = z.infer<typeof planDiagnosticSchema>

export const planPreflightResultSchema = z.object({
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  capabilityDigest: z.string().min(1).max(256),
  resolvedBackend: planBackendSchema,
  valid: z.boolean(),
  diagnostics: z.array(planDiagnosticSchema).max(512),
  parallelWaves: z.array(z.array(identifierSchema).min(1)).max(128),
}).strict()
export type PlanPreflightResult = z.infer<typeof planPreflightResultSchema>

export const planRepositorySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().uuid(),
  hostStartedAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  capturedAt: z.number().finite(),
  durability: z.enum(['host-only', 'disk']),
  plans: z.array(agentPlanRevisionSchema).max(5_000),
}).strict()
export type PlanRepositorySnapshot = z.infer<typeof planRepositorySnapshotSchema>

export const planExecutionRepositorySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().uuid(),
  hostStartedAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  capturedAt: z.number().finite(),
  durability: z.enum(['host-only', 'disk']),
  executions: z.array(planExecutionSchema).max(5_000),
}).strict()
export type PlanExecutionRepositorySnapshot = z.infer<typeof planExecutionRepositorySnapshotSchema>

const parentSessionIdSchema = z.string().min(1).max(256)

export const listPlansRequestSchema = z.object({
  parentSessionIds: z.array(parentSessionIdSchema).min(1).max(64),
}).strict()
export type ListPlansRequest = z.infer<typeof listPlansRequestSchema>

export const watchPlansRequestSchema = listPlansRequestSchema.extend({
  hostInstanceId: z.string().uuid().optional(),
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(25_000),
}).strict()
export type WatchPlansRequest = z.infer<typeof watchPlansRequestSchema>

export const savePlanRequestSchema = z.object({
  parentSessionId: parentSessionIdSchema,
  planId: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative(),
  content: agentPlanContentSchema,
}).strict()
export type SavePlanRequest = z.infer<typeof savePlanRequestSchema>

export const planRevisionRequestSchema = z.object({
  parentSessionId: parentSessionIdSchema,
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
}).strict()
export type PlanRevisionRequest = z.infer<typeof planRevisionRequestSchema>

export const approvePlanRequestSchema = planRevisionRequestSchema.extend({
  capabilityDigest: z.string().min(1).max(256),
  acceptedWarningIds: z.array(z.string().min(1).max(256)).max(512).default([]),
}).strict()
export type ApprovePlanRequest = z.infer<typeof approvePlanRequestSchema>

export const executionCapabilitiesRequestSchema = z.object({
  parentSessionId: parentSessionIdSchema,
}).strict()
export type ExecutionCapabilitiesRequest = z.infer<typeof executionCapabilitiesRequestSchema>

export const listPlanExecutionsRequestSchema = z.object({
  parentSessionIds: z.array(parentSessionIdSchema).min(1).max(64),
}).strict()
export type ListPlanExecutionsRequest = z.infer<typeof listPlanExecutionsRequestSchema>

export const watchPlanExecutionsRequestSchema = listPlanExecutionsRequestSchema.extend({
  hostInstanceId: z.string().uuid().optional(),
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(25_000),
}).strict()
export type WatchPlanExecutionsRequest = z.infer<typeof watchPlanExecutionsRequestSchema>

export const cancelPlanExecutionRequestSchema = z.object({
  parentSessionId: parentSessionIdSchema,
  executionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict()
export type CancelPlanExecutionRequest = z.infer<typeof cancelPlanExecutionRequestSchema>

export const cancelPlanExecutionResultSchema = z.object({
  status: z.enum(['requested', 'already-terminal', 'not-found']),
}).strict()
export type CancelPlanExecutionResult = z.infer<typeof cancelPlanExecutionResultSchema>

export const planExecutionGrantSchema = z.object({
  grantId: z.string().uuid(),
  parentSessionId: parentSessionIdSchema,
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  capabilityDigest: z.string().min(1).max(256),
  executeToolName: boundedNameSchema,
  expiresAt: z.number().finite(),
}).strict()
export type PlanExecutionGrant = z.infer<typeof planExecutionGrantSchema>

export const LIST_PLANS_ENDPOINT = 'planner.list'
export const WATCH_PLANS_ENDPOINT = 'planner.watch'
export const SAVE_PLAN_ENDPOINT = 'planner.save'
export const PREFLIGHT_PLAN_ENDPOINT = 'planner.preflight'
export const APPROVE_PLAN_ENDPOINT = 'planner.approve'
export const EXECUTION_CAPABILITIES_ENDPOINT = 'planner.capabilities'
export const ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT = 'planner.executions.grant'
export const LIST_PLAN_EXECUTIONS_ENDPOINT = 'planner.executions.list'
export const WATCH_PLAN_EXECUTIONS_ENDPOINT = 'planner.executions.watch'
export const CANCEL_PLAN_EXECUTION_ENDPOINT = 'planner.executions.cancel'

export const MAX_PLAN_BYTES = 256 * 1024
export const MAX_PLAN_EDGES = 256

/** Reject non-JSON graphs and excessive nesting before recursive schema parsing. */
export function assertBoundedJsonValue(
  value: unknown,
  maxBytes = MAX_PLAN_BYTES,
  maxDepth = 64,
  maxNodes = 50_000,
): void {
  const stack: {
    readonly value: unknown
    readonly depth: number
    readonly leaving?: boolean
  }[] = [{ value, depth: 0 }]
  const active = new WeakSet<object>()
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.leaving === true) {
      active.delete(current.value as object)
      continue
    }
    nodes += 1
    if (nodes > maxNodes) throw new Error('agent plan JSON value has too many nodes')
    if (current.depth > maxDepth) throw new Error('agent plan JSON value is nested too deeply')
    const item = current.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('agent plan JSON value contains a non-finite number')
      continue
    }
    if (typeof item !== 'object') throw new Error('agent plan contains a non-JSON value')
    if (active.has(item)) throw new Error('agent plan JSON value must not contain cycles')
    active.add(item)
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('agent plan contains a non-plain object')
    }
    if (Reflect.ownKeys(item).some(key => typeof key === 'symbol')) {
      throw new Error('agent plan contains a symbol property')
    }
    stack.push({ value: item, depth: current.depth, leaving: true })
    const children = Array.isArray(item) ? item : Object.values(item)
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 })
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('agent plan is not JSON serializable')
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new Error(`agent plan exceeds ${String(maxBytes)} encoded bytes`)
  }
}

/** Parse an untrusted revision and enforce its encoded payload bound before deeper processing. */
export function parseAgentPlanRevision(value: unknown): AgentPlanRevision {
  assertBoundedJsonValue(value)
  return agentPlanRevisionSchema.parse(value)
}
