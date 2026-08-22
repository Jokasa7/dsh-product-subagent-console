import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NativeWorkbenchNode, ProductWorkbenchNode } from '../src/client/workbench-model.js'
import {
  applyWorkbenchCanvasOffsets, buildWorkbenchCanvasEdges, buildWorkbenchCanvasTopology,
  layoutWorkbenchCanvas,
} from '../src/client/workbench-canvas.js'

const parent = 'parent' as SessionId
const child = 'child' as SessionId

function fixtureTree(): readonly NativeWorkbenchNode[] {
  const product: ProductWorkbenchNode = {
    key: 'run:one',
    kind: 'product',
    parentSessionId: child,
    childId: 'product-child',
    label: 'Review module status',
    state: 'active',
    run: {
      runId: 'one',
      parentSessionId: String(child),
      childId: 'product-child',
      callId: 'call-one',
      providerName: 'codex-safe',
      toolName: 'subagent_codex',
      product: 'codex',
      displayName: 'Codex',
      label: 'Review module status',
      providerMismatch: false,
      source: 'observed-tool',
      local: false,
      state: 'active',
      startedAt: 1,
    },
    children: [],
  }
  return [{
    key: `session:${child}`,
    kind: 'native',
    parentSessionId: parent,
    childSessionId: child,
    label: 'Review branch',
    state: 'active',
    mode: 'continuable',
    address: { parentSessionId: parent, childSessionId: child, mode: 'continuable' },
    children: [product],
  }]
}

describe('workbench canvas topology', () => {
  it('derives only factual parent-child connectors and keeps external runs as leaves', () => {
    const topology = buildWorkbenchCanvasTopology(parent, fixtureTree())
    expect(topology.map(node => [node.id, node.parentId, node.kind, node.level])).toEqual([
      ['conversation:parent', undefined, 'root', 1],
      ['session:child', 'conversation:parent', 'native', 2],
      ['run:one', 'session:child', 'product', 3],
    ])
    expect(topology.at(-1)?.hasChildren).toBe(false)
    expect(buildWorkbenchCanvasEdges(topology)).toEqual([
      { id: 'edge:conversation:parent->session:child', source: 'conversation:parent', target: 'session:child' },
      { id: 'edge:session:child->run:one', source: 'session:child', target: 'run:one' },
    ])
  })

  it('reflows untouched siblings and retains only deliberate drag offsets', () => {
    const rootId = 'conversation:parent'
    const before = [
      { id: rootId, kind: 'root', hasChildren: true, level: 1, positionInSet: 1, setSize: 1 },
      {
        id: 'session:a', parentId: rootId, workbenchKey: 'session:a', kind: 'native',
        hasChildren: false, level: 2, positionInSet: 1, setSize: 1,
      },
    ] as const
    const after = [
      { ...before[0] },
      { ...before[1], positionInSet: 1, setSize: 2 },
      {
        id: 'session:b', parentId: rootId, workbenchKey: 'session:b', kind: 'native',
        hasChildren: false, level: 2, positionInSet: 2, setSize: 2,
      },
    ] as const
    const oldLayout = layoutWorkbenchCanvas(before)
    const baseline = layoutWorkbenchCanvas(after)
    const oldA = oldLayout.find(node => node.id === 'session:a')
    const newA = baseline.find(node => node.id === 'session:a')
    const newB = baseline.find(node => node.id === 'session:b')
    expect(oldA?.position).not.toEqual(newA?.position)
    const dragged = applyWorkbenchCanvasOffsets(baseline, new Map([['session:a', { x: 28, y: 14 }]]))
    expect(dragged.find(node => node.id === 'session:a')?.position).toEqual({
      x: (newA?.position.x ?? 0) + 28,
      y: (newA?.position.y ?? 0) + 14,
    })
    expect(dragged.find(node => node.id === 'session:b')?.position).toEqual(newB?.position)
  })
})
