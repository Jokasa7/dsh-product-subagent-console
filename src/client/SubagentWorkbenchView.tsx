import {
  useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react'
import type { SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconBranchOutline16, IconCloseOutline16, IconRefreshOutline14, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConsoleSnapshot, OwnedAttemptOutcome } from '../types.js'
import type {
  CancelPlanExecutionRequest,
  CancelPlanExecutionResult,
  ExecutionCapabilitySnapshot,
  PlanExecutionRepositorySnapshot,
  PlanRepositorySnapshot,
  PlanRevisionRequest,
} from '../plan-types.js'
import {
  AGENT_PLAN_WORKBENCH_COPY_EN,
  AGENT_PLAN_WORKBENCH_COPY_ZH,
  AgentPlanWorkbench, type AgentPlanWorkbenchInjected,
} from './AgentPlanWorkbench.js'
import {
  AGENT_PLAN_COMPARISON_COPY_EN,
  AGENT_PLAN_COMPARISON_COPY_ZH,
  AgentPlanComparison,
} from './AgentPlanComparison.js'
import {
  AGENT_PLAN_CANVAS_COPY_EN,
  AGENT_PLAN_CANVAS_COPY_ZH,
} from './AgentPlanCanvas.js'
import {
  PLAN_COMPARISON_CANVAS_COPY_EN,
  PLAN_COMPARISON_CANVAS_COPY_ZH,
} from './AgentPlanComparisonCanvas.js'
import {
  SubagentTaskCanvas, type SubagentCanvasContent, type SubagentCanvasCopy,
} from './SubagentTaskCanvas.js'
import { buildWorkbenchCanvasTopology, workbenchCanvasRootId } from './workbench-canvas.js'
import {
  buildWorkbenchTree, collectTreeParentIds, flattenWorkbenchTree,
  type NativeWorkbenchNode, type ProductAttemptWorkbenchNode, type ProductWorkbenchNode,
  type WorkbenchNode, type WorkbenchState,
} from './workbench-model.js'
import css from './SubagentWorkbenchView.module.css'

/** Runtime actions supplied by the independent browser entry. */
export interface SubagentWorkbenchInjected {
  readonly listSessions: (
    parentSessionIds: readonly SessionId[],
    signal: AbortSignal,
  ) => Promise<ConsoleSnapshot>
  readonly watchSessions: (
    parentSessionIds: readonly SessionId[],
    hostInstanceId: string,
    afterRevision: number,
    signal: AbortSignal,
  ) => Promise<ConsoleSnapshot>
  readonly openChild: (address: SubagentAddress) => void
  readonly refreshNative: (parentSessionId: SessionId) => Promise<void>
}

/** Plan execution actions supplied by the browser entry. */
export interface PlanExecutionWorkbenchInjected extends AgentPlanWorkbenchInjected {
  readonly getExecutionCapabilities: (
    parentSessionId: SessionId,
    signal: AbortSignal,
  ) => Promise<ExecutionCapabilitySnapshot>
  readonly listPlanExecutions: (
    parentSessionIds: readonly SessionId[],
    signal: AbortSignal,
  ) => Promise<PlanExecutionRepositorySnapshot>
  readonly watchPlanExecutions: (
    parentSessionIds: readonly SessionId[],
    hostInstanceId: string | undefined,
    afterRevision: number,
    signal: AbortSignal,
  ) => Promise<PlanExecutionRepositorySnapshot>
  readonly cancelPlanExecution: (
    request: CancelPlanExecutionRequest,
    signal: AbortSignal,
  ) => Promise<CancelPlanExecutionResult>
  readonly requestPlanExecution: (
    parentSessionId: SessionId,
    request: PlanRevisionRequest,
    signal: AbortSignal,
  ) => Promise<void>
}

export type ProductSubagentWorkbenchInjected = SubagentWorkbenchInjected
  & PlanExecutionWorkbenchInjected

type RuntimeWorkbenchProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'productSubagents'>
  & InjectFace<SubagentWorkbenchInjected>

/** Standard conversation-view props plus all three workbench mode actions. */
export type SubagentWorkbenchProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'productSubagents'>
  & InjectFace<ProductSubagentWorkbenchInjected>

type SnapshotState = {
  readonly status: 'loading' | 'ready' | 'error'
  readonly snapshot?: ConsoleSnapshot
}

type ComparisonSnapshotState = {
  readonly plans?: PlanRepositorySnapshot
  readonly executions?: PlanExecutionRepositorySnapshot
  readonly planError: boolean
  readonly executionError: boolean
}

function stateDot(node: WorkbenchNode): StateDotState {
  if (node.state === 'active' || node.state === 'queued' || node.state === 'starting') return 'ongoing'
  if (node.state === 'completed') return 'done'
  if (
    node.state === 'aborted'
    || node.state === 'refusal'
    || node.state === 'max-tokens'
    || node.state === 'unknown'
    || node.state === 'inactive'
    || (node.kind === 'product-attempt' && node.attempt.cancellationRequested === true)
  ) return 'warning'
  return 'error'
}

function stateKey(state: WorkbenchState): Parameters<SubagentWorkbenchProps['t']>[0] {
  switch (state) {
    case 'active': return 'state.active'
    case 'queued': return 'state.queued'
    case 'starting': return 'state.starting'
    case 'inactive': return 'state.inactive'
    case 'completed': return 'state.completed'
    case 'aborted': return 'state.aborted'
    case 'error': return 'state.error'
    case 'max-tokens': return 'state.maxTokens'
    case 'refusal': return 'state.refusal'
    case 'not-published': return 'state.notPublished'
    default: return 'state.unknown'
  }
}

function isLiveNode(node: WorkbenchNode): boolean {
  return node.state === 'active' || node.state === 'queued' || node.state === 'starting'
}

function isDisconnectedPluginNode(node: WorkbenchNode, disconnected: boolean): boolean {
  return disconnected && node.kind !== 'native' && isLiveNode(node)
}

function nodeStateKey(node: WorkbenchNode): Parameters<SubagentWorkbenchProps['t']>[0] {
  if (node.kind === 'native' && node.state === 'inactive') {
    return node.mode === 'continuable' ? 'state.resumable' : 'state.ended'
  }
  if (node.kind === 'product-attempt' && node.state === 'not-published') {
    return node.attempt.cancellationRequested === true
      ? 'state.notPublishedCancelled'
      : 'state.notPublished'
  }
  return stateKey(node.state)
}

function outcomeKey(outcome: OwnedAttemptOutcome): Parameters<SubagentWorkbenchProps['t']>[0] {
  switch (outcome) {
    case 'cancelled-before-publication': return 'outcome.cancelled'
    case 'queue-full': return 'outcome.queueFull'
    case 'start-failed': return 'outcome.startFailed'
    case 'lifecycle-missing': return 'outcome.lifecycleMissing'
  }
}

function formatDuration(startedAt: number, finishedAt: number | undefined, now: number): string {
  const total = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function nativeDuration(node: NativeWorkbenchNode, now: number): string | undefined {
  const timing = node.summary?.projectionValues?.subagentTiming
  if (timing === undefined) return undefined
  if (timing.active === undefined) return formatDuration(0, timing.settledMs, 0)
  const end = node.state === 'active' ? Math.max(now, timing.active.through) : timing.active.through
  return formatDuration(0, timing.settledMs + Math.max(0, end - timing.active.since), 0)
}

function DetailRow({ label, children }: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

function productName(value: {
  readonly displayName?: string | undefined
  readonly product?: string | undefined
}, fallback: string): string {
  return value.displayName ?? value.product ?? fallback
}

function ProductDetails({ node, now, disconnected, t }: {
  readonly node: ProductWorkbenchNode
  readonly now: number
  readonly disconnected: boolean
  readonly t: SubagentWorkbenchProps['t']
}): ReactNode {
  const run = node.run
  return (
    <>
      <dl className={css.detailList}>
        <DetailRow label={t('details.tool')}><code>{run.toolName}</code></DetailRow>
        <DetailRow label={t('details.task')}>{node.label}</DetailRow>
        <DetailRow label={t('details.product')}>{productName(run, t('externalAgent'))}</DetailRow>
        {run.instance === undefined ? null : (
          <DetailRow label={t('details.instance')}><code>{run.instance}</code></DetailRow>
        )}
        <DetailRow label={t('details.provider')}><code>{run.providerName}</code></DetailRow>
        <DetailRow label={t('details.source')}>
          {t(run.source === 'owned-tool' ? 'source.ownedTool' : 'source.observedTool')}
        </DetailRow>
        <DetailRow label={t('details.status')}>
          {t(disconnected ? 'state.disconnected' : nodeStateKey(node))}
        </DetailRow>
        <DetailRow label={t('details.duration')}>
          {formatDuration(run.startedAt, run.finishedAt, now)}
        </DetailRow>
        {run.providerMismatch ? (
          <DetailRow label={t('details.providerMismatch')}>{t('yes')}</DetailRow>
        ) : null}
      </dl>
      <details className={css.technical}>
        <summary>{t('details.technical')}</summary>
        <dl className={`${css.detailList} ${css.technicalList}`}>
          {run.expectedProviderName === undefined ? null : (
            <DetailRow label={t('details.expectedProvider')}><code>{run.expectedProviderName}</code></DetailRow>
          )}
          <DetailRow label={t('details.callId')}><code>{run.callId}</code></DetailRow>
          <DetailRow label={t('details.childId')}><code>{run.childId}</code></DetailRow>
          <DetailRow label={t('details.runId')}><code>{run.runId}</code></DetailRow>
          <DetailRow label={t('details.local')}>{t(run.local ? 'yes' : 'no')}</DetailRow>
        </dl>
      </details>
    </>
  )
}

function ProductAttemptDetails({ node, now, disconnected, t }: {
  readonly node: ProductAttemptWorkbenchNode
  readonly now: number
  readonly disconnected: boolean
  readonly t: SubagentWorkbenchProps['t']
}): ReactNode {
  const attempt = node.attempt
  return (
    <>
      <dl className={css.detailList}>
        <DetailRow label={t('details.tool')}><code>{attempt.toolName}</code></DetailRow>
        <DetailRow label={t('details.task')}>{node.label}</DetailRow>
        <DetailRow label={t('details.product')}>{productName(attempt, t('externalAgent'))}</DetailRow>
        {attempt.instance === undefined ? null : (
          <DetailRow label={t('details.instance')}><code>{attempt.instance}</code></DetailRow>
        )}
        <DetailRow label={t('details.expectedProvider')}><code>{attempt.expectedProviderName}</code></DetailRow>
        <DetailRow label={t('details.status')}>
          {t(disconnected ? 'state.disconnected' : nodeStateKey(node))}
        </DetailRow>
        <DetailRow label={t('details.duration')}>
          {formatDuration(attempt.startedAt ?? attempt.createdAt, attempt.finishedAt, now)}
        </DetailRow>
        {attempt.outcome === undefined ? null : (
          <DetailRow label={t('details.outcome')}>{t(outcomeKey(attempt.outcome))}</DetailRow>
        )}
      </dl>
      <details className={css.technical}>
        <summary>{t('details.technical')}</summary>
        <dl className={`${css.detailList} ${css.technicalList}`}>
          <DetailRow label={t('details.callId')}><code>{attempt.callId}</code></DetailRow>
          <DetailRow label={t('details.attemptId')}><code>{attempt.attemptId}</code></DetailRow>
        </dl>
      </details>
    </>
  )
}

function NativeDetails({ node, now, t }: {
  readonly node: NativeWorkbenchNode
  readonly now: number
  readonly t: SubagentWorkbenchProps['t']
}): ReactNode {
  const duration = nativeDuration(node, now)
  return (
    <>
      <dl className={css.detailList}>
        <DetailRow label={t('details.task')}>{node.label}</DetailRow>
        <DetailRow label={t('details.type')}>{t('nativeAgent')}</DetailRow>
        <DetailRow label={t('details.status')}>{t(nodeStateKey(node))}</DetailRow>
        <DetailRow label={t('details.mode')}>
          {t(node.mode === 'continuable' ? 'mode.continuable' : 'mode.oneShot')}
        </DetailRow>
        {duration === undefined ? null : <DetailRow label={t('details.duration')}>{duration}</DetailRow>}
      </dl>
      <details className={css.technical}>
        <summary>{t('details.technical')}</summary>
        <dl className={`${css.detailList} ${css.technicalList}`}>
          <DetailRow label={t('details.childId')}><code>{node.childSessionId}</code></DetailRow>
        </dl>
      </details>
    </>
  )
}

/** Render factual native and observed delegation state for the runtime mode. */
function RuntimeWorkbenchView({
  sessionId, useSessions, listSessions, watchSessions, openChild, refreshNative, t,
}: RuntimeWorkbenchProps): ReactNode {
  const catalogs = useSessions(snapshot => snapshot.subagentsByParent)
  const summaries = useSessions(snapshot => snapshot.byId)
  const parentIds = useMemo(
    () => collectTreeParentIds(sessionId, summaries, catalogs),
    [catalogs, sessionId, summaries],
  )
  const parentIdsKey = useMemo(() => parentIds.map(String).join('\u0000'), [parentIds])
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<SnapshotState>({ status: 'loading' })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const refreshed = useRef(new Set<SessionId>())
  const refreshCursor = useRef(0)
  const root = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const current = new Set(parentIds)
    for (const parentId of refreshed.current) {
      if (!current.has(parentId)) refreshed.current.delete(parentId)
    }
    for (const parentId of parentIds) {
      if (refreshed.current.has(parentId)) continue
      refreshed.current.add(parentId)
      void refreshNative(parentId)
    }
  }, [parentIds, refreshNative])

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        let snapshot = await listSessions(parentIds, controller.signal)
        while (!controller.signal.aborted) {
          setState({ status: 'ready', snapshot })
          snapshot = await watchSessions(
            parentIds,
            snapshot.hostInstanceId,
            snapshot.revision,
            controller.signal,
          )
        }
      } catch {
        if (!controller.signal.aborted) {
          setState(previous => ({
            status: 'error',
            ...(previous.snapshot === undefined ? {} : { snapshot: previous.snapshot }),
          }))
        }
      }
    }
    void load()
    return () => { controller.abort() }
  // parentIdsKey is the stable value dependency; parentIds is captured from the same render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSessions, parentIdsKey, request, watchSessions])

  useEffect(() => {
    if (parentIds.length === 0) return
    const refreshOne = (): void => {
      const parentId = parentIds[refreshCursor.current % parentIds.length]
      refreshCursor.current += 1
      if (parentId !== undefined) void refreshNative(parentId)
    }
    const timer = setInterval(refreshOne, 3_000)
    return () => { clearInterval(timer) }
  // parentIdsKey is the stable value dependency; parentIds is captured from the same render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentIdsKey, refreshNative])

  const tree = useMemo(() => buildWorkbenchTree({
    rootSessionId: sessionId,
    catalogs,
    summaries,
    ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }),
  }), [catalogs, sessionId, state.snapshot, summaries])
  const flat = useMemo(() => flattenWorkbenchTree(tree), [tree])
  const disconnected = state.status === 'error'
  const liveCount = flat.filter(node => isLiveNode(node) && !isDisconnectedPluginNode(node, disconnected)).length
  const selected = flat.find(node => node.key === selectedKey)
  const topology = useMemo(() => buildWorkbenchCanvasTopology(sessionId, tree), [sessionId, tree])
  const rootId = workbenchCanvasRootId(sessionId)
  const content = useMemo(() => {
    const next: Record<string, SubagentCanvasContent> = {}
    const rootTitle = summaries[sessionId]?.displayTitle || t('currentConversation')
    next[rootId] = {
      kind: 'root',
      title: t('currentConversation'),
      label: rootTitle,
      meta: t('root.summary'),
      status: t('root.branches', { count: flat.length }),
      ariaLabel: t('canvas.rootAria', { title: rootTitle, count: flat.length }),
    }
    for (const node of flat) {
      const product = node.kind === 'product'
      const attempt = node.kind === 'product-attempt'
      const title = product
        ? node.run.toolName
        : attempt ? node.attempt.toolName : t('nativeAgent')
      const pluginNow = disconnected ? state.snapshot?.capturedAt ?? now : now
      const duration = product
        ? formatDuration(node.run.startedAt, node.run.finishedAt, pluginNow)
        : attempt
          ? formatDuration(
            node.attempt.startedAt ?? node.attempt.createdAt,
            node.attempt.finishedAt,
            pluginNow,
          )
          : nativeDuration(node, now)
      const pluginDisconnected = isDisconnectedPluginNode(node, disconnected)
      const status = t(pluginDisconnected ? 'state.disconnected' : nodeStateKey(node))
      const meta = product
        ? `${productName(node.run, t('externalAgent'))} · ${node.run.providerName}`
        : attempt
          ? `${productName(node.attempt, t('externalAgent'))} · ${node.attempt.expectedProviderName}`
          : t(node.mode === 'continuable' ? 'mode.continuable' : 'mode.oneShot')
      next[node.key] = {
        kind: node.kind,
        title,
        label: node.label,
        meta,
        status,
        ...(duration === undefined ? {} : { duration }),
        state: node.state,
        dotState: pluginDisconnected ? 'warning' : stateDot(node),
        ariaLabel: t('canvas.nodeAria', { title, task: node.label, status }),
      }
    }
    return next
  }, [disconnected, flat, now, rootId, sessionId, state.snapshot?.capturedAt, summaries, t])
  const canvasCopy = useMemo((): SubagentCanvasCopy => ({
    ariaLabel: t('tree.aria'),
    controls: t('canvas.controls'),
    minimap: t('canvas.minimap'),
    zoomIn: t('canvas.zoomIn'),
    zoomOut: t('canvas.zoomOut'),
    fitView: t('canvas.fitView'),
    autoLayout: t('canvas.autoLayout'),
    nodeInstructions: t('canvas.nodeInstructions'),
    nodeMoved: t('canvas.nodeMoved'),
    interactionHint: t('canvas.interactionHint'),
    localLayoutNotice: t('canvas.localLayoutNotice'),
  }), [t])

  useEffect(() => {
    if (liveCount === 0) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [liveCount])

  useEffect(() => {
    if (selectedKey === null || selected !== undefined) return
    setSelectedKey(null)
    setDetailsOpen(false)
  }, [selected, selectedKey])

  const refresh = (): void => {
    for (const parentId of parentIds) void refreshNative(parentId)
    setState(previous => ({
      status: 'loading',
      ...(previous.snapshot === undefined ? {} : { snapshot: previous.snapshot }),
    }))
    setRequest(value => value + 1)
  }

  const closeDetails = (): void => {
    const restoreKey = selected?.key
    if (restoreKey !== undefined) {
      for (const candidate of root.current?.querySelectorAll<HTMLElement>('[data-canvas-node-id]') ?? []) {
        if (candidate.dataset.canvasNodeId !== restoreKey) continue
        candidate.focus()
        break
      }
    }
    setDetailsOpen(false)
  }

  return (
    <section ref={root} className={css.runtimeRoot} aria-busy={state.status === 'loading'}>
      <header className={css.header}>
        <div>
          <div className={css.titleLine}>
            <h2>{t('title')}</h2>
            <span>{t('summary.count', { total: flat.length, live: liveCount })}</span>
          </div>
          <p>{t('summary')}</p>
        </div>
        <button type="button" className={css.refresh} onClick={refresh} aria-label={t('refresh')}>
          <IconRefreshOutline14 />
        </button>
      </header>
      {state.status === 'error' ? (
        <div className={css.failure} role="alert">
          <span>{t('load.error')}</span>
          <button type="button" onClick={refresh}>{t('retry')}</button>
        </div>
      ) : null}
      {(state.snapshot?.diagnostics.droppedActiveRuns ?? 0) > 0 ? (
        <div className={css.failure} role="status">
          <span>{t('load.truncated', { count: state.snapshot?.diagnostics.droppedActiveRuns ?? 0 })}</span>
        </div>
      ) : null}
      <div className={selected === undefined || !detailsOpen ? css.layout : `${css.layout} ${css.layoutWithDetails}`}>
        <div className={css.canvasShell}>
          <SubagentTaskCanvas
            topology={topology}
            content={content}
            selectedKey={selectedKey}
            expandedKey={detailsOpen ? selectedKey : null}
            copy={canvasCopy}
            onSelect={(key) => {
              setSelectedKey(key)
              setDetailsOpen(true)
            }}
          />
          {state.status === 'loading' && flat.length === 0 ? (
            <p className={css.canvasEmpty}>{t('loading')}</p>
          ) : null}
          {state.status !== 'loading' && flat.length === 0 ? (
            <div className={css.canvasEmptyState}>
              <IconBranchOutline16 />
              <strong>{t('empty.title')}</strong>
              <span>{t('empty.body')}</span>
            </div>
          ) : null}
        </div>
        {selected === undefined || !detailsOpen ? null : (
          <aside id="product-subagent-details" className={css.details} aria-label={t('details.title')}>
            <header>
              <div>
                <span>{selected.kind === 'product'
                  ? selected.run.toolName
                  : selected.kind === 'product-attempt' ? selected.attempt.toolName : t('nativeAgent')}</span>
                <strong>{selected.label}</strong>
              </div>
              <button type="button" aria-label={t('details.close')} onClick={closeDetails}>
                <IconCloseOutline16 />
              </button>
            </header>
            {selected.kind === 'product'
              ? <ProductDetails
                node={selected}
                now={disconnected ? state.snapshot?.capturedAt ?? now : now}
                disconnected={isDisconnectedPluginNode(selected, disconnected)}
                t={t}
              />
              : selected.kind === 'product-attempt'
                ? <ProductAttemptDetails
                  node={selected}
                  now={disconnected ? state.snapshot?.capturedAt ?? now : now}
                  disconnected={isDisconnectedPluginNode(selected, disconnected)}
                  t={t}
                />
                : <NativeDetails node={selected} now={now} t={t} />}
            {selected.kind === 'native' ? (
              <button type="button" className={css.openSession} onClick={() => { openChild(selected.address) }}>
                {t('details.openConversation')}
              </button>
            ) : (
              <>
                <p className={css.externalNote}>
                  {t(selected.kind === 'product-attempt'
                    ? 'details.attemptNote'
                    : selected.run.local ? 'details.localPendingNote' : 'details.externalNote')}
                </p>
                <p className={css.externalNote}>{t('details.volatileNote')}</p>
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}

function ComparisonWorkbenchMode({
  sessionId, injected, t, english,
}: {
  readonly sessionId: SessionId
  readonly injected: PlanExecutionWorkbenchInjected
  readonly t: SubagentWorkbenchProps['t']
  readonly english: boolean
}): ReactNode {
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<ComparisonSnapshotState>({
    planError: false,
    executionError: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    const loadPlans = async (): Promise<void> => {
      try {
        let snapshot = await injected.listPlans([sessionId], controller.signal)
        while (!controller.signal.aborted) {
          setState(previous => ({ ...previous, plans: snapshot, planError: false }))
          snapshot = await injected.watchPlans(
            [sessionId],
            snapshot.hostInstanceId,
            snapshot.revision,
            controller.signal,
          )
        }
      } catch {
        if (!controller.signal.aborted) {
          setState(previous => ({ ...previous, planError: true }))
        }
      }
    }
    const loadExecutions = async (): Promise<void> => {
      try {
        let snapshot = await injected.listPlanExecutions([sessionId], controller.signal)
        while (!controller.signal.aborted) {
          setState(previous => ({ ...previous, executions: snapshot, executionError: false }))
          snapshot = await injected.watchPlanExecutions(
            [sessionId],
            snapshot.hostInstanceId,
            snapshot.revision,
            controller.signal,
          )
        }
      } catch {
        if (!controller.signal.aborted) {
          setState(previous => ({ ...previous, executionError: true }))
        }
      }
    }
    void loadPlans()
    void loadExecutions()
    return () => { controller.abort() }
  }, [injected, reload, sessionId])

  const actions = useMemo(() => ({
    requestExecution: (request: PlanRevisionRequest, signal: AbortSignal) => (
      injected.requestPlanExecution(sessionId, request, signal)
    ),
    cancelExecution: (request: CancelPlanExecutionRequest, signal: AbortSignal) => (
      injected.cancelPlanExecution(request, signal)
    ),
  }), [injected, sessionId])

  if (state.executions === undefined) {
    return (
      <section className={css.comparisonPlaceholder} aria-busy={!state.executionError}>
        <strong>{state.executionError
          ? t('workbench.compare.errorTitle')
          : t('workbench.compare.loadingTitle')}</strong>
        <p>{state.executionError
          ? t('workbench.compare.errorBody')
          : t('workbench.compare.loadingBody')}</p>
        {state.executionError ? (
          <button type="button" onClick={() => { setReload(value => value + 1) }}>{t('retry')}</button>
        ) : null}
      </section>
    )
  }

  return (
    <>
      {state.planError || state.executionError ? (
        <div className={css.failure} role="alert">
          <span>{t('workbench.compare.stale')}</span>
          <button type="button" onClick={() => { setReload(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : null}
      <AgentPlanComparison
        sessionId={sessionId}
        plans={state.plans?.plans ?? []}
        executionSnapshot={state.executions}
        actions={actions}
        copy={english ? AGENT_PLAN_COMPARISON_COPY_EN : AGENT_PLAN_COMPARISON_COPY_ZH}
        canvasCopy={english ? PLAN_COMPARISON_CANVAS_COPY_EN : PLAN_COMPARISON_CANVAS_COPY_ZH}
      />
    </>
  )
}

type WorkbenchMode = 'runtime' | 'planner' | 'compare'

/** Render the conversation-level workbench with runtime, plan, and comparison modes. */
export function SubagentWorkbenchView(props: SubagentWorkbenchProps): ReactNode {
  const { sessionId, t } = props
  const english = t('locale.code') === 'en'
  const [mode, setMode] = useState<WorkbenchMode>('runtime')
  const tabs: readonly { readonly id: WorkbenchMode; readonly label: string }[] = [
    { id: 'runtime', label: t('workbench.mode.runtime') },
    { id: 'planner', label: t('workbench.mode.planner') },
    { id: 'compare', label: t('workbench.mode.compare') },
  ]

  const selectAdjacent = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: number,
  ): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    if (next === undefined) return
    setMode(next.id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <section className={css.root} data-subagent-workbench="">
      <nav className={css.modeTabs} role="tablist" aria-label={t('workbench.mode.label')}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`product-subagent-mode-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            aria-controls={`product-subagent-panel-${tab.id}`}
            tabIndex={mode === tab.id ? 0 : -1}
            onClick={() => { setMode(tab.id) }}
            onKeyDown={(event) => { selectAdjacent(event, index) }}
          >{tab.label}</button>
        ))}
      </nav>
      <div
        id={`product-subagent-panel-${mode}`}
        className={css.modeBody}
        role="tabpanel"
        aria-labelledby={`product-subagent-mode-${mode}`}
      >
        {mode === 'runtime' ? (
          <RuntimeWorkbenchView {...props} />
        ) : mode === 'planner' ? (
          <AgentPlanWorkbench
            sessionId={sessionId}
            injected={props}
            copy={english ? AGENT_PLAN_WORKBENCH_COPY_EN : AGENT_PLAN_WORKBENCH_COPY_ZH}
            canvasCopy={english ? AGENT_PLAN_CANVAS_COPY_EN : AGENT_PLAN_CANVAS_COPY_ZH}
          />
        ) : (
          <ComparisonWorkbenchMode sessionId={sessionId} injected={props} t={t} english={english} />
        )}
      </div>
    </section>
  )
}
