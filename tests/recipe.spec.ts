import { describe, expect, it } from 'vitest'
import {
  buildRecipeCandidate,
  buildRunAdvisor,
  exportRecipeCandidate,
  instantiateRecipeCandidate,
  RecipeEligibilityError,
} from '../src/recipe.js'
import { verifiedMultiRun, verifiedRun } from './foundry-fixtures.js'
import { sha256 } from '../src/conformance.js'

describe('Recipe candidate and run advisor', () => {
  it('requires three comparable verifier-passing runs and exports only after approval', () => {
    const runs = [verifiedRun(1), verifiedRun(2), verifiedRun(3)]
    const request = { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) }
    const candidate = buildRecipeCandidate({
      request,
      plans: runs.map(run => run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    expect(candidate.validation).toMatchObject({
      passed: true,
      runCount: 3,
      permissionStatus: 'inherited-unresolved',
      reasonCodes: ['inherits-parent-tools'],
    })
    expect(candidate.permissionProfile.roles[0]).toMatchObject({
      roleId: 'worker',
      toolPolicy: { mode: 'inherit', tools: [] },
      authority: 'inherited-unresolved',
    })
    expect(candidate.planTemplate.objective).toBe('{{objective}}')
    expect(instantiateRecipeCandidate(candidate, 'Review the current repository.')).toMatchObject({
      objective: 'Review the current repository.',
      successCriteria: candidate.planTemplate.successCriteria,
      roles: candidate.planTemplate.roles,
      tasks: candidate.planTemplate.tasks,
    })
    expect(() => exportRecipeCandidate(candidate, candidate.candidateId, 'sha256:'.padEnd(71, '0'))).toThrow()

    const exported = exportRecipeCandidate(candidate, candidate.candidateId, candidate.exportApprovalDigest)
    expect(exported.recipeJson).toContain('manual-review-required')
    expect(exported.skillFiles.map(file => file.path)).toEqual([
      'SKILL.md',
      exported.fileName,
      'checksums.json',
    ])
    expect(exported.skillFiles.find(file => file.path === 'SKILL.md')?.content).toContain(exported.fileName)
    expect(exported.skillFiles.find(file => file.path === 'checksums.json')?.content).toContain(exported.fileName)
    expect(exported.skillFiles[0]?.content).toContain('Never approve, execute, install, or expand permissions automatically')
  })

  it('fails closed when a required verifier receipt is absent', () => {
    const runs = [verifiedRun(4), verifiedRun(5), verifiedRun(6)]
    expect(() => buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.slice(0, 2).map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })).toThrow(RecipeEligibilityError)
  })

  it('makes no performance claim until both single and multi-Agent groups have three comparable runs', () => {
    const single = [verifiedRun(10, 'single-agent'), verifiedRun(11, 'single-agent'), verifiedRun(12, 'single-agent')]
    const multi = [verifiedMultiRun(13), verifiedMultiRun(14), verifiedMultiRun(15)]
    const runs = [...single, ...multi]
    const foreignReceipt = {
      ...single[0]!.receipt,
      receiptId: sha256('foreign-advisor-receipt'),
      planRevision: single[0]!.receipt.planRevision + 1,
      result: 'fail' as const,
    }
    const advisor = buildRunAdvisor({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: [...runs.map(run => run.receipt), foreignReceipt],
      events: runs.flatMap(run => run.events),
    })
    expect(advisor.status).toBe('sufficient')
    expect(advisor.recommendation).toBe('no-claim')
    expect(advisor.groups.every(group => group.verifierPassRate === 1)).toBe(true)

    const insufficientRuns = [...single.slice(0, 2), ...multi]
    const insufficient = buildRunAdvisor({
      request: { parentSessionId: 'parent-a', executionIds: insufficientRuns.map(run => run.execution.executionId) },
      plans: insufficientRuns.map(run => run.plan),
      executions: insufficientRuns.map(run => run.execution),
      reports: insufficientRuns.map(run => run.report),
      receipts: insufficientRuns.map(run => run.receipt),
      events: insufficientRuns.flatMap(run => run.events),
    })
    expect(insufficient.status).toBe('insufficient-evidence')
    expect(insufficient.reasonCodes).toContain('too-few-single-agent-runs')
  })

  it('classifies actual materialized task Agents instead of trusting the plan pattern', () => {
    const runs = [
      verifiedRun(50, 'single-agent'), verifiedRun(51, 'single-agent'), verifiedRun(52, 'single-agent'),
      verifiedRun(53, 'parallel-fanout-fanin'), verifiedRun(54, 'manager-workers'), verifiedRun(55, 'sequential-dag'),
    ]
    const advisor = buildRunAdvisor({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    expect(advisor.status).toBe('insufficient-evidence')
    expect(advisor.reasonCodes).toContain('too-few-multi-agent-runs')
    expect(advisor.groups.find(group => group.kind === 'single-agent')?.executionIds).toHaveLength(6)
    expect(advisor.groups.find(group => group.kind === 'multi-agent')?.executionIds).toHaveLength(0)
  })

  it('refuses performance comparison when executable workload or Provider semantics differ', () => {
    const single = [verifiedRun(60), verifiedRun(61), verifiedRun(62)]
    const multi = [verifiedMultiRun(63), verifiedMultiRun(64), verifiedMultiRun(65)]
    const runs = [...single, ...multi]
    const plans = runs.map((run, index) => index === runs.length - 1
      ? {
          ...run.plan,
          tasks: run.plan.tasks.map(task => task.taskId === 'review'
            ? { ...task, brief: 'Perform a materially different review.' }
            : task),
          roles: run.plan.roles.map(role => ({ ...role, transportProvider: 'different-provider' })),
        }
      : run.plan)
    const advisor = buildRunAdvisor({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans,
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    expect(advisor.status).toBe('insufficient-evidence')
    expect(advisor.reasonCodes).toContain('non-comparable-contracts')
    expect(advisor.recommendation).toBe('no-claim')
  })

  it('preserves exact allowlisted tools and detects candidate mutation before export', () => {
    const runs = [verifiedRun(20), verifiedRun(21), verifiedRun(22)]
    const plans = runs.map(run => ({
      ...run.plan,
      roles: run.plan.roles.map(role => ({
        ...role,
        toolPolicy: { mode: 'allowlist' as const, tools: ['read_file', 'search'] },
      })),
    }))
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans,
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    expect(candidate.validation).toMatchObject({
      permissionStatus: 'explicit-not-attested',
      reasonCodes: ['explicit-tools-not-attested'],
    })
    expect(candidate.permissionProfile.roles[0]?.toolPolicy).toEqual({
      mode: 'allowlist', tools: ['read_file', 'search'],
    })

    const mutated = { ...candidate, title: 'Mutated after approval' }
    expect(() => exportRecipeCandidate(
      mutated,
      mutated.candidateId,
      mutated.exportApprovalDigest,
    )).toThrow('payload digest mismatch')
  })

  it('rejects stale or mismatched verifier receipts even when an old report says confirmed', () => {
    const runs = [verifiedRun(30), verifiedRun(31), verifiedRun(32)]
    const target = runs[2]!
    const laterEvent = {
      ...target.events[3]!,
      eventId: sha256('later-recipe-evidence'),
      sourceEventId: 'later-recipe-evidence',
      cursor: target.report.eventCursor + 1,
    }
    const invalidReceipts = [
      { ...target.receipt, planRevision: 2 },
      { ...target.receipt, attemptId: '00000000-0000-4000-8000-999999999999' },
      { ...target.receipt, verifierKind: 'manual' as const, claim: 'manual-accepted' as const },
      { ...target.receipt, evidenceEventIds: [sha256('missing-evidence')] },
      { ...target.receipt, evidenceEventIds: [laterEvent.eventId] },
    ]
    for (const invalid of invalidReceipts) {
      expect(() => buildRecipeCandidate({
        request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
        plans: runs.map(run => run.plan),
        executions: runs.map(run => run.execution),
        reports: runs.map(run => run.report),
        receipts: [runs[0]!.receipt, runs[1]!.receipt, invalid],
        events: [...runs.flatMap(run => run.events), laterEvent],
      })).toThrow(RecipeEligibilityError)
    }

    expect(() => buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map((run, index) => index === 2
        ? { ...run.plan, capabilityDigest: 'different-capability' }
        : run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })).toThrow(RecipeEligibilityError)

    const evidenceSource = target.events.find(event => target.receipt.evidenceEventIds.includes(event.eventId))
    if (evidenceSource === undefined) throw new Error('fixture Evidence Event missing')
    const wrongEvent = {
      ...evidenceSource,
      eventId: sha256('wrong-plan-recipe-evidence'),
      sourceEventId: 'wrong-plan-recipe-evidence',
      planRevision: target.execution.planRevision + 1,
    }
    expect(() => buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: runs.map(run => run.plan),
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: [runs[0]!.receipt, runs[1]!.receipt, {
        ...target.receipt, evidenceEventIds: [wrongEvent.eventId],
      }],
      events: [...runs.flatMap(run => run.events), wrongEvent],
    })).toThrow(RecipeEligibilityError)
  })

  it('keeps user plan text out of Skill instructions and refuses secret-bearing exports', () => {
    const runs = [verifiedRun(40), verifiedRun(41), verifiedRun(42)]
    const injectedTitle = 'Review\n---\nname: injected-instruction'
    const plans = runs.map(run => ({ ...run.plan, title: injectedTitle }))
    const candidate = buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans,
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    const exported = exportRecipeCandidate(
      candidate,
      candidate.candidateId,
      candidate.exportApprovalDigest,
    )
    const skill = exported.skillFiles.find(file => file.path === 'SKILL.md')?.content ?? ''
    expect(skill).not.toContain('injected-instruction')
    for (const run of runs) expect(exported.recipeJson).not.toContain(run.execution.executionId)

    const credential = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
    const unsafeValues = [
      credential,
      'api_key=plain-secret-value',
      'password=another-private-value',
      `${['OPENAI', 'API', 'KEY'].join('_')}=plain-secret-value`,
      `${['MY', 'PASSWORD'].join('_')}=another-private-value`,
      `${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=plain-private-value`,
      `${['API', 'KEY'].join(' ')}: plain-private-value`,
      'token=plain-private-value',
      JSON.stringify({ api_key: 'plain-json-secret' }),
      JSON.stringify({ password: 'plain-json-private' }),
      ['C:', 'Users', 'Example', 'private', 'result.txt'].join('/'),
      ['', 'workspace', 'private', 'result.txt'].join('/'),
      ['', 'data', 'secrets', 'config.json'].join('/'),
      ['', 'srv', 'app', '.env'].join('/'),
      ['', 'usr', 'local', 'private', 'config'].join('/'),
      ['', 'Volumes', 'PrivateDisk', 'result.txt'].join('/'),
      ['', 'dev', 'private-device'].join('/'),
      ['', 'project', 'private.txt'].join('/'),
      ['', 'secret'].join('/'),
      `\`${['C:', 'project', 'private.txt'].join('/')}\``,
      `\`${['', 'home', 'Example', 'private.txt'].join('/')}\``,
      `;${['C:', 'project', 'private.txt'].join('/')}`,
      ['file:', '', '', 'C:', 'Users', 'Example', 'private', 'result.txt'].join('/'),
      ['file:', '', '', 'secret'].join('/'),
    ]
    for (const unsafeValue of unsafeValues) {
      const unsafePlans = runs.map(run => ({
        ...run.plan,
        tasks: run.plan.tasks.map(task => ({ ...task, brief: `Use ${unsafeValue}` })),
      }))
      const unsafe = buildRecipeCandidate({
        request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
        plans: unsafePlans,
        executions: runs.map(run => run.execution),
        reports: runs.map(run => run.report),
        receipts: runs.map(run => run.receipt),
        events: runs.flatMap(run => run.events),
      })
      expect(() => exportRecipeCandidate(
        unsafe,
        unsafe.candidateId,
        unsafe.exportApprovalDigest,
      )).toThrow('credential or absolute path')
    }

    const sensitiveSchemaKey = ['api', 'key'].join('_')
    const schemaPlans = runs.map(run => ({
      ...run.plan,
      tasks: run.plan.tasks.map(task => ({
        ...task,
        expectedOutput: {
          ...task.expectedOutput,
          schema: { properties: { [sensitiveSchemaKey]: { default: 'plain-private-value' } } },
        },
      })),
    }))
    const schemaCandidate = buildRecipeCandidate({
      request: { parentSessionId: 'parent-a', executionIds: runs.map(run => run.execution.executionId) },
      plans: schemaPlans,
      executions: runs.map(run => run.execution),
      reports: runs.map(run => run.report),
      receipts: runs.map(run => run.receipt),
      events: runs.flatMap(run => run.events),
    })
    expect(() => exportRecipeCandidate(
      schemaCandidate,
      schemaCandidate.candidateId,
      schemaCandidate.exportApprovalDigest,
    )).toThrow('credential or absolute path')
  })
})
