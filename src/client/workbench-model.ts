import type {
  SessionId, SessionListState, SessionSummary, SubagentAddress, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConsoleSnapshot, ObservedRunView, OwnedAttemptView } from '../types.js'

type CatalogEntry = Extract<SubagentCatalogSnapshot['entries'][number], { kind: 'child' }>
const MAX_PARENT_SESSION_IDS = 64

export interface TreeParentScope {
  readonly ids: readonly SessionId[]
  readonly truncated: boolean
}

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
  return collectTreeParentScope(rootSessionId, summaries, catalogs).ids
}

/** Collect a deterministic bounded RPC scope and report when descendants were omitted. */
export function collectTreeParentScope(
  rootSessionId: SessionId,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  catalogs: SessionListState['subagentsByParent'],
): TreeParentScope {
  const childrenByParent = new Map<SessionId, Set<SessionId>>()
  const active = new Set<SessionId>()
  const addChild = (parentId: SessionId, childId: SessionId): void => {
    const children = childrenByParent.get(parentId) ?? new Set<SessionId>()
    children.add(childId)
    childrenByParent.set(parentId, children)
  }
  for (const summary of Object.values(summaries)) {
    if (summary.running) active.add(summary.id)
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    addChild(summary.parentId, summary.id)
  }
  for (const [rawParentId, catalog] of Object.entries(catalogs)) {
    const parentId = rawParentId as SessionId
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child') continue
      addChild(parentId, entry.id)
      if (entry.activity === 'running') active.add(entry.id)
    }
  }

  const reachable = new Set<SessionId>([rootSessionId])
  const reachableParent = new Map<SessionId, SessionId>()
  const queue: SessionId[] = [rootSessionId]
  let cursor = 0
  while (cursor < queue.length) {
    const parentId = queue[cursor]
    cursor += 1
    if (parentId === undefined) break
    const candidates = [...(childrenByParent.get(parentId) ?? [])]
      .sort((left, right) => String(left).localeCompare(String(right)))
    for (const childId of candidates) {
      if (reachable.has(childId)) continue
      reachable.add(childId)
      reachableParent.set(childId, parentId)
      queue.push(childId)
    }
  }

  const selected = new Set<SessionId>([rootSessionId])
  const candidates = [...reachable].filter(id => id !== rootSessionId).sort((left, right) => {
    const leftActive = active.has(left)
    const rightActive = active.has(right)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    const recent = (summaries[right]?.updatedAt ?? 0) - (summaries[left]?.updatedAt ?? 0)
    return recent !== 0 ? recent : String(left).localeCompare(String(right))
  })
  for (const candidate of candidates) {
    if (selected.has(candidate)) continue
    const path: SessionId[] = []
    const pathSeen = new Set<SessionId>()
    let current: SessionId | undefined = candidate
    while (current !== undefined && !selected.has(current)) {
      if (pathSeen.has(current)) {
        path.length = 0
        break
      }
      pathSeen.add(current)
      path.push(current)
      current = reachableParent.get(current)
    }
    if (current === undefined || selected.size + path.length > MAX_PARENT_SESSION_IDS) continue
    for (const id of path.reverse()) selected.add(id)
    if (selected.size >= MAX_PARENT_SESSION_IDS) break
  }
  return { ids: [...selected], truncated: selected.size < reachable.size }
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
  readonly includedSessionIds?: ReadonlySet<SessionId>
}): readonly WorkbenchNode[] {
  const { rootSessionId, catalogs, summaries, snapshot, includedSessionIds } = input
  const visiting = new Set<SessionId>()

  const childrenOf = (parentSessionId: SessionId): readonly WorkbenchNode[] => {
    if (visiting.has(parentSessionId)) return []
    visiting.add(parentSessionId)
    const nativeEntries = catalogChildren(parentSessionId, catalogs)
      .filter(entry => includedSessionIds?.has(entry.id) ?? true)
    const nativeIds = new Set(nativeEntries.map(entry => String(entry.id)))
    const localRunByChildId = new Map<string, ObservedRunView>()
    for (const run of snapshot?.runs ?? []) {
      if (run.parentSessionId !== String(parentSessionId) || !run.local || !nativeIds.has(run.childId)) continue
      const current = localRunByChildId.get(run.childId)
      if (current === undefined || run.startedAt > current.startedAt) localRunByChildId.set(run.childId, run)
    }
    const nativeNodes = nativeEntries.map((entry): NativeWorkbenchNode => {
      const summary = summaries[entry.id]
      const fallbackLabel = nativeLabel(entry, summary)
      const observed = localRunByChildId.get(String(entry.id))
      return {
        key: `session:${entry.id}`,
        kind: 'native',
        parentSessionId,
        childSessionId: entry.id,
        label: observed === undefined ? fallbackLabel : configuredLabel(observed, fallbackLabel),
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
