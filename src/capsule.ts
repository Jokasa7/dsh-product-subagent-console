import { sha256 } from './conformance.js'
import { redactSensitiveText } from './sensitive-text.js'
import {
  exportRunCapsuleResultSchema,
  runCapsuleManifestSchema,
  type ConformanceReport,
  type EvidenceReceipt,
  type ExportRunCapsuleRequest,
  type ExportRunCapsuleResult,
  type FoundryEventEnvelope,
  type RecoveryProposal,
  type RunCapsuleManifest,
} from './foundry-types.js'
import type { AgentPlanRevision, PlanExecution } from './plan-types.js'

export interface BuildRunCapsuleInput {
  readonly request: ExportRunCapsuleRequest
  readonly plan: AgentPlanRevision
  readonly execution: PlanExecution
  readonly report: ConformanceReport
  readonly proposal?: RecoveryProposal
  readonly events: readonly FoundryEventEnvelope[]
  readonly receipts: readonly EvidenceReceipt[]
  readonly projectionDigest: string
  readonly generatorVersion: string
}

const CAPSULE_MAX_EVENTS = 500
const CAPSULE_MAX_RECEIPTS = 100
const CAPSULE_MAX_FINDINGS = 100
const CAPSULE_MAX_ARTIFACTS_PER_RECORD = 4
const CAPSULE_MAX_MANIFEST_BYTES = 1_310_720
const CAPSULE_MAX_HTML_BYTES = 8 * 1024 * 1024

export class CapsuleIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapsuleIntegrityError'
  }
}

/** Produce a static, offline, allowlisted viewer. No raw Agent content is accepted. */
export function buildRunCapsule(input: BuildRunCapsuleInput): ExportRunCapsuleResult {
  assertIdentity(input)
  const sourceEvents = input.events
    .filter(event => event.parentSessionId === input.request.parentSessionId && event.runId === input.request.runId)
    .sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  if (
    sourceEvents.some(event => (
      event.planId !== input.execution.planId
      || event.planRevision !== input.execution.planRevision
    ))
    || input.report.eventCursor !== (sourceEvents.at(-1)?.cursor ?? 0)
  ) throw new CapsuleIntegrityError('run Event identity or cursor does not match the exported execution')
  const scopedReceipts = input.receipts
    .filter(receipt => receipt.parentSessionId === input.request.parentSessionId && receipt.runId === input.request.runId)
  if (scopedReceipts.some(receipt => (
    receipt.planId !== input.execution.planId
    || receipt.planRevision !== input.execution.planRevision
  ))) {
    throw new CapsuleIntegrityError('run receipt identity does not match the exported execution')
  }
  const sourceReceipts = scopedReceipts
    .sort((left, right) => left.observedAt - right.observedAt || left.receiptId.localeCompare(right.receiptId))
  const sourceFindings = [...input.report.findings]
    .sort((left, right) => left.firstObservedAt - right.firstObservedAt || left.findingId.localeCompare(right.findingId))
  const eventById = new Map(sourceEvents.map(event => [event.eventId, event]))
  for (const receipt of sourceReceipts) {
    const binding = input.execution.bindings.find(candidate => (
      candidate.taskId === receipt.taskId && candidate.attemptId === receipt.attemptId
    ))
    const verifier = input.plan.tasks
      .find(task => task.taskId === receipt.taskId)
      ?.verifiers?.find(candidate => candidate.verifierId === receipt.verifierId)
    if (
      binding === undefined
      || verifier === undefined
      || verifier.kind !== receipt.verifierKind
      || !receiptClaimMatchesVerifier(receipt.claim, verifier.kind)
      || !receipt.evidenceEventIds.every((eventId) => {
        const event = eventById.get(eventId)
        return event?.taskId === receipt.taskId && event.attemptId === receipt.attemptId
      })
    ) {
      throw new CapsuleIntegrityError(`receipt ${receipt.receiptId} references an unavailable Evidence Event`)
    }
  }
  for (const finding of sourceFindings) {
    if (!finding.evidenceEventIds.every(eventId => eventById.has(eventId))) {
      throw new CapsuleIntegrityError(`finding ${finding.findingId} references an unavailable Evidence Event`)
    }
  }
  const lastSourceEvent = sourceEvents.at(-1)
  const requiredEventIds = new Set<string>(lastSourceEvent === undefined ? [] : [lastSourceEvent.eventId])
  const canIncludeEvidence = (eventIds: readonly string[]): boolean => {
    if (!eventIds.every(eventId => eventById.has(eventId))) return false
    const additional = eventIds.filter(eventId => !requiredEventIds.has(eventId)).length
    return requiredEventIds.size + additional <= CAPSULE_MAX_EVENTS
  }
  const includeEvidence = (eventIds: readonly string[]): void => {
    for (const eventId of eventIds) requiredEventIds.add(eventId)
  }
  const firstDivergence = sourceFindings.find(finding => (
    finding.findingId === input.report.firstProvableDivergenceId
  ))
  const selectedFindings = firstDivergence !== undefined && canIncludeEvidence(firstDivergence.evidenceEventIds)
    ? [firstDivergence]
    : []
  if (selectedFindings[0] !== undefined) includeEvidence(selectedFindings[0].evidenceEventIds)
  const receipts = sourceReceipts.filter((receipt) => {
    if (requiredEventIds.size >= CAPSULE_MAX_EVENTS || !canIncludeEvidence(receipt.evidenceEventIds)) return false
    includeEvidence(receipt.evidenceEventIds)
    return true
  }).slice(0, CAPSULE_MAX_RECEIPTS)
  // Rebuild the evidence set after slicing so omitted receipts never retain events by accident.
  requiredEventIds.clear()
  if (lastSourceEvent !== undefined) requiredEventIds.add(lastSourceEvent.eventId)
  if (selectedFindings[0] !== undefined) includeEvidence(selectedFindings[0].evidenceEventIds)
  for (const receipt of receipts) includeEvidence(receipt.evidenceEventIds)
  const findings = [
    ...selectedFindings,
    ...sourceFindings.filter(finding => finding.findingId !== firstDivergence?.findingId).filter((finding) => {
      if (!canIncludeEvidence(finding.evidenceEventIds)) return false
      includeEvidence(finding.evidenceEventIds)
      return true
    }),
  ].slice(0, CAPSULE_MAX_FINDINGS)
  requiredEventIds.clear()
  if (lastSourceEvent !== undefined) requiredEventIds.add(lastSourceEvent.eventId)
  for (const receipt of receipts) includeEvidence(receipt.evidenceEventIds)
  for (const finding of findings) includeEvidence(finding.evidenceEventIds)
  const selectedEventIds = new Set(requiredEventIds)
  const selectedReceiptIds = new Set(receipts.map(receipt => receipt.receiptId))
  const selectedFindingIds = new Set(findings.map(finding => finding.findingId))
  const omittedEvidenceEventIds = new Set([
    ...sourceReceipts
      .filter(receipt => !selectedReceiptIds.has(receipt.receiptId))
      .flatMap(receipt => receipt.evidenceEventIds),
    ...sourceFindings
      .filter(finding => !selectedFindingIds.has(finding.findingId))
      .flatMap(finding => finding.evidenceEventIds),
  ])
  const prioritizedEvents = [
    lastSourceEvent,
    ...sourceEvents.filter(event => (
      event.type === 'execution-started'
      || event.type === 'execution-terminal'
      || event.type === 'attempt-terminal'
      || event.type === 'child-terminal'
      || event.type.startsWith('control-')
    )),
  ].filter((event): event is FoundryEventEnvelope => event !== undefined)
  for (const event of [...prioritizedEvents, ...sourceEvents]) {
    if (selectedEventIds.size >= CAPSULE_MAX_EVENTS) break
    if (omittedEvidenceEventIds.has(event.eventId) && !requiredEventIds.has(event.eventId)) continue
    selectedEventIds.add(event.eventId)
  }
  const events = sourceEvents.filter(event => selectedEventIds.has(event.eventId))
  const findingIds = new Set(findings.map(finding => finding.findingId))
  const createdAt = input.execution.finishedAt
    ?? events.at(-1)?.occurredAt
    ?? events.at(-1)?.observedAt
    ?? input.execution.startedAt
    ?? input.execution.createdAt
  const startedAt = input.execution.startedAt ?? input.execution.createdAt
  const sourceArtifactCount = sourceEvents.reduce((sum, event) => sum + event.artifacts.length, 0)
    + sourceReceipts.reduce((sum, receipt) => sum + receipt.artifacts.length, 0)
  const exportedArtifactCount = events.reduce(
    (sum, event) => sum + Math.min(event.artifacts.length, CAPSULE_MAX_ARTIFACTS_PER_RECORD),
    0,
  ) + receipts.reduce(
    (sum, receipt) => sum + Math.min(receipt.artifacts.length, CAPSULE_MAX_ARTIFACTS_PER_RECORD),
    0,
  )
  const publicId = (kind: string, value: string): string => sha256(`capsule:${kind}\u0000${value}`)
  const publicEventId = (value: string): string => publicId('event', value)
  const safeArtifacts = (artifacts: readonly {
    readonly artifactId: string
    readonly kind: 'input' | 'output' | 'report' | 'test' | 'patch' | 'other'
    readonly digest: string
    readonly mediaType?: string | undefined
  }[]) => artifacts.slice(0, CAPSULE_MAX_ARTIFACTS_PER_RECORD).map(artifact => ({
    artifactId: publicId('artifact', artifact.artifactId),
    kind: artifact.kind,
    digest: publicId('artifact-content', artifact.digest),
    ...(artifact.mediaType === undefined ? {} : { mediaType: sanitizeText(artifact.mediaType, 128) }),
  }))
  const manifestWithoutDigest = {
    schemaVersion: 2 as const,
    generator: {
      name: 'dsh-product-subagent-console' as const,
      version: input.generatorVersion,
    },
    createdAt,
    policy: {
      includeObjective: input.request.includeObjective,
      includeTaskBriefs: input.request.includeTaskBriefs,
      redactedFields: [
        'prompt', 'raw-output', 'stderr', 'environment', 'absolute-path', 'credential', 'reasoning',
      ] as const,
      limits: {
        maxEvents: CAPSULE_MAX_EVENTS,
        maxReceipts: CAPSULE_MAX_RECEIPTS,
        maxFindings: CAPSULE_MAX_FINDINGS,
        maxArtifactsPerRecord: CAPSULE_MAX_ARTIFACTS_PER_RECORD,
        sourceEvents: sourceEvents.length,
        sourceReceipts: sourceReceipts.length,
        sourceFindings: sourceFindings.length,
        sourceArtifacts: sourceArtifactCount,
        exportedEvents: events.length,
        exportedReceipts: receipts.length,
        exportedFindings: findings.length,
        exportedArtifacts: exportedArtifactCount,
        truncated: events.length < sourceEvents.length
          || receipts.length < sourceReceipts.length
          || findings.length < sourceFindings.length
          || exportedArtifactCount < sourceArtifactCount,
      },
    },
    run: {
      parentSessionDigest: publicId('parent-session', input.execution.parentSessionId),
      runDigest: publicId('run', input.execution.executionId),
      planDigest: publicId('plan', input.execution.planId),
      planRevision: input.execution.planRevision,
      eventCursor: input.report.eventCursor,
      projectionDigest: publicId('projection', input.projectionDigest),
    },
    plan: {
      title: 'Agent run',
      ...(input.request.includeObjective ? { objective: sanitizeText(input.plan.objective, 8_000) } : {}),
      pattern: input.plan.pattern,
      roles: input.plan.roles.map((role, index) => ({
        roleId: publicId('role', role.roleId),
        name: `Role ${String(index + 1)}`,
        transportProvider: `provider-${publicId('transport-provider', role.transportProvider).slice(7, 19)}`,
        ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
        toolPolicy: {
          mode: role.toolPolicy.mode,
          tools: role.toolPolicy.mode === 'allowlist'
            ? [...new Set(role.toolPolicy.tools.map(tool => (
                `tool-${publicId('tool', tool).slice(7, 19)}`
              )))].sort()
            : [],
        },
      })),
      tasks: input.plan.tasks.map((task, index) => ({
        taskId: publicId('task', task.taskId),
        title: `Task ${String(index + 1)}`,
        roleId: publicId('role', task.roleId),
        dependencies: task.dependsOn.map(dependency => ({
          taskId: publicId('task', dependency.taskId),
          mode: dependency.mode,
        })),
        effectKind: task.effect?.kind ?? 'unknown',
        verifiers: (task.verifiers ?? []).map(verifier => ({
          verifierId: publicId('verifier', verifier.verifierId),
          kind: verifier.kind,
          required: verifier.required,
        })),
        ...(input.request.includeTaskBriefs ? { brief: sanitizeText(task.brief, 2_000) } : {}),
      })),
    },
    execution: {
      status: input.execution.status,
      cancellationRequested: input.execution.cancellationRequested,
      ...(input.execution.finishedAt === undefined ? {} : {
        durationMs: Math.max(0, input.execution.finishedAt - startedAt),
      }),
      bindings: input.execution.bindings.map(binding => ({
        taskId: publicId('task', binding.taskId),
        attemptId: publicId('attempt', binding.attemptId),
        attemptNumber: binding.attemptNumber,
        status: binding.status,
        ...(binding.childId === undefined ? {} : { childId: publicId('child', binding.childId) }),
        ...(binding.finishedAt === undefined ? {} : {
          durationMs: Math.max(0, binding.finishedAt - (binding.startedAt ?? input.execution.createdAt)),
        }),
      })),
    },
    report: {
      state: input.report.state,
      eventCursor: input.report.eventCursor,
      ...(input.report.firstProvableDivergenceId === undefined || !findingIds.has(input.report.firstProvableDivergenceId) ? {} : {
        firstProvableDivergenceId: publicId('finding', input.report.firstProvableDivergenceId),
      }),
      tasks: input.report.tasks.map(task => ({
        taskId: publicId('task', task.taskId),
        state: task.state,
        ...(task.lifecycleStatus === undefined ? {} : { lifecycleStatus: task.lifecycleStatus }),
        evidenceStatus: task.evidenceStatus,
        findingIds: task.findingIds.filter(id => findingIds.has(id)).map(id => publicId('finding', id)),
      })),
      findings: findings.map(finding => ({
        findingId: publicId('finding', finding.findingId),
        code: finding.code,
        status: finding.status,
        severity: finding.severity,
        certainty: finding.certainty,
        ...(finding.taskId === undefined ? {} : { taskId: publicId('task', finding.taskId) }),
        ...(finding.attemptId === undefined ? {} : { attemptId: publicId('attempt', finding.attemptId) }),
        evidenceEventIds: finding.evidenceEventIds.map(publicEventId),
      })),
    },
    ...(input.proposal === undefined ? {} : {
      recoveryProposal: {
        proposalId: publicId('proposal', input.proposal.proposalId),
        eventCursor: input.proposal.eventCursor,
        affectedTaskIds: input.proposal.affectedTaskIds.map(id => publicId('task', id)),
        reusableTaskIds: input.proposal.reusableTaskIds.map(id => publicId('task', id)),
        actions: input.proposal.actions.map(action => ({
          actionId: publicId('action', action.actionId),
          kind: action.kind,
          taskId: publicId('task', action.taskId),
          allowed: action.allowed,
          requiresApproval: action.requiresApproval,
          reasonCode: action.reasonCode,
        })),
        blockedReasonCodes: input.proposal.blockedReasonCodes,
        requiresApproval: true as const,
      },
    }),
    events: events.map(event => ({
      eventId: publicEventId(event.eventId),
      cursor: event.cursor,
      type: event.type,
      authority: event.authority,
      occurredOffsetMs: (event.occurredAt ?? event.observedAt) - startedAt,
      ...(event.taskId === undefined ? {} : { taskId: publicId('task', event.taskId) }),
      ...(event.attemptId === undefined ? {} : { attemptId: publicId('attempt', event.attemptId) }),
      ...(event.executionStatus === undefined ? {} : { executionStatus: event.executionStatus }),
      ...(event.attemptStatus === undefined ? {} : { attemptStatus: event.attemptStatus }),
      ...(event.terminalReason === undefined ? {} : { terminalReason: event.terminalReason }),
      ...(event.controlResult === undefined ? {} : { controlResult: event.controlResult }),
      artifacts: safeArtifacts(event.artifacts),
    })),
    receipts: receipts.map(receipt => ({
      receiptId: publicId('receipt', receipt.receiptId),
      taskId: publicId('task', receipt.taskId),
      attemptId: publicId('attempt', receipt.attemptId),
      verifierId: publicId('verifier', receipt.verifierId),
      verifierVersion: `verifier-${publicId('verifier-version', receipt.verifierVersion).slice(7, 19)}`,
      verifierKind: receipt.verifierKind,
      claim: receipt.claim,
      result: receipt.result,
      authority: receipt.authority,
      observedOffsetMs: receipt.observedAt - startedAt,
      evidenceEventIds: receipt.evidenceEventIds.map(publicEventId),
      artifacts: safeArtifacts(receipt.artifacts),
    })),
  }
  const manifest = runCapsuleManifestSchema.parse({
    ...manifestWithoutDigest,
    manifestDigest: sha256(JSON.stringify(manifestWithoutDigest)),
  })
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength
  if (manifestBytes > CAPSULE_MAX_MANIFEST_BYTES) {
    throw new CapsuleIntegrityError('Capsule manifest exceeds the bounded export byte limit')
  }
  const html = renderCapsuleHtml(manifest)
  if (new TextEncoder().encode(html).byteLength > CAPSULE_MAX_HTML_BYTES) {
    throw new CapsuleIntegrityError('Capsule viewer exceeds the bounded export byte limit')
  }
  return exportRunCapsuleResultSchema.parse({
    fileName: `agent-run-${publicId('run', input.execution.executionId).slice(7, 23)}.html`,
    manifest,
    html,
  })
}

export function renderCapsuleHtml(manifest: RunCapsuleManifest): string {
  const manifestJson = JSON.stringify(manifest, null, 2).replaceAll('<', '\\u003c')
  const downloadHref = `data:application/json;charset=utf-8,${encodeURIComponent(manifestJson)}`
  const findings = manifest.report.findings.length === 0
    ? '<p class="empty">No conformance findings were recorded.</p>'
    : `<ol>${manifest.report.findings.map(finding => (
      `<li><strong>${escapeHtml(finding.code)}</strong><span>${escapeHtml(finding.severity)} · ${escapeHtml(finding.certainty)}</span>${finding.taskId === undefined ? '' : `<code>${escapeHtml(finding.taskId)}</code>`}</li>`
    )).join('')}</ol>`
  const tasks = manifest.plan.tasks.map(task => (
    `<li><div><strong>${escapeHtml(task.title)}</strong><code>${escapeHtml(task.taskId)}</code></div><span>${escapeHtml(task.effectKind)} · ${String(task.verifiers.length)} verifier(s)</span></li>`
  )).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(manifest.plan.title)} · Agent Run Capsule</title>
<style>${CAPSULE_CSS}</style>
</head>
<body>
<main>
  <header><div><span class="eyebrow">Agent Run Capsule</span><h1>${escapeHtml(manifest.plan.title)}</h1><p>${escapeHtml(manifest.execution.status)} · ${escapeHtml(manifest.report.state)} · revision ${String(manifest.run.planRevision)}</p></div><a download="manifest.json" href="${escapeHtml(downloadHref)}">Download manifest</a></header>
  <section class="metrics"><article><span>Lifecycle</span><strong>${escapeHtml(manifest.execution.status)}</strong></article><article><span>Conformance</span><strong>${escapeHtml(manifest.report.state)}</strong></article><article><span>Events</span><strong>${String(manifest.events.length)} / ${String(manifest.policy.limits.sourceEvents)}</strong></article><article><span>Evidence</span><strong>${String(manifest.receipts.length)} / ${String(manifest.policy.limits.sourceReceipts)}</strong></article></section>
  <section><h2>Plan contract</h2><ul class="tasks">${tasks}</ul></section>
  <section><h2>First provable divergence</h2>${findings}</section>
  <section><h2>Integrity and redaction</h2><dl><div><dt>Manifest digest</dt><dd><code>${escapeHtml(manifest.manifestDigest)}</code></dd></div><div><dt>Projection digest</dt><dd><code>${escapeHtml(manifest.run.projectionDigest)}</code></dd></div><div><dt>Bounded export</dt><dd>${manifest.policy.limits.truncated ? 'Yes — source counts and exported counts are recorded in the manifest.' : 'No truncation was required.'}</dd></div><div><dt>Redacted by default</dt><dd>${manifest.policy.redactedFields.map(escapeHtml).join(', ')}</dd></div></dl></section>
  <details><summary>Manifest JSON</summary><pre>${escapeHtml(manifestJson)}</pre></details>
</main>
</body>
</html>`
}

/** Verify a Capsule manifest after transport or extraction. */
export function verifyRunCapsuleManifest(manifest: unknown): boolean {
  const parsed = runCapsuleManifestSchema.safeParse(manifest)
  if (!parsed.success) return false
  const { manifestDigest, ...withoutDigest } = parsed.data
  return sha256(JSON.stringify(withoutDigest)) === manifestDigest
}

function assertIdentity(input: BuildRunCapsuleInput): void {
  if (
    input.request.parentSessionId !== input.plan.parentSessionId
    || input.request.parentSessionId !== input.execution.parentSessionId
    || input.request.runId !== input.execution.executionId
    || input.plan.planId !== input.execution.planId
    || input.plan.revision !== input.execution.planRevision
    || input.plan.capabilityDigest !== input.execution.capabilityDigest
    || input.report.parentSessionId !== input.execution.parentSessionId
    || input.report.runId !== input.execution.executionId
    || input.report.planId !== input.execution.planId
    || input.report.planRevision !== input.execution.planRevision
    || input.report.findings.some(finding => (
      finding.parentSessionId !== input.execution.parentSessionId
      || finding.runId !== input.execution.executionId
      || finding.planId !== input.execution.planId
      || finding.planRevision !== input.execution.planRevision
    ))
    || (input.proposal !== undefined && (
      input.proposal.parentSessionId !== input.execution.parentSessionId
      || input.proposal.runId !== input.execution.executionId
      || input.proposal.planId !== input.execution.planId
      || input.proposal.planRevision !== input.execution.planRevision
      || input.proposal.capabilityDigest !== input.execution.capabilityDigest
      || input.proposal.eventCursor !== input.report.eventCursor
    ))
  ) throw new Error('run capsule inputs do not describe the same execution')
}

function receiptClaimMatchesVerifier(
  claim: EvidenceReceipt['claim'],
  kind: NonNullable<BuildRunCapsuleInput['plan']['tasks'][number]['verifiers']>[number]['kind'],
): boolean {
  if (kind === 'lifecycle') return claim === 'lifecycle-terminal'
  if (kind === 'manual') return claim === 'manual-accepted'
  return claim === 'criteria-satisfied' || claim === 'artifact-produced'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sanitizeText(value: string, maxLength: number): string {
  const sanitized = redactSensitiveText(value
    .replace(/https?:\/\/[^\s<>"']+/giu, '[redacted URL]')
  )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, maxLength)
  return sanitized.length === 0 ? 'Redacted' : sanitized
}

const CAPSULE_CSS = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#111214;color:#f4f4f5}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#202534 0,transparent 36%),#111214}main{width:min(1040px,calc(100% - 32px));margin:0 auto;padding:48px 0 80px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}h1{margin:7px 0 8px;font-size:clamp(28px,5vw,52px);line-height:1.05}h2{margin:0 0 16px;font-size:17px}.eyebrow,header p,article span,li span,dt{color:#9ca3af;font-size:12px}.eyebrow{letter-spacing:.14em;text-transform:uppercase}a{border:1px solid #3f4657;border-radius:9px;padding:9px 12px;color:#dce6ff;text-decoration:none}section,details{margin-top:24px;border:1px solid #2b2e36;border-radius:16px;background:#191b20;padding:20px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metrics article{border:1px solid #2f3440;border-radius:12px;background:#20232a;padding:14px}.metrics article strong{display:block;margin-top:7px;font-size:18px}ul,ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #2b303a;border-radius:10px;padding:11px 12px}li div{display:flex;min-width:0;align-items:center;gap:10px}li code{color:#8fb1ff;font-size:11px}dl{display:grid;gap:10px;margin:0}dl div{display:grid;grid-template-columns:160px minmax(0,1fr);gap:16px}dd{min-width:0;margin:0;overflow-wrap:anywhere;color:#d1d5db;font-size:13px}summary{cursor:pointer;font-weight:650}pre{overflow:auto;margin:16px 0 0;border-radius:10px;background:#0d0e10;padding:16px;color:#cbd5e1;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.empty{color:#9ca3af}@media(max-width:720px){main{padding-top:28px}header{flex-direction:column}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}dl div{grid-template-columns:1fr}li{align-items:flex-start;flex-direction:column}}
`
