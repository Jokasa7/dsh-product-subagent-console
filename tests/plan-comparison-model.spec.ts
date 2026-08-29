import { describe, expect, it } from 'vitest'
import {
  buildPlanComparisonGraph,
  findExecutionPlanRevision,
} from '../src/client/plan-comparison-model.js'
import { verifiedRun } from './foundry-fixtures.js'

describe('plan comparison identity', () => {
  it('accepts only the immutable plan revision with the execution capability digest', () => {
    const source = verifiedRun(98)
    const wrongCapabilities = { ...source.plan, capabilityDigest: 'capability-foreign' }

    expect(findExecutionPlanRevision([wrongCapabilities], source.execution)).toBeUndefined()
    expect(findExecutionPlanRevision([wrongCapabilities, source.plan], source.execution)).toEqual(source.plan)
  })

  it('keeps mismatched attempt bindings visibly unresolved instead of attaching them to a plan task', () => {
    const source = verifiedRun(99)
    const execution = {
      ...source.execution,
      bindings: [{ ...source.execution.bindings[0]!, planRevision: 2 }],
    }
    const graph = buildPlanComparisonGraph(execution, source.plan)

    expect(graph.droppedBindings).toBe(1)
    expect(graph.nodes.some(node => node.kind === 'attempt')).toBe(false)
  })
})
