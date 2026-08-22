import dagre from '@dagrejs/dagre'
import type { AgentPlanContent, DependencyMode } from '../plan-types.js'

/** Stable canvas node projected from one editable Agent plan. */
export interface PlanCanvasTopologyNode {
  readonly id: string
  readonly kind: 'root' | 'task'
  readonly taskId?: string
}

/** Visual connector derived from a task dependency or the plan root. */
export interface PlanCanvasTopologyEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly mode: 'plan-root' | DependencyMode
}

/** Deterministic Dagre placement for one plan canvas node. */
export interface PlanCanvasLayoutNode {
  readonly id: string
  readonly position: { readonly x: number; readonly y: number }
  readonly width: number
  readonly height: number
}

/** Browser-only displacement retained after a card is dragged. */
export interface PlanCanvasOffset {
  readonly x: number
  readonly y: number
}

/** Return the canvas id for the plan summary card. */
export function planCanvasRootId(planKey: string): string {
  return `plan:${planKey}`
}

/** Return the canvas id for a task card. */
export function planCanvasTaskId(taskId: string): string {
  return `task:${taskId}`
}

/** Project the editable plan into stable root and task nodes. */
export function buildPlanCanvasTopology(
  planKey: string,
  content: AgentPlanContent,
): readonly PlanCanvasTopologyNode[] {
  return [
    { id: planCanvasRootId(planKey), kind: 'root' },
    ...content.tasks.map(task => ({
      id: planCanvasTaskId(task.taskId),
      kind: 'task' as const,
      taskId: task.taskId,
    })),
  ]
}

/**
 * Derive presentation connectors from explicit dependencies.
 * Tasks without a valid dependency are attached to the summary root so every
 * independent parallel branch remains visible. Invalid references are left to
 * deterministic preflight diagnostics instead of inventing phantom nodes.
 */
export function buildPlanCanvasEdges(
  planKey: string,
  content: AgentPlanContent,
): readonly PlanCanvasTopologyEdge[] {
  const rootId = planCanvasRootId(planKey)
  const taskIds = new Set(content.tasks.map(task => task.taskId))
  const edges: PlanCanvasTopologyEdge[] = []
  for (const task of content.tasks) {
    const target = planCanvasTaskId(task.taskId)
    const dependencies = new Map<string, DependencyMode>()
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency.taskId) || dependency.taskId === task.taskId) continue
      const previous = dependencies.get(dependency.taskId)
      dependencies.set(
        dependency.taskId,
        previous === 'context' || dependency.mode === 'context' ? 'context' : 'order-only',
      )
    }
    if (dependencies.size === 0) {
      edges.push({
        id: `edge:${rootId}->${target}`,
        source: rootId,
        target,
        mode: 'plan-root',
      })
      continue
    }
    for (const [dependencyTaskId, mode] of dependencies) {
      const source = planCanvasTaskId(dependencyTaskId)
      edges.push({
        id: `edge:${source}->${target}:${mode}`,
        source,
        target,
        mode,
      })
    }
  }
  return edges
}

function nodeSize(node: PlanCanvasTopologyNode): { readonly width: number; readonly height: number } {
  return node.kind === 'root'
    ? { width: 360, height: 132 }
    : { width: 300, height: 150 }
}

/** Auto-arrange a task DAG from top to bottom without changing plan data. */
export function layoutPlanCanvas(
  topology: readonly PlanCanvasTopologyNode[],
  edges: readonly PlanCanvasTopologyEdge[],
): readonly PlanCanvasLayoutNode[] {
  const graph = new dagre.graphlib.Graph()
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({ rankdir: 'TB', ranksep: 76, nodesep: 46, edgesep: 22, marginx: 48, marginy: 38 })
  for (const node of topology) graph.setNode(node.id, nodeSize(node))
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return topology.map((node) => {
    const size = nodeSize(node)
    const placed = graph.node(node.id) as { readonly x: number; readonly y: number } | undefined
    if (placed === undefined) throw new Error(`plan canvas layout omitted ${node.id}`)
    return {
      id: node.id,
      position: { x: placed.x - size.width / 2, y: placed.y - size.height / 2 },
      ...size,
    }
  })
}

/** Apply presentation offsets to a fresh layout baseline. */
export function applyPlanCanvasOffsets(
  layout: readonly PlanCanvasLayoutNode[],
  offsets: ReadonlyMap<string, PlanCanvasOffset>,
): readonly PlanCanvasLayoutNode[] {
  return layout.map((node) => {
    const offset = offsets.get(node.id)
    if (offset === undefined) return node
    return {
      ...node,
      position: {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
    }
  })
}
