import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, BackgroundVariant, ControlButton, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider, useNodesState, useUpdateNodeInternals,
  type Edge, type Node, type NodeProps, type OnNodesChange, type ReactFlowInstance,
} from '@xyflow/react'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AgentPlanContent, PlanDiagnostic, PlanRole, PlanTask,
} from '../plan-types.js'
import {
  applyPlanCanvasOffsets, buildPlanCanvasEdges, buildPlanCanvasTopology, layoutPlanCanvas,
  planCanvasRootId, planCanvasTaskId,
  type PlanCanvasLayoutNode, type PlanCanvasOffset, type PlanCanvasTopologyNode,
} from './plan-canvas.js'
import '@xyflow/react/dist/style.css'
import css from './AgentPlanCanvas.module.css'

/** Localizable text owned by the editable plan canvas. */
export interface AgentPlanCanvasCopy {
  readonly ariaLabel: string
  readonly controls: string
  readonly minimap: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fitView: string
  readonly autoLayout: string
  readonly nodeInstructions: string
  readonly nodeMoved: string
  readonly plan: string
  readonly role: string
  readonly roles: string
  readonly task: string
  readonly tasks: string
  readonly inheritTools: string
  readonly tools: string
  readonly noProvider: string
  readonly orderDependency: string
  readonly contextDependency: string
  readonly dragHint: string
  readonly localLayoutNotice: string
}

export const AGENT_PLAN_CANVAS_COPY_ZH: AgentPlanCanvasCopy = {
  ariaLabel: 'Agent 方案任务画布',
  controls: '方案画布控制',
  minimap: '方案缩略图',
  zoomIn: '放大',
  zoomOut: '缩小',
  fitView: '适应视图',
  autoLayout: '恢复自动布局',
  nodeInstructions: '按 Enter 或空格选择，方向键移动焦点。',
  nodeMoved: '节点已移动到',
  plan: '方案',
  role: '角色',
  roles: '角色',
  task: '任务',
  tasks: '任务',
  inheritTools: '继承工具',
  tools: '个工具',
  noProvider: '未配置 Provider',
  orderDependency: '顺序依赖',
  contextDependency: '上下文依赖',
  dragHint: '拖动卡片调整本地视图，点击后在右侧编辑。',
  localLayoutNotice: '卡片位置不会写入方案。',
}

export const AGENT_PLAN_CANVAS_COPY_EN: AgentPlanCanvasCopy = {
  ariaLabel: 'Agent plan task canvas',
  controls: 'Plan canvas controls',
  minimap: 'Plan minimap',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitView: 'Fit view',
  autoLayout: 'Restore automatic layout',
  nodeInstructions: 'Press Enter or Space to select; use arrow keys to move focus.',
  nodeMoved: 'Node moved to',
  plan: 'Plan',
  role: 'Role',
  roles: 'roles',
  task: 'Task',
  tasks: 'tasks',
  inheritTools: 'Inherited tools',
  tools: 'tools',
  noProvider: 'Provider not configured',
  orderDependency: 'Order dependency',
  contextDependency: 'Context dependency',
  dragHint: 'Drag cards to arrange this browser view; click a card to edit it.',
  localLayoutNotice: 'Card positions are not saved to the plan.',
}

/** Props for the editable plan presentation canvas. */
export interface AgentPlanCanvasProps {
  readonly planKey: string
  readonly content: AgentPlanContent
  readonly diagnostics: readonly PlanDiagnostic[]
  readonly selected: 'root' | string | null
  readonly onSelect: (selection: 'root' | string) => void
  readonly editorId?: string
  readonly copy?: AgentPlanCanvasCopy
}

type DiagnosticSeverity = PlanDiagnostic['severity']

type PlanNodeData = Record<string, unknown> & {
  readonly topology: PlanCanvasTopologyNode
  readonly plan: AgentPlanContent
  readonly task?: PlanTask
  readonly role?: PlanRole
  readonly diagnostic?: DiagnosticSeverity
  readonly copy: AgentPlanCanvasCopy
}

type PlanNode = Node<PlanNodeData, 'agent-plan'>
type PlanEdge = Edge<Record<string, never>, 'smoothstep'>

function severityRank(value: DiagnosticSeverity | undefined): number {
  if (value === 'error') return 3
  if (value === 'warning') return 2
  if (value === 'info') return 1
  return 0
}

function nodeDiagnostics(
  diagnostics: readonly PlanDiagnostic[],
  taskIds: ReadonlySet<string>,
): ReadonlyMap<string, DiagnosticSeverity> {
  const result = new Map<string, DiagnosticSeverity>()
  for (const diagnostic of diagnostics) {
    const targets = diagnostic.nodeIds.filter(id => taskIds.has(id))
    const nodeIds = targets.length === 0 ? ['root'] : targets
    for (const id of nodeIds) {
      const previous = result.get(id)
      if (severityRank(diagnostic.severity) > severityRank(previous)) {
        result.set(id, diagnostic.severity)
      }
    }
  }
  return result
}

function taskMeta(role: PlanRole | undefined, copy: AgentPlanCanvasCopy): string {
  if (role === undefined) return copy.noProvider
  return [role.name, role.transportProvider, role.model].filter(Boolean).join(' · ')
}

function toolSummary(role: PlanRole | undefined, copy: AgentPlanCanvasCopy): string {
  if (role?.toolPolicy.mode !== 'allowlist') return copy.inheritTools
  return `${String(role.toolPolicy.tools.length)} ${copy.tools}`
}

function PlanNodeCard({ data, selected }: NodeProps<PlanNode>): ReactNode {
  const { topology, plan, task, role, diagnostic, copy } = data
  const isRoot = topology.kind === 'root'
  return (
    <div
      className={css.card}
      data-kind={topology.kind}
      data-selected={selected || undefined}
      data-diagnostic={diagnostic}
    >
      {isRoot ? null : (
        <Handle type="target" position={Position.Top} isConnectable={false} className={css.handle} />
      )}
      <div className={css.topline}>
        <span className={css.icon}>
          {isRoot ? <IconBranchOutline16 /> : <IconAgentPresetOutline16 />}
        </span>
        <span className={css.identity}>
          <strong>{isRoot ? copy.plan : role?.name ?? copy.role}</strong>
          <span>{isRoot ? plan.pattern : taskMeta(role, copy)}</span>
        </span>
        {diagnostic === undefined ? null : (
          <span className={css.diagnostic} data-severity={diagnostic}>{diagnostic}</span>
        )}
      </div>
      <p className={isRoot ? css.rootTitle : css.taskTitle}>
        {isRoot ? plan.title : task?.title ?? copy.task}
      </p>
      {isRoot ? (
        <div className={css.rootMeta}>
          <span>{String(plan.roles.length)} {copy.roles}</span>
          <span>{String(plan.tasks.length)} {copy.tasks}</span>
          <span>{plan.optimizationTarget}</span>
        </div>
      ) : (
        <div className={css.taskMeta}>
          <span>{toolSummary(role, copy)}</span>
          <span>{task?.budgetHint?.maxTokens === undefined
            ? task?.risk
            : `${String(task.budgetHint.maxTokens)} tokens`}</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={css.handle} />
    </div>
  )
}

const NODE_TYPES = { 'agent-plan': PlanNodeCard }

function createFlowNodes(
  topology: readonly PlanCanvasTopologyNode[],
  layout: readonly PlanCanvasLayoutNode[],
  content: AgentPlanContent,
  diagnostics: readonly PlanDiagnostic[],
  selected: AgentPlanCanvasProps['selected'],
  copy: AgentPlanCanvasCopy,
  editorId: string,
): readonly PlanNode[] {
  const positions = new Map(layout.map(node => [node.id, node] as const))
  const tasks = new Map(content.tasks.map(task => [task.taskId, task] as const))
  const roles = new Map(content.roles.map(role => [role.roleId, role] as const))
  const taskIds = new Set(tasks.keys())
  const diagnosticByNode = nodeDiagnostics(diagnostics, taskIds)
  return topology.map((node) => {
    const placed = positions.get(node.id)
    if (placed === undefined) throw new Error(`plan canvas content omitted ${node.id}`)
    const task = node.taskId === undefined ? undefined : tasks.get(node.taskId)
    const role = task === undefined ? undefined : roles.get(task.roleId)
    const selection = node.kind === 'root' ? 'root' : node.taskId
    const diagnostic = diagnosticByNode.get(selection ?? 'root')
    const label = node.kind === 'root'
      ? `${copy.plan}: ${content.title}`
      : `${copy.task}: ${task?.title ?? node.taskId ?? ''}`
    return {
      id: node.id,
      type: 'agent-plan',
      position: placed.position,
      data: {
        topology: node,
        plan: content,
        copy,
        ...(task === undefined ? {} : { task }),
        ...(role === undefined ? {} : { role }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
      draggable: node.kind === 'task',
      selectable: true,
      deletable: false,
      connectable: false,
      selected: selected === selection,
      focusable: true,
      ariaRole: 'button',
      ariaLabel: label,
      domAttributes: {
        'data-plan-node-id': node.id,
        'aria-controls': editorId,
        'aria-pressed': selected === selection,
      } as NonNullable<PlanNode['domAttributes']>,
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
    }
  })
}

function createFlowEdges(planKey: string, content: AgentPlanContent): readonly PlanEdge[] {
  return buildPlanCanvasEdges(planKey, content).map(edge => ({
    ...edge,
    type: 'smoothstep',
    selectable: false,
    focusable: false,
    deletable: false,
    ariaRole: 'presentation',
    domAttributes: { 'aria-hidden': true },
    style: edge.mode === 'context'
      ? {
          stroke: 'var(--dsw-alias-state-business-primary)',
          strokeWidth: 1.6,
          strokeDasharray: '8 5',
        }
      : edge.mode === 'order-only'
        ? {
            stroke: 'var(--dsw-alias-label-tertiary)',
            strokeWidth: 1.35,
            strokeDasharray: '4 5',
          }
        : { stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1.35 },
  }))
}

function motionDuration(): number {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 220
}

function AgentPlanCanvasInner({
  planKey, content, diagnostics, selected, onSelect,
  editorId = 'agent-plan-editor',
  copy = AGENT_PLAN_CANVAS_COPY_ZH,
}: AgentPlanCanvasProps): ReactNode {
  const topology = useMemo(() => buildPlanCanvasTopology(planKey, content), [content, planKey])
  const edges = useMemo(() => buildPlanCanvasEdges(planKey, content), [content, planKey])
  const topologyIdentity = useMemo(
    () => `${topology.map(node => node.id).join('\u0000')}\u0001${edges.map(edge => edge.id).join('\u0000')}`,
    [edges, topology],
  )
  const layoutCache = useRef<{ readonly key: string; readonly value: readonly PlanCanvasLayoutNode[] }>()
  const autoLayout = useMemo(() => {
    if (layoutCache.current?.key === topologyIdentity) return layoutCache.current.value
    const value = layoutPlanCanvas(topology, edges)
    layoutCache.current = { key: topologyIdentity, value }
    return value
  }, [edges, topology, topologyIdentity])
  const baselineNodes = useMemo(
    () => createFlowNodes(topology, autoLayout, content, diagnostics, selected, copy, editorId),
    [autoLayout, content, copy, diagnostics, editorId, selected, topology],
  )
  const baselineById = useMemo(
    () => new Map(baselineNodes.map(node => [node.id, node] as const)),
    [baselineNodes],
  )
  const flowEdges = useMemo(() => createFlowEdges(planKey, content), [content, planKey])
  const [nodes, setNodes, applyNodeChanges] = useNodesState<PlanNode>([...baselineNodes])
  const [layoutChanged, setLayoutChanged] = useState(false)
  const instance = useRef<ReactFlowInstance<PlanNode, PlanEdge> | null>(null)
  const offsets = useRef(new Map<string, PlanCanvasOffset>())
  const updateNodeInternals = useUpdateNodeInternals()

  const recordOffset = (id: string, position: { readonly x: number; readonly y: number }): void => {
    const baseline = baselineById.get(id)
    if (baseline === undefined || baseline.data.topology.kind === 'root') return
    const offset = {
      x: position.x - baseline.position.x,
      y: position.y - baseline.position.y,
    }
    if (Math.abs(offset.x) < 0.5 && Math.abs(offset.y) < 0.5) offsets.current.delete(id)
    else offsets.current.set(id, offset)
    setLayoutChanged(offsets.current.size > 0)
  }

  const onNodesChange: OnNodesChange<PlanNode> = (changes): void => {
    applyNodeChanges(changes)
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) {
        recordOffset(change.id, change.position)
      }
    }
  }

  useEffect(() => {
    const currentIds = new Set(baselineNodes.map(node => node.id))
    for (const id of offsets.current.keys()) {
      if (!currentIds.has(id)) offsets.current.delete(id)
    }
    const placed = applyPlanCanvasOffsets(autoLayout, offsets.current)
    const positions = new Map(placed.map(node => [node.id, node.position] as const))
    setNodes(baselineNodes.map(node => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })))
    setLayoutChanged(offsets.current.size > 0)
  }, [autoLayout, baselineNodes, setNodes])

  useEffect(() => {
    if (topologyIdentity.length === 0 || typeof window.DOMMatrixReadOnly !== 'function') return
    const ids = topology.map(node => node.id)
    const frame = requestAnimationFrame(() => { updateNodeInternals(ids) })
    return () => { cancelAnimationFrame(frame) }
  }, [topology, topologyIdentity, updateNodeInternals])

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
      <ReactFlow<PlanNode, PlanEdge>
        aria-label={copy.ariaLabel}
        nodes={nodes}
        edges={[...flowEdges]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onInit={(next) => { instance.current = next }}
        onNodeClick={(_event, node) => {
          onSelect(node.data.topology.kind === 'root' ? 'root' : node.data.topology.taskId ?? 'root')
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-plan-node-id]')
            : null
          const id = target?.dataset.planNodeId
          const topologyNode = id === undefined ? undefined : baselineById.get(id)?.data.topology
          if (topologyNode === undefined) return
          event.preventDefault()
          onSelect(topologyNode.kind === 'root' ? 'root' : topologyNode.taskId ?? 'root')
        }}
        onNodeDrag={(_event, node) => { recordOffset(node.id, node.position) }}
        onNodeDragStop={(_event, node) => { recordOffset(node.id, node.position) }}
        nodesConnectable={false}
        edgesReconnectable={false}
        nodesDraggable
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        minZoom={0.32}
        maxZoom={1.55}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1, duration: 0 }}
        onlyRenderVisibleElements={topology.length > 100}
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
          aria-label={copy.controls}
          fitViewOptions={{ padding: 0.18, maxZoom: 1, duration: motionDuration() }}
        >
          <ControlButton onClick={arrange} title={copy.autoLayout} aria-label={copy.autoLayout}>
            <IconRefreshOutline14 />
          </ControlButton>
        </Controls>
        {topology.length <= 12 ? null : (
          <MiniMap<PlanNode>
            className={css.minimap ?? ''}
            position="bottom-right"
            pannable
            zoomable
            ariaLabel={copy.minimap}
            nodeBorderRadius={8}
            nodeColor={node => node.data.diagnostic === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-bg-module-platform)'}
            maskColor="color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent)"
          />
        )}
        <div className={css.legend}>
          <span><i data-mode="order" />{copy.orderDependency}</span>
          <span><i data-mode="context" />{copy.contextDependency}</span>
        </div>
        <div className={css.notice} data-layout-changed={layoutChanged || undefined}>
          <span>{copy.dragHint}</span>
          <span>{copy.localLayoutNotice}</span>
        </div>
      </ReactFlow>
    </div>
  )
}

/** Render an editable-plan DAG with browser-local card placement. */
export function AgentPlanCanvas(props: AgentPlanCanvasProps): ReactNode {
  return <ReactFlowProvider><AgentPlanCanvasInner {...props} /></ReactFlowProvider>
}

export { planCanvasRootId, planCanvasTaskId }
