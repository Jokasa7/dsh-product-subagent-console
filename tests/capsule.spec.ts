import { describe, expect, it } from 'vitest'
import { buildRunCapsule, CapsuleIntegrityError, verifyRunCapsuleManifest } from '../src/capsule.js'
import { sha256 } from '../src/conformance.js'
import { projectPlanContractV2 } from '../src/foundry-types.js'
import { buildRecoveryProposal } from '../src/recovery.js'
import { verifiedRun } from './foundry-fixtures.js'

describe('Run Capsule', () => {
  it('is deterministic, offline, and redacted by default', () => {
    const source = verifiedRun(1)
    const plan = {
      ...source.plan,
      objective: 'SECRET objective that must stay out of the default Capsule.',
      tasks: source.plan.tasks.map(task => ({ ...task, brief: 'SECRET task brief' })),
    }
    const input = {
      request: {
        parentSessionId: 'parent-a',
        runId: source.execution.executionId,
        includeObjective: false,
        includeTaskBriefs: false,
      },
      plan,
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [source.receipt],
      projectionDigest: sha256('projection'),
      generatorVersion: '0.9.0',
    } as const
    const first = buildRunCapsule(input)
    const second = buildRunCapsule(input)
    expect(first).toEqual(second)
    expect(first.manifest.plan.objective).toBeUndefined()
    expect(first.manifest.plan.tasks[0]?.brief).toBeUndefined()
    expect(first.html).toContain('Content-Security-Policy')
    expect(first.html).not.toMatch(/https?:\/\//u)
    expect(first.html).not.toContain('SECRET')
  })

  it('escapes malicious titles, briefs, and manifest JSON', () => {
    const source = verifiedRun(2)
    const plan = {
      ...source.plan,
      title: '</script><img src=x onerror=alert(1)>',
      tasks: source.plan.tasks.map(task => ({ ...task, brief: '</script><script>alert(1)</script>' })),
    }
    const result = buildRunCapsule({
      request: {
        parentSessionId: 'parent-a', runId: source.execution.executionId,
        includeObjective: true, includeTaskBriefs: true,
      },
      plan,
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [source.receipt],
      projectionDigest: sha256('projection-two'),
      generatorVersion: '0.9.0',
    })
    expect(result.html).not.toContain('<script>')
    expect(result.html).not.toContain('<img')
    expect(result.html).toContain(String.raw`\u003c/script`)
  })

  it('pseudonymizes identities and removes credentials, paths, source ids, and artifact labels', () => {
    const source = verifiedRun(3)
    const credential = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
    const absolutePath = ['C:', 'Users', 'Example', 'private', 'result.txt'].join('\\')
    const slashPath = ['C:', 'Users', 'Example', 'private', 'result.txt'].join('/')
    const posixPath = ['', 'workspace', 'private', 'result.txt'].join('/')
    const namedSecret = 'password=plain-private-value'
    const prefixedApiKey = `${['OPENAI', 'API', 'KEY'].join('_')}=plain-private-value`
    const prefixedPassword = `${['MY', 'PASSWORD'].join('_')}=plain-private-value`
    const volumesPath = ['', 'Volumes', 'PrivateDisk', 'result.txt'].join('/')
    const devicePath = ['', 'dev', 'private-device'].join('/')
    const genericPath = ['', 'project', 'private.txt'].join('/')
    const markdownWindowsPath = `\`${['C:', 'project', 'private.txt'].join('/')}\``
    const markdownPosixPath = `\`${['', 'home', 'Example', 'private.txt'].join('/')}\``
    const jsonSecret = JSON.stringify({ api_key: 'plain-json-secret' })
    const awsSecret = `${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=plain-private-value`
    const spacedApiKey = `${['API', 'KEY'].join(' ')}: plain-private-value`
    const genericToken = 'token=plain-private-value'
    const rootPath = ['', 'secret'].join('/')
    const rootFileUrl = ['file:', '', '', 'secret'].join('/')
    const childId = 'private-child-id'
    const execution = {
      ...source.execution,
      bindings: source.execution.bindings.map(binding => ({ ...binding, childId })),
    }
    const plan = {
      ...source.plan,
      title: `Audit api_key=${credential} ${absolutePath} ${slashPath}`,
      objective: `Inspect ${absolutePath}, ${posixPath}, ${volumesPath}, ${devicePath}, ${genericPath}, ${rootPath}, ${rootFileUrl}, ${markdownWindowsPath}, and ${markdownPosixPath}`,
      roles: source.plan.roles.map(role => ({
        ...role,
        name: `Reviewer token=${credential}`,
        responsibility: `Never expose ${absolutePath}, ${namedSecret}, ${prefixedApiKey}, ${awsSecret}, ${spacedApiKey}, ${genericToken}, or ${jsonSecret}`,
        boundaries: [`credential=${credential}`, slashPath, prefixedPassword],
        toolPolicy: { mode: 'allowlist' as const, tools: [absolutePath, 'read_file'] },
      })),
      tasks: source.plan.tasks.map(task => ({
        ...task,
        brief: `Read ${absolutePath} with password=${credential}`,
        completionCriteria: [`Do not reveal ${credential}`],
        resourceClaims: [absolutePath],
      })),
    }
    const events = source.events.map(event => ({
      ...event,
      sourceEventId: `private-source-${credential}`,
      artifacts: [{
        artifactId: 'private-artifact-id',
        kind: 'report' as const,
        digest: sha256('private artifact'),
        label: absolutePath,
        producerTaskId: source.plan.tasks[0]!.taskId,
      }],
    }))
    const receipts = [{
      ...source.receipt,
      verifierVersion: `token=${credential}`,
      artifacts: events[0]!.artifacts,
    }]

    const result = buildRunCapsule({
      request: {
        parentSessionId: source.execution.parentSessionId,
        runId: source.execution.executionId,
        includeObjective: true,
        includeTaskBriefs: true,
      },
      plan,
      execution,
      report: source.report,
      events,
      receipts,
      projectionDigest: sha256('private projection'),
      generatorVersion: '0.9.0',
    })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(source.execution.parentSessionId)
    expect(serialized).not.toContain(source.execution.executionId)
    expect(serialized).not.toContain(source.execution.planId)
    expect(serialized).not.toContain(childId)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain(absolutePath)
    expect(serialized).not.toContain(slashPath)
    expect(serialized).not.toContain(posixPath)
    expect(serialized).not.toContain(namedSecret)
    expect(serialized).not.toContain(prefixedApiKey)
    expect(serialized).not.toContain(prefixedPassword)
    expect(serialized).not.toContain(volumesPath)
    expect(serialized).not.toContain(devicePath)
    expect(serialized).not.toContain(genericPath)
    expect(serialized).not.toContain(markdownWindowsPath)
    expect(serialized).not.toContain(markdownPosixPath)
    expect(serialized).not.toContain('plain-json-secret')
    expect(serialized).not.toContain(awsSecret)
    expect(serialized).not.toContain(spacedApiKey)
    expect(serialized).not.toContain(genericToken)
    expect(serialized).not.toContain(rootPath)
    expect(serialized).not.toContain(rootFileUrl)
    expect(serialized).not.toContain('private-source-')
    expect(serialized).not.toContain('private-artifact-id')
    expect(serialized).toContain('[redacted credential]')
    expect(serialized).toContain('[redacted path]')
  })

  it('turns a 50k-event run into a deterministic bounded evidence-closed Capsule', () => {
    const source = verifiedRun(4)
    const terminalCursor = 50_000
    const boundaryEvents = source.events.map((event, index) => ({
      ...event,
      cursor: index === 0 ? 1 : terminalCursor - (source.events.length - 1 - index),
    }))
    const extraEvents = Array.from({ length: 50_000 - source.events.length }, (_, index) => {
      const cursor = index + 2
      const sourceEventId = `${source.execution.executionId}:high-volume:${String(cursor)}`
      return {
        ...source.events[1]!,
        cursor,
        sourceEventId,
        eventId: sha256(sourceEventId),
        observedAt: cursor,
        type: 'attempt-started' as const,
        taskId: 'review',
        attemptId: source.execution.bindings[0]!.attemptId,
        attemptStatus: 'running' as const,
      }
    })
    const events = [boundaryEvents[0]!, ...extraEvents, ...boundaryEvents.slice(1)]
    const input = {
      request: {
        parentSessionId: 'parent-a',
        runId: source.execution.executionId,
        includeObjective: false,
        includeTaskBriefs: false,
      },
      plan: source.plan,
      execution: source.execution,
      report: { ...source.report, eventCursor: terminalCursor },
      events,
      receipts: [source.receipt],
      projectionDigest: sha256('50k projection'),
      generatorVersion: '0.9.0',
    } as const

    const result = buildRunCapsule(input)
    const reversed = buildRunCapsule({ ...input, events: [...events].reverse() })
    expect(result).toEqual(reversed)
    expect(result.manifest.events.length).toBeLessThanOrEqual(500)
    expect(result.manifest.policy.limits).toMatchObject({
      sourceEvents: 50_000,
      exportedEvents: result.manifest.events.length,
      truncated: true,
    })
    expect(new TextEncoder().encode(result.html).byteLength).toBeLessThan(8 * 1024 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(result.manifest)).byteLength).toBeLessThanOrEqual(1_310_720)
    expect(verifyRunCapsuleManifest(result.manifest)).toBe(true)

    const eventIds = new Set(result.manifest.events.map(event => event.eventId))
    for (const receipt of result.manifest.receipts) {
      expect(receipt.evidenceEventIds.every(eventId => eventIds.has(eventId))).toBe(true)
    }
    for (const finding of result.manifest.report.findings) {
      expect(finding.evidenceEventIds.every(eventId => eventIds.has(eventId))).toBe(true)
    }
  })

  it('reserves the final source Event when evidence alone could fill the export budget', () => {
    const source = verifiedRun(5)
    const attemptId = source.execution.bindings[0]!.attemptId
    const evidenceEvents = Array.from({ length: 500 }, (_value, index) => {
      const cursor = index + 1
      const sourceEventId = `${source.execution.executionId}:evidence:${String(cursor)}`
      return {
        ...source.events[2]!,
        cursor,
        sourceEventId,
        eventId: sha256(sourceEventId),
        observedAt: cursor,
        taskId: 'review',
        attemptId,
      }
    })
    const terminal = {
      ...source.events.at(-1)!,
      cursor: 501,
      sourceEventId: `${source.execution.executionId}:terminal:501`,
      eventId: sha256(`${source.execution.executionId}:terminal:501`),
      observedAt: 501,
    }
    const receipts = Array.from({ length: 100 }, (_value, index) => ({
      ...source.receipt,
      receiptId: sha256(`${source.execution.executionId}:receipt:${String(index)}`),
      observedAt: index,
      evidenceEventIds: evidenceEvents.slice(index * 5, index * 5 + 5).map(event => event.eventId),
    }))
    const result = buildRunCapsule({
      request: {
        parentSessionId: 'parent-a', runId: source.execution.executionId,
        includeObjective: false, includeTaskBriefs: false,
      },
      plan: source.plan,
      execution: source.execution,
      report: { ...source.report, eventCursor: terminal.cursor },
      events: [...evidenceEvents, terminal],
      receipts,
      projectionDigest: sha256('full evidence budget'),
      generatorVersion: '0.9.0',
    })
    expect(result.manifest.events).toHaveLength(496)
    expect(result.manifest.receipts).toHaveLength(99)
    expect(result.manifest.events.at(-1)?.cursor).toBe(terminal.cursor)
    expect(result.manifest.run.eventCursor).toBe(terminal.cursor)
    expect(verifyRunCapsuleManifest(result.manifest)).toBe(true)
  })

  it('rejects source receipts whose Evidence Event is unavailable', () => {
    const source = verifiedRun(6)
    expect(() => buildRunCapsule({
      request: {
        parentSessionId: 'parent-a',
        runId: source.execution.executionId,
        includeObjective: false,
        includeTaskBriefs: false,
      },
      plan: source.plan,
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [{ ...source.receipt, evidenceEventIds: [sha256('missing-event')] }],
      projectionDigest: sha256('dangling projection'),
      generatorVersion: '0.9.0',
    })).toThrow(CapsuleIntegrityError)
  })

  it('fails closed when verifying malformed or mutated manifests', () => {
    const source = verifiedRun(7)
    const artifacts = Array.from({ length: 5 }, (_value, index) => ({
      artifactId: `source-artifact-${String(index)}`,
      kind: 'report' as const,
      digest: sha256(`source-artifact-content-${String(index)}`),
    }))
    const result = buildRunCapsule({
      request: {
        parentSessionId: 'parent-a', runId: source.execution.executionId,
        includeObjective: false, includeTaskBriefs: false,
      },
      plan: source.plan,
      execution: source.execution,
      report: source.report,
      events: source.events.map((event, index) => index === 0 ? { ...event, artifacts } : event),
      receipts: [source.receipt],
      projectionDigest: sha256('verification projection'),
      generatorVersion: '0.9.0',
    })

    expect(verifyRunCapsuleManifest(result.manifest)).toBe(true)
    expect(result.manifest.policy.limits).toMatchObject({
      sourceArtifacts: 5,
      exportedArtifacts: 4,
      truncated: true,
    })
    expect(verifyRunCapsuleManifest(null)).toBe(false)
    expect(verifyRunCapsuleManifest({ manifestDigest: sha256('{}') })).toBe(false)
    expect(verifyRunCapsuleManifest({
      ...result.manifest,
      run: { ...result.manifest.run, planRevision: result.manifest.run.planRevision + 1 },
    })).toBe(false)

    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: {
        ...result.manifest.policy,
        limits: { ...result.manifest.policy.limits, maxEvents: 501 },
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      events: result.manifest.events.map((event, index) => index === 0
        ? {
            ...event,
            artifacts: Array.from({ length: 5 }, (_value, artifactIndex) => ({
              artifactId: sha256(`artifact-${String(artifactIndex)}`),
              kind: 'report' as const,
              digest: sha256(`artifact-content-${String(artifactIndex)}`),
            })),
          }
        : event),
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: {
        ...result.manifest.policy,
        limits: { ...result.manifest.policy.limits, sourceEvents: 0 },
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: {
        ...result.manifest.policy,
        limits: {
          ...result.manifest.policy.limits,
          sourceEvents: result.manifest.policy.limits.exportedEvents + 1,
          truncated: false,
        },
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: {
        ...result.manifest.policy,
        limits: {
          ...result.manifest.policy.limits,
          exportedArtifacts: result.manifest.policy.limits.exportedArtifacts - 1,
        },
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: { ...result.manifest.policy, includeObjective: true },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      policy: {
        ...result.manifest.policy,
        redactedFields: result.manifest.policy.redactedFields.slice(1),
      },
    }))).toBe(false)
    const evidenceEventId = result.manifest.receipts[0]?.evidenceEventIds[0]
    expect(evidenceEventId).toBeDefined()
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      events: result.manifest.events.map(event => event.eventId === evidenceEventId
        ? { ...event, attemptId: sha256('foreign-attempt') }
        : event),
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      plan: { ...result.manifest.plan, roles: [] },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      plan: { ...result.manifest.plan, tasks: [] },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      report: { ...result.manifest.report, tasks: [] },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      report: {
        ...result.manifest.report,
        tasks: [result.manifest.report.tasks[0]!, result.manifest.report.tasks[0]!],
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      events: result.manifest.events.map((event, index) => index === 1
        ? { ...event, cursor: result.manifest.events[0]!.cursor }
        : event),
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      plan: {
        ...result.manifest.plan,
        roles: result.manifest.plan.roles.map(role => ({
          ...role,
          toolPolicy: { mode: 'inherit' as const, tools: [sha256('unexpected-tool')] },
        })),
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      plan: {
        ...result.manifest.plan,
        tasks: result.manifest.plan.tasks.map(task => ({
          ...task,
          dependencies: [{ taskId: task.taskId, mode: 'context' as const }],
        })),
      },
    }))).toBe(false)
    expect(verifyRunCapsuleManifest(rehashManifest({
      ...result.manifest,
      execution: {
        ...result.manifest.execution,
        bindings: [
          result.manifest.execution.bindings[0]!,
          { ...result.manifest.execution.bindings[0]!, attemptId: sha256('duplicate-attempt-number') },
        ],
      },
    }))).toBe(false)
  })

  it('rejects mismatched report and recovery identities', () => {
    const source = verifiedRun(8)
    const base = {
      request: {
        parentSessionId: 'parent-a', runId: source.execution.executionId,
        includeObjective: false, includeTaskBriefs: false,
      },
      plan: source.plan,
      execution: source.execution,
      report: source.report,
      events: source.events,
      receipts: [source.receipt],
      projectionDigest: sha256('identity projection'),
      generatorVersion: '0.9.0',
    } as const
    expect(() => buildRunCapsule({
      ...base,
      report: { ...source.report, parentSessionId: 'another-session' },
    })).toThrow('same execution')
    expect(() => buildRunCapsule({
      ...base,
      report: {
        ...source.report,
        findings: [{
          schemaVersion: 1,
          findingId: sha256('foreign-finding'),
          code: 'lifecycle-incomplete',
          status: 'open',
          severity: 'warning',
          certainty: 'proven',
          parentSessionId: 'another-session',
          runId: source.execution.executionId,
          planId: source.execution.planId,
          planRevision: source.execution.planRevision,
          taskId: 'review',
          firstObservedAt: source.execution.finishedAt ?? source.execution.createdAt,
          evidenceEventIds: [],
        }],
      },
    })).toThrow('same execution')
    expect(() => buildRunCapsule({
      ...base,
      receipts: [{ ...source.receipt, planRevision: source.receipt.planRevision + 1 }],
    })).toThrow(CapsuleIntegrityError)
    expect(() => buildRunCapsule({
      ...base,
      plan: { ...source.plan, capabilityDigest: 'different-capability' },
    })).toThrow('same execution')
    expect(() => buildRunCapsule({
      ...base,
      report: { ...source.report, eventCursor: Math.max(0, source.report.eventCursor - 1) },
    })).toThrow(CapsuleIntegrityError)
    const evidenceId = source.receipt.evidenceEventIds[0]
    expect(() => buildRunCapsule({
      ...base,
      events: source.events.map(event => event.eventId === evidenceId
        ? { ...event, taskId: 'foreign-task' }
        : event),
    })).toThrow(CapsuleIntegrityError)

    const proposal = buildRecoveryProposal({
      contract: projectPlanContractV2(source.plan),
      execution: source.execution,
      report: source.report,
      capabilityDigest: source.execution.capabilityDigest,
      now: 10_000,
    })
    expect(() => buildRunCapsule({
      ...base,
      proposal: { ...proposal, eventCursor: proposal.eventCursor + 1 },
    })).toThrow('same execution')
    expect(() => buildRunCapsule({
      ...base,
      proposal: { ...proposal, capabilityDigest: 'different-capability' },
    })).toThrow('same execution')
  })
})

function rehashManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { manifestDigest: _manifestDigest, ...withoutDigest } = manifest
  return { ...withoutDigest, manifestDigest: sha256(JSON.stringify(withoutDigest)) }
}
