/** Conversation-level task canvas merging native child sessions and observed external runs. */
import type {
  ClientContext, ISessions, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  agentPlanContentSchema,
  agentPlanRevisionSchema,
  APPROVE_PLAN_ENDPOINT,
  approvePlanRequestSchema,
  CANCEL_PLAN_EXECUTION_ENDPOINT,
  cancelPlanExecutionRequestSchema,
  cancelPlanExecutionResultSchema,
  EXECUTION_CAPABILITIES_ENDPOINT,
  executionCapabilitiesRequestSchema,
  executionCapabilitySnapshotSchema,
  LIST_PLAN_EXECUTIONS_ENDPOINT,
  listPlanExecutionsRequestSchema,
  LIST_PLANS_ENDPOINT,
  listPlansRequestSchema,
  planExecutionRepositorySnapshotSchema,
  planPreflightResultSchema,
  planRepositorySnapshotSchema,
  planRevisionRequestSchema,
  PREFLIGHT_PLAN_ENDPOINT,
  SAVE_PLAN_ENDPOINT,
  savePlanRequestSchema,
  WATCH_PLANS_ENDPOINT,
  WATCH_PLAN_EXECUTIONS_ENDPOINT,
  watchPlanExecutionsRequestSchema,
  watchPlansRequestSchema,
  type CancelPlanExecutionRequest,
  type CancelPlanExecutionResult,
  type ExecutionCapabilitySnapshot,
  type PlanExecutionRepositorySnapshot,
  type PlanRevisionRequest,
} from '../plan-types.js'
import {
  consoleSnapshotSchema,
  LIST_SESSIONS_ENDPOINT,
  PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
  WATCH_SESSIONS_ENDPOINT,
} from '../types.js'
import { SubagentWorkbenchView, type SubagentWorkbenchInjected } from './SubagentWorkbenchView.js'
import type { AgentPlanWorkbenchInjected } from './AgentPlanWorkbench.js'
import { en, NS, zh, type ProductSubagentsLocaleKey } from './locales.js'

export type { SubagentWorkbenchInjected, SubagentWorkbenchProps } from './SubagentWorkbenchView.js'
export type { ProductSubagentsLocaleKey } from './locales.js'
export type { WorkbenchNode } from './workbench-model.js'

/** Planner and execution actions supplied by the browser entry. */
export interface PlannerWorkbenchInjected extends AgentPlanWorkbenchInjected {
  readonly getExecutionCapabilities: (
    parentSessionId: SessionId,
    signal: AbortSignal,
  ) => Promise<ExecutionCapabilitySnapshot>
  readonly listPlanExecutions: (
    parentSessionIds: readonly SessionId[],
    signal: AbortSignal,
  ) => Promise<PlanExecutionRepositorySnapshot>
  readonly watchPlanExecutions: (
    parentSessionIds: readonly SessionId[],
    hostInstanceId: string | undefined,
    afterRevision: number,
    signal: AbortSignal,
  ) => Promise<PlanExecutionRepositorySnapshot>
  readonly cancelPlanExecution: (
    request: CancelPlanExecutionRequest,
    signal: AbortSignal,
  ) => Promise<CancelPlanExecutionResult>
  /** Queue a visible user turn asking the current conversation Agent to execute one approved revision. */
  readonly requestPlanExecution: (
    parentSessionId: SessionId,
    request: PlanRevisionRequest,
    signal: AbortSignal,
  ) => Promise<void>
}

/** Complete browser-injected surface for the runtime and planner workbench modes. */
export type ProductSubagentWorkbenchInjected = SubagentWorkbenchInjected & PlannerWorkbenchInjected

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    productSubagents: ProductSubagentsLocaleKey
  }
}

export const inject = ['slots', 'locale', 'connection', 'sessions']

/** Register the third conversation tab and its one batched loopback RPC reader. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const sessions = ctx.get('sessions') as unknown as ISessions
  const callPlanner = async (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const result = await connection.rpc.call(
      PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
      endpoint,
      payload,
      signal,
    )
    if (!result.ok) throw new Error(`product-subagent-console RPC failed: ${result.error.code}`)
    return result.value
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-product-subagent-console: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'subagents',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (sessionId: SessionId): ProductSubagentWorkbenchInjected => ({
      async listSessions(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        const result = await connection.rpc.call(
          PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
          LIST_SESSIONS_ENDPOINT,
          { parentSessionIds: parentSessionIds.map(String) },
          signal,
        )
        if (!result.ok) throw new Error(`product-subagent-console RPC failed: ${result.error.code}`)
        return consoleSnapshotSchema.parse(result.value)
      },
      async listPlans(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        const request = listPlansRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
        })
        const value = await callPlanner(LIST_PLANS_ENDPOINT, request, signal)
        return planRepositorySnapshotSchema.parse(value)
      },
      async watchPlans(
        parentSessionIds: readonly SessionId[],
        hostInstanceId: string,
        afterRevision: number,
        signal: AbortSignal,
      ) {
        const request = watchPlansRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
          hostInstanceId,
          afterRevision,
          timeoutMs: 25_000,
        })
        const value = await callPlanner(WATCH_PLANS_ENDPOINT, request, signal)
        return planRepositorySnapshotSchema.parse(value)
      },
      async savePlan(input, signal: AbortSignal) {
        const request = savePlanRequestSchema.parse(input)
        const value = await callPlanner(SAVE_PLAN_ENDPOINT, request, signal)
        return agentPlanRevisionSchema.parse(value)
      },
      async getExecutionCapabilities(parentSessionId: SessionId, signal: AbortSignal) {
        const request = executionCapabilitiesRequestSchema.parse({
          parentSessionId: String(parentSessionId),
        })
        const value = await callPlanner(EXECUTION_CAPABILITIES_ENDPOINT, request, signal)
        return executionCapabilitySnapshotSchema.parse(value)
      },
      async preflightPlan(input, signal: AbortSignal) {
        const request = planRevisionRequestSchema.parse(input)
        const value = await callPlanner(PREFLIGHT_PLAN_ENDPOINT, request, signal)
        return planPreflightResultSchema.parse(value)
      },
      async approvePlan(input, signal: AbortSignal) {
        const request = approvePlanRequestSchema.parse(input)
        const value = await callPlanner(APPROVE_PLAN_ENDPOINT, request, signal)
        return agentPlanRevisionSchema.parse(value)
      },
      async requestPlanDesign(
        parentSessionId: SessionId,
        objective: string,
        signal: AbortSignal,
      ) {
        if (parentSessionId !== sessionId) {
          throw new Error('product-subagent-console: plan owner does not match current session')
        }
        const normalizedObjective = agentPlanContentSchema.shape.objective.parse(objective)
        const capabilityRequest = executionCapabilitiesRequestSchema.parse({
          parentSessionId: String(sessionId),
        })
        const capabilityValue = await callPlanner(
          EXECUTION_CAPABILITIES_ENDPOINT,
          capabilityRequest,
          signal,
        )
        const capabilities = executionCapabilitySnapshotSchema.parse(capabilityValue)
        if (capabilities.scopeStatus === 'available' && !capabilities.tools.includes('design_subagent_plan')) {
          throw new Error('product-subagent-console: design_subagent_plan is unavailable in the current Agent scope')
        }
        const binding = sessions.binding(sessionId)
        if (binding === undefined) {
          throw new Error('product-subagent-console: current session is unavailable')
        }
        const result = await binding.session.prompt([{
          type: 'text',
          text: [
            '请为以下目标设计一个可执行的多 Agent 方案，并调用 design_subagent_plan 工具将方案保存为草稿。',
            '这一步只生成和保存方案，不要启动任何子代理。',
            '只能使用下面列出的当前能力；不要假设未列出的 Provider、模型、工具或执行后端存在。',
            `Workflow 后端：${capabilities.adapters.workflow ? '可用' : '不可用'}；Agent Teams 后端：不可执行。`,
            `Transport Provider：${capabilities.transportProviders.map(provider => (
              `${provider.name}(context=${provider.inheritsParentContext ? 'fork' : 'fresh'},modelRouting=${provider.modelRouting})`
            )).join(', ') || '无'}`,
            `预算上限：最多 ${String(capabilities.limits.maxAgents)} 个 Agent，最大并发 ${String(capabilities.limits.maxConcurrent)}。`,
            'Workflow 方案必须只使用一个 Transport Provider、继承工具（toolPolicy.mode=inherit），且不要填写 Agent Preset。',
            '仅当所选 Transport Provider 的 modelRouting=enforced 时才填写 llmProvider 或 model。',
            '',
            `目标：${normalizedObjective}`,
          ].join('\n'),
        }], 'queue', signal)
        if (!result.ok) {
          throw new Error(`product-subagent-console prompt failed: ${result.error.code}`)
        }
      },
      async listPlanExecutions(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        const request = listPlanExecutionsRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
        })
        const value = await callPlanner(LIST_PLAN_EXECUTIONS_ENDPOINT, request, signal)
        return planExecutionRepositorySnapshotSchema.parse(value)
      },
      async watchPlanExecutions(
        parentSessionIds: readonly SessionId[],
        hostInstanceId: string | undefined,
        afterRevision: number,
        signal: AbortSignal,
      ) {
        const request = watchPlanExecutionsRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
          ...(hostInstanceId === undefined ? {} : { hostInstanceId }),
          afterRevision,
          timeoutMs: 25_000,
        })
        const value = await callPlanner(WATCH_PLAN_EXECUTIONS_ENDPOINT, request, signal)
        return planExecutionRepositorySnapshotSchema.parse(value)
      },
      async cancelPlanExecution(input, signal: AbortSignal) {
        const request = cancelPlanExecutionRequestSchema.parse(input)
        const value = await callPlanner(CANCEL_PLAN_EXECUTION_ENDPOINT, request, signal)
        return cancelPlanExecutionResultSchema.parse(value)
      },
      async requestPlanExecution(
        parentSessionId: SessionId,
        input: PlanRevisionRequest,
        signal: AbortSignal,
      ) {
        if (parentSessionId !== sessionId) {
          throw new Error('product-subagent-console: execution owner does not match current session')
        }
        const request = planRevisionRequestSchema.parse(input)
        if (request.parentSessionId !== String(sessionId)) {
          throw new Error('product-subagent-console: execution request does not belong to current session')
        }
        const capabilityRequest = executionCapabilitiesRequestSchema.parse({
          parentSessionId: String(sessionId),
        })
        const capabilityValue = await callPlanner(
          EXECUTION_CAPABILITIES_ENDPOINT,
          capabilityRequest,
          signal,
        )
        const capabilities = executionCapabilitySnapshotSchema.parse(capabilityValue)
        if (!capabilities.adapters.workflow) {
          throw new Error('product-subagent-console: Workflow execution is unavailable')
        }
        if (capabilities.scopeStatus === 'available' && !capabilities.tools.includes('execute_subagent_plan')) {
          throw new Error('product-subagent-console: execute_subagent_plan is unavailable in the current Agent scope')
        }
        const binding = sessions.binding(sessionId)
        if (binding === undefined) {
          throw new Error('product-subagent-console: current session is unavailable')
        }
        const result = await binding.session.prompt([{
          type: 'text',
          text: [
            '请执行我已在 Agent 方案设计器中批准的精确修订。',
            `请调用 execute_subagent_plan，参数 plan_id=${request.planId}、revision=${String(request.revision)}。`,
            '不要改写方案，不要改用其他修订；如果预检或能力已变化，请报告阻塞原因。',
          ].join('\n'),
        }], 'queue', signal)
        if (!result.ok) {
          throw new Error(`product-subagent-console prompt failed: ${result.error.code}`)
        }
      },
      async watchSessions(
        parentSessionIds: readonly SessionId[],
        hostInstanceId: string,
        afterRevision: number,
        signal: AbortSignal,
      ) {
        const result = await connection.rpc.call(
          PRODUCT_SUBAGENT_CONSOLE_CHANNEL,
          WATCH_SESSIONS_ENDPOINT,
          {
            parentSessionIds: parentSessionIds.map(String),
            hostInstanceId,
            afterRevision,
            timeoutMs: 25_000,
          },
          signal,
        )
        if (!result.ok) throw new Error(`product-subagent-console RPC failed: ${result.error.code}`)
        return consoleSnapshotSchema.parse(result.value)
      },
      openChild(address: SubagentAddress) { sessions.openSubagent(address) },
      refreshNative(parentSessionId: SessionId) { return sessions.refreshSubagents(parentSessionId) },
    }),
  }, SubagentWorkbenchView))
}
