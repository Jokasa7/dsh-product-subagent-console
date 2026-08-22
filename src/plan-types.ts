import { z } from 'zod'

const identifierSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const boundedNameSchema = z.string().trim().min(1).max(128)
const boundedTextSchema = z.string().trim().min(1).max(8_000)
const resourceClaimSchema = z.string().trim().min(1).max(256).refine((value) => {
  const normalized = value.replaceAll('\\', '/')
  return !normalized.startsWith('/')
    && !/^[A-Za-z]:/u.test(normalized)
    && !normalized.split('/').includes('..')
}, 'resource claims must be relative identifiers without parent traversal')

export const capabilitySupportSchema = z.enum(['enforced', 'advisory', 'unsupported'])
export type CapabilitySupport = z.infer<typeof capabilitySupportSchema>

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
    schema: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  completionCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(16),
  resourceClaims: z.array(resourceClaimSchema).max(32).default([]),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  approvalRequired: z.boolean().default(false),
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
  acceptedWarningCodes: z.array(z.string().min(1).max(128)).max(128).optional(),
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
}).strict()
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
    catalogStatus: z.enum(['available', 'unavailable']),
  }).strict()).max(128),
  agentPresets: z.array(boundedNameSchema).max(256),
  tools: z.array(boundedNameSchema).max(1_024),
  budgetSupport: z.object({
    maxAgents: capabilitySupportSchema,
    maxConcurrent: capabilitySupportSchema,
    planTimeout: capabilitySupportSchema,
    requests: capabilitySupportSchema,
    tokens: capabilitySupportSchema,
    cost: capabilitySupportSchema,
  }).strict(),
  limits: z.object({
    maxAgents: z.number().int().min(1).max(32),
    maxConcurrent: z.number().int().min(1).max(16),
  }).strict(),
  experimentalAgentTeam: z.boolean(),
}).strict()
export type ExecutionCapabilitySnapshot = z.infer<typeof executionCapabilitySnapshotSchema>

export const planDiagnosticSchema = z.object({
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
  durability: z.literal('host-only'),
  plans: z.array(agentPlanRevisionSchema).max(5_000),
}).strict()
export type PlanRepositorySnapshot = z.infer<typeof planRepositorySnapshotSchema>

export const planExecutionRepositorySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().uuid(),
  hostStartedAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  capturedAt: z.number().finite(),
  durability: z.literal('host-only'),
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
  acceptedWarningCodes: z.array(z.string().min(1).max(128)).max(128).default([]),
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

export const LIST_PLANS_ENDPOINT = 'planner.list'
export const WATCH_PLANS_ENDPOINT = 'planner.watch'
export const SAVE_PLAN_ENDPOINT = 'planner.save'
export const PREFLIGHT_PLAN_ENDPOINT = 'planner.preflight'
export const APPROVE_PLAN_ENDPOINT = 'planner.approve'
export const EXECUTION_CAPABILITIES_ENDPOINT = 'planner.capabilities'
export const LIST_PLAN_EXECUTIONS_ENDPOINT = 'planner.executions.list'
export const WATCH_PLAN_EXECUTIONS_ENDPOINT = 'planner.executions.watch'
export const CANCEL_PLAN_EXECUTION_ENDPOINT = 'planner.executions.cancel'

export const MAX_PLAN_BYTES = 256 * 1024
export const MAX_PLAN_EDGES = 256

/** Parse an untrusted revision and enforce its encoded payload bound before deeper processing. */
export function parseAgentPlanRevision(value: unknown): AgentPlanRevision {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_PLAN_BYTES) {
    throw new Error(`agent plan exceeds ${String(MAX_PLAN_BYTES)} encoded bytes`)
  }
  return agentPlanRevisionSchema.parse(value)
}
