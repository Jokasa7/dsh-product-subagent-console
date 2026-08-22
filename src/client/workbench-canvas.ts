import dagre from '@dagrejs/dagre'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkbenchNode } from './workbench-model.js'

/** Stable topology entry projected from one authoritative delegation tree. */
export interface WorkbenchCanvasTopologyNode {
  readonly id: string
  readonly parentId?: string
  readonly workbenchKey?: string
  readonly kind: 'root' | WorkbenchNode['kind']
  readonly hasChildren: boolean
  readonly level: number
  readonly positionInSet: number
  readonly setSize: number
}

/** One presentation-only parent-to-child connector. */
export interface WorkbenchCanvasTopologyEdge {
  readonly id: string
  readonly source: string
  readonly target: string
}

/** Auto-layout result for one canvas node. */
export interface WorkbenchCanvasLayoutNode {
  readonly id: string
  readonly position: { readonly x: number; readonly y: number }
  readonly width: number
  readonly height: number
}

/** Presentation-only displacement retained for a node the user moved. */
export interface WorkbenchCanvasOffset {
  readonly x: number
  readonly y: number
}

/**
 * Produce one stable id for the conversation root node.
 * @param sessionId - conversation owning the workbench.
 * @returns id outside the native-session and product-run key spaces.
 */
export function workbenchCanvasRootId(sessionId: SessionId): string {
  return `conversation:${sessionId}`
}

/**
 * Project the canonical workbench tree into a flat, accessible canvas topology.
 * @param rootSessionId - conversation owning the workbench.
 * @param tree - authoritative native and product delegation children.
 * @returns root first, then descendants in pre-order with sibling metadata.
 */
export function buildWorkbenchCanvasTopology(
  rootSessionId: SessionId,
  tree: readonly WorkbenchNode[],
): readonly WorkbenchCanvasTopologyNode[] {
  const rootId = workbenchCanvasRootId(rootSessionId)
  const result: WorkbenchCanvasTopologyNode[] = [{
    id: rootId,
    kind: 'root',
    hasChildren: tree.length > 0,
    level: 1,
    positionInSet: 1,
    setSize: 1,
  }]
  const visit = (children: readonly WorkbenchNode[], parentId: string, level: number): void => {
    children.forEach((node, index) => {
      result.push({
        id: node.key,
        parentId,
        workbenchKey: node.key,
        kind: node.kind,
        hasChildren: node.children.length > 0,
        level,
        positionInSet: index + 1,
        setSize: children.length,
      })
      visit(node.children, node.key, level + 1)
    })
  }
  visit(tree, rootId, 2)
  return result
}

/**
 * Derive connectors exclusively from canonical parent ids.
 * @param topology - flat workbench topology.
 * @returns one immutable connector for every non-root node.
 */
export function buildWorkbenchCanvasEdges(
  topology: readonly WorkbenchCanvasTopologyNode[],
): readonly WorkbenchCanvasTopologyEdge[] {
  return topology.flatMap(node => node.parentId === undefined ? [] : [{
    id: `edge:${node.parentId}->${node.id}`,
    source: node.parentId,
    target: node.id,
  }])
}

function nodeSize(node: WorkbenchCanvasTopologyNode): { readonly width: number; readonly height: number } {
  return node.kind === 'root' ? { width: 320, height: 100 } : { width: 272, height: 104 }
}

/**
 * Auto-arrange the canonical tree from top to bottom without changing its topology.
 * @param topology - flat workbench topology.
 * @returns deterministic node positions suitable for React Flow.
 */
export function layoutWorkbenchCanvas(
  topology: readonly WorkbenchCanvasTopologyNode[],
): readonly WorkbenchCanvasLayoutNode[] {
  const graph = new dagre.graphlib.Graph()
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({ rankdir: 'TB', ranksep: 86, nodesep: 54, marginx: 42, marginy: 34 })
  for (const node of topology) graph.setNode(node.id, nodeSize(node))
  for (const edge of buildWorkbenchCanvasEdges(topology)) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return topology.map((node) => {
    const size = nodeSize(node)
    const placed = graph.node(node.id) as { readonly x: number; readonly y: number } | undefined
    if (placed === undefined) throw new Error(`workbench canvas layout omitted ${node.id}`)
    return {
      id: node.id,
      position: { x: placed.x - size.width / 2, y: placed.y - size.height / 2 },
      ...size,
    }
  })
}

/**
 * Apply user displacements to a fresh auto-layout without pinning stale absolute positions.
 * @param layout - current deterministic Dagre baseline.
 * @param offsets - local offsets recorded only for nodes the user moved.
 * @returns current baseline for untouched nodes and baseline plus offset for moved nodes.
 */
export function applyWorkbenchCanvasOffsets(
  layout: readonly WorkbenchCanvasLayoutNode[],
  offsets: ReadonlyMap<string, WorkbenchCanvasOffset>,
): readonly WorkbenchCanvasLayoutNode[] {
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
