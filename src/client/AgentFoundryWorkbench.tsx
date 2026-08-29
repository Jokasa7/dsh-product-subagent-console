import {
  useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { strToU8, zipSync, type Zippable } from 'fflate/browser'
import {
  type CompareRunsRequest,
  type ExportRecipeRequest,
  type ExportRecipeResult,
  type ExportRunCapsuleRequest,
  type ExportRunCapsuleResult,
  type ExportTelemetryRequest,
  type ExportTelemetryResult,
  type FoundrySnapshot,
  type ExecuteCancelControlRequest,
  type ExecuteCancelControlResult,
  type FoundryControlGrant,
  type InspectRunRequest,
  type InspectRunResult,
  type InstantiateRecipeRequest,
  type InstantiateRecipeResult,
  type IssueCancelGrantRequest,
  type RecipeCandidate,
  type RecipeCandidateRequest,
  type RunAdvisorResult,
  type RunQueryKind,
} from '../foundry-types.js'
import type { AgentPlanRevision, PlanExecution } from '../plan-types.js'
import { projectExecutionAtCursor } from '../temporal-execution.js'
import {
  AgentPlanComparisonCanvas,
  type AgentPlanComparisonCanvasCopy,
} from './AgentPlanComparisonCanvas.js'
import {
  buildPlanComparisonGraph,
  executionNodeId,
  findExecutionPlanRevision,
} from './plan-comparison-model.js'
import css from './AgentFoundryWorkbench.module.css'

export type FoundryWorkbenchMode = 'deviation' | 'recovery'

export interface AgentFoundryActions {
  readonly askRun: (
    parentSessionId: SessionId,
    request: InspectRunRequest,
    question: string,
    signal: AbortSignal,
  ) => Promise<InspectRunResult>
  readonly exportRunCapsule: (
    request: ExportRunCapsuleRequest,
    signal: AbortSignal,
  ) => Promise<ExportRunCapsuleResult>
  readonly previewRecipe: (
    request: RecipeCandidateRequest,
    signal: AbortSignal,
  ) => Promise<RecipeCandidate>
  readonly exportRecipe: (
    request: ExportRecipeRequest,
    signal: AbortSignal,
  ) => Promise<ExportRecipeResult>
  readonly instantiateRecipe: (
    request: InstantiateRecipeRequest,
    signal: AbortSignal,
  ) => Promise<InstantiateRecipeResult>
  readonly compareRuns: (
    request: CompareRunsRequest,
    signal: AbortSignal,
  ) => Promise<RunAdvisorResult>
  readonly exportTelemetry: (
    request: ExportTelemetryRequest,
    signal: AbortSignal,
  ) => Promise<ExportTelemetryResult>
  readonly issueCancelControlGrant: (
    request: IssueCancelGrantRequest,
    signal: AbortSignal,
  ) => Promise<FoundryControlGrant>
  readonly executeCancelControl: (
    request: ExecuteCancelControlRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteCancelControlResult>
}

export interface AgentFoundryWorkbenchProps {
  readonly sessionId: SessionId
  readonly snapshot?: FoundrySnapshot
  readonly status: 'loading' | 'ready' | 'error'
  readonly mode: FoundryWorkbenchMode
  readonly actions: AgentFoundryActions
  readonly english: boolean
  readonly canvasCopy: AgentPlanComparisonCanvasCopy
  readonly onRetry: () => void
  readonly onOpenPlan: () => void
  readonly active: boolean
}

interface Copy {
  readonly title: string
  readonly description: string
  readonly loading: string
  readonly unavailable: string
  readonly retry: string
  readonly noRuns: string
  readonly noRunsBody: string
  readonly execution: string
  readonly live: string
  readonly paused: string
  readonly returnLive: string
  readonly timeline: string
  readonly passport: string
  readonly summary: string
  readonly contract: string
  readonly actual: string
  readonly evidence: string
  readonly deviations: string
  readonly recovery: string
  readonly technical: string
  readonly lifecycle: string
  readonly conformance: string
  readonly evidenceState: string
  readonly noEvidence: string
  readonly noDeviation: string
  readonly firstDivergence: string
  readonly storage: string
  readonly askTitle: string
  readonly askPlaceholder: string
  readonly ask: string
  readonly asking: string
  readonly askQueued: string
  readonly capsule: string
  readonly exporting: string
  readonly capsuleSaved: string
  readonly recoveryPreview: string
  readonly affected: string
  readonly reusable: string
  readonly blocked: string
  readonly noAffected: string
  readonly previewOnly: string
  readonly reviewCancel: string
  readonly confirmCancel: string
  readonly cancelRequested: string
  readonly cancelAlreadyTerminal: string
  readonly cancelAlreadyRequested: string
  readonly cancelNotFound: string
  readonly cancelStale: string
  readonly cancelInterrupted: string
  readonly cancelWarning: string
  readonly foundry: string
  readonly recipeRuns: string
  readonly previewRecipe: string
  readonly exportRecipe: string
  readonly recipeBundleSaved: string
  readonly compare: string
  readonly insufficient: string
  readonly telemetry: string
  readonly telemetryDisabled: string
  readonly recipeReady: string
  readonly recipePermissionExplicit: string
  readonly recipePermissionInherited: string
  readonly recipeBudget: string
  readonly recipeVerifiers: string
  readonly recipeCurrentPreflight: string
  readonly recipeObjective: string
  readonly recipeObjectivePlaceholder: string
  readonly createRecipeDraft: string
  readonly creatingRecipeDraft: string
  readonly recipeDraftCreated: string
  readonly recipeRunLimit: string
  readonly queryKind: string
  readonly question: string
  readonly verifiedRuns: string
  readonly cursor: string
}

const COPY_ZH: Copy = {
  title: 'Agent Foundry', description: '按权威事件对照计划与实际运行，定位首个可证明偏差，并预演安全恢复。',
  loading: '正在重建运行事实…', unavailable: 'Foundry 事实流暂时不可用；当前内容可能不是最新状态。', retry: '重试',
  noRuns: '还没有计划执行记录', noRunsBody: '批准并执行一个 Agent 方案后，这里会显示 Execution Twin、时间轴与证据护照。',
  execution: '运行', live: '实时', paused: '历史回看', returnLive: '返回实时', timeline: '运行时间轴', passport: 'Evidence Passport',
  summary: '摘要', contract: '计划合同', actual: '实际运行', evidence: '验证证据', deviations: '偏差', recovery: '恢复', technical: '技术信息',
  lifecycle: '生命周期', conformance: '一致性', evidenceState: '证据状态', noEvidence: '没有适用于当前节点的验证回执。', noDeviation: '当前游标下没有可证明偏差。', firstDivergence: '首个可证明偏差', storage: '事实存储',
  askTitle: '询问本次运行', askPlaceholder: '例如：为什么它还在运行？证据是什么？', ask: '发送到当前对话', asking: '正在生成事实包…', askQueued: '问题与事实引用已发送到当前对话。',
  capsule: '导出运行 Capsule', exporting: '正在导出…', capsuleSaved: '已生成默认脱敏的离线 Capsule；分享前请检查下载内容。',
  recoveryPreview: '恢复影响预演', affected: '受影响任务', reusable: '可复用任务', blocked: '阻塞原因', noAffected: '尚无被证明需要重做的任务。', previewOnly: '这里只生成 Retry / Fork 建议，不会自动执行。',
  reviewCancel: '查看取消影响', confirmCancel: '确认取消整个运行', cancelRequested: '已请求取消。', cancelAlreadyTerminal: '运行已经结束，没有发送取消。', cancelAlreadyRequested: '取消已在处理中，没有重复发送。', cancelNotFound: 'DSH 已找不到该活动运行。', cancelStale: '运行事实已变化；请返回实时状态并重新检查影响。', cancelInterrupted: '取消调用被中断；未把它记录为成功。', cancelWarning: '当前 DSH Workflow 只能取消整个运行。再次确认才会发送请求。',
  foundry: '运行工坊', recipeRuns: '用于比较 / Recipe 的运行', previewRecipe: '检查历史运行', exportRecipe: '导出 Recipe ZIP（不会安装）', recipeBundleSaved: '已下载一份 Recipe ZIP；解压后可检查 recipe.json、SKILL.md 与 checksums.json。', compare: '比较单/多 Agent', insufficient: '证据不足，不能形成性能结论。', telemetry: '导出 OTLP JSON', telemetryDisabled: '遥测导出默认关闭。', recipeReady: '已找到可比且验证通过的历史运行。', recipePermissionExplicit: '工具清单已记录，但历史后端强制执行尚未证明；创建草稿后必须重新预检。', recipePermissionInherited: '工具权限继承当前对话，尚未隔离；创建草稿后必须重新预检。', recipeBudget: '复用预算边界', recipeVerifiers: '必需验证器', recipeCurrentPreflight: '创建草稿时会重新检查当前 Provider、工具权限、验证器和完整预算；不会自动批准或执行。', recipeObjective: '新方案目标', recipeObjectivePlaceholder: '输入这次要完成的具体目标', createRecipeDraft: '创建草稿、预检并打开 Plan', creatingRecipeDraft: '正在创建草稿…', recipeDraftCreated: '已创建方案草稿并完成当前环境预检；尚未批准或执行。', recipeRunLimit: '一次最多选择 50 次运行。', queryKind: '事实查询类型', question: '关于本次运行的问题', verifiedRuns: '验证运行', cursor: '事件游标',
}

const COPY_EN: Copy = {
  title: 'Agent Foundry', description: 'Align the approved plan with authoritative runtime events, find the first provable divergence, and preview safe recovery.',
  loading: 'Rebuilding run facts…', unavailable: 'The Foundry fact stream is unavailable; the current view may be stale.', retry: 'Retry',
  noRuns: 'No plan execution yet', noRunsBody: 'Approve and execute an Agent plan to see its Execution Twin, timeline, and evidence passport.',
  execution: 'Execution', live: 'Live', paused: 'Historical view', returnLive: 'Return live', timeline: 'Run timeline', passport: 'Evidence Passport',
  summary: 'Summary', contract: 'Plan contract', actual: 'Actual run', evidence: 'Verifier evidence', deviations: 'Deviations', recovery: 'Recovery', technical: 'Technical',
  lifecycle: 'Lifecycle', conformance: 'Conformance', evidenceState: 'Evidence state', noEvidence: 'No verifier receipt applies to this node.', noDeviation: 'No provable divergence exists at this cursor.', firstDivergence: 'First provable divergence', storage: 'Fact storage',
  askTitle: 'Ask this run', askPlaceholder: 'For example: why is it still running, and what evidence supports that?', ask: 'Send to current conversation', asking: 'Building factual packet…', askQueued: 'The question and evidence references were sent to the current conversation.',
  capsule: 'Export run Capsule', exporting: 'Exporting…', capsuleSaved: 'A redacted offline Capsule was generated. Inspect the download before sharing it.',
  recoveryPreview: 'Recovery impact preview', affected: 'Affected tasks', reusable: 'Reusable tasks', blocked: 'Blockers', noAffected: 'No task is proven to require rework.', previewOnly: 'This preview proposes Retry or Fork only and never executes them automatically.',
  reviewCancel: 'Review cancel impact', confirmCancel: 'Confirm whole-run cancel', cancelRequested: 'Cancellation was requested.', cancelAlreadyTerminal: 'The run is already terminal; no cancellation was sent.', cancelAlreadyRequested: 'Cancellation is already in progress; no duplicate request was sent.', cancelNotFound: 'DSH no longer reports this active execution.', cancelStale: 'Run facts changed. Return live and review the impact again.', cancelInterrupted: 'The cancel call was interrupted and was not recorded as successful.', cancelWarning: 'The current DSH Workflow adapter can cancel only the whole execution. Confirm again to send the request.',
  foundry: 'Run foundry', recipeRuns: 'Runs used for comparison / Recipe', previewRecipe: 'Check historical runs', exportRecipe: 'Export Recipe ZIP (not installed)', recipeBundleSaved: 'One Recipe ZIP was downloaded. Extract it to inspect recipe.json, SKILL.md, and checksums.json.', compare: 'Compare single vs multi-Agent', insufficient: 'Evidence is insufficient for a performance claim.', telemetry: 'Export OTLP JSON', telemetryDisabled: 'Telemetry export is disabled by default.', recipeReady: 'Comparable verifier-passing historical runs were found.', recipePermissionExplicit: 'The tool list was recorded, but historical backend enforcement was not attested. Current preflight is still required.', recipePermissionInherited: 'Tool authority is inherited from the conversation and remains unresolved. Current preflight is still required.', recipeBudget: 'Reusable budget envelope', recipeVerifiers: 'Required verifiers', recipeCurrentPreflight: 'Creating a draft rechecks current Providers, tool authority, verifiers, and the complete budget. It never approves or executes automatically.', recipeObjective: 'New plan objective', recipeObjectivePlaceholder: 'Enter the concrete objective for this run', createRecipeDraft: 'Create draft, preflight, and open Plan', creatingRecipeDraft: 'Creating draft…', recipeDraftCreated: 'A plan draft was created and checked against the current environment. It is not approved or running.', recipeRunLimit: 'Select at most 50 runs.', queryKind: 'Fact query type', question: 'Question about this run', verifiedRuns: 'Verified runs', cursor: 'Event cursor',
}

const QUERY_KINDS: readonly RunQueryKind[] = [
  'summary', 'why-running', 'first-divergence', 'active-tasks', 'configuration',
  'cancel-impact', 'recovery-impact', 'evidence',
]

export function AgentFoundryWorkbench(props: AgentFoundryWorkbenchProps): ReactNode {
  const { snapshot, sessionId, status, mode, actions, english, canvasCopy, onRetry, onOpenPlan, active } = props
  const instanceId = useId()
  const passportId = `${instanceId}-foundry-passport`
  const copy = english ? COPY_EN : COPY_ZH
  const executions = snapshot?.executions.filter(execution => execution.parentSessionId === String(sessionId)) ?? []
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const selectedExecution = executions.find(item => item.executionId === selectedExecutionId) ?? executions[0]
  const plan = selectedExecution === undefined || snapshot === undefined
    ? undefined
    : findExecutionPlanRevision(snapshot.plans, selectedExecution)
  const runEvents = useMemo(() => {
    if (selectedExecution === undefined) return []
    const bindingsByAttempt = new Map(selectedExecution.bindings.map(binding => [binding.attemptId, binding] as const))
    const planTaskIds = new Set(plan?.tasks.map(task => task.taskId) ?? [])
    return (snapshot?.events.filter((event) => {
      if (
        event.parentSessionId !== selectedExecution.parentSessionId
        || event.runId !== selectedExecution.executionId
        || event.planId !== selectedExecution.planId
        || event.planRevision !== selectedExecution.planRevision
      ) return false
      if (event.taskId !== undefined && !planTaskIds.has(event.taskId)) return false
      if (event.attemptId === undefined) return true
      const binding = bindingsByAttempt.get(event.attemptId)
      if (binding !== undefined) return event.taskId === undefined || binding.taskId === event.taskId
      return event.taskId === undefined
        && event.authority === 'dsh'
        && (event.type === 'child-published' || event.type === 'child-terminal')
    }) ?? []).sort((left, right) => left.cursor - right.cursor || left.eventId.localeCompare(right.eventId))
  }, [plan, selectedExecution, snapshot?.events])
  const maxCursor = runEvents.at(-1)?.cursor ?? 0
  const minCursor = runEvents[0]?.cursor ?? 0
  const [cursor, setCursor] = useState(maxCursor)
  const [followLive, setFollowLive] = useState(true)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [queryKind, setQueryKind] = useState<RunQueryKind>('why-running')
  const [question, setQuestion] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [cancelConfirmation, setCancelConfirmation] = useState<{
    readonly parentSessionId: string
    readonly runId: string
    readonly proposalId: string
    readonly eventCursor: number
  } | null>(null)
  const [recipeRuns, setRecipeRuns] = useState<ReadonlySet<string>>(() => new Set())
  const [candidate, setCandidate] = useState<RecipeCandidate | null>(null)
  const [advisor, setAdvisor] = useState<RunAdvisorResult | null>(null)
  const [recipeObjective, setRecipeObjective] = useState('')
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (selectedExecution === undefined) {
      setSelectedExecutionId(null)
      setSelectedNodeId(null)
      return
    }
    setSelectedExecutionId(selectedExecution.executionId)
    setSelectedNodeId(previous => previous ?? executionNodeId(selectedExecution.executionId))
  }, [selectedExecution])

  useEffect(() => {
    if (!followLive) return
    setCursor(maxCursor)
  }, [followLive, maxCursor])

  useEffect(() => {
    setCursor(maxCursor)
    setFollowLive(true)
    setSelectedNodeId(selectedExecution === undefined ? null : executionNodeId(selectedExecution.executionId))
    setCancelConfirmation(null)
  }, [sessionId, selectedExecution?.executionId])

  useEffect(() => {
    controller.current?.abort()
    controller.current = null
    setOperation(null)
    setRecipeRuns(new Set())
    setCandidate(null)
    setAdvisor(null)
    setNotice(null)
    setError(null)
    setRecipeObjective('')
  }, [sessionId])

  useEffect(() => { setCancelConfirmation(null) }, [selectedExecution?.executionId, snapshot?.revision])

  useEffect(() => {
    setCandidate(null)
    setAdvisor(null)
  }, [snapshot?.revision])

  useEffect(() => {
    if (active) return
    controller.current?.abort()
    controller.current = null
    setOperation(null)
    setCancelConfirmation(null)
  }, [active])

  useEffect(() => () => { controller.current?.abort() }, [])

  if (snapshot === undefined) {
    return <EmptyState copy={copy} loading={status === 'loading'} onRetry={onRetry} />
  }
  if (selectedExecution === undefined) {
    return (
      <section className={css.empty}>
        <strong>{copy.noRuns}</strong><p>{copy.noRunsBody}</p>
        {status === 'error' ? <button type="button" onClick={onRetry}>{copy.retry}</button> : null}
      </section>
    )
  }

  const taskTitle = (taskId: string): string => (
    plan?.tasks.find(task => task.taskId === taskId)?.title ?? taskId
  )
  const projectedExecution = projectExecutionAtCursor(selectedExecution, snapshot.events, cursor)
  const liveCursor = cursor >= maxCursor
  const visibleRunEvents = runEvents.filter(event => event.cursor <= cursor)
  const visibleEventsById = new Map(visibleRunEvents.map(event => [event.eventId, event] as const))
  const visibleEventIds = new Set(visibleEventsById.keys())
  const visibleReceipts = snapshot.receipts.filter((receipt) => {
    if (
      receipt.parentSessionId !== selectedExecution.parentSessionId
      || receipt.runId !== selectedExecution.executionId
      || receipt.planId !== selectedExecution.planId
      || receipt.planRevision !== selectedExecution.planRevision
      || receipt.authority === 'model-claim'
      || !selectedExecution.bindings.some(binding => (
        binding.taskId === receipt.taskId && binding.attemptId === receipt.attemptId
      ))
    ) return false
    const verifier = plan?.tasks.find(task => task.taskId === receipt.taskId)
      ?.verifiers?.find(candidate => candidate.verifierId === receipt.verifierId)
    return verifier?.kind === receipt.verifierKind
      && receiptClaimMatchesVerifier(receipt.claim, verifier.kind)
      && receipt.evidenceEventIds.every((eventId) => {
        const event = visibleEventsById.get(eventId)
        return event?.taskId === receipt.taskId && event.attemptId === receipt.attemptId
      })
  })
  const historicalNow = visibleRunEvents.at(-1)?.occurredAt
    ?? visibleRunEvents.at(-1)?.observedAt
    ?? selectedExecution.createdAt
  const runEventsById = new Map(runEvents.map(event => [event.eventId, event] as const))
  const report = snapshot.reports.find(item => reportMatchesExecution(
    item,
    selectedExecution,
    plan,
    runEventsById,
    maxCursor,
  ))
  const proposal = liveCursor
    ? snapshot.recoveryProposals.find(item => (
      item.parentSessionId === selectedExecution.parentSessionId
      && item.runId === selectedExecution.executionId
      && item.planId === selectedExecution.planId
      && item.planRevision === selectedExecution.planRevision
      && item.capabilityDigest === selectedExecution.capabilityDigest
      && report !== undefined
      && item.eventCursor === report.eventCursor
      && item.divergenceIds.every(findingId => report.findings.some(finding => (
        finding.findingId === findingId && finding.status === 'open'
      )))
      && item.affectedTaskIds.every(taskId => plan?.tasks.some(task => task.taskId === taskId) === true)
      && item.reusableTaskIds.every(taskId => plan?.tasks.some(task => task.taskId === taskId) === true)
      && item.actions.every(action => (
        item.affectedTaskIds.includes(action.taskId)
        && plan?.tasks.some(task => task.taskId === action.taskId) === true
      ))
    ))
    : undefined
  const cancelTarget = proposal === undefined ? undefined : {
    parentSessionId: String(sessionId),
    runId: selectedExecution.executionId,
    proposalId: proposal.proposalId,
    eventCursor: proposal.eventCursor,
  }
  const cancelArmed = cancelTarget !== undefined
    && cancelConfirmation?.parentSessionId === cancelTarget.parentSessionId
    && cancelConfirmation.runId === cancelTarget.runId
    && cancelConfirmation.proposalId === cancelTarget.proposalId
    && cancelConfirmation.eventCursor === cancelTarget.eventCursor
  const visibleFindings = report?.findings.filter(finding => (
    liveCursor
    || (
      finding.firstObservedAt <= historicalNow
      && finding.evidenceEventIds.length > 0
      && finding.evidenceEventIds.every(eventId => visibleEventIds.has(eventId))
    )
  )) ?? []
  const firstVisibleDivergence = visibleFindings.find(finding => (
    finding.status === 'open' && finding.certainty === 'proven'
  ))
  const visibleConformance = liveCursor
    ? report?.state ?? 'unknown'
    : visibleFindings.some(finding => finding.status === 'open' && finding.severity !== 'info')
      ? 'deviated'
      : 'unknown'
  const graph = projectedExecution === undefined
    ? undefined
    : buildPlanComparisonGraph(projectedExecution, plan)
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId) ?? graph?.nodes[0]
  const selectedTaskId = selectedNode?.taskId
  const selectedAttemptId = selectedNode?.binding?.attemptId
  const evidence = visibleReceipts.filter(receipt => (
    (selectedTaskId === undefined || receipt.taskId === selectedTaskId)
    && (selectedAttemptId === undefined || receipt.attemptId === selectedAttemptId)
  ))
  const nodeFindings = visibleFindings.filter(finding => (
    selectedTaskId === undefined || finding.taskId === undefined || finding.taskId === selectedTaskId
  ))

  const begin = (name: string): AbortController => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setOperation(name)
    setNotice(null)
    setError(null)
    return next
  }
  const finish = (owner: AbortController): void => {
    if (controller.current !== owner) return
    controller.current = null
    setOperation(null)
  }
  const ownsOperation = (owner: AbortController): boolean => (
    !owner.signal.aborted && controller.current === owner
  )

  const ask = async (): Promise<void> => {
    if (question.trim().length === 0) return
    const request = begin('ask')
    try {
      await actions.askRun(sessionId, {
        parentSessionId: String(sessionId),
        runId: selectedExecution.executionId,
        kind: queryKind,
        throughCursor: cursor,
        ...(selectedTaskId === undefined ? {} : { taskId: selectedTaskId }),
      }, question, request.signal)
      if (!ownsOperation(request)) return
      setNotice(copy.askQueued)
      setQuestion('')
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  const exportCapsule = async (): Promise<void> => {
    const request = begin('capsule')
    try {
      const result = await actions.exportRunCapsule({
        parentSessionId: String(sessionId), runId: selectedExecution.executionId,
        includeObjective: false, includeTaskBriefs: false,
      }, request.signal)
      if (!ownsOperation(request)) return
      downloadText(result.fileName, result.html, 'text/html;charset=utf-8')
      setNotice(copy.capsuleSaved)
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  const previewRecipe = async (): Promise<void> => {
    const request = begin('recipe-preview')
    try {
      const result = await actions.previewRecipe({
        parentSessionId: String(sessionId), executionIds: [...recipeRuns],
      }, request.signal)
      if (!ownsOperation(request)) return
      setCandidate(result)
      setNotice(`${copy.recipeReady} ${copy.verifiedRuns}: ${String(result.validation.runCount)}.`)
    } catch { if (ownsOperation(request)) { setCandidate(null); setError(copy.insufficient) } } finally { finish(request) }
  }

  const instantiateRecipe = async (): Promise<void> => {
    if (candidate === null || recipeObjective.trim().length === 0) return
    const request = begin('recipe-instantiate')
    try {
      await actions.instantiateRecipe({
        parentSessionId: String(sessionId),
        executionIds: [...recipeRuns],
        candidateId: candidate.candidateId,
        objective: recipeObjective.trim(),
      }, request.signal)
      if (!ownsOperation(request)) return
      setNotice(copy.recipeDraftCreated)
      onOpenPlan()
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  const exportRecipe = async (): Promise<void> => {
    if (candidate === null) return
    const request = begin('recipe-export')
    try {
      const result = await actions.exportRecipe({
        parentSessionId: String(sessionId), executionIds: [...recipeRuns],
        candidateId: candidate.candidateId, approvalDigest: candidate.exportApprovalDigest,
      }, request.signal)
      if (!ownsOperation(request)) return
      const archive = await buildRecipeArchive(result)
      if (!ownsOperation(request)) return
      downloadBytes(
        `agent-foundry-recipe-${candidate.candidateId.slice(0, 12)}.zip`,
        archive,
        'application/zip',
      )
      setNotice(copy.recipeBundleSaved)
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  const compare = async (): Promise<void> => {
    const request = begin('compare')
    try {
      const result = await actions.compareRuns({
        parentSessionId: String(sessionId), executionIds: [...recipeRuns],
      }, request.signal)
      if (!ownsOperation(request)) return
      setAdvisor(result)
    } catch { if (ownsOperation(request)) { setAdvisor(null); setError(copy.insufficient) } } finally { finish(request) }
  }

  const exportTelemetry = async (): Promise<void> => {
    const request = begin('telemetry')
    try {
      const result = await actions.exportTelemetry({
        parentSessionId: String(sessionId), runId: selectedExecution.executionId,
      }, request.signal)
      if (!ownsOperation(request)) return
      if (!result.enabled) setNotice(copy.telemetryDisabled)
      else downloadText('agent-run-telemetry.otlp.json', result.payload, 'application/json;charset=utf-8')
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  const cancel = async (): Promise<void> => {
    if (cancelTarget === undefined) { setError(copy.unavailable); return }
    if (!cancelArmed) { setCancelConfirmation(cancelTarget); return }
    const request = begin('cancel')
    try {
      const grant = await actions.issueCancelControlGrant({
        parentSessionId: cancelTarget.parentSessionId,
        runId: cancelTarget.runId,
        proposalId: cancelTarget.proposalId,
        eventCursor: cancelTarget.eventCursor,
      }, request.signal)
      if (!ownsOperation(request)) return
      const result = await actions.executeCancelControl({
        parentSessionId: cancelTarget.parentSessionId,
        runId: cancelTarget.runId,
        grantId: grant.grantId,
      }, request.signal)
      if (!ownsOperation(request)) return
      setNotice(cancelResultText(result.status, copy))
      setCancelConfirmation(null)
    } catch { if (ownsOperation(request)) setError(copy.unavailable) } finally { finish(request) }
  }

  return (
    <section className={css.root} aria-busy={operation !== null || status === 'loading'}>
      <header className={css.header}>
        <div><span>{copy.foundry}</span><h2>{copy.title}</h2><p>{copy.description}</p></div>
        <label><span>{copy.execution}</span><select value={selectedExecution.executionId} disabled={!active || operation !== null} onChange={(event) => { setSelectedExecutionId(event.currentTarget.value); setCandidate(null); setAdvisor(null) }}>{executions.map(execution => <option key={execution.executionId} value={execution.executionId}>{foundryValue(execution.status, english)} · r{String(execution.planRevision)} · {shortId(execution.executionId)}</option>)}</select></label>
      </header>
      {status === 'error' ? <div className={css.error} role="alert"><span>{copy.unavailable}</span><button type="button" onClick={onRetry}>{copy.retry}</button></div> : null}
      {error === null ? null : <div className={css.error} role="alert">{error}</div>}
      {notice === null ? null : <div className={css.notice} role="status">{notice}</div>}
      <div className={css.layout}>
        <div className={css.mainColumn}>
          <div className={css.canvasShell}>
            {projectedExecution === undefined ? <div className={css.beforeRun}>{copy.paused}</div> : <AgentPlanComparisonCanvas execution={projectedExecution} {...(plan === undefined ? {} : { plan })} selectedNodeId={selectedNode?.id ?? null} onSelect={setSelectedNodeId} now={historicalNow} detailsId={passportId} copy={canvasCopy} />}
          </div>
          <section className={css.timeline} aria-label={copy.timeline}>
            <header><div><strong>{copy.timeline}</strong><span>{liveCursor ? copy.live : copy.paused} · {copy.cursor} {String(cursor)}</span></div>{liveCursor ? null : <button type="button" onClick={() => { setCursor(maxCursor); setFollowLive(true) }}>{copy.returnLive}</button>}</header>
            <input type="range" min={minCursor} max={Math.max(minCursor, maxCursor)} value={Math.min(Math.max(cursor, minCursor), Math.max(minCursor, maxCursor))} aria-label={copy.timeline} aria-valuetext={`${copy.cursor} ${String(cursor)} · ${liveCursor ? copy.live : copy.paused}`} onChange={(event) => { const value = Number(event.currentTarget.value); setCursor(value); setFollowLive(value >= maxCursor) }} onKeyDown={(event) => timelineKey(event, minCursor, maxCursor, setCursor, setFollowLive)} />
            <div className={css.eventStrip}>{runEvents.filter(event => event.cursor <= cursor).slice(-8).map(event => <button key={event.eventId} type="button" title={event.eventId} onClick={() => { setCursor(event.cursor); setFollowLive(event.cursor >= maxCursor) }}><span>{event.type}</span><code>{String(event.cursor)}</code></button>)}</div>
          </section>
          <section className={css.ask}>
            <header><strong>{copy.askTitle}</strong><label><span className={css.visuallyHidden}>{copy.queryKind}</span><select aria-label={copy.queryKind} value={queryKind} disabled={!active || operation !== null} onChange={(event) => { setQueryKind(event.currentTarget.value as RunQueryKind) }}>{QUERY_KINDS.map(kind => <option key={kind} value={kind}>{queryKindLabel(kind, english)}</option>)}</select></label></header>
            <div><label><span className={css.visuallyHidden}>{copy.question}</span><textarea aria-label={copy.question} value={question} maxLength={2_000} disabled={!active || operation !== null} placeholder={copy.askPlaceholder} onChange={(event) => { setQuestion(event.currentTarget.value) }} /></label><button type="button" disabled={!active || operation !== null || question.trim().length === 0} onClick={() => { void ask() }}>{operation === 'ask' ? copy.asking : copy.ask}</button></div>
          </section>
        </div>
        <aside id={passportId} className={css.passport} aria-label={copy.passport}>
          <header><span>{copy.passport}</span><strong>{selectedNode?.task?.title ?? selectedNode?.taskId ?? copy.summary}</strong></header>
          <PassportSection title={copy.summary}><Fact label={copy.lifecycle} value={foundryValue(projectedExecution?.status ?? 'not-observed', english)} /><Fact label={copy.conformance} value={foundryValue(visibleConformance, english)} /><Fact label={copy.evidenceState} value={foundryValue(evidenceState(evidence), english)} /><Fact label={copy.storage} value={`${snapshot.durability}/${snapshot.storageStatus}`} /></PassportSection>
          <PassportSection title={copy.contract}><Fact label={english ? 'plan' : '方案'} value={plan === undefined ? foundryValue('unknown', english) : `${plan.title} · r${String(plan.revision)}`} /><Fact label={english ? 'pattern' : '协作模式'} value={plan?.pattern ?? foundryValue('unknown', english)} />{selectedNode?.task === undefined ? null : <><Fact label={english ? 'role' : '角色'} value={selectedNode.task.roleId} /><Fact label={english ? 'effect' : '影响类型'} value={foundryValue(selectedNode.task.effect?.kind ?? 'unknown', english)} /></>}</PassportSection>
          <PassportSection title={copy.actual}><Fact label="attempt" value={selectedNode?.binding?.attemptId ?? foundryValue('not-materialized', english)} /><Fact label={english ? 'status' : '状态'} value={foundryValue(selectedNode?.binding?.status ?? projectedExecution?.status ?? 'unknown', english)} /><Fact label={english ? 'recorded provider/model' : '已记录 Provider / 模型'} value={foundryValue(observedConfiguration(runEvents, selectedTaskId, cursor), english)} /></PassportSection>
          <PassportSection title={copy.evidence}>{evidence.length === 0 ? <p>{copy.noEvidence}</p> : <ul>{evidence.slice(0, 50).map(receipt => <li key={receipt.receiptId}><strong>{receipt.verifierId}</strong><span>{receipt.result} · {receipt.authority}</span><code>{shortId(receipt.receiptId)}</code></li>)}</ul>}</PassportSection>
          <PassportSection title={copy.deviations}>{nodeFindings.length === 0 ? <p>{copy.noDeviation}</p> : <ul>{nodeFindings.slice(0, 100).map(finding => <li key={finding.findingId} data-first={finding.findingId === firstVisibleDivergence?.findingId ? '' : undefined}><strong>{finding.code}</strong><span>{finding.severity} · {finding.certainty}</span><code>{shortId(finding.findingId)}</code></li>)}</ul>}{firstVisibleDivergence === undefined ? null : <small>{copy.firstDivergence}: <code>{shortId(firstVisibleDivergence.findingId)}</code></small>}</PassportSection>
          <PassportSection title={copy.technical}><Fact label="runId" value={selectedExecution.executionId} code /><Fact label="planId" value={selectedExecution.planId} code /><Fact label={copy.cursor} value={String(cursor)} code /><Fact label="snapshot digest" value={snapshot.projectionDigest} code /></PassportSection>
        </aside>
      </div>
      {mode === 'recovery' ? <section className={css.recoveryPanel}><header><div><span>{copy.recovery}</span><h3>{copy.recoveryPreview}</h3></div><strong>{copy.previewOnly}</strong></header><div className={css.recoveryGrid}><FactList title={copy.affected} values={(proposal?.affectedTaskIds ?? []).map(taskTitle)} empty={copy.noAffected} /><FactList title={copy.reusable} values={(proposal?.reusableTaskIds ?? []).map(taskTitle)} empty="—" /><FactList title={copy.blocked} values={proposal?.blockedReasonCodes ?? []} empty="—" /></div>{proposal?.actions.slice(0, 100).map(action => <div className={css.actionRow} key={action.actionId}><strong title={action.taskId}>{taskTitle(action.taskId)}</strong><span>{foundryValue(action.kind, english)}</span><strong data-allowed={String(action.allowed)}>{action.allowed ? foundryValue('preview-allowed', english) : action.reasonCode}</strong></div>)}<div className={css.cancelArea}>{cancelArmed ? <p role="alert">{copy.cancelWarning}</p> : null}<button type="button" disabled={!active || status !== 'ready' || operation !== null || proposal === undefined || !liveCursor || selectedExecution.cancellationRequested || ['stopping', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'].includes(selectedExecution.status)} onClick={() => { void cancel() }}>{cancelArmed ? copy.confirmCancel : copy.reviewCancel}</button></div></section> : null}
      <section className={css.exportBar}><button type="button" disabled={!active || !liveCursor || operation !== null} onClick={() => { void exportCapsule() }}>{operation === 'capsule' ? copy.exporting : copy.capsule}</button><button type="button" disabled={!active || !liveCursor || operation !== null} onClick={() => { void exportTelemetry() }}>{copy.telemetry}</button></section>
      <details className={css.recipePanel}><summary>{copy.recipeRuns}</summary><div className={css.runChoices}>{executions.slice(0, 50).map(execution => <label key={execution.executionId}><input type="checkbox" disabled={!active || operation !== null} checked={recipeRuns.has(execution.executionId)} onChange={(event) => { const checked = event.currentTarget.checked; setRecipeRuns(current => { const next = new Set(current); if (checked && next.size < 50) next.add(execution.executionId); else if (!checked) next.delete(execution.executionId); return next }); setCandidate(null); setAdvisor(null) }} /><span>{foundryValue(execution.status, english)} · {shortId(execution.executionId)} · {execution.backend}</span></label>)}</div>{executions.length <= 50 ? null : <p>{copy.recipeRunLimit}</p>}<div className={css.recipeActions}><button type="button" disabled={!active || recipeRuns.size < 3 || operation !== null} onClick={() => { void previewRecipe() }}>{copy.previewRecipe}</button><button type="button" disabled={!active || recipeRuns.size < 2 || operation !== null} onClick={() => { void compare() }}>{copy.compare}</button><button type="button" disabled={!active || candidate === null || operation !== null} onClick={() => { void exportRecipe() }}>{copy.exportRecipe}</button></div>{candidate === null ? null : <div className={css.recipeCandidate}><p>{copy.recipeReady} {copy.verifiedRuns}: {String(candidate.validation.runCount)}.</p><div><Fact label={copy.recipeBudget} value={formatRecipeBudget(candidate, english)} /><Fact label={copy.recipeVerifiers} value={String(candidate.capabilityRequirements.verifiers.filter(verifier => verifier.required).length)} /></div><p>{candidate.validation.permissionStatus === 'explicit-not-attested' ? copy.recipePermissionExplicit : copy.recipePermissionInherited}</p><p>{copy.recipeCurrentPreflight}</p><label><span>{copy.recipeObjective}</span><input value={recipeObjective} maxLength={8_000} disabled={!active || operation !== null} placeholder={copy.recipeObjectivePlaceholder} onChange={(event) => { setRecipeObjective(event.currentTarget.value) }} /></label><button type="button" disabled={!active || recipeObjective.trim().length === 0 || operation !== null} onClick={() => { void instantiateRecipe() }}>{operation === 'recipe-instantiate' ? copy.creatingRecipeDraft : copy.createRecipeDraft}</button></div>}{advisor === null ? null : <p>{advisor.status === 'sufficient' ? foundryValue(advisor.recommendation, english) : `${copy.insufficient} ${advisor.reasonCodes.join(', ')}`}</p>}</details>
    </section>
  )
}

function EmptyState({ copy, loading, onRetry }: { readonly copy: Copy; readonly loading: boolean; readonly onRetry: () => void }): ReactNode {
  return <section className={css.empty} aria-busy={loading}><strong>{loading ? copy.loading : copy.unavailable}</strong>{loading ? null : <button type="button" onClick={onRetry}>{copy.retry}</button>}</section>
}

function PassportSection({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return <section className={css.passportSection}><h3>{title}</h3>{children}</section>
}

function Fact({ label, value, code = false }: { readonly label: string; readonly value: string; readonly code?: boolean }): ReactNode {
  return <div className={css.fact}><span>{label}</span>{code ? <code>{value}</code> : <strong>{value}</strong>}</div>
}

function FactList({ title, values, empty }: { readonly title: string; readonly values: readonly string[]; readonly empty: string }): ReactNode {
  return <div><span>{title}</span><strong>{values.length === 0 ? empty : values.join(', ')}</strong></div>
}

function shortId(value: string): string { return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-6)}` }

function queryKindLabel(kind: RunQueryKind, english: boolean): string {
  const labels: Record<RunQueryKind, readonly [string, string]> = {
    summary: ['摘要', 'Summary'],
    'why-running': ['为什么仍在运行', 'Why it is running'],
    'first-divergence': ['首个偏差', 'First divergence'],
    'active-tasks': ['活动任务', 'Active tasks'],
    configuration: ['已记录配置', 'Recorded configuration'],
    'cancel-impact': ['取消影响', 'Cancel impact'],
    'recovery-impact': ['恢复影响', 'Recovery impact'],
    evidence: ['验证证据', 'Evidence'],
  }
  return labels[kind][english ? 1 : 0]
}

function cancelResultText(status: ExecuteCancelControlResult['status'], copy: Copy): string {
  if (status === 'requested') return copy.cancelRequested
  if (status === 'already-terminal') return copy.cancelAlreadyTerminal
  if (status === 'already-requested') return copy.cancelAlreadyRequested
  if (status === 'not-found') return copy.cancelNotFound
  if (status === 'stale-grant') return copy.cancelStale
  return copy.cancelInterrupted
}

function formatRecipeBudget(candidate: RecipeCandidate, english: boolean): string {
  const budget = candidate.budgetEnvelope
  const seconds = Math.ceil(budget.planTimeoutMs / 1_000)
  return english
    ? `${String(budget.maxAgents)} Agents · ${String(budget.maxConcurrent)} concurrent · ${String(seconds)}s timeout`
    : `${String(budget.maxAgents)} 个 Agent · ${String(budget.maxConcurrent)} 并发 · ${String(seconds)} 秒超时`
}

function foundryValue(value: string, english: boolean): string {
  if (english) return value
  const labels: Readonly<Record<string, string>> = {
    queued: '排队中', running: '运行中', succeeded: '已成功', partial: '部分完成', failed: '失败', cancelled: '已取消', unknown: '未知',
    pending: '等待中', published: '已发布', completed: '已完成', confirmed: '已确认', deviated: '存在偏差', 'not-applicable': '不适用',
    verified: '已验证', 'not-observed': '尚未观测', 'not-materialized': '尚未创建',
    pure: '纯计算', idempotent: '幂等', compensatable: '可补偿', irreversible: '不可逆',
    retry: '重试', replay: '重放', fork: '分叉', reassign: '重新分配', cancel: '取消', 'preview-allowed': '允许预演',
    'attempt-unsuccessful': '尝试未成功',
    'single-agent': '单 Agent', 'multi-agent': '多 Agent', 'no-claim': '不作结论',
  }
  return labels[value] ?? value
}

function evidenceState(receipts: readonly FoundrySnapshot['receipts'][number][]): string {
  if (receipts.some(receipt => receipt.result === 'fail')) return 'failed'
  if (receipts.some(receipt => receipt.result === 'pass')) return 'verified'
  return 'unknown'
}

function receiptClaimMatchesVerifier(
  claim: FoundrySnapshot['receipts'][number]['claim'],
  kind: FoundrySnapshot['receipts'][number]['verifierKind'],
): boolean {
  if (kind === 'lifecycle') return claim === 'lifecycle-terminal'
  if (kind === 'manual') return claim === 'manual-accepted'
  return claim === 'criteria-satisfied' || claim === 'artifact-produced'
}

function reportMatchesExecution(
  report: FoundrySnapshot['reports'][number],
  execution: PlanExecution,
  plan: AgentPlanRevision | undefined,
  eventsById: ReadonlyMap<string, FoundrySnapshot['events'][number]>,
  maxCursor: number,
): boolean {
  if (
    plan === undefined
    || report.parentSessionId !== execution.parentSessionId
    || report.runId !== execution.executionId
    || report.planId !== execution.planId
    || report.planRevision !== execution.planRevision
    || report.eventCursor !== maxCursor
  ) return false
  const findingsById = new Map(report.findings.map(finding => [finding.findingId, finding] as const))
  if (findingsById.size !== report.findings.length) return false
  const tasksById = new Map(report.tasks.map(task => [task.taskId, task] as const))
  if (tasksById.size !== report.tasks.length || tasksById.size !== plan.tasks.length) return false
  if (!plan.tasks.every(task => tasksById.has(task.taskId))) return false
  if (!report.tasks.every(task => (
    new Set(task.findingIds).size === task.findingIds.length
    && (task.attemptId === undefined || execution.bindings.some(binding => (
      binding.taskId === task.taskId && binding.attemptId === task.attemptId
    )))
    && task.findingIds.every(findingId => findingsById.get(findingId)?.taskId === task.taskId)
  ))) return false
  if (!report.findings.every(finding => (
    finding.parentSessionId === execution.parentSessionId
    && finding.runId === execution.executionId
    && finding.planId === execution.planId
    && finding.planRevision === execution.planRevision
    && (finding.taskId === undefined || tasksById.get(finding.taskId)?.findingIds.includes(finding.findingId) === true)
    && (finding.attemptId === undefined || execution.bindings.some(binding => (
      binding.attemptId === finding.attemptId
      && (finding.taskId === undefined || binding.taskId === finding.taskId)
    )))
    && finding.evidenceEventIds.every((eventId) => {
      const event = eventsById.get(eventId)
      return event !== undefined
        && event.cursor <= report.eventCursor
        && (finding.taskId === undefined || event.taskId === undefined || event.taskId === finding.taskId)
        && (finding.attemptId === undefined || event.attemptId === undefined || event.attemptId === finding.attemptId)
    })
  ))) return false
  if (report.firstProvableDivergenceId !== undefined) {
    const first = findingsById.get(report.firstProvableDivergenceId)
    if (first?.status !== 'open' || first.certainty !== 'proven') return false
  }
  return true
}

function observedConfiguration(events: readonly FoundrySnapshot['events'][number][], taskId: string | undefined, cursor: number): string {
  const configuration = events.filter(event => event.cursor <= cursor && (taskId === undefined || event.taskId === taskId)).findLast(event => event.configuration !== undefined)?.configuration
  if (configuration === undefined) return 'unknown'
  return [configuration.transportProvider, configuration.llmProvider, configuration.model, configuration.reasoningEffort].filter(value => value !== undefined).join(' / ') || 'unknown'
}

function timelineKey(event: KeyboardEvent<HTMLInputElement>, min: number, max: number, setCursor: (value: number) => void, setLive: (value: boolean) => void): void {
  if (event.key === 'Home') { event.preventDefault(); setCursor(min); setLive(false) }
  if (event.key === 'End') { event.preventDefault(); setCursor(max); setLive(true) }
  if (event.key === 'PageUp') { event.preventDefault(); setCursor(Math.max(min, Number(event.currentTarget.value) - 10)); setLive(false) }
  if (event.key === 'PageDown') { event.preventDefault(); const next = Math.min(max, Number(event.currentTarget.value) + 10); setCursor(next); setLive(next >= max) }
}

function downloadText(fileName: string, content: string, type: string): void {
  downloadBytes(fileName, strToU8(content), type)
}

function downloadBytes(fileName: string, content: Uint8Array<ArrayBuffer>, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export async function buildRecipeArchive(result: ExportRecipeResult): Promise<Uint8Array<ArrayBuffer>> {
  const expectedPaths = ['SKILL.md', 'checksums.json', result.fileName].sort()
  const actualPaths = result.skillFiles.map(file => file.path).sort()
  if (new Set(actualPaths).size !== actualPaths.length || actualPaths.join('\u0000') !== expectedPaths.join('\u0000')) {
    throw new Error('recipe export does not contain the expected bounded file set')
  }
  const recipe = result.skillFiles.find(file => file.path === result.fileName)
  if (recipe?.content !== result.recipeJson) throw new Error('recipe export entrypoint does not match recipeJson')
  for (const file of result.skillFiles) {
    if (await browserSha256(file.content) !== file.digest) {
      throw new Error(`recipe export digest does not match ${file.path}`)
    }
  }
  const checksumFile = result.skillFiles.find(file => file.path === 'checksums.json')
  let checksums: unknown
  try {
    checksums = JSON.parse(checksumFile?.content ?? '')
  } catch (error) {
    throw new Error('recipe export checksums are not valid JSON', { cause: error })
  }
  const expectedChecksums = Object.fromEntries(
    result.skillFiles
      .filter(file => file.path !== 'checksums.json')
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(file => [file.path, file.digest]),
  )
  const checksumEntries = checksums !== null && typeof checksums === 'object' && !Array.isArray(checksums)
    ? Object.entries(checksums)
    : []
  const checksumKeys = checksumEntries.map(([path]) => path).sort()
  const expectedChecksumKeys = Object.keys(expectedChecksums).sort()
  if (
    checksums === null
    || typeof checksums !== 'object'
    || Array.isArray(checksums)
    || checksumKeys.join('\u0000') !== expectedChecksumKeys.join('\u0000')
    || checksumEntries.some(([path, digest]) => expectedChecksums[path] !== digest)
  ) throw new Error('recipe export checksums do not match the reviewed files')
  const entries: Zippable = {}
  for (const file of [...result.skillFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    if (file.path.includes('..') || file.path.startsWith('/') || file.path.includes('\\')) {
      throw new Error('recipe export contains an unsafe archive path')
    }
    entries[file.path] = [strToU8(file.content), {
      level: 6,
      mtime: new Date('1980-01-01T00:00:00.000Z'),
    }]
  }
  return zipSync(entries)
}

async function browserSha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', strToU8(value))
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
