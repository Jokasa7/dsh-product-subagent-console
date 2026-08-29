// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { strFromU8, unzipSync } from 'fflate/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentFoundryWorkbench,
  buildRecipeArchive,
  type AgentFoundryActions,
} from '../src/client/AgentFoundryWorkbench.js'
import { buildRecipeCandidate, exportRecipeCandidate } from '../src/recipe.js'
import { buildRecoveryProposal } from '../src/recovery.js'
import { sha256 } from '../src/conformance.js'
import { projectPlanContractV2, type FoundrySnapshot } from '../src/foundry-types.js'
import type { PlanExecution } from '../src/plan-types.js'
import { fixtureUuid, verifiedRun } from './foundry-fixtures.js'

vi.mock('../src/client/AgentPlanComparisonCanvas.js', () => ({
  AgentPlanComparisonCanvas: ({ onSelect }: { readonly onSelect: (id: string) => void }) => createElement(
    'button',
    { type: 'button', onClick: () => { onSelect('plan-task:review') } },
    'Select review task',
  ),
}))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const sessionId = 'parent-a' as SessionId

function actions(): AgentFoundryActions {
  return {
    askRun: vi.fn(),
    exportRunCapsule: vi.fn(),
    previewRecipe: vi.fn(),
    exportRecipe: vi.fn(),
    instantiateRecipe: vi.fn(),
    compareRuns: vi.fn(),
    exportTelemetry: vi.fn(),
    issueCancelControlGrant: vi.fn(),
    executeCancelControl: vi.fn(),
  }
}

function snapshotOf(runs = [verifiedRun(1)], revision = 1): FoundrySnapshot {
  const events = runs.flatMap(run => run.events).sort((left, right) => left.cursor - right.cursor)
  return {
    schemaVersion: 1,
    hostInstanceId: fixtureUuid(900),
    hostStartedAt: 1,
    revision,
    eventCursor: events.at(-1)?.cursor ?? 0,
    capturedAt: 100_000 + revision,
    durability: 'disk',
    storageStatus: 'ready',
    projectionDigest: sha256(`snapshot:${String(revision)}`),
    adapterFacts: [],
    plans: runs.map(run => run.plan),
    executions: runs.map(run => run.execution),
    events,
    receipts: runs.map(run => run.receipt),
    reports: runs.map(run => run.report),
    recoveryProposals: runs.map(run => buildRecoveryProposal({
      contract: projectPlanContractV2(run.plan),
      execution: run.execution,
      report: run.report,
      events: run.events,
      receipts: [run.receipt],
      capabilityDigest: run.execution.capabilityDigest,
      now: 100_000,
      controlSupport: { retry: 'unsupported', fork: 'unsupported' },
    })),
  }
}

function renderWorkbench(input: {
  readonly snapshot?: FoundrySnapshot
  readonly status?: 'loading' | 'ready' | 'error'
  readonly mode?: 'deviation' | 'recovery'
  readonly actions?: AgentFoundryActions
  readonly onRetry?: () => void
  readonly onOpenPlan?: () => void
  readonly active?: boolean
  readonly english?: boolean
} = {}) {
  const injected = input.actions ?? actions()
  const props = {
    sessionId,
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    status: input.status ?? 'ready' as const,
    mode: input.mode ?? 'deviation' as const,
    actions: injected,
    active: input.active ?? true,
    english: input.english ?? true,
    canvasCopy: {} as never,
    onRetry: input.onRetry ?? vi.fn(),
    onOpenPlan: input.onOpenPlan ?? vi.fn(),
  }
  return { injected, props, view: render(createElement(AgentFoundryWorkbench, props)) }
}

describe('Agent Foundry workbench', () => {
  it('pins a historical cursor while live events arrive and asks with the exact run, task, and cursor', async () => {
    const run = verifiedRun(1)
    const initial = snapshotOf([run])
    const injected = actions()
    const rendered = renderWorkbench({ snapshot: initial, actions: injected })

    fireEvent.change(screen.getByRole('slider', { name: 'Run timeline' }), { target: { value: 12 } })
    fireEvent.click(screen.getByRole('button', { name: 'Select review task' }))

    const baseEvent = initial.events[0]
    if (baseEvent === undefined) throw new Error('fixture event missing')
    const newer = {
      ...initial,
      revision: 2,
      eventCursor: 15,
      events: [...initial.events, {
        ...baseEvent,
        eventId: sha256('new-live-event'),
        sourceEventId: 'new-live-event',
        cursor: 15,
        observedAt: 15,
      }],
    } satisfies FoundrySnapshot
    rendered.view.rerender(createElement(AgentFoundryWorkbench, { ...rendered.props, snapshot: newer }))

    expect((screen.getByRole('slider', { name: 'Run timeline' }) as HTMLInputElement).value).toBe('12')
    fireEvent.change(screen.getByRole('textbox', { name: 'Question about this run' }), {
      target: { value: 'Why was this task still active?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send to current conversation' }))

    await waitFor(() => {
      expect(injected.askRun).toHaveBeenCalledWith(sessionId, {
        parentSessionId: 'parent-a',
        runId: run.execution.executionId,
        kind: 'why-running',
        throughCursor: 12,
        taskId: 'review',
      }, 'Why was this task still active?', expect.any(AbortSignal))
    })
    expect((screen.getByRole('button', { name: 'Export run Capsule' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Export OTLP JSON' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('resets a staged cancel when facts change and requires a fresh two-step confirmation', async () => {
    const source = verifiedRun(2)
    const execution: PlanExecution = {
      ...source.execution,
      status: 'running',
      bindings: source.execution.bindings.map(binding => ({
        ...binding,
        status: 'running',
        finishedAt: undefined,
      })),
      finishedAt: undefined,
    }
    const run = { ...source, execution }
    const initial = snapshotOf([run])
    const injected = actions()
    vi.mocked(injected.issueCancelControlGrant).mockResolvedValue({
      grantId: fixtureUuid(777),
      action: 'cancel',
      parentSessionId: 'parent-a',
      runId: execution.executionId,
      proposalId: initial.recoveryProposals[0]?.proposalId ?? sha256('proposal'),
      planId: execution.planId,
      planRevision: execution.planRevision,
      capabilityDigest: execution.capabilityDigest,
      issuedCursor: initial.eventCursor,
      expiresAt: Date.now() + 60_000,
    })
    vi.mocked(injected.executeCancelControl).mockResolvedValue({ status: 'requested' })
    const rendered = renderWorkbench({ snapshot: initial, mode: 'recovery', actions: injected })

    fireEvent.click(screen.getByRole('button', { name: 'Review cancel impact' }))
    expect(screen.getByRole('button', { name: 'Confirm whole-run cancel' })).toBeTruthy()
    const changedProposal = {
      ...initial.recoveryProposals[0]!,
      proposalId: sha256('proposal-after-new-facts'),
    }
    rendered.view.rerender(createElement(AgentFoundryWorkbench, {
      ...rendered.props,
      mode: 'recovery',
      snapshot: {
        ...initial,
        revision: initial.revision + 1,
        recoveryProposals: [changedProposal],
      },
    }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Review cancel impact' })).toBeTruthy() })
    expect(injected.executeCancelControl).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Review cancel impact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm whole-run cancel' }))
    await waitFor(() => { expect(injected.executeCancelControl).toHaveBeenCalledOnce() })
    expect(injected.issueCancelControlGrant).toHaveBeenCalledWith({
      parentSessionId: 'parent-a',
      runId: execution.executionId,
      proposalId: changedProposal.proposalId,
      eventCursor: changedProposal.eventCursor,
    }, expect.any(AbortSignal))
    expect(injected.executeCancelControl).toHaveBeenCalledWith({
      parentSessionId: 'parent-a',
      runId: execution.executionId,
      grantId: fixtureUuid(777),
    }, expect.any(AbortSignal))
  })

  it('disables cancellation after the run has entered stopping', () => {
    const source = verifiedRun(24)
    const run = {
      ...source,
      execution: {
        ...source.execution,
        status: 'stopping' as const,
        cancellationRequested: true,
        finishedAt: undefined,
      },
    }
    renderWorkbench({ snapshot: snapshotOf([run]), mode: 'recovery' })
    expect((screen.getByRole('button', { name: 'Review cancel impact' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('localizes execution status and presents recovery tasks by title', () => {
    const run = verifiedRun(2)
    renderWorkbench({ snapshot: snapshotOf([run]), mode: 'recovery', english: false })

    expect((screen.getByRole('combobox', { name: '运行' }) as HTMLSelectElement).selectedOptions[0]?.textContent)
      .toContain('已成功')
    expect(screen.getByText('Review')).toBeTruthy()
  })

  it('turns three verified historical runs into a draft and current preflight without approving or executing', async () => {
    const runs = [verifiedRun(3), verifiedRun(4), verifiedRun(5)]
    const snapshot = snapshotOf(runs)
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: snapshot.plans,
      executions: snapshot.executions,
      reports: snapshot.reports,
      receipts: snapshot.receipts,
      events: snapshot.events,
    })
    const injected = actions()
    vi.mocked(injected.previewRecipe).mockResolvedValue(candidate)
    vi.mocked(injected.instantiateRecipe).mockResolvedValue({
      plan: { ...runs[0]!.plan, state: 'draft', objective: 'Ship the bounded review.' },
      preflight: { schemaVersion: 1, valid: true, errors: [], warnings: [], capabilityDigest: 'capability-a' },
    } as never)
    const onOpenPlan = vi.fn()
    renderWorkbench({ snapshot, actions: injected, onOpenPlan })

    const checks = screen.getAllByRole('checkbox')
    checks.slice(0, 3).forEach(check => { fireEvent.click(check) })
    fireEvent.click(screen.getByRole('button', { name: 'Check historical runs' }))
    await screen.findByText(/Tool authority is inherited/)
    expect(screen.queryByText(/isolation passed/i)).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'New plan objective' }), {
      target: { value: 'Ship the bounded review.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create draft, preflight, and open Plan' }))

    await waitFor(() => { expect(onOpenPlan).toHaveBeenCalledOnce() })
    expect(injected.instantiateRecipe).toHaveBeenCalledWith({
      parentSessionId: 'parent-a',
      executionIds: runs.map(run => run.execution.executionId),
      candidateId: candidate.candidateId,
      objective: 'Ship the bounded review.',
    }, expect.any(AbortSignal))
  })

  it('packages the complete Recipe as one safe ZIP and triggers only one browser download', async () => {
    const runs = [verifiedRun(6), verifiedRun(7), verifiedRun(8)]
    const snapshot = snapshotOf(runs)
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: snapshot.plans,
      executions: snapshot.executions,
      reports: snapshot.reports,
      receipts: snapshot.receipts,
      events: snapshot.events,
    })
    const exported = exportRecipeCandidate(
      candidate,
      candidate.candidateId,
      candidate.exportApprovalDigest,
    )
    const archive = unzipSync(await buildRecipeArchive(exported))
    expect(Object.keys(archive).sort()).toEqual(['SKILL.md', 'checksums.json', 'recipe.json'])
    const skill = strFromU8(archive['SKILL.md']!)
    const recipe = strFromU8(archive['recipe.json']!)
    const checksums = JSON.parse(strFromU8(archive['checksums.json']!)) as Record<string, string>
    expect(skill).toContain('recipe.json')
    expect(recipe).toBe(exported.recipeJson)
    expect(checksums).toEqual({ 'SKILL.md': sha256(skill), 'recipe.json': sha256(recipe) })
    await expect(buildRecipeArchive({
      ...exported,
      skillFiles: exported.skillFiles.map(file => file.path === 'SKILL.md'
        ? { ...file, content: `${file.content}\nTampered` }
        : file),
    })).rejects.toThrow('digest does not match SKILL.md')
    const wrongChecksums = JSON.stringify({
      'SKILL.md': sha256(skill),
      'recipe.json': sha256('wrong'),
    })
    await expect(buildRecipeArchive({
      ...exported,
      skillFiles: exported.skillFiles.map(file => file.path === 'checksums.json'
        ? { ...file, content: wrongChecksums, digest: sha256(wrongChecksums) }
        : file),
    })).rejects.toThrow('checksums do not match')

    const injected = actions()
    vi.mocked(injected.previewRecipe).mockResolvedValue(candidate)
    vi.mocked(injected.exportRecipe).mockResolvedValue(exported)
    const createObjectURL = vi.fn(() => 'blob:recipe')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderWorkbench({ snapshot, actions: injected })
    screen.getAllByRole('checkbox').slice(0, 3).forEach(check => { fireEvent.click(check) })
    fireEvent.click(screen.getByRole('button', { name: 'Check historical runs' }))
    await screen.findByText(/Tool authority is inherited/)
    fireEvent.click(screen.getByRole('button', { name: 'Export Recipe ZIP \(not installed\)' }))

    await waitFor(() => { expect(createObjectURL).toHaveBeenCalledOnce() })
    expect(injected.exportRecipe).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(screen.getByText(/One Recipe ZIP was downloaded/)).toBeTruthy()
  })

  it('shows a retry for an unavailable fact stream and bounds run selection rendering to fifty', () => {
    const onRetry = vi.fn()
    const empty = renderWorkbench({ status: 'error', onRetry })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
    empty.view.unmount()

    const base = verifiedRun(10)
    const executions = Array.from({ length: 51 }, (_value, index) => ({
      ...base.execution,
      executionId: fixtureUuid(1_000 + index),
    }))
    renderWorkbench({ snapshot: { ...snapshotOf([base]), executions } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(50)
    expect(screen.getByText('Select at most 50 runs.')).toBeTruthy()
  })

  it('drops foreign plan events, receipts, and nested findings from the visible run', () => {
    const run = verifiedRun(19)
    const base = snapshotOf([run])
    const foreignEvent = {
      ...run.events.at(-1)!,
      eventId: sha256('foreign-ui-event'),
      sourceEventId: 'foreign-ui-event',
      cursor: run.events.at(-1)!.cursor + 1,
      planRevision: run.execution.planRevision + 1,
      type: 'control-requested' as const,
    }
    const findingId = sha256('foreign-ui-finding')
    const foreignReport = {
      ...run.report,
      state: 'deviated' as const,
      firstProvableDivergenceId: findingId,
      findings: [{
        schemaVersion: 1 as const,
        findingId,
        code: 'lifecycle-incomplete' as const,
        status: 'open' as const,
        severity: 'blocking' as const,
        certainty: 'proven' as const,
        parentSessionId: 'foreign-parent',
        runId: run.execution.executionId,
        planId: run.execution.planId,
        planRevision: run.execution.planRevision,
        taskId: 'review',
        attemptId: run.execution.bindings[0]!.attemptId,
        firstObservedAt: run.execution.finishedAt ?? run.execution.createdAt,
        evidenceEventIds: [run.events[2]!.eventId],
      }],
    }
    renderWorkbench({
      snapshot: {
        ...base,
        events: [...base.events, foreignEvent],
        receipts: [{ ...run.receipt, planRevision: run.receipt.planRevision + 1 }],
        reports: [foreignReport],
      },
      english: true,
    })
    expect(screen.queryByText('control-requested')).toBeNull()
    expect(screen.queryByText('lifecycle-complete')).toBeNull()
    expect(screen.getByText('No verifier receipt applies to this node.')).toBeTruthy()
    expect(screen.queryByText('deviated')).toBeNull()
  })

  it('does not combine a stale report with a live recovery proposal', () => {
    const run = verifiedRun(25)
    const base = snapshotOf([run])
    const { finishedAt: _finishedAt, ...executionBase } = run.execution
    const running: PlanExecution = {
      ...executionBase,
      status: 'running',
      bindings: run.execution.bindings.map((binding) => {
        const { finishedAt: _bindingFinishedAt, ...bindingBase } = binding
        return { ...bindingBase, status: 'running' as const }
      }),
    }
    renderWorkbench({
      snapshot: {
        ...base,
        executions: [running],
        reports: [{ ...run.report, eventCursor: run.report.eventCursor - 1 }],
      },
      mode: 'recovery',
      english: true,
    })

    expect((screen.getByRole('button', { name: 'Review cancel impact' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('rejects report task finding references that do not close to same-task findings', () => {
    const run = verifiedRun(26)
    const base = snapshotOf([run])
    const { finishedAt: _finishedAt, ...executionBase } = run.execution
    const running: PlanExecution = {
      ...executionBase,
      status: 'running',
      bindings: run.execution.bindings.map((binding) => {
        const { finishedAt: _bindingFinishedAt, ...bindingBase } = binding
        return { ...bindingBase, status: 'running' as const }
      }),
    }
    renderWorkbench({
      snapshot: {
        ...base,
        executions: [running],
        reports: [{
          ...run.report,
          tasks: run.report.tasks.map(task => ({ ...task, findingIds: [sha256('missing-finding')] })),
        }],
      },
      mode: 'recovery',
      english: true,
    })

    expect((screen.getByRole('button', { name: 'Review cancel impact' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not present model claims or claim-kind mismatches as verifier evidence', () => {
    const run = verifiedRun(27)
    const base = snapshotOf([run])
    renderWorkbench({
      snapshot: {
        ...base,
        receipts: [
          { ...run.receipt, authority: 'model-claim' },
          { ...run.receipt, receiptId: sha256('wrong-ui-claim'), claim: 'manual-accepted' },
        ],
      },
      english: true,
    })

    expect(screen.getByText('No verifier receipt applies to this node.')).toBeTruthy()
    expect(screen.queryByText('lifecycle-complete')).toBeNull()
  })

  it('locks async request context and aborts the operation when Foundry becomes inactive', async () => {
    const runs = [verifiedRun(20), verifiedRun(21), verifiedRun(22)]
    const injected = actions()
    let requestSignal: AbortSignal | undefined
    vi.mocked(injected.previewRecipe).mockImplementation((_request, signal) => {
      requestSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    })
    const rendered = renderWorkbench({ snapshot: snapshotOf(runs), actions: injected })
    screen.getAllByRole('checkbox').slice(0, 3).forEach(check => { fireEvent.click(check) })
    fireEvent.click(screen.getByRole('button', { name: 'Check historical runs' }))

    await waitFor(() => { expect(injected.previewRecipe).toHaveBeenCalledOnce() })
    expect((screen.getByRole('combobox', { name: 'Execution' }) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: 'Fact query type' }) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Question about this run' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getAllByRole('checkbox').every(check => (check as HTMLInputElement).disabled)).toBe(true)

    rendered.view.rerender(createElement(AgentFoundryWorkbench, { ...rendered.props, active: false }))
    await waitFor(() => { expect(requestSignal?.aborted).toBe(true) })
  })

  it('does not continue a cancel chain when an aborted grant request resolves late', async () => {
    const source = verifiedRun(23)
    const execution: PlanExecution = {
      ...source.execution,
      status: 'running',
      finishedAt: undefined,
      bindings: source.execution.bindings.map(binding => ({
        ...binding, status: 'running', finishedAt: undefined,
      })),
    }
    const snapshot = snapshotOf([{ ...source, execution }])
    const injected = actions()
    let requestSignal: AbortSignal | undefined
    let resolveGrant: ((value: Awaited<ReturnType<AgentFoundryActions['issueCancelControlGrant']>>) => void) | undefined
    vi.mocked(injected.issueCancelControlGrant).mockImplementation((_request, signal) => {
      requestSignal = signal
      return new Promise(resolve => { resolveGrant = resolve })
    })
    const rendered = renderWorkbench({ snapshot, mode: 'recovery', actions: injected })
    fireEvent.click(screen.getByRole('button', { name: 'Review cancel impact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm whole-run cancel' }))
    await waitFor(() => { expect(injected.issueCancelControlGrant).toHaveBeenCalledOnce() })

    rendered.view.rerender(createElement(AgentFoundryWorkbench, { ...rendered.props, active: false }))
    await waitFor(() => { expect(requestSignal?.aborted).toBe(true) })
    await act(async () => {
      resolveGrant?.({
        grantId: fixtureUuid(779),
        action: 'cancel',
        parentSessionId: 'parent-a',
        runId: execution.executionId,
        proposalId: snapshot.recoveryProposals[0]?.proposalId ?? sha256('proposal'),
        planId: execution.planId,
        planRevision: execution.planRevision,
        capabilityDigest: execution.capabilityDigest,
        issuedCursor: snapshot.eventCursor,
        expiresAt: Date.now() + 60_000,
      })
      await Promise.resolve()
    })
    expect(injected.executeCancelControl).not.toHaveBeenCalled()
  })
})
