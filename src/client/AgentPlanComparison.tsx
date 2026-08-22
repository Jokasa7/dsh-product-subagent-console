import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AgentPlanRevision,
  CancelPlanExecutionRequest,
  CancelPlanExecutionResult,
  PlanExecution,
  PlanExecutionRepositorySnapshot,
  PlanRevisionRequest,
  PlanRunBinding,
  PlanTask,
} from '../plan-types.js'
import {
  AgentPlanComparisonCanvas, type AgentPlanComparisonCanvasCopy,
} from './AgentPlanComparisonCanvas.js'
import {
  buildPlanComparisonGraph, executionNodeId, findExecutionPlanRevision,
  type PlanComparisonNode,
} from './plan-comparison-model.js'
import css from './AgentPlanComparison.module.css'

/** Authority-bearing callbacks supplied by the client entry. */
export interface AgentPlanComparisonActions {
  /** Queue or start execution for this exact approved revision according to host policy. */
  readonly requestExecution: (
    request: PlanRevisionRequest,
    signal: AbortSignal,
  ) => Promise<void>
  /** Request cancellation for one exact execution owned by the current Session. */
  readonly cancelExecution: (
    request: CancelPlanExecutionRequest,
    signal: AbortSignal,
  ) => Promise<CancelPlanExecutionResult>
}

const COMPARISON_COPY_ZH_VALUES = {
  notFoundError: '该执行已不存在，请刷新运行快照。',
  alreadyTerminalError: '该执行已经结束，无需再次取消。',
  genericError: '操作失败，请刷新后重试。',
  status: '状态',
  backend: '后端',
  planRevision: '计划修订',
  attemptCount: '尝试数量',
  startedAt: '开始时间',
  finishedAt: '结束时间',
  duration: '持续时间',
  cancellationRequested: '已请求取消',
  yes: '是',
  no: '否',
  role: '角色',
  risk: '风险',
  actualAttempts: '实际尝试',
  dependencies: '依赖',
  none: '无',
  taskBrief: '任务说明',
  expectedOutput: '预期输出',
  unresolvedBindingNote: '此 binding 的 taskId 不存在于该执行指定的计划修订中，因此没有自动关联到任何计划任务。',
  attemptNumber: '尝试次数',
  unpublished: '尚未发布',
  executionRequested: '已提交“{title}”修订 r{revision} 的执行请求。',
  cancelRequestedMessage: '已请求取消该执行；最终状态以运行快照为准。',
  alreadyEndedMessage: '该执行已经结束。',
  executionNotFoundMessage: '未找到该执行，请刷新运行快照。',
  title: '计划 / 实际对照',
  description: '只显示执行快照中明确记录的 taskId 与 attempt 映射。',
  temporaryStorage: '临时记录，仅在本次运行中保留',
  viewExecution: '查看执行',
  noExecutions: '暂无执行记录',
  approvedPlan: '批准的方案',
  noRunnablePlans: '暂无可执行方案',
  submitting: '正在提交…',
  requestExecution: '请求执行',
  cancelling: '正在取消…',
  cancelAlreadyRequested: '已请求取消',
  cancelExecution: '取消执行',
  droppedBindings: '快照中有 {count} 条 binding 的执行或计划标识不一致，未参与对照。',
  emptyTitle: '尚无执行记录',
  emptyDescription: '选择一个已批准方案并请求执行后，对照结果会显示在这里。',
  missingPlan: '找不到该执行指定的精确计划修订；实际 attempt 会保留为未对应节点，不会自动匹配其他修订。',
  detailsAria: '对照节点详情',
  executionSnapshot: '执行快照',
  plannedTask: '计划任务',
  actualAttempt: '实际尝试',
  notSelected: '未选择',
  detailEmpty: '选择画布节点查看详情。',
} as const

/** Complete user-facing text for the plan-versus-execution workbench. */
export type AgentPlanComparisonCopy = {
  readonly [Key in keyof typeof COMPARISON_COPY_ZH_VALUES]: string
}

export const AGENT_PLAN_COMPARISON_COPY_ZH: AgentPlanComparisonCopy = COMPARISON_COPY_ZH_VALUES

export const AGENT_PLAN_COMPARISON_COPY_EN: AgentPlanComparisonCopy = {
  notFoundError: 'This execution no longer exists. Refresh the execution snapshot.',
  alreadyTerminalError: 'This execution has already ended and cannot be cancelled again.',
  genericError: 'The action failed. Refresh and try again.',
  status: 'Status',
  backend: 'Backend',
  planRevision: 'Plan revision',
  attemptCount: 'Attempts',
  startedAt: 'Started',
  finishedAt: 'Finished',
  duration: 'Duration',
  cancellationRequested: 'Cancellation requested',
  yes: 'Yes',
  no: 'No',
  role: 'Role',
  risk: 'Risk',
  actualAttempts: 'Actual attempts',
  dependencies: 'Dependencies',
  none: 'None',
  taskBrief: 'Task brief',
  expectedOutput: 'Expected output',
  unresolvedBindingNote: 'This binding references a taskId that is not present in the exact plan revision, so it was not attached to a planned task.',
  attemptNumber: 'Attempt number',
  unpublished: 'Not published',
  executionRequested: 'Requested execution of “{title}” revision r{revision}.',
  cancelRequestedMessage: 'Cancellation was requested. The execution snapshot remains the source of truth for the final status.',
  alreadyEndedMessage: 'This execution has already ended.',
  executionNotFoundMessage: 'This execution was not found. Refresh the execution snapshot.',
  title: 'Plan / actual comparison',
  description: 'Shows only taskId-to-attempt mappings explicitly recorded in the execution snapshot.',
  temporaryStorage: 'Temporary history retained for this run only',
  viewExecution: 'View execution',
  noExecutions: 'No execution history',
  approvedPlan: 'Approved plan',
  noRunnablePlans: 'No approved plans ready to run',
  submitting: 'Submitting…',
  requestExecution: 'Request execution',
  cancelling: 'Cancelling…',
  cancelAlreadyRequested: 'Cancellation requested',
  cancelExecution: 'Cancel execution',
  droppedBindings: '{count} bindings had mismatched execution or plan identities and were excluded from this comparison.',
  emptyTitle: 'No execution history yet',
  emptyDescription: 'Select an approved plan and request execution to see the comparison here.',
  missingPlan: 'The exact plan revision for this execution is unavailable. Actual attempts remain unresolved and are not matched to another revision.',
  detailsAria: 'Comparison node details',
  executionSnapshot: 'Execution snapshot',
  plannedTask: 'Planned task',
  actualAttempt: 'Actual attempt',
  notSelected: 'Not selected',
  detailEmpty: 'Select a canvas node to view its details.',
}

/** Inputs for the plan-versus-actual comparison workbench. */
export interface AgentPlanComparisonProps {
  readonly sessionId: SessionId
  readonly plans: readonly AgentPlanRevision[]
  readonly executionSnapshot: PlanExecutionRepositorySnapshot
  readonly actions: AgentPlanComparisonActions
  readonly copy?: AgentPlanComparisonCopy
  readonly canvasCopy?: AgentPlanComparisonCanvasCopy
}

type ActionState = 'request' | 'cancel' | null

function liveExecution(execution: PlanExecution): boolean {
  return execution.status === 'queued'
    || execution.status === 'running'
    || execution.status === 'stopping'
}

function liveAttempt(binding: PlanRunBinding): boolean {
  return binding.status === 'queued'
    || binding.status === 'starting'
    || binding.status === 'running'
    || binding.status === 'waiting'
    || binding.status === 'stopping'
}

function canCancel(execution: PlanExecution): boolean {
  return (execution.status === 'queued' || execution.status === 'running')
    && !execution.cancellationRequested
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Date(value).toLocaleString()
}

function formatDuration(
  startedAt: number | undefined,
  finishedAt: number | undefined,
  now: number,
): string {
  if (startedAt === undefined) return '—'
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds / 60) % 60
  const remainder = seconds % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`
  if (minutes > 0) return `${String(minutes)}m ${String(remainder).padStart(2, '0')}s`
  return `${String(remainder)}s`
}

function formatCopy(template: string, values: Readonly<Record<string, string | number>>): string {
  let result = template
  for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value))
  return result
}

function safeActionMessage(error: unknown, copy: AgentPlanComparisonCopy): string {
  const message = error instanceof Error ? error.message : ''
  if (/not found|does not exist/iu.test(message)) return copy.notFoundError
  if (/terminal|already/iu.test(message)) return copy.alreadyTerminalError
  if (/aborted|aborterror/iu.test(message)) return ''
  return copy.genericError
}

function approvedPlans(
  plans: readonly AgentPlanRevision[],
  parentSessionId: string,
): readonly AgentPlanRevision[] {
  return plans
    .filter(plan => plan.parentSessionId === parentSessionId && plan.state === 'approved')
    .sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision)
}

function DetailRow({ label, children }: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

function ExecutionDetails({ execution, now, copy }: {
  readonly execution: PlanExecution
  readonly now: number
  readonly copy: AgentPlanComparisonCopy
}): ReactNode {
  return (
    <dl className={css.detailList}>
      <DetailRow label={copy.status}>{execution.status}</DetailRow>
      <DetailRow label={copy.backend}><code>{execution.backend}</code></DetailRow>
      <DetailRow label={copy.planRevision}>r{String(execution.planRevision)}</DetailRow>
      <DetailRow label={copy.attemptCount}>{String(execution.bindings.length)}</DetailRow>
      <DetailRow label={copy.startedAt}>{formatTimestamp(execution.startedAt ?? execution.createdAt)}</DetailRow>
      <DetailRow label={copy.finishedAt}>{formatTimestamp(execution.finishedAt)}</DetailRow>
      <DetailRow label={copy.duration}>
        {formatDuration(execution.startedAt ?? execution.createdAt, execution.finishedAt, now)}
      </DetailRow>
      <DetailRow label={copy.cancellationRequested}>{execution.cancellationRequested ? copy.yes : copy.no}</DetailRow>
      <DetailRow label="Execution ID"><code>{execution.executionId}</code></DetailRow>
    </dl>
  )
}

function TaskDetails({ task, attempts, roles, copy }: {
  readonly task: PlanTask
  readonly attempts: readonly PlanRunBinding[]
  readonly roles: ReadonlyMap<string, AgentPlanRevision['roles'][number]>
  readonly copy: AgentPlanComparisonCopy
}): ReactNode {
  const role = roles.get(task.roleId)
  return (
    <>
      <dl className={css.detailList}>
        <DetailRow label="Task ID"><code>{task.taskId}</code></DetailRow>
        <DetailRow label={copy.role}>{role?.name ?? task.roleId}</DetailRow>
        <DetailRow label="Transport Provider"><code>{role?.transportProvider ?? '—'}</code></DetailRow>
        <DetailRow label={copy.risk}>{task.risk}</DetailRow>
        <DetailRow label={copy.actualAttempts}>{String(attempts.length)}</DetailRow>
        <DetailRow label={copy.dependencies}>
          {task.dependsOn.length === 0
            ? copy.none
            : task.dependsOn.map(item => `${item.taskId} (${item.mode})`).join(', ')}
        </DetailRow>
      </dl>
      <section className={css.detailText}>
        <strong>{copy.taskBrief}</strong>
        <p>{task.brief}</p>
      </section>
      <section className={css.detailText}>
        <strong>{copy.expectedOutput}</strong>
        <p>{task.expectedOutput.description}</p>
      </section>
    </>
  )
}

function AttemptDetails({ binding, now, unresolved, copy }: {
  readonly binding: PlanRunBinding
  readonly now: number
  readonly unresolved: boolean
  readonly copy: AgentPlanComparisonCopy
}): ReactNode {
  return (
    <>
      {unresolved ? (
        <p className={css.unresolvedNote}>
          {copy.unresolvedBindingNote}
        </p>
      ) : null}
      <dl className={css.detailList}>
        <DetailRow label={copy.status}>{binding.status}</DetailRow>
        <DetailRow label="Task ID"><code>{binding.taskId}</code></DetailRow>
        <DetailRow label={copy.attemptNumber}>#{String(binding.attemptNumber)}</DetailRow>
        <DetailRow label="Child ID"><code>{binding.childId ?? copy.unpublished}</code></DetailRow>
        <DetailRow label={copy.startedAt}>{formatTimestamp(binding.startedAt)}</DetailRow>
        <DetailRow label={copy.finishedAt}>{formatTimestamp(binding.finishedAt)}</DetailRow>
        <DetailRow label={copy.duration}>{formatDuration(binding.startedAt, binding.finishedAt, now)}</DetailRow>
        <DetailRow label="Attempt ID"><code>{binding.attemptId}</code></DetailRow>
        <DetailRow label="Retry of"><code>{binding.retryOf ?? '—'}</code></DetailRow>
      </dl>
    </>
  )
}

/** Render exact plan-to-execution bindings with selection, detail, execution request, and cancellation. */
export function AgentPlanComparison({
  sessionId, plans, executionSnapshot, actions, canvasCopy,
  copy = AGENT_PLAN_COMPARISON_COPY_ZH,
}: AgentPlanComparisonProps): ReactNode {
  const parentSessionId = String(sessionId)
  const executions = useMemo(() => executionSnapshot.executions
    .filter(execution => execution.parentSessionId === parentSessionId)
    .sort((left, right) => right.createdAt - left.createdAt), [executionSnapshot.executions, parentSessionId])
  const runnablePlans = useMemo(() => approvedPlans(plans, parentSessionId), [parentSessionId, plans])
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const [selectedPlanKey, setSelectedPlanKey] = useState<string>('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [action, setAction] = useState<ActionState>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  const selectedExecution = executions.find(execution => execution.executionId === selectedExecutionId)
    ?? executions[0]
  const selectedPlan = selectedExecution === undefined
    ? undefined
    : findExecutionPlanRevision(plans, selectedExecution)
  const graph = useMemo(() => selectedExecution === undefined
    ? undefined
    : buildPlanComparisonGraph(selectedExecution, selectedPlan), [selectedExecution, selectedPlan])
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId)
    ?? graph?.nodes[0]
  const roles = useMemo(() => new Map(
    selectedPlan?.roles.map(role => [role.roleId, role] as const) ?? [],
  ), [selectedPlan])
  const selectedTaskAttempts = selectedNode?.taskId === undefined || graph === undefined
    ? []
    : graph.nodes
      .filter(node => node.taskId === selectedNode.taskId && node.binding !== undefined)
      .flatMap(node => node.binding === undefined ? [] : [node.binding])

  useEffect(() => {
    if (selectedExecution === undefined) {
      setSelectedExecutionId(null)
      setSelectedNodeId(null)
      return
    }
    if (selectedExecutionId !== selectedExecution.executionId) {
      setSelectedExecutionId(selectedExecution.executionId)
    }
    setSelectedNodeId(previous => previous !== null
      && graph?.nodes.some(node => node.id === previous)
      ? previous
      : executionNodeId(selectedExecution.executionId))
  }, [graph?.nodes, selectedExecution, selectedExecutionId])

  useEffect(() => {
    const current = runnablePlans.find(plan => `${plan.planId}@${String(plan.revision)}` === selectedPlanKey)
    if (current !== undefined) return
    const preferred = selectedPlan?.state === 'approved'
      ? selectedPlan
      : runnablePlans[0]
    setSelectedPlanKey(preferred === undefined ? '' : `${preferred.planId}@${String(preferred.revision)}`)
  }, [runnablePlans, selectedPlan, selectedPlanKey])

  useEffect(() => () => { controller.current?.abort() }, [])

  useEffect(() => {
    if (selectedExecution === undefined) return
    if (!liveExecution(selectedExecution) && !selectedExecution.bindings.some(liveAttempt)) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [selectedExecution])

  const beginAction = (next: Exclude<ActionState, null>): AbortSignal => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setAction(next)
    setMessage(null)
    setError(null)
    return nextController.signal
  }

  const finishAction = (): void => {
    controller.current = null
    setAction(null)
  }

  const requestExecution = async (): Promise<void> => {
    const plan = runnablePlans.find(item => `${item.planId}@${String(item.revision)}` === selectedPlanKey)
    if (plan === undefined) return
    const signal = beginAction('request')
    try {
      await actions.requestExecution({
        parentSessionId,
        planId: plan.planId,
        revision: plan.revision,
      }, signal)
      setMessage(formatCopy(copy.executionRequested, { title: plan.title, revision: plan.revision }))
    } catch (reason: unknown) {
      const safe = safeActionMessage(reason, copy)
      if (safe.length > 0) setError(safe)
    } finally {
      finishAction()
    }
  }

  const cancelExecution = async (): Promise<void> => {
    if (selectedExecution === undefined || !canCancel(selectedExecution)) return
    const signal = beginAction('cancel')
    try {
      const result = await actions.cancelExecution({
        parentSessionId,
        executionId: selectedExecution.executionId,
      }, signal)
      setMessage(result.status === 'requested'
        ? copy.cancelRequestedMessage
        : result.status === 'already-terminal'
          ? copy.alreadyEndedMessage
          : copy.executionNotFoundMessage)
    } catch (reason: unknown) {
      const safe = safeActionMessage(reason, copy)
      if (safe.length > 0) setError(safe)
    } finally {
      finishAction()
    }
  }

  return (
    <section className={css.root} aria-busy={action !== null}>
      <header className={css.header}>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <span>{executionSnapshot.durability === 'host-only' ? copy.temporaryStorage : ''}</span>
      </header>

      <div className={css.toolbar}>
        <label>
          <span>{copy.viewExecution}</span>
          <select
            value={selectedExecution?.executionId ?? ''}
            disabled={executions.length === 0}
            onChange={(event) => {
              setSelectedExecutionId(event.currentTarget.value)
              setSelectedNodeId(executionNodeId(event.currentTarget.value))
              setMessage(null)
              setError(null)
            }}
          >
            {executions.length === 0 ? <option value="">{copy.noExecutions}</option> : null}
            {executions.map(execution => (
              <option key={execution.executionId} value={execution.executionId}>
                {execution.status} · {execution.backend} · r{String(execution.planRevision)} · {formatTimestamp(execution.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{copy.approvedPlan}</span>
          <select
            value={selectedPlanKey}
            disabled={runnablePlans.length === 0 || action !== null}
            onChange={(event) => { setSelectedPlanKey(event.currentTarget.value) }}
          >
            {runnablePlans.length === 0 ? <option value="">{copy.noRunnablePlans}</option> : null}
            {runnablePlans.map(plan => (
              <option key={`${plan.planId}@${String(plan.revision)}`} value={`${plan.planId}@${String(plan.revision)}`}>
                {plan.title} · r{String(plan.revision)}
              </option>
            ))}
          </select>
        </label>
        <div className={css.toolbarActions}>
          <button
            type="button"
            disabled={selectedPlanKey.length === 0 || action !== null}
            onClick={() => { void requestExecution() }}
          >{action === 'request' ? copy.submitting : copy.requestExecution}</button>
          <button
            type="button"
            className={css.cancelButton}
            disabled={selectedExecution === undefined || !canCancel(selectedExecution) || action !== null}
            onClick={() => { void cancelExecution() }}
          >{action === 'cancel'
              ? copy.cancelling
              : selectedExecution?.cancellationRequested === true || selectedExecution?.status === 'stopping'
                ? copy.cancelAlreadyRequested
                : copy.cancelExecution}</button>
        </div>
      </div>

      {error === null ? null : <div className={css.failure} role="alert">{error}</div>}
      {message === null ? null : <div className={css.success} role="status">{message}</div>}
      {(graph?.droppedBindings ?? 0) === 0 ? null : (
        <div className={css.failure} role="status">
          {formatCopy(copy.droppedBindings, { count: graph?.droppedBindings ?? 0 })}
        </div>
      )}

      {selectedExecution === undefined ? (
        <div className={css.empty}>
          <strong>{copy.emptyTitle}</strong>
          <p>{copy.emptyDescription}</p>
        </div>
      ) : (
        <>
          {selectedPlan === undefined ? (
            <div className={css.missingPlan} role="status">
              {copy.missingPlan}
            </div>
          ) : null}
          <div className={css.layout}>
            <div className={css.canvasColumn}>
              <AgentPlanComparisonCanvas
                execution={selectedExecution}
                {...(selectedPlan === undefined ? {} : { plan: selectedPlan })}
                selectedNodeId={selectedNode?.id ?? null}
                onSelect={setSelectedNodeId}
                now={now}
                {...(canvasCopy === undefined ? {} : { copy: canvasCopy })}
              />
            </div>
            <aside
              id="agent-plan-comparison-details"
              className={css.details}
              aria-label={copy.detailsAria}
            >
              <header>
                <span>{selectedNode?.kind === 'execution'
                  ? copy.executionSnapshot
                  : selectedNode?.kind === 'plan-task'
                    ? copy.plannedTask
                    : copy.actualAttempt}</span>
                <strong>{selectedNode?.kind === 'execution'
                  ? selectedExecution.status
                  : selectedNode?.task?.title ?? selectedNode?.taskId ?? copy.notSelected}</strong>
              </header>
              {selectedNode?.kind === 'execution'
                ? <ExecutionDetails execution={selectedExecution} now={now} copy={copy} />
                : selectedNode?.kind === 'plan-task' && selectedNode.task !== undefined
                  ? <TaskDetails task={selectedNode.task} attempts={selectedTaskAttempts} roles={roles} copy={copy} />
                  : selectedNode?.binding === undefined
                    ? <p className={css.detailEmpty}>{copy.detailEmpty}</p>
                    : <AttemptDetails
                      binding={selectedNode.binding}
                      now={now}
                      unresolved={selectedNode.kind === 'unresolved-attempt'}
                      copy={copy}
                    />}
            </aside>
          </div>
        </>
      )}
    </section>
  )
}

export type { PlanComparisonNode }
