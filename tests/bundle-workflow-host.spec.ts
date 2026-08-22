import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  HostConnectionRpc,
} from '@deepseek-ai/dsh-client-connection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import ProductSubagentConsoleService from '../src/index.js'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginPatchPath = join(packageDir, 'cordis.patch.yml')
const siblingDshRoot = resolve(packageDir, '..', 'deepseek-harness')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

interface WorkflowRow {
  readonly id: 'workflow-worker-thread'
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: { readonly provider?: string }
}

/** Read the one Workflow row from a Bundle patch without accepting unrelated YAML. */
function workflowRow(raw: string): WorkflowRow {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(line => /^\s*- id:\s*workflow-worker-thread\s*$/.test(line))
  if (start < 0) throw new Error('patch has no workflow-worker-thread row')
  const indent = /^\s*/.exec(lines[start] ?? '')?.[0] ?? ''
  const block: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (index > start && new RegExp(`^${indent.replaceAll(' ', '\\s')}- (?:id|insert):`).test(line)) break
    block.push(line)
  }
  const text = block.join('\n')
  const name = /^\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text)?.[1]
  const disabledText = /^\s*disabled:\s*(true|false)\s*$/m.exec(text)?.[1]
  const provider = /^\s*provider:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text)?.[1]
  return {
    id: 'workflow-worker-thread',
    ...(name === undefined ? {} : { name }),
    ...(disabledText === undefined ? {} : { disabled: disabledText === 'true' }),
    ...(provider === undefined ? {} : { config: { provider } }),
  }
}

/** The relevant id-target override semantics of DSH's public applyEntryPatches. */
function applyWorkflowPatch(current: WorkflowRow, patch: WorkflowRow): WorkflowRow {
  if (patch.name !== undefined && patch.name !== current.name) {
    throw new Error(`workflow row name mismatch: ${patch.name}`)
  }
  return {
    ...current,
    ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
    ...(patch.config === undefined ? {} : { config: patch.config }),
  }
}

const BASELINE_BASE_ROW = `
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn
`

const BASELINE_WEB_ROW = `
- id: workflow-worker-thread
  disabled: true
`

class FakeSystemPromptService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(_render: unknown): () => void { return () => {} }
  section(_section: unknown): () => void { return () => {} }
}

class FakeConnectionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  readonly rpc: HostConnectionRpc = {
    handle: (_channel, _handler: ConnectionRpcHandler) => async () => {},
    intercept: () => { throw new Error('not used by this fixture') },
  }
}

describe('Web Bundle Workflow Host-plane compatibility', () => {
  it('re-enables the DSH 0.1.1-rc.2 Web row with the spawn provider', () => {
    const plugin = workflowRow(readFileSync(pluginPatchPath, 'utf8'))
    const basePath = join(siblingDshRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')
    const webPath = join(siblingDshRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
    const base = workflowRow(existsSync(basePath) ? readFileSync(basePath, 'utf8') : BASELINE_BASE_ROW)
    const web = workflowRow(existsSync(webPath) ? readFileSync(webPath, 'utf8') : BASELINE_WEB_ROW)

    expect(plugin).toEqual({
      id: 'workflow-worker-thread',
      name: '@deepseek-ai/dsh-workflow-worker-thread',
      disabled: false,
      config: { provider: 'spawn' },
    })
    expect(applyWorkflowPatch(applyWorkflowPatch(base, web), plugin)).toEqual({
      id: 'workflow-worker-thread',
      name: '@deepseek-ai/dsh-workflow-worker-thread',
      disabled: false,
      config: { provider: 'spawn' },
    })
  })

  it('mounts the real worker engine where the plugin Host can discover it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(FakeSystemPromptService).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(SubagentRuntime).await()
    await ctx.plugin(FakeConnectionService).await()
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' }).await()
    await ctx.plugin(ProductSubagentConsoleService).await()

    expect(ctx.get('workflowEngine')).toBeInstanceOf(WorkerThreadWorkflowEngine)
    await expect(ctx.productSubagentConsole.executionCapabilities('fixture-parent'))
      .resolves.toMatchObject({ adapters: { workflow: true, agentTeam: false } })
  })
})
