import dagre from '@dagrejs/dagre'
import type {
  AgentPlanRevision, DependencyMode, PlanExecution, PlanRunBinding, PlanTask,
} from '../plan-types.js'

export type PlanComparisonNodeKind = 'execution' | 'plan-task' | 'attempt' | 'unresolved-attempt'

/** One factual node in the plan-versus-execution projection. */
export interface PlanComparisonNode {
  readonly id: string
  readonly kind: PlanComparisonNodeKind
  readonly taskId?: string
  readonly task?: PlanTask
  readonly binding?: PlanRunBinding
}

export type PlanComparisonEdgeMode =
  | 'plan-root'
  | DependencyMode
  | 'binding'
  | 'retry'
  | 'unresolved'

/** One connector derived from plan dependencies or an exact execution binding. */
export interface PlanComparisonEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly mode: PlanComparisonEdgeMode
}

/** Authority-preserving projection plus count of rejected inconsistent bindings. */
export interface PlanComparisonGraph {
  readonly nodes: readonly PlanComparisonNode[]
  readonly edges: readonly PlanComparisonEdge[]
  readonly droppedBindings: number
}

/** Deterministic Dagre placement for one comparison node. */
export interface PlanComparisonLayoutNode {
  readonly id: string
  readonly position: { readonly x: number; readonly y: number }
  readonly width: number
  readonly height: number
}

export function executionNodeId(executionId: string): string {
  return `execution:${executionId}`
}

export function comparisonTaskNodeId(taskId: string): string {
  return `plan-task:${taskId}`
}

export function comparisonAttemptNodeId(attemptId: string): string {
  return `attempt:${attemptId}`
}

/** Find only the exact immutable revision named by an execution snapshot. */
export function findExecutionPlanRevision(
  plans: readonly AgentPlanRevision[],
  execution: PlanExecution,
): AgentPlanRevision | undefined {
  return plans.find(plan => (
    plan.parentSessionId === execution.parentSessionId
    && plan.planId === execution.planId
    && plan.revision === execution.planRevision
    && plan.capabilityDigest === execution.capabilityDigest
  ))
}

function exactBindings(execution: PlanExecution): {
  readonly accepted: readonly PlanRunBinding[]
  readonly dropped: number
} {
  const accepted = execution.bindings.filter(binding => (
    binding.executionId === execution.executionId
    && binding.planId === execution.planId
    && binding.planRevision === execution.planRevision
  ))
  return { accepted, dropped: execution.bindings.length - accepted.length }
}

/**
 * Build the comparison graph without title, timing, child-id, or heuristic matching.
 * A binding is attached to a task only when its exact taskId exists in the exact
 * plan revision named by the execution. Otherwise it remains visibly unresolved.
 */
export function buildPlanComparisonGraph(
  execution: PlanExecution,
  plan: AgentPlanRevision | undefined,
): PlanComparisonGraph {
  const rootId = executionNodeId(execution.executionId)
  const nodes: PlanComparisonNode[] = [{ id: rootId, kind: 'execution' }]
  const edges: PlanComparisonEdge[] = []
  const tasks = new Map<string, PlanTask>()

  if (plan !== undefined) {
    for (const task of plan.tasks) {
      tasks.set(task.taskId, task)
      nodes.push({
        id: comparisonTaskNodeId(task.taskId),
        kind: 'plan-task',
        taskId: task.taskId,
        task,
      })
    }
    for (const task of plan.tasks) {
      const target = comparisonTaskNodeId(task.taskId)
      const validDependencies = new Map<string, DependencyMode>()
      for (const dependency of task.dependsOn) {
        if (!tasks.has(dependency.taskId) || dependency.taskId === task.taskId) continue
        const previous = validDependencies.get(dependency.taskId)
        validDependencies.set(
          dependency.taskId,
          previous === 'context' || dependency.mode === 'context' ? 'context' : 'order-only',
        )
      }
      if (validDependencies.size === 0) {
        edges.push({
          id: `edge:${rootId}->${target}:plan-root`,
          source: rootId,
          target,
          mode: 'plan-root',
        })
      } else {
        for (const [dependencyTaskId, mode] of validDependencies) {
          const source = comparisonTaskNodeId(dependencyTaskId)
          edges.push({ id: `edge:${source}->${target}:${mode}`, source, target, mode })
        }
      }
    }
  }

  const exact = exactBindings(execution)
  const acceptedAttemptIds = new Set(exact.accepted.map(binding => binding.attemptId))
  const orderedBindings = [...exact.accepted].sort((left, right) => (
    left.taskId.localeCompare(right.taskId)
    || left.attemptNumber - right.attemptNumber
    || left.attemptId.localeCompare(right.attemptId)
  ))
  for (const binding of orderedBindings) {
    const attemptId = comparisonAttemptNodeId(binding.attemptId)
    const task = tasks.get(binding.taskId)
    nodes.push({
      id: attemptId,
      kind: task === undefined ? 'unresolved-attempt' : 'attempt',
      taskId: binding.taskId,
      ...(task === undefined ? {} : { task }),
      binding,
    })
    if (task === undefined) {
      edges.push({
        id: `edge:${rootId}->${attemptId}:unresolved`,
        source: rootId,
        target: attemptId,
        mode: 'unresolved',
      })
      continue
    }
    const taskNodeId = comparisonTaskNodeId(task.taskId)
    edges.push({
      id: `edge:${taskNodeId}->${attemptId}:binding`,
      source: taskNodeId,
      target: attemptId,
      mode: 'binding',
    })
    if (binding.retryOf !== undefined && acceptedAttemptIds.has(binding.retryOf)) {
      edges.push({
        id: `edge:${comparisonAttemptNodeId(binding.retryOf)}->${attemptId}:retry`,
        source: comparisonAttemptNodeId(binding.retryOf),
        target: attemptId,
        mode: 'retry',
      })
    }
  }
  return { nodes, edges, droppedBindings: exact.dropped }
}

function nodeSize(node: PlanComparisonNode): { readonly width: number; readonly height: number } {
  if (node.kind === 'execution') return { width: 360, height: 130 }
  if (node.kind === 'plan-task') return { width: 300, height: 148 }
  return { width: 270, height: 132 }
}

/** Auto-arrange the exact comparison projection from top to bottom. */
export function layoutPlanComparisonGraph(
  graphValue: PlanComparisonGraph,
): readonly PlanComparisonLayoutNode[] {
  const graph = new dagre.graphlib.Graph()
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({ rankdir: 'TB', ranksep: 78, nodesep: 44, edgesep: 20, marginx: 46, marginy: 38 })
  for (const node of graphValue.nodes) graph.setNode(node.id, nodeSize(node))
  for (const edge of graphValue.edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  return graphValue.nodes.map((node) => {
    const size = nodeSize(node)
    const placed = graph.node(node.id) as { readonly x: number; readonly y: number } | undefined
    if (placed === undefined) throw new Error(`plan comparison layout omitted ${node.id}`)
    return {
      id: node.id,
      position: { x: placed.x - size.width / 2, y: placed.y - size.height / 2 },
      ...size,
    }
  })
}
