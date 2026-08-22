import type {
  SessionId, SessionListState, SessionSummary, SubagentAddress, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConsoleSnapshot, ObservedRunView, OwnedAttemptView } from '../types.js'

type CatalogEntry = Extract<SubagentCatalogSnapshot['entries'][number], { kind: 'child' }>

/** Normalized states rendered by native, observed, and plugin-owned nodes. */
export type WorkbenchState =
  | 'active'
  | 'queued'
  | 'starting'
  | 'not-published'
  | 'inactive'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal'
  | 'unknown'

/** One node in the merged current-conversation delegation tree. */
export type WorkbenchNode = NativeWorkbenchNode | ProductWorkbenchNode | ProductAttemptWorkbenchNode

/** Navigable DSH child Session and its recursively projected descendants. */
export interface NativeWorkbenchNode {
  readonly key: string
  readonly kind: 'native'
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly label: string
  readonly state: 'active' | 'inactive'
  readonly mode: 'one-shot' | 'continuable'
  readonly address: SubagentAddress
  readonly summary?: SessionSummary
  readonly children: readonly WorkbenchNode[]
}

/** Published official DSH lifecycle correlated to the model-facing tool call. */
export interface ProductWorkbenchNode {
  readonly key: string
  readonly kind: 'product'
  readonly parentSessionId: SessionId
  readonly childId: string
  readonly label: string
  readonly state: Exclude<WorkbenchState, 'queued' | 'starting' | 'not-published' | 'inactive'>
  readonly run: ObservedRunView
  readonly children: readonly []
}

/** Plugin-owned delegation that has not published an official DSH run. */
export interface ProductAttemptWorkbenchNode {
  readonly key: string
  readonly kind: 'product-attempt'
  readonly parentSessionId: SessionId
  readonly label: string
  readonly state: 'queued' | 'starting' | 'not-published' | 'unknown'
  readonly attempt: OwnedAttemptView
  readonly children: readonly []
}

/**
 * Find every known native descendant whose own delegation rows belong in the workbench.
 * @param rootSessionId - conversation that owns the workbench tab.
 * @param summaries - current Session inventory used to follow parent links.
 * @returns root first, followed by every reachable native descendant id.
 */
export function collectTreeParentIds(
  rootSessionId: SessionId,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  catalogs: SessionListState['subagentsByParent'],
): readonly SessionId[] {
  const found = new Set<SessionId>([rootSessionId])
  let changed = true
  while (changed && found.size < 64) {
    changed = false
    for (const summary of Object.values(summaries)) {
      if (
        summary.origin !== 'subagent'
        || summary.parentId === undefined
        || !found.has(summary.parentId)
        || found.has(summary.id)
      ) continue
      found.add(summary.id)
      changed = true
    }
    for (const parentId of [...found]) {
      for (const entry of catalogChildren(parentId, catalogs)) {
        if (found.has(entry.id) || found.size >= 64) continue
        found.add(entry.id)
        changed = true
      }
    }
  }
  return [...found]
}

function catalogChildren(
  parentSessionId: SessionId,
  catalogs: SessionListState['subagentsByParent'],
): readonly CatalogEntry[] {
  return catalogs[parentSessionId]?.entries.filter(
    (entry): entry is CatalogEntry => entry.kind === 'child',
  ) ?? []
}

function nativeLabel(entry: CatalogEntry, summary: SessionSummary | undefined): string {
  const label = 'label' in entry ? entry.label : undefined
  return label?.trim() || summary?.displayTitle || String(entry.id)
}

function configuredLabel(value: {
  readonly label?: string | undefined
  readonly displayName?: string | undefined
  readonly product?: string | undefined
}, fallback: string): string {
  return value.label?.trim() || value.displayName?.trim() || value.product?.trim() || fallback
}

/**
 * Merge native child Sessions and observed external runs into one factual branch tree.
 * @param input - current Session catalogs, summaries, and Host-filtered plugin snapshot.
 * @returns sorted direct children with native descendants nested recursively.
 */
export function buildWorkbenchTree(input: {
  readonly rootSessionId: SessionId
  readonly catalogs: SessionListState['subagentsByParent']
  readonly summaries: Readonly<Record<SessionId, SessionSummary>>
  readonly snapshot?: ConsoleSnapshot
}): readonly WorkbenchNode[] {
  const { rootSessionId, catalogs, summaries, snapshot } = input
  const visiting = new Set<SessionId>()

  const childrenOf = (parentSessionId: SessionId): readonly WorkbenchNode[] => {
    if (visiting.has(parentSessionId)) return []
    visiting.add(parentSessionId)
    const nativeEntries = catalogChildren(parentSessionId, catalogs)
    const nativeIds = new Set(nativeEntries.map(entry => String(entry.id)))
    const nativeNodes = nativeEntries.map((entry): NativeWorkbenchNode => {
      const summary = summaries[entry.id]
      return {
        key: `session:${entry.id}`,
        kind: 'native',
        parentSessionId,
        childSessionId: entry.id,
        label: nativeLabel(entry, summary),
        // `inactive` means only not presently running; a continuable child may resume.
        state: entry.activity === 'running' ? 'active' : 'inactive',
        mode: entry.mode,
        address: {
          parentSessionId,
          childSessionId: entry.id,
          mode: entry.mode,
        },
        ...(summary === undefined ? {} : { summary }),
        children: childrenOf(entry.id),
      }
    })
    const attempts = (snapshot?.attempts ?? [])
      .filter(attempt => attempt.parentSessionId === String(parentSessionId))
      .map((attempt): ProductAttemptWorkbenchNode => ({
        key: `attempt:${attempt.attemptId}`,
        kind: 'product-attempt',
        parentSessionId,
        label: configuredLabel(attempt, attempt.toolName),
        state: attempt.state,
        attempt,
        children: [],
      }))
    const runs = (snapshot?.runs ?? [])
      .filter(run => run.parentSessionId === String(parentSessionId))
      .filter(run => !run.local || !nativeIds.has(run.childId))
      .map((run): ProductWorkbenchNode => ({
        key: run.attemptId === undefined ? `run:${run.runId}` : `attempt:${run.attemptId}`,
        kind: 'product',
        parentSessionId,
        childId: run.childId,
        label: configuredLabel(run, run.toolName),
        state: run.state,
        run,
        children: [],
      }))
    visiting.delete(parentSessionId)
    return [...nativeNodes, ...attempts, ...runs].sort((left, right) => {
      const leftLive = left.state === 'active' || left.state === 'queued' || left.state === 'starting'
      const rightLive = right.state === 'active' || right.state === 'queued' || right.state === 'starting'
      if (leftLive !== rightLive) return leftLive ? -1 : 1
      const leftTime = left.kind === 'product'
        ? left.run.startedAt
        : left.kind === 'product-attempt' ? left.attempt.createdAt : left.summary?.updatedAt ?? 0
      const rightTime = right.kind === 'product'
        ? right.run.startedAt
        : right.kind === 'product-attempt' ? right.attempt.createdAt : right.summary?.updatedAt ?? 0
      return rightTime - leftTime
    })
  }

  return childrenOf(rootSessionId)
}

/** Flatten one workbench forest in display order. */
export function flattenWorkbenchTree(nodes: readonly WorkbenchNode[]): readonly WorkbenchNode[] {
  return nodes.flatMap(node => [node, ...flattenWorkbenchTree(node.children)])
}
