import type {
  SessionId, SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import type { ConsoleSnapshot } from '../src/types.js'
import {
  buildWorkbenchTree, collectTreeParentIds, flattenWorkbenchTree,
} from '../src/client/workbench-model.js'

const root = 'root' as SessionId
const child = 'child' as SessionId
const grandchild = 'grandchild' as SessionId

function summary(id: SessionId, parentId?: SessionId): SessionSummary {
  return {
    id,
    displayTitle: String(id),
    ...(parentId === undefined ? {} : { parentId, origin: 'subagent' as const }),
    running: false,
    blank: false,
    updatedAt: 1,
    projectionValues: {},
  }
}

const catalogs = {
  [root]: {
    state: 'ready', error: null, parentAvailable: true,
    entries: [{
      kind: 'child', id: child, activity: 'running', hasChildren: true,
      mode: 'continuable', label: 'Native child',
    }],
  },
  [child]: {
    state: 'ready', error: null, parentAvailable: true,
    entries: [{
      kind: 'child', id: grandchild, activity: 'inactive', hasChildren: false,
      mode: 'one-shot', label: 'Nested child',
    }],
  },
} as unknown as SessionListState['subagentsByParent']

const summaries = {
  [root]: summary(root),
  [child]: summary(child, root),
  [grandchild]: summary(grandchild, child),
}

function snapshot(): ConsoleSnapshot {
  return {
    schemaVersion: 1,
    hostInstanceId: '81d7cb39-bcca-4a51-899d-622da8593645',
    hostStartedAt: 1,
    revision: 3,
    capturedAt: 4,
    capabilities: {
      publishedLifecycle: true,
      startupLifecycle: 'owned-tool-only',
      liveProgress: false,
      browserCancellation: false,
      durableHistory: false,
    },
    diagnostics: { droppedActiveRuns: 0 },
    attempts: [{
      attemptId: 'bcba3947-9cf5-4375-8594-77221806ae20',
      parentSessionId: String(root),
      callId: 'call-attempt',
      toolName: 'subagent_codex',
      expectedProviderName: 'codex-safe',
      label: 'Queued audit',
      state: 'queued',
      createdAt: 3,
    }],
    runs: [{
      runId: 'native-duplicate',
      parentSessionId: String(root),
      childId: String(child),
      callId: 'call-native',
      toolName: 'subagent_native',
      providerName: 'native',
      providerMismatch: false,
      source: 'observed-tool',
      local: true,
      state: 'active',
      startedAt: 2,
    }, {
      runId: 'external',
      parentSessionId: String(child),
      childId: 'external-child',
      callId: 'call-external',
      toolName: 'subagent_codex',
      providerName: 'codex-safe',
      providerMismatch: false,
      source: 'observed-tool',
      local: false,
      state: 'completed',
      startedAt: 1,
      finishedAt: 2,
    }],
  }
}

describe('workbench model', () => {
  it('collects only reachable catalog or summary descendants', () => {
    expect(collectTreeParentIds(root, summaries, catalogs)).toEqual([root, child, grandchild])
    expect(collectTreeParentIds(root, {
      ...summaries,
      ['unrelated' as SessionId]: summary('unrelated' as SessionId),
    } as Readonly<Record<SessionId, SessionSummary>>, catalogs)).not.toContain('unrelated')
  })

  it('deduplicates native lifecycle rows and preserves factual nesting', () => {
    const tree = buildWorkbenchTree({ rootSessionId: root, catalogs, summaries, snapshot: snapshot() })
    expect(tree.map(node => [node.kind, node.key, node.state])).toEqual([
      ['product-attempt', 'attempt:bcba3947-9cf5-4375-8594-77221806ae20', 'queued'],
      ['native', 'session:child', 'active'],
    ])
    const childNode = tree[1]
    expect(childNode?.children.map(node => [node.kind, node.key])).toEqual([
      ['native', 'session:grandchild'],
      ['product', 'run:external'],
    ])
    expect(flattenWorkbenchTree(tree).map(node => node.key)).toEqual([
      'attempt:bcba3947-9cf5-4375-8594-77221806ae20',
      'session:child',
      'session:grandchild',
      'run:external',
    ])
  })

  it('keeps the visual key stable when an owned attempt publishes', () => {
    const before = buildWorkbenchTree({
      rootSessionId: root, catalogs: {}, summaries: {}, snapshot: snapshot(),
    })
    const published = snapshot()
    const attempt = published.attempts[0]!
    const after = buildWorkbenchTree({
      rootSessionId: root,
      catalogs: {},
      summaries: {},
      snapshot: {
        ...published,
        attempts: [],
        runs: [{
          ...published.runs[1]!,
          runId: 'published',
          attemptId: attempt.attemptId,
          parentSessionId: String(root),
        }],
      },
    })
    expect(before[0]?.key).toBe(`attempt:${attempt.attemptId}`)
    expect(after[0]?.key).toBe(before[0]?.key)
  })
})
