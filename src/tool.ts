import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth,
  settleRun,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './index.js'

export const name = 'product-subagent-console-tool'
export const inject = ['tools', 'subagents', 'productSubagentConsole']

/** One model-visible, precisely correlated delegation tool instance. */
export interface Config {
  /** Official `ctx.subagents` provider registry name. */
  provider: string
  /** Unique model-visible tool name. Default: `board_subagent`. */
  toolName?: string
  /** Optional product family used only as display metadata. */
  product?: string
  /** Optional human-readable product name used only as display metadata. */
  displayName?: string
  /** Optional named-instance label used only as display metadata. */
  instance?: string
  /** Whether the model may submit a one-shot background Job. Default: true. */
  enableRunInBackground?: boolean
  /** Numeric child depth cap or provider-owned depth policy. Default: `provider-managed`. */
  maxDepth?: number | 'provider-managed'
}

export const Config: schema<Config> = schema.object({
  provider: schema.string().required(),
  toolName: schema.string().default('board_subagent'),
  product: schema.string(),
  displayName: schema.string(),
  instance: schema.string(),
  enableRunInBackground: schema.boolean().default(true),
  maxDepth: schema.union([
    schema.natural().max(Number.MAX_SAFE_INTEGER),
    schema.const('provider-managed' as const),
  ]).default('provider-managed'),
})

function outputText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } => (
      typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && value.type === 'text'
      && typeof value.text === 'string'
    ))
    .map(value => value.text)
    .join('')
}

function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function providerWording(inheritsConversation: boolean): {
  readonly description: string
  readonly promptDescription: string
} {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a focused task to a child that inherits this conversation\'s completed turns. '
        + 'It does not see the current in-flight turn and returns only its result.',
      promptDescription:
        'The task for the subagent. It already sees completed turns, so state only the new work and constraints.',
    }
  }
  return {
    description:
      'Delegate a focused task to a separate subagent context. Give it a complete standalone prompt; '
      + 'it does not see this conversation and returns only its result.',
    promptDescription:
      'The complete self-contained task for the subagent, including every fact and constraint it needs.',
  }
}

async function settleForeground(run: SubagentRun): Promise<{
  readonly kind: 'foreground'
  readonly childId: string
  readonly output: JsonValue[]
}> {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], 'subagent execution and disposal failed')
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  const failure = stopReasonError(execution.value)
  if (failure !== undefined) throw new Error(failure)
  return {
    kind: 'foreground',
    childId: String(run.id),
    output: execution.value.output as unknown as JsonValue[],
  }
}

async function settleBackground(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** Register one exact provider-bound delegation tool when its Provider is available. */
export function apply(ctx: Context, config: Config): void {
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const toolName = config.toolName ?? 'board_subagent'
  const backgroundEnabled = config.enableRunInBackground !== false
  let disposeTool: (() => void) | undefined

  const mount = (provider: SubagentProvider): void => {
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `product-subagent-console/tool: provider "${provider.name}" cannot enforce maxDepth; `
        + "set maxDepth: 'provider-managed'",
      )
    }
    const wording = providerWording(provider.inheritsParentContext)
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        `${wording.description} The task canvas records its real startup and published lifecycle. `
        + (backgroundEnabled
          ? 'Wait for the result by default; set run_in_background to submit a Job and continue.'
          : 'This call waits for the result.'),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short 3-5 word task label shown on the task canvas.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean' as const,
            description: 'Submit a background Job instead of waiting. Defaults to false.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                childId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `submitted background subagent job ${value.jobId}`
            : outputText(value.output),
        }],
      },
      presentCall: args => ({
        card: 'generic',
        title: args.run_in_background === true ? `Submit ${toolName}` : toolName,
        kind: 'other',
        rawInput: args.description,
      }),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!backgroundEnabled && args.run_in_background === true) {
          throw new Error('run_in_background is disabled for this tool instance')
        }
        const parent = exec.agent
        if (parent === undefined) throw new Error('owned subagent tool requires a calling agent')
        const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...maxDepth === undefined ? {} : { maxDepth },
        }
        const start = (signal: AbortSignal): Promise<SubagentRun> => (
          ctx.productSubagentConsole.startOwned({
            parentSessionId: String(parent.id),
            callId: String(exec.callId),
            toolName: exec.name,
            providerName: config.provider,
            label: args.description,
            signal,
            ...config.product === undefined ? {} : { product: config.product },
            ...config.displayName === undefined ? {} : { displayName: config.displayName },
            ...config.instance === undefined ? {} : { instance: config.instance },
          }, ownedSignal => ctx.subagents.start(config.provider, { ...request, signal: ownedSignal }))
        )

        if (backgroundEnabled && args.run_in_background === true) {
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: install the DSH Jobs runtime and tool')
          }
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const started = start(controller.signal)
              return {
                cancel: reason => { controller.abort(reason ?? 'background subagent job killed') },
                done: settleBackground(started, controller.signal),
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
        }

        return settleForeground(await start(exec.signal))
      },
    }))
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (providerName !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    ctx.logger.info(
      `subagent provider "${config.provider}" is not registered yet; `
      + `the "${toolName}" tool will appear when it is available`,
    )
  } else {
    mount(provider)
  }
}
