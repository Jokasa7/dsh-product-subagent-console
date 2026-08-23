import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, BackgroundVariant, ControlButton, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider, useNodesState, useUpdateNodeInternals,
  type Edge, type Node, type NodeProps, type OnNodesChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconRefreshOutline14,
  StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkbenchCanvasLayoutNode, WorkbenchCanvasOffset, WorkbenchCanvasTopologyNode,
} from './workbench-canvas.js'
import {
  applyWorkbenchCanvasOffsets, buildWorkbenchCanvasEdges, layoutWorkbenchCanvas,
} from './workbench-canvas.js'
import '@xyflow/react/dist/style.css'
import css from './SubagentTaskCanvas.module.css'

/** Display-safe content for one root or delegated-task canvas node. */
export interface SubagentCanvasContent {
  readonly kind: 'root' | 'native' | 'product' | 'product-attempt'
  readonly title: string
  readonly label: string
  readonly meta: string
  readonly status?: string
  readonly duration?: string
  readonly state?: string
  readonly dotState?: StateDotState
  readonly ariaLabel: string
}

/** Localized controls and guidance owned by the subagent canvas. */
export interface SubagentCanvasCopy {
  readonly ariaLabel: string
  readonly controls: string
  readonly minimap: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fitView: string
  readonly autoLayout: string
  readonly nodeInstructions: string
  readonly nodeMoved: string
  readonly interactionHint: string
  readonly localLayoutNotice: string
}

/** Props for the presentation-only delegation canvas. */
export interface SubagentTaskCanvasProps {
  readonly topology: readonly WorkbenchCanvasTopologyNode[]
  readonly content: Readonly<Record<string, SubagentCanvasContent>>
  readonly selectedKey: string | null
  readonly expandedKey: string | null
  readonly copy: SubagentCanvasCopy
  readonly detailsId?: string
  readonly onSelect: (workbenchKey: string) => void
}

type CanvasNodeData = Record<string, unknown> & {
  readonly topology: WorkbenchCanvasTopologyNode
  readonly content: SubagentCanvasContent
}

type CanvasNode = Node<CanvasNodeData, 'subagent'>
type CanvasEdge = Edge<Record<string, never>, 'smoothstep'>

function CanvasNodeCard({ data, selected }: NodeProps<CanvasNode>): ReactNode {
  const { content, topology } = data
  const isRoot = content.kind === 'root'
  return (
    <div
      className={css.card}
      data-kind={content.kind}
      data-selected={selected || undefined}
      data-state={content.state}
      data-workbench-node={topology.workbenchKey ?? topology.id}
    >
      {topology.parentId === undefined ? null : (
        <Handle type="target" position={Position.Top} isConnectable={false} className={css.handle} />
      )}
      <div className={css.cardTopline}>
        <span className={css.icon}>
          {content.kind === 'product' || content.kind === 'product-attempt'
            ? <IconAgentPresetOutline16 />
            : <IconBranchOutline16 />}
          {content.dotState === undefined ? null : (
            <span className={css.dot}><StateDot state={content.dotState} /></span>
          )}
        </span>
        <span className={css.identity}>
          <strong>{content.title}</strong>
          {isRoot ? null : <span>{content.meta}</span>}
        </span>
        {content.status === undefined ? null : (
          <span className={css.status}>
            {content.status}{content.duration === undefined ? null : ` · ${content.duration}`}
          </span>
        )}
      </div>
      <p className={isRoot ? css.rootLabel : css.taskLabel}>{content.label}</p>
      {isRoot ? <span className={css.rootHint}>{content.meta}</span> : null}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={topology.hasChildren ? css.handle : `${css.handle} ${css.dormantHandle}`}
      />
    </div>
  )
}

const NODE_TYPES = { subagent: CanvasNodeCard }

function flowNodes(
  topology: readonly WorkbenchCanvasTopologyNode[],
  layout: readonly WorkbenchCanvasLayoutNode[],
  content: Readonly<Record<string, SubagentCanvasContent>>,
  selectedKey: string | null,
  expandedKey: string | null,
  detailsId: string,
): readonly CanvasNode[] {
  const positions = new Map(layout.map(node => [node.id, node] as const))
  return topology.map((node) => {
    const placed = positions.get(node.id)
    const display = content[node.id]
    if (placed === undefined || display === undefined) {
      throw new Error(`workbench canvas content omitted ${node.id}`)
    }
    const selected = node.workbenchKey === selectedKey
    const expanded = node.workbenchKey === expandedKey
    return {
      id: node.id,
      type: 'subagent',
      position: placed.position,
      data: { topology: node, content: display },
      draggable: node.kind !== 'root',
      selectable: node.kind !== 'root',
      deletable: false,
      connectable: false,
      selected,
      focusable: node.kind !== 'root',
      ariaRole: node.kind === 'root' ? 'group' : 'button',
      ariaLabel: display.ariaLabel,
      domAttributes: {
        ...(node.kind === 'root' ? {} : {
          'aria-controls': detailsId,
          'aria-expanded': expanded,
        }),
        'data-canvas-node-id': node.id,
      } as NonNullable<CanvasNode['domAttributes']>,
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
    }
  })
}

function flowEdges(topology: readonly WorkbenchCanvasTopologyNode[]): readonly CanvasEdge[] {
  return buildWorkbenchCanvasEdges(topology).map(edge => ({
    ...edge,
    type: 'smoothstep',
    selectable: false,
    focusable: false,
    deletable: false,
    ariaRole: 'presentation',
    domAttributes: { 'aria-hidden': true },
    style: { stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1.35 },
  }))
}

function motionDuration(): number {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 240
}

function topologyKey(topology: readonly WorkbenchCanvasTopologyNode[]): string {
  return topology.map(node => [
    node.id,
    node.parentId ?? '',
    node.kind,
    node.hasChildren ? '1' : '0',
    String(node.level),
    String(node.positionInSet),
    String(node.setSize),
  ].join('\u0001')).join('\u0000')
}

function sameContent(left: SubagentCanvasContent, right: SubagentCanvasContent): boolean {
  return left.kind === right.kind
    && left.title === right.title
    && left.label === right.label
    && left.meta === right.meta
    && left.status === right.status
    && left.duration === right.duration
    && left.state === right.state
    && left.dotState === right.dotState
    && left.ariaLabel === right.ariaLabel
}

function sameTopology(
  left: WorkbenchCanvasTopologyNode,
  right: WorkbenchCanvasTopologyNode,
): boolean {
  return left.id === right.id
    && left.parentId === right.parentId
    && left.workbenchKey === right.workbenchKey
    && left.kind === right.kind
    && left.hasChildren === right.hasChildren
    && left.level === right.level
    && left.positionInSet === right.positionInSet
    && left.setSize === right.setSize
}

function samePosition(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): boolean {
  return left.x === right.x && left.y === right.y
}

/** Keep unchanged React Flow node objects stable so one duration tick does not redraw the graph. */
function mergeCanvasNodes(
  previous: readonly CanvasNode[],
  baseline: readonly CanvasNode[],
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): CanvasNode[] {
  const previousById = new Map(previous.map(node => [node.id, node] as const))
  return baseline.map((candidate) => {
    const nextPosition = positions.get(candidate.id) ?? candidate.position
    const next = samePosition(candidate.position, nextPosition)
      ? candidate
      : { ...candidate, position: nextPosition }
    const current = previousById.get(candidate.id)
    if (
      current !== undefined
      && current.type === next.type
      && current.draggable === next.draggable
      && current.selectable === next.selectable
      && current.selected === next.selected
      && current.width === next.width
      && current.height === next.height
      && samePosition(current.position, next.position)
      && sameTopology(current.data.topology, next.data.topology)
      && sameContent(current.data.content, next.data.content)
      && current.ariaLabel === next.ariaLabel
      && current.domAttributes?.['aria-expanded'] === next.domAttributes?.['aria-expanded']
    ) return current
    return next
  })
}

/**
 * Render a draggable task tree whose positions never mutate delegation facts.
 * @param props - canonical topology, display-safe labels, selection, and local controls.
 * @returns interactive canvas with derived connectors and a minimap.
 */
function SubagentTaskCanvasInner({
  topology, content, selectedKey, expandedKey, copy, onSelect,
  detailsId = 'product-subagent-details',
}: SubagentTaskCanvasProps): ReactNode {
  const topologyIdentity = topologyKey(topology)
  const autoLayout = useMemo(
    () => layoutWorkbenchCanvas(topology),
    // topologyIdentity contains every layout-relevant topology field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topologyIdentity],
  )
  const baselineNodes = useMemo(
    () => flowNodes(topology, autoLayout, content, selectedKey, expandedKey, detailsId),
    [autoLayout, content, detailsId, expandedKey, selectedKey, topology],
  )
  const baselineById = useMemo(
    () => new Map(baselineNodes.map(node => [node.id, node] as const)),
    [baselineNodes],
  )
  const baselineEdges = useMemo(() => flowEdges(topology), [topology])
  const [nodes, setNodes, applyNodeChanges] = useNodesState<CanvasNode>([...baselineNodes])
  const [layoutChanged, setLayoutChanged] = useState(false)
  const [flowReady, setFlowReady] = useState(false)
  const instance = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const offsets = useRef(new Map<string, WorkbenchCanvasOffset>())
  const previousTopology = useRef('')
  const measuredTopology = useRef(new Map<string, string>())
  const viewportTouched = useRef(false)
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

  const onNodesChange: OnNodesChange<CanvasNode> = (changes): void => {
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
    const placed = applyWorkbenchCanvasOffsets(autoLayout, offsets.current)
    const positions = new Map(placed.map(node => [node.id, node.position] as const))
    setNodes(previous => mergeCanvasNodes(previous, baselineNodes, positions))
    setLayoutChanged(offsets.current.size > 0)
  }, [autoLayout, baselineNodes, setNodes])

  useEffect(() => {
    if (topologyIdentity.length === 0 || typeof window.DOMMatrixReadOnly !== 'function') return
    const nextMeasured = new Map(topology.map(node => [
      node.id,
      `${node.kind}:${node.hasChildren ? '1' : '0'}`,
    ] as const))
    const ids = topology
      .filter(node => measuredTopology.current.get(node.id) !== nextMeasured.get(node.id))
      .map(node => node.id)
    measuredTopology.current = nextMeasured
    if (ids.length === 0) return
    let frame = requestAnimationFrame(() => {
      updateNodeInternals(ids)
      // React Flow measures newly mounted handles asynchronously. A second
      // frame makes dynamic root-to-first-child edges deterministic without
      // changing the canonical topology or the user's local node offsets.
      frame = requestAnimationFrame(() => { updateNodeInternals(ids) })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [topology, topologyIdentity, updateNodeInternals])

  useEffect(() => {
    if (!flowReady || topology.length === 0) return
    const changed = previousTopology.current !== topologyIdentity
    previousTopology.current = topologyIdentity
    if (!changed || viewportTouched.current || offsets.current.size > 0) return
    let cancelled = false
    let frame: number | undefined
    let attempts = 0
    const expected = new Set(topology.map(node => node.id))
    const fitWhenReady = (): void => {
      frame = requestAnimationFrame(() => {
        if (cancelled || viewportTouched.current || offsets.current.size > 0) return
        const rendered = instance.current?.getNodes() ?? []
        const ready = rendered.length === expected.size && rendered.every(node => (
          expected.has(node.id)
          && (node.measured?.width ?? node.width ?? 0) > 0
          && (node.measured?.height ?? node.height ?? 0) > 0
        ))
        if (!ready && attempts < 60) {
          attempts += 1
          fitWhenReady()
          return
        }
        if (ready) void instance.current?.fitView({ padding: 0.18, maxZoom: 1, duration: 0 })
      })
    }
    fitWhenReady()
    return () => {
      cancelled = true
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [flowReady, topology, topologyIdentity])

  const arrange = (): void => {
    offsets.current.clear()
    viewportTouched.current = false
    setLayoutChanged(false)
    setNodes([...baselineNodes])
    requestAnimationFrame(() => {
      void instance.current?.fitView({ padding: 0.18, maxZoom: 1, duration: motionDuration() })
    })
  }

  return (
    <div className={css.frame}>
      <ReactFlow<CanvasNode, CanvasEdge>
        aria-label={copy.ariaLabel}
        nodes={nodes}
        edges={[...baselineEdges]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onInit={(next) => {
          instance.current = next
          setFlowReady(true)
        }}
        onMoveStart={(event) => {
          if (event !== null) viewportTouched.current = true
        }}
        onNodeClick={(_event, node) => {
          const key = node.data.topology.workbenchKey
          if (key !== undefined) onSelect(key)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-canvas-node-id]')
            : null
          const id = target?.dataset.canvasNodeId
          const key = id === undefined ? undefined : baselineById.get(id)?.data.topology.workbenchKey
          if (key === undefined) return
          event.preventDefault()
          onSelect(key)
        }}
        onNodeDrag={(_event, node) => { recordOffset(node.id, node.position) }}
        onNodeDragStop={(_event, node) => { recordOffset(node.id, node.position) }}
        nodesConnectable={false}
        onlyRenderVisibleElements
        edgesReconnectable={false}
        nodesDraggable
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        minZoom={0.35}
        maxZoom={1.6}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1, duration: 0 }}
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
          <ControlButton
            className={css.arrange}
            onClick={arrange}
            title={copy.autoLayout}
            aria-label={copy.autoLayout}
          >
            <IconRefreshOutline14 />
          </ControlButton>
        </Controls>
        {topology.length > 200 ? null : (
          <MiniMap<CanvasNode>
            className={css.minimap ?? ''}
            position="bottom-right"
            pannable
            zoomable
            ariaLabel={copy.minimap}
            nodeBorderRadius={8}
            nodeColor={node => node.data.content.state === 'active'
              ? 'var(--dsw-alias-state-business-primary)'
              : 'var(--dsw-alias-bg-module-platform)'}
            maskColor="color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent)"
          />
        )}
        <div className={css.canvasNotice} data-layout-changed={layoutChanged || undefined}>
          <span>{copy.interactionHint}</span>
          <span>{copy.localLayoutNotice}</span>
        </div>
      </ReactFlow>
    </div>
  )
}

/**
 * Render a draggable task tree whose positions never mutate delegation facts.
 * @param props - canonical topology, display-safe labels, selection, and local controls.
 * @returns interactive canvas with derived connectors and a minimap.
 */
export function SubagentTaskCanvas(props: SubagentTaskCanvasProps): ReactNode {
  return <ReactFlowProvider><SubagentTaskCanvasInner {...props} /></ReactFlowProvider>
}
