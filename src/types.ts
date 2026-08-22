import { z } from 'zod'

/** Why the plugin can associate one task with a published DSH run. */
export const observationSourceSchema = z.enum(['observed-tool', 'owned-tool'])
export type ObservationSource = z.infer<typeof observationSourceSchema>

/** Published-run state derived only from the official DSH start/end pair. */
export const observedRunStateSchema = z.enum([
  'active',
  'completed',
  'aborted',
  'error',
  'max-tokens',
  'refusal',
  'unknown',
])
export type ObservedRunState = z.infer<typeof observedRunStateSchema>

/** State of a plugin-owned delegation before DSH publishes a child run. */
export const ownedAttemptStateSchema = z.enum(['queued', 'starting', 'not-published', 'unknown'])
export type OwnedAttemptState = z.infer<typeof ownedAttemptStateSchema>

/** Content-free reason an owned attempt did not become a visible run. */
export const ownedAttemptOutcomeSchema = z.enum([
  'cancelled-before-publication',
  'queue-full',
  'start-failed',
  'lifecycle-missing',
])
export type OwnedAttemptOutcome = z.infer<typeof ownedAttemptOutcomeSchema>

/** Optional operator-declared labels for one plugin-owned tool instance. */
export const configuredProductSchema = z.object({
  product: z.string().min(1).max(64).optional(),
  displayName: z.string().min(1).max(80).optional(),
  instance: z.string().min(1).max(80).optional(),
}).strict()
export type ConfiguredProduct = z.infer<typeof configuredProductSchema>

/** One plugin-owned startup attempt that has not published a DSH child. */
export const ownedAttemptViewSchema = configuredProductSchema.extend({
  attemptId: z.string().uuid(),
  parentSessionId: z.string().min(1),
  callId: z.string().min(1),
  toolName: z.string().min(1).max(128),
  expectedProviderName: z.string().min(1).max(128),
  label: z.string().min(1).max(160).optional(),
  state: ownedAttemptStateSchema,
  outcome: ownedAttemptOutcomeSchema.optional(),
  cancellationRequested: z.boolean().optional(),
  createdAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
}).strict()
export type OwnedAttemptView = z.infer<typeof ownedAttemptViewSchema>

/** One published DSH lifecycle record correlated to a model-facing tool call. */
export const observedRunViewSchema = configuredProductSchema.extend({
  runId: z.string().min(1),
  attemptId: z.string().uuid().optional(),
  parentSessionId: z.string().min(1),
  childId: z.string().min(1),
  callId: z.string().min(1),
  toolName: z.string().min(1).max(128),
  label: z.string().min(1).max(160).optional(),
  providerName: z.string().min(1).max(128),
  expectedProviderName: z.string().min(1).max(128).optional(),
  providerMismatch: z.boolean(),
  source: observationSourceSchema,
  local: z.boolean(),
  state: observedRunStateSchema,
  startedAt: z.number().finite(),
  finishedAt: z.number().finite().optional(),
}).strict()
export type ObservedRunView = z.infer<typeof observedRunViewSchema>

/** Fixed safety and ownership facts advertised by the first standalone release. */
export const consoleCapabilitiesSchema = z.object({
  publishedLifecycle: z.literal(true),
  startupLifecycle: z.literal('owned-tool-only'),
  liveProgress: z.literal(false),
  browserCancellation: z.literal(false),
  durableHistory: z.literal(false),
}).strict()
export type ConsoleCapabilities = z.infer<typeof consoleCapabilitiesSchema>

/** Honest capacity diagnostics for records that could not be retained. */
export const consoleDiagnosticsSchema = z.object({
  droppedActiveRuns: z.number().int().nonnegative(),
}).strict()
export type ConsoleDiagnostics = z.infer<typeof consoleDiagnosticsSchema>

/** One Host-generation snapshot filtered to the requested conversations. */
export const consoleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  hostInstanceId: z.string().uuid(),
  hostStartedAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  capturedAt: z.number().finite(),
  capabilities: consoleCapabilitiesSchema,
  diagnostics: consoleDiagnosticsSchema,
  attempts: z.array(ownedAttemptViewSchema),
  runs: z.array(observedRunViewSchema),
}).strict()
export type ConsoleSnapshot = z.infer<typeof consoleSnapshotSchema>

/** Batched, Host-filtered read request used by the conversation canvas. */
export const listSessionsRequestSchema = z.object({
  parentSessionIds: z.array(z.string().min(1)).min(1).max(64),
}).strict()
export type ListSessionsRequest = z.infer<typeof listSessionsRequestSchema>

/** Revision-aware wait request used to receive the next bounded snapshot. */
export const watchSessionsRequestSchema = listSessionsRequestSchema.extend({
  hostInstanceId: z.string().uuid().optional(),
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(25_000),
}).strict()
export type WatchSessionsRequest = z.infer<typeof watchSessionsRequestSchema>

/** Dedicated loopback RPC channel for the browser console. */
export const PRODUCT_SUBAGENT_CONSOLE_CHANNEL = '/product-subagent-console'

/** Read-only endpoint returning a bounded session-filtered snapshot. */
export const LIST_SESSIONS_ENDPOINT = 'list-sessions'

/** Long-poll endpoint returning after a ledger change or bounded timeout. */
export const WATCH_SESSIONS_ENDPOINT = 'watch-sessions'
