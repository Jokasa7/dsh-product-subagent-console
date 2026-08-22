import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, BackgroundVariant, ControlButton, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider, useNodesState, useUpdateNodeInternals,
  type Edge, type Node, type NodeProps, type OnNodesChange, type ReactFlowInstance,
} from '@xyflow/react'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconRefreshOutline14,
  StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AgentPlanRevision, PlanAttemptStatus, PlanExecution, PlanRole, PlanRunBinding,
} from '../plan-types.js'
import {
  buildPlanComparisonGraph, layoutPlanComparisonGraph,
  type PlanComparisonGraph, type PlanComparisonLayoutNode, type PlanComparisonNode,
} from './plan-comparison-model.js'
import '@xyflow/react/dist/style.css'
import css from './AgentPlanComparisonCanvas.module.css'

export interface AgentPlanComparisonCanvasCopy {
  readonly ariaLabel: string
  readonly controls: string
  readonly minimap: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fitView: string
  readonly autoLayout: string
  readonly nodeInstructions: string
  readonly nodeMoved: string
  readonly execution: string
  readonly plannedTask: string
  readonly actualAttempt: string
  readonly unresolvedAttempt: string
  readonly attempts: string
  readonly noAttempt: string
  readonly child: string
  readonly noChild: string
  readonly planDependency: string
  readonly binding: string
  readonly retry: string
  readonly dragHint: string
}

export const PLAN_COMPARISON_CANVAS_COPY_ZH: AgentPlanComparisonCanvasCopy = {
  ariaLabel: 'Agent 计划与实际运行对照画布',
  controls: '对照画布控制',
  minimap: '对照缩略图',
  zoomIn: '放大',
  zoomOut: '缩小',
  fitView: '适应视图',
  autoLayout: '恢复自动布局',
  nodeInstructions: '按 Enter 或空格查看节点详情。',
  nodeMoved: '节点已移动到',
  execution: '执行',
  plannedTask: '计划任务',
  actualAttempt: '实际尝试',
  unresolvedAttempt: '未对应的实际尝试',
  attempts: '次尝试',
  noAttempt: '尚无实际尝试',
  child: 'Child',
  noChild: '尚未发布 Child',
  planDependency: '计划依赖',
  binding: '计划 / 实际映射',
  retry: '重试关系',
  dragHint: '拖动卡片只调整当前浏览视图；点击卡片查看权威快照详情。',
}

export const PLAN_COMPARISON_CANVAS_COPY_EN: AgentPlanComparisonCanvasCopy = {
  ariaLabel: 'Agent plan versus execution canvas',
  controls: 'Comparison canvas controls',
  minimap: 'Comparison minimap',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitView: 'Fit view',
  autoLayout: 'Restore automatic layout',
  nodeInstructions: 'Press Enter or Space to inspect node details.',
  nodeMoved: 'Node moved to',
  execution: 'Execution',
  plannedTask: 'Planned task',
  actualAttempt: 'Actual attempt',
  unresolvedAttempt: 'Unresolved actual attempt',
  attempts: 'attempts',
  noAttempt: 'No actual attempt yet',
  child: 'Child',
  noChild: 'Child not published',
  planDependency: 'Plan dependency',
  binding: 'Plan / actual binding',
  retry: 'Retry relation',
  dragHint: 'Dragging only changes this browser view; click a card for authoritative snapshot details.',
}

export interface AgentPlanComparisonCanvasProps {
  readonly execution: PlanExecution
  readonly plan?: AgentPlanRevision
  readonly selectedNodeId: string | null
  readonly onSelect: (nodeId: string) => void
  readonly now: number
  readonly copy?: AgentPlanComparisonCanvasCopy
}

type ComparisonNodeData = Record<string, unknown> & {
  readonly node: PlanComparisonNode
  readonly execution: PlanExecution
  readonly role?: PlanRole
  readonly attempts: readonly PlanRunBinding[]
  readonly now: number
  readonly copy: AgentPlanComparisonCanvasCopy
}

type ComparisonFlowNode = Node<ComparisonNodeData, 'plan-comparison'>
type ComparisonFlowEdge = Edge<Record<string, never>, 'smoothstep'>
type Offset = { readonly x: number; readonly y: number }

function stateDot(status: PlanAttemptStatus): StateDotState {
  if (status === 'completed') return 'done'
  if (status === 'running' || status === 'starting' || status === 'queued' || status === 'waiting') {
    return 'ongoing'
  }
  if (status === 'failed' || status === 'rejected') return 'error'
  return 'warning'
}

function duration(startedAt: number | undefined, finishedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds / 60) % 60
  const remainder = seconds % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${String(minutes)}m ${String(remainder).padStart(2, '0')}s`
  return `${String(remainder)}s`
}

function latestAttempt(attempts: readonly PlanRunBinding[]): PlanRunBinding | undefined {
  return [...attempts].sort((left, right) => (
    right.attemptNumber - left.attemptNumber || right.attemptId.localeCompare(left.attemptId)
  ))[0]
}

function ComparisonNodeCard({ data, selected }: NodeProps<ComparisonFlowNode>): ReactNode {
  const { node, execution, role, attempts, now, copy } = data
  const binding = node.binding
  const latest = latestAttempt(attempts)
  const isExecution = node.kind === 'execution'
  const isTask = node.kind === 'plan-task'
  const title = isExecution
    ? copy.execution
    : isTask
      ? copy.plannedTask
      : node.kind === 'attempt' ? copy.actualAttempt : copy.unresolvedAttempt
  const label = isExecution
    ? `#${execution.executionId.slice(0, 8)}`
    : isTask
      ? node.task?.title ?? node.taskId ?? copy.plannedTask
      : `#${String(binding?.attemptNumber ?? '?')} · ${node.task?.title ?? node.taskId ?? copy.actualAttempt}`
  const meta = isExecution
    ? `${execution.backend} · r${String(execution.planRevision)}`
    : isTask
      ? `${role?.name ?? node.task?.roleId ?? ''} · ${role?.transportProvider ?? ''}`
      : binding?.childId === undefined ? copy.noChild : `${copy.child} · ${binding.childId}`
  const status = isExecution
    ? execution.status
    : isTask
      ? latest === undefined ? copy.noAttempt : `${String(attempts.length)} ${copy.attempts} · ${latest.status}`
      : binding?.status ?? 'unknown'
  const elapsed = isTask
    ? undefined
    : isExecution
      ? duration(execution.startedAt ?? execution.createdAt, execution.finishedAt, now)
      : duration(binding?.startedAt, binding?.finishedAt, now)
  return (
    <div
      className={css.card}
      data-kind={node.kind}
      data-selected={selected || undefined}
      data-status={binding?.status ?? execution.status}
    >
      {isExecution ? null : (
        <Handle type="target" position={Position.Top} isConnectable={false} className={css.handle} />
      )}
      <div className={css.topline}>
        <span className={css.icon}>{isTask || isExecution
          ? <IconBranchOutline16 />
          : <IconAgentPresetOutline16 />}</span>
        <span className={css.identity}>
          <strong>{title}</strong>
          <span>{meta}</span>
        </span>
        {binding === undefined ? null : (
          <span className={css.dot}><StateDot state={stateDot(binding.status)} /></span>
        )}
      </div>
      <p>{label}</p>
      <div className={css.metaRow}>
        <span>{status}</span>
        {elapsed === undefined ? null : <span>{elapsed}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={css.handle} />
    </div>
  )
}

const NODE_TYPES = { 'plan-comparison': ComparisonNodeCard }

function flowNodes(
  graph: PlanComparisonGraph,
  layout: readonly PlanComparisonLayoutNode[],
  execution: PlanExecution,
  plan: AgentPlanRevision | undefined,
  selectedNodeId: string | null,
  now: number,
  copy: AgentPlanComparisonCanvasCopy,
): readonly ComparisonFlowNode[] {
  const positions = new Map(layout.map(node => [node.id, node] as const))
  const roles = new Map(plan?.roles.map(role => [role.roleId, role] as const) ?? [])
  const attemptsByTask = new Map<string, PlanRunBinding[]>()
  for (const node of graph.nodes) {
    if (node.binding === undefined || node.taskId === undefined) continue
    const attempts = attemptsByTask.get(node.taskId) ?? []
    attempts.push(node.binding)
    attemptsByTask.set(node.taskId, attempts)
  }
  return graph.nodes.map((node) => {
    const placed = positions.get(node.id)
    if (placed === undefined) throw new Error(`comparison canvas content omitted ${node.id}`)
    const role = node.task === undefined ? undefined : roles.get(node.task.roleId)
    const attempts = node.taskId === undefined ? [] : attemptsByTask.get(node.taskId) ?? []
    const ariaLabel = node.kind === 'execution'
      ? `${copy.execution} ${execution.status}`
      : node.kind === 'plan-task'
        ? `${copy.plannedTask} ${node.task?.title ?? node.taskId ?? ''}`
        : `${copy.actualAttempt} ${node.binding?.status ?? 'unknown'}`
    return {
      id: node.id,
      type: 'plan-comparison',
      position: placed.position,
      data: {
        node,
        execution,
        attempts,
        now,
        copy,
        ...(role === undefined ? {} : { role }),
      },
      draggable: node.kind !== 'execution',
      selectable: true,
      deletable: false,
      connectable: false,
      selected: selectedNodeId === node.id,
      focusable: true,
      ariaRole: 'button',
      ariaLabel,
      domAttributes: {
        'data-comparison-node-id': node.id,
        'aria-controls': 'agent-plan-comparison-details',
        'aria-expanded': selectedNodeId === node.id,
      } as NonNullable<ComparisonFlowNode['domAttributes']>,
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
    }
  })
}

function flowEdges(graph: PlanComparisonGraph): readonly ComparisonFlowEdge[] {
  return graph.edges.map(edge => ({
    ...edge,
    type: 'smoothstep',
    selectable: false,
    focusable: false,
    deletable: false,
    ariaRole: 'presentation',
    domAttributes: { 'aria-hidden': true },
    style: edge.mode === 'context'
      ? { stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeDasharray: '8 5' }
      : edge.mode === 'order-only'
        ? { stroke: 'var(--dsw-alias-label-tertiary)', strokeWidth: 1.3, strokeDasharray: '4 5' }
        : edge.mode === 'binding'
          ? { stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeDasharray: '2 5' }
          : edge.mode === 'retry'
            ? { stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.7 }
            : edge.mode === 'unresolved'
              ? { stroke: 'var(--dsw-alias-state-error-primary)', strokeWidth: 1.4, strokeDasharray: '5 5' }
              : { stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1.3 },
  }))
}

function motionDuration(): number {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 220
}

function AgentPlanComparisonCanvasInner({
  execution, plan, selectedNodeId, onSelect, now,
  copy = PLAN_COMPARISON_CANVAS_COPY_ZH,
}: AgentPlanComparisonCanvasProps): ReactNode {
  const graph = useMemo(() => buildPlanComparisonGraph(execution, plan), [execution, plan])
  const layout = useMemo(() => layoutPlanComparisonGraph(graph), [graph])
  const baselineNodes = useMemo(
    () => flowNodes(graph, layout, execution, plan, selectedNodeId, now, copy),
    [copy, execution, graph, layout, now, plan, selectedNodeId],
  )
  const baselineById = useMemo(
    () => new Map(baselineNodes.map(node => [node.id, node] as const)),
    [baselineNodes],
  )
  const edges = useMemo(() => flowEdges(graph), [graph])
  const [nodes, setNodes, applyNodeChanges] = useNodesState<ComparisonFlowNode>([...baselineNodes])
  const offsets = useRef(new Map<string, Offset>())
  const [layoutChanged, setLayoutChanged] = useState(false)
  const instance = useRef<ReactFlowInstance<ComparisonFlowNode, ComparisonFlowEdge> | null>(null)
  const updateNodeInternals = useUpdateNodeInternals()
  const topologyIdentity = useMemo(() => (
    `${graph.nodes.map(node => node.id).join('\u0000')}\u0001${graph.edges.map(edge => edge.id).join('\u0000')}`
  ), [graph])

  const recordOffset = (id: string, position: { readonly x: number; readonly y: number }): void => {
    const baseline = baselineById.get(id)
    if (baseline === undefined || baseline.data.node.kind === 'execution') return
    const offset = { x: position.x - baseline.position.x, y: position.y - baseline.position.y }
    if (Math.abs(offset.x) < 0.5 && Math.abs(offset.y) < 0.5) offsets.current.delete(id)
    else offsets.current.set(id, offset)
    setLayoutChanged(offsets.current.size > 0)
  }

  const onNodesChange: OnNodesChange<ComparisonFlowNode> = (changes): void => {
    applyNodeChanges(changes)
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) recordOffset(change.id, change.position)
    }
  }

  useEffect(() => {
    const valid = new Set(baselineNodes.map(node => node.id))
    for (const id of offsets.current.keys()) if (!valid.has(id)) offsets.current.delete(id)
    setNodes(baselineNodes.map((node) => {
      const offset = offsets.current.get(node.id)
      return offset === undefined ? node : {
        ...node,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      }
    }))
    setLayoutChanged(offsets.current.size > 0)
  }, [baselineNodes, setNodes])

  useEffect(() => {
    if (typeof window.DOMMatrixReadOnly !== 'function') return
    const ids = graph.nodes.map(node => node.id)
    const frame = requestAnimationFrame(() => { updateNodeInternals(ids) })
    return () => { cancelAnimationFrame(frame) }
  }, [graph.nodes, topologyIdentity, updateNodeInternals])

  const arrange = (): void => {
    offsets.current.clear()
    setLayoutChanged(false)
    setNodes([...baselineNodes])
    requestAnimationFrame(() => {
      void instance.current?.fitView({ padding: 0.18, maxZoom: 1, duration: motionDuration() })
    })
  }

  return (
    <div className={css.frame}>
      <ReactFlow<ComparisonFlowNode, ComparisonFlowEdge>
        aria-label={copy.ariaLabel}
        nodes={nodes}
        edges={[...edges]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onInit={(next) => { instance.current = next }}
        onNodeClick={(_event, node) => { onSelect(node.id) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-comparison-node-id]')
            : null
          const id = target?.dataset.comparisonNodeId
          if (id === undefined || !baselineById.has(id)) return
          event.preventDefault()
          onSelect(id)
        }}
        onNodeDrag={(_event, node) => { recordOffset(node.id, node.position) }}
        onNodeDragStop={(_event, node) => { recordOffset(node.id, node.position) }}
        nodesConnectable={false}
        edgesReconnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={1.55}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1, duration: 0 }}
        onlyRenderVisibleElements={graph.nodes.length > 100}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          'controls.ariaLabel': copy.controls,
          'controls.zoomIn.ariaLabel': copy.zoomIn,
          'controls.zoomOut.ariaLabel': copy.zoomOut,
          'controls.fitView.ariaLabel': copy.fitView,
          'minimap.ariaLabel': copy.minimap,
          'node.a11yDescription.default': copy.nodeInstructions,
          'node.a11yDescription.keyboardDisabled': copy.nodeInstructions,
          'node.a11yDescription.ariaLiveMessage': ({ x, y }) => `${copy.nodeMoved} x ${x}, y ${y}`,
          'edge.a11yDescription.default': '',
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} />
        <Controls
          className={css.controls ?? ''}
          position="top-right"
          orientation="horizontal"
          showInteractive={false}
          fitViewOptions={{ padding: 0.18, maxZoom: 1, duration: motionDuration() }}
        >
          <ControlButton onClick={arrange} title={copy.autoLayout} aria-label={copy.autoLayout}>
            <IconRefreshOutline14 />
          </ControlButton>
        </Controls>
        {graph.nodes.length <= 12 ? null : (
          <MiniMap<ComparisonFlowNode>
            className={css.minimap ?? ''}
            position="bottom-right"
            pannable
            zoomable
            ariaLabel={copy.minimap}
            nodeBorderRadius={8}
            nodeColor={node => node.data.node.kind === 'unresolved-attempt'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-bg-module-platform)'}
            maskColor="color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent)"
          />
        )}
        <div className={css.legend}>
          <span><i data-mode="plan" />{copy.planDependency}</span>
          <span><i data-mode="binding" />{copy.binding}</span>
          <span><i data-mode="retry" />{copy.retry}</span>
        </div>
        <div className={css.notice} data-layout-changed={layoutChanged || undefined}>{copy.dragHint}</div>
      </ReactFlow>
    </div>
  )
}

/** Render a draggable, authority-preserving plan-versus-execution canvas. */
export function AgentPlanComparisonCanvas(props: AgentPlanComparisonCanvasProps): ReactNode {
  return <ReactFlowProvider><AgentPlanComparisonCanvasInner {...props} /></ReactFlowProvider>
}
