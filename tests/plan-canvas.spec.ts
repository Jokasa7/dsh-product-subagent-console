import { describe, expect, it } from 'vitest'
import type { AgentPlanContent } from '../src/plan-types.js'
import {
  applyPlanCanvasOffsets, buildPlanCanvasEdges, buildPlanCanvasTopology, layoutPlanCanvas,
  planCanvasRootId,
} from '../src/client/plan-canvas.js'

function fixture(): AgentPlanContent {
  return {
    title: 'Review release',
    objective: 'Review independent surfaces in parallel and combine the evidence.',
    successCriteria: ['Every finding has evidence'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'The surfaces are independent.',
      userOverride: false,
    },
    pattern: 'parallel-fanout-fanin',
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 4, maxConcurrent: 3, planTimeoutMs: 600_000 },
    roles: [{
      roleId: 'reviewer',
      name: 'Reviewer',
      responsibility: 'Review one assigned surface.',
      boundaries: [],
      transportProvider: 'codex',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'frontend',
      title: 'Review frontend',
      brief: 'Inspect the frontend.',
      roleId: 'reviewer',
      dependsOn: [],
      expectedOutput: { description: 'Frontend findings' },
      completionCriteria: ['Findings cite files'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'backend',
      title: 'Review backend',
      brief: 'Inspect the backend.',
      roleId: 'reviewer',
      dependsOn: [],
      expectedOutput: { description: 'Backend findings' },
      completionCriteria: ['Findings cite files'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }, {
      taskId: 'merge',
      title: 'Combine evidence',
      brief: 'Combine the two reviews.',
      roleId: 'reviewer',
      dependsOn: [
        { taskId: 'frontend', mode: 'context' },
        { taskId: 'backend', mode: 'order-only' },
      ],
      expectedOutput: { description: 'Release report' },
      completionCriteria: ['Both reviews are represented'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

describe('Agent plan canvas projection', () => {
  it('renders independent roots and exact dependency modes without inventing missing nodes', () => {
    const content = fixture()
    content.tasks[2]?.dependsOn.push({ taskId: 'missing', mode: 'context' })
    const topology = buildPlanCanvasTopology('one', content)
    expect(topology.map(node => node.id)).toEqual([
      'plan:one', 'task:frontend', 'task:backend', 'task:merge',
    ])
    expect(buildPlanCanvasEdges('one', content)).toEqual([
      {
        id: 'edge:plan:one->task:frontend', source: 'plan:one', target: 'task:frontend', mode: 'plan-root',
      },
      {
        id: 'edge:plan:one->task:backend', source: 'plan:one', target: 'task:backend', mode: 'plan-root',
      },
      {
        id: 'edge:task:frontend->task:merge:context',
        source: 'task:frontend', target: 'task:merge', mode: 'context',
      },
      {
        id: 'edge:task:backend->task:merge:order-only',
        source: 'task:backend', target: 'task:merge', mode: 'order-only',
      },
    ])
  })

  it('uses deterministic layout and preserves only browser-local drag offsets', () => {
    const content = fixture()
    const topology = buildPlanCanvasTopology('one', content)
    const edges = buildPlanCanvasEdges('one', content)
    const first = layoutPlanCanvas(topology, edges)
    const second = layoutPlanCanvas(topology, edges)
    expect(second).toEqual(first)
    expect(first.find(node => node.id === planCanvasRootId('one'))?.width).toBe(360)

    const baseline = first.find(node => node.id === 'task:frontend')
    const shifted = applyPlanCanvasOffsets(first, new Map([
      ['task:frontend', { x: 21, y: -9 }],
    ]))
    expect(shifted.find(node => node.id === 'task:frontend')?.position).toEqual({
      x: (baseline?.position.x ?? 0) + 21,
      y: (baseline?.position.y ?? 0) - 9,
    })
    expect(shifted.find(node => node.id === 'task:backend')?.position).toEqual(
      first.find(node => node.id === 'task:backend')?.position,
    )
  })
})
