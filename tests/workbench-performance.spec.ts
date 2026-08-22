import { describe, expect, it } from 'vitest'
import {
  layoutWorkbenchCanvas, type WorkbenchCanvasTopologyNode,
} from '../src/client/workbench-canvas.js'

type Shape = 'balanced' | 'star'

function topology(size: number, shape: Shape): readonly WorkbenchCanvasTopologyNode[] {
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer')
  const nodes: WorkbenchCanvasTopologyNode[] = [{
    id: 'conversation:root',
    kind: 'root',
    hasChildren: size > 1,
    level: 1,
    positionInSet: 1,
    setSize: 1,
  }]
  const parentIndex = (index: number): number => shape === 'star' ? 0 : Math.floor((index - 1) / 2)
  const children = new Map<number, number[]>()
  for (let index = 1; index < size; index += 1) {
    const parent = parentIndex(index)
    children.set(parent, [...children.get(parent) ?? [], index])
  }
  const levels = [1]
  for (let index = 1; index < size; index += 1) {
    levels[index] = (levels[parentIndex(index)] ?? 1) + 1
  }
  for (let index = 1; index < size; index += 1) {
    const siblings = children.get(parentIndex(index)) ?? []
    nodes.push({
      id: `session:${index}`,
      parentId: parentIndex(index) === 0 ? 'conversation:root' : `session:${parentIndex(index)}`,
      workbenchKey: `session:${index}`,
      kind: 'native',
      hasChildren: children.has(index),
      level: levels[index] ?? 2,
      positionInSet: siblings.indexOf(index) + 1,
      setSize: siblings.length,
    })
  }
  return nodes
}

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

function canvasWidth(layout: ReturnType<typeof layoutWorkbenchCanvas>): number {
  const left = Math.min(...layout.map(node => node.position.x))
  const right = Math.max(...layout.map(node => node.position.x + node.width))
  return right - left
}

describe('workbench layout performance', () => {
  it('lays out representative balanced and star trees within an interactive budget', () => {
    const report: Record<string, { p95Ms: number; maxMs: number; widthPx: number }> = {}
    for (const size of [4, 8, 16, 32]) {
      for (const shape of ['balanced', 'star'] as const) {
        const input = topology(size, shape)
        for (let warmup = 0; warmup < 5; warmup += 1) layoutWorkbenchCanvas(input)
        const samples: number[] = []
        let last = layoutWorkbenchCanvas(input)
        for (let sample = 0; sample < 20; sample += 1) {
          const startedAt = performance.now()
          last = layoutWorkbenchCanvas(input)
          samples.push(performance.now() - startedAt)
        }
        const maxMs = Math.max(...samples)
        report[`${shape}-${size}`] = {
          p95Ms: Number(percentile95(samples).toFixed(3)),
          maxMs: Number(maxMs.toFixed(3)),
          widthPx: Math.round(canvasWidth(last)),
        }
        expect(last).toHaveLength(size)
        if (size === 32) expect(maxMs).toBeLessThan(100)
      }
    }

    expect(report['star-32']!.widthPx).toBeGreaterThan(report['balanced-32']!.widthPx)
    console.info('workbench-layout-performance', JSON.stringify(report))
  })
})
