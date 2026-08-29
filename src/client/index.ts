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
  EXECUTION_CAPABILITIES_ENDPOINT,
  executionCapabilitiesRequestSchema,
  executionCapabilitySnapshotSchema,
  ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT,
  LIST_PLAN_EXECUTIONS_ENDPOINT,
  listPlanExecutionsRequestSchema,
  LIST_PLANS_ENDPOINT,
  listPlansRequestSchema,
  planExecutionRepositorySnapshotSchema,
  planExecutionGrantSchema,
  planPreflightResultSchema,
  plannerRpcReasonSchema,
  planRepositorySnapshotSchema,
  planRevisionRequestSchema,
  PREFLIGHT_PLAN_ENDPOINT,
  SAVE_PLAN_ENDPOINT,
  savePlanRequestSchema,
  WATCH_PLANS_ENDPOINT,
  WATCH_PLAN_EXECUTIONS_ENDPOINT,
  watchPlanExecutionsRequestSchema,
  watchPlansRequestSchema,
  type ExecutionCapabilitySnapshot,
  type PlanExecutionGrant,
  type PlanExecutionRepositorySnapshot,
  type PlanRevisionRequest,
} from '../plan-types.js'
import {
  COMPARE_FOUNDRY_RUNS_ENDPOINT,
  compareRunsRequestSchema,
  EXPORT_RECIPE_ENDPOINT,
  exportRecipeRequestSchema,
  exportRecipeResultSchema,
  EXPORT_RUN_CAPSULE_ENDPOINT,
  exportRunCapsuleRequestSchema,
  exportRunCapsuleResultSchema,
  EXPORT_TELEMETRY_ENDPOINT,
  exportTelemetryRequestSchema,
  exportTelemetryResultSchema,
  foundrySnapshotSchema,
  EXECUTE_CANCEL_CONTROL_ENDPOINT,
  executeCancelControlRequestSchema,
  executeCancelControlResultSchema,
  INSPECT_FOUNDRY_RUN_ENDPOINT,
  inspectRunRequestSchema,
  inspectRunResultSchema,
  INSTANTIATE_RECIPE_ENDPOINT,
  instantiateRecipeRequestSchema,
  instantiateRecipeResultSchema,
  LIST_FOUNDRY_RUNS_ENDPOINT,
  ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT,
  issueCancelGrantRequestSchema,
  foundryControlGrantSchema,
  listFoundryRunsRequestSchema,
  PREVIEW_RECIPE_ENDPOINT,
  recipeCandidateRequestSchema,
  recipeCandidateSchema,
  runAdvisorResultSchema,
  WATCH_FOUNDRY_RUNS_ENDPOINT,
  watchFoundryRunsRequestSchema,
  type CompareRunsRequest,
  type ExportRecipeRequest,
  type ExportRecipeResult,
  type ExportRunCapsuleRequest,
  type ExportRunCapsuleResult,
  type ExportTelemetryRequest,
  type ExportTelemetryResult,
  type FoundrySnapshot,
  type ExecuteCancelControlRequest,
  type ExecuteCancelControlResult,
  type FoundryControlGrant,
  type InspectRunRequest,
  type InspectRunResult,
  type InstantiateRecipeRequest,
  type InstantiateRecipeResult,
  type IssueCancelGrantRequest,
  type RecipeCandidate,
  type RecipeCandidateRequest,
  type RunAdvisorResult,
} from '../foundry-types.js'
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
  /** Queue a visible user turn asking the current conversation Agent to execute one approved revision. */
  readonly requestPlanExecution: (
    parentSessionId: SessionId,
    request: PlanRevisionRequest,
    signal: AbortSignal,
  ) => Promise<PlanExecutionGrant>
  readonly listFoundry: (
    parentSessionIds: readonly SessionId[],
    signal: AbortSignal,
  ) => Promise<FoundrySnapshot>
  readonly watchFoundry: (
    parentSessionIds: readonly SessionId[],
    hostInstanceId: string | undefined,
    afterRevision: number,
    signal: AbortSignal,
  ) => Promise<FoundrySnapshot>
  readonly inspectRun: (request: InspectRunRequest, signal: AbortSignal) => Promise<InspectRunResult>
  readonly askRun: (
    parentSessionId: SessionId,
    request: InspectRunRequest,
    question: string,
    signal: AbortSignal,
  ) => Promise<InspectRunResult>
  readonly exportRunCapsule: (
    request: ExportRunCapsuleRequest,
    signal: AbortSignal,
  ) => Promise<ExportRunCapsuleResult>
  readonly previewRecipe: (
    request: RecipeCandidateRequest,
    signal: AbortSignal,
  ) => Promise<RecipeCandidate>
  readonly exportRecipe: (
    request: ExportRecipeRequest,
    signal: AbortSignal,
  ) => Promise<ExportRecipeResult>
  readonly instantiateRecipe: (
    request: InstantiateRecipeRequest,
    signal: AbortSignal,
  ) => Promise<InstantiateRecipeResult>
  readonly compareRuns: (
    request: CompareRunsRequest,
    signal: AbortSignal,
  ) => Promise<RunAdvisorResult>
  readonly exportTelemetry: (
    request: ExportTelemetryRequest,
    signal: AbortSignal,
  ) => Promise<ExportTelemetryResult>
  readonly issueCancelControlGrant: (
    request: IssueCancelGrantRequest,
    signal: AbortSignal,
  ) => Promise<FoundryControlGrant>
  readonly executeCancelControl: (
    request: ExecuteCancelControlRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteCancelControlResult>
}

/** Complete browser-injected surface for the runtime and planner workbench modes. */
export type ProductSubagentWorkbenchInjected = SubagentWorkbenchInjected & PlannerWorkbenchInjected

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    productSubagents: ProductSubagentsLocaleKey
  }
}

export const inject = ['slots', 'locale', 'connection', 'sessions']

function plannerRpcFailureLabel(error: { readonly code: string; readonly message: string }): string {
  if (error.code !== 'command-error') return error.code
  const reason = /^\[([a-z0-9-]{1,64})\](?:\s|$)/u.exec(error.message)?.[1]
  const parsed = plannerRpcReasonSchema.safeParse(reason)
  return parsed.success ? parsed.data : error.code
}

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
    if (!result.ok) {
      throw new Error(`product-subagent-console RPC failed: ${plannerRpcFailureLabel(result.error)}`)
    }
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
    inject: (sessionId: SessionId): ProductSubagentWorkbenchInjected => {
      const currentParentSessionId = String(sessionId)
      const assertCurrentParent = (parentSessionId: string | SessionId): void => {
        if (String(parentSessionId) !== currentParentSessionId) {
          throw new Error('product-subagent-console: request does not belong to current session')
        }
      }
      const assertCurrentParents = (parentSessionIds: readonly SessionId[]): void => {
        if (parentSessionIds.length !== 1) {
          throw new Error('product-subagent-console: exactly one current session is required')
        }
        assertCurrentParent(parentSessionIds[0] as SessionId)
      }
      const assertRequestActive = (signal: AbortSignal): void => {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      }
      return ({
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
      async listFoundry(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        assertCurrentParents(parentSessionIds)
        const request = listFoundryRunsRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
        })
        const value = await callPlanner(LIST_FOUNDRY_RUNS_ENDPOINT, request, signal)
        return foundrySnapshotSchema.parse(value)
      },
      async watchFoundry(
        parentSessionIds: readonly SessionId[],
        hostInstanceId: string | undefined,
        afterRevision: number,
        signal: AbortSignal,
      ) {
        assertCurrentParents(parentSessionIds)
        const request = watchFoundryRunsRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
          ...(hostInstanceId === undefined ? {} : { hostInstanceId }),
          afterRevision,
          timeoutMs: 25_000,
        })
        const value = await callPlanner(WATCH_FOUNDRY_RUNS_ENDPOINT, request, signal)
        return foundrySnapshotSchema.parse(value)
      },
      async inspectRun(input: InspectRunRequest, signal: AbortSignal) {
        const request = inspectRunRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(INSPECT_FOUNDRY_RUN_ENDPOINT, request, signal)
        return inspectRunResultSchema.parse(value)
      },
      async askRun(
        parentSessionId: SessionId,
        input: InspectRunRequest,
        question: string,
        signal: AbortSignal,
      ) {
        if (parentSessionId !== sessionId || input.parentSessionId !== String(sessionId)) {
          throw new Error('product-subagent-console: run question does not belong to current session')
        }
        const request = inspectRunRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const normalizedQuestion = question.trim()
        if (normalizedQuestion.length < 1 || normalizedQuestion.length > 2_000) {
          throw new Error('product-subagent-console: run question must contain 1-2000 characters')
        }
        const value = await callPlanner(INSPECT_FOUNDRY_RUN_ENDPOINT, request, signal)
        const facts = inspectRunResultSchema.parse(value)
        assertRequestActive(signal)
        assertCurrentParent(request.parentSessionId)
        const binding = sessions.binding(sessionId)
        if (binding === undefined) throw new Error('product-subagent-console: current session is unavailable')
        const english = t('locale.code') === 'en'
        const packet = facts.facts.map(fact => ({
          factId: fact.factId,
          category: fact.category,
          label: fact.label,
          value: fact.value,
          certainty: fact.certainty,
          evidenceEventIds: fact.evidenceEventIds,
          findingIds: fact.findingIds,
          ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
          ...(fact.attemptId === undefined ? {} : { attemptId: fact.attemptId }),
        }))
        const result = await binding.session.prompt([{
          type: 'text',
          text: (english ? [
            `Question about Agent run ${request.runId}: ${normalizedQuestion}`,
            `Foundry query: ${request.kind}; event cursor: ${String(facts.throughCursor)}; answer code: ${facts.answerCode}.`,
            `Factual packet: ${JSON.stringify(packet)}`,
            'Explain only what this packet supports. Cite factId/findingId/eventId. Label any additional interpretation as a hypothesis. Do not execute, retry, resume, cancel, or edit an Agent.',
          ] : [
            `关于 Agent 运行 ${request.runId} 的问题：${normalizedQuestion}`,
            `Foundry 查询：${request.kind}；事件游标：${String(facts.throughCursor)}；答案代码：${facts.answerCode}。`,
            `事实包：${JSON.stringify(packet)}`,
            '只解释事实包能够支持的内容，并引用 factId/findingId/eventId；额外推测必须标为“假设”。不要执行、重试、恢复、取消或编辑任何 Agent。',
          ]).join('\n'),
        }], 'queue', signal)
        if (!result.ok) throw new Error(`product-subagent-console prompt failed: ${result.error.code}`)
        return facts
      },
      async exportRunCapsule(input: ExportRunCapsuleRequest, signal: AbortSignal) {
        const request = exportRunCapsuleRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(EXPORT_RUN_CAPSULE_ENDPOINT, request, signal)
        return exportRunCapsuleResultSchema.parse(value)
      },
      async previewRecipe(input: RecipeCandidateRequest, signal: AbortSignal) {
        const request = recipeCandidateRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(PREVIEW_RECIPE_ENDPOINT, request, signal)
        return recipeCandidateSchema.parse(value)
      },
      async exportRecipe(input: ExportRecipeRequest, signal: AbortSignal) {
        const request = exportRecipeRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(EXPORT_RECIPE_ENDPOINT, request, signal)
        return exportRecipeResultSchema.parse(value)
      },
      async instantiateRecipe(input: InstantiateRecipeRequest, signal: AbortSignal) {
        const request = instantiateRecipeRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(INSTANTIATE_RECIPE_ENDPOINT, request, signal)
        return instantiateRecipeResultSchema.parse(value)
      },
      async compareRuns(input: CompareRunsRequest, signal: AbortSignal) {
        const request = compareRunsRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(COMPARE_FOUNDRY_RUNS_ENDPOINT, request, signal)
        return runAdvisorResultSchema.parse(value)
      },
      async exportTelemetry(input: ExportTelemetryRequest, signal: AbortSignal) {
        const request = exportTelemetryRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(EXPORT_TELEMETRY_ENDPOINT, request, signal)
        return exportTelemetryResultSchema.parse(value)
      },
      async issueCancelControlGrant(input: IssueCancelGrantRequest, signal: AbortSignal) {
        const request = issueCancelGrantRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(ISSUE_CANCEL_CONTROL_GRANT_ENDPOINT, request, signal)
        return foundryControlGrantSchema.parse(value)
      },
      async executeCancelControl(input: ExecuteCancelControlRequest, signal: AbortSignal) {
        const request = executeCancelControlRequestSchema.parse(input)
        assertCurrentParent(request.parentSessionId)
        const value = await callPlanner(EXECUTE_CANCEL_CONTROL_ENDPOINT, request, signal)
        return executeCancelControlResultSchema.parse(value)
      },
      async listPlans(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        assertCurrentParents(parentSessionIds)
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
        assertCurrentParents(parentSessionIds)
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
        assertRequestActive(signal)
        assertCurrentParent(parentSessionId)
        const designToolName = capabilities.plannerTools?.design.find(name => capabilities.tools.includes(name))
        if (capabilities.scopeStatus !== 'available' || designToolName === undefined) {
          throw new Error('product-subagent-console: the plan design tool is unavailable in the current Agent scope')
        }
        const binding = sessions.binding(sessionId)
        if (binding === undefined) {
          throw new Error('product-subagent-console: current session is unavailable')
        }
        const english = t('locale.code') === 'en'
        const result = await binding.session.prompt([{
          type: 'text',
          text: (english ? [
            `Design an executable multi-Agent plan for the objective below and call ${designToolName} to save it as a draft.`,
            'Only design and save the plan. Do not start any child Agent.',
            'Use only the capabilities listed below; do not assume that any unlisted Provider, model, tool, or backend exists.',
            `Workflow backend: ${capabilities.adapters.workflow ? 'available' : 'unavailable'}; Agent Teams backend: unavailable for execution.`,
            `Transport Providers: ${capabilities.transportProviders.map(provider => (
              `${provider.name}(context=${provider.inheritsParentContext ? 'fork' : 'fresh'},modelRouting=${provider.modelRouting})`
            )).join(', ') || 'none'}`,
            `Budget limits: at most ${String(capabilities.limits.maxAgents)} Agents and ${String(capabilities.limits.maxConcurrent)} concurrent Agents.`,
            'A Workflow plan must use one Transport Provider, inherit tools (toolPolicy.mode=inherit), and omit Agent Presets.',
            'Only set llmProvider or model when the selected Transport Provider reports modelRouting=enforced.',
            '',
            `Objective: ${normalizedObjective}`,
          ] : [
            `请为以下目标设计一个可执行的多 Agent 方案，并调用 ${designToolName} 工具将方案保存为草稿。`,
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
          ]).join('\n'),
        }], 'queue', signal)
        if (!result.ok) {
          throw new Error(`product-subagent-console prompt failed: ${result.error.code}`)
        }
      },
      async listPlanExecutions(parentSessionIds: readonly SessionId[], signal: AbortSignal) {
        assertCurrentParents(parentSessionIds)
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
        assertCurrentParents(parentSessionIds)
        const request = watchPlanExecutionsRequestSchema.parse({
          parentSessionIds: parentSessionIds.map(String),
          ...(hostInstanceId === undefined ? {} : { hostInstanceId }),
          afterRevision,
          timeoutMs: 25_000,
        })
        const value = await callPlanner(WATCH_PLAN_EXECUTIONS_ENDPOINT, request, signal)
        return planExecutionRepositorySnapshotSchema.parse(value)
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
        const grantValue = await callPlanner(ISSUE_PLAN_EXECUTION_GRANT_ENDPOINT, request, signal)
        const grant = planExecutionGrantSchema.parse(grantValue)
        assertRequestActive(signal)
        assertCurrentParent(request.parentSessionId)
        const binding = sessions.binding(sessionId)
        if (binding === undefined) {
          throw new Error('product-subagent-console: current session is unavailable')
        }
        const english = t('locale.code') === 'en'
        const result = await binding.session.prompt([{
          type: 'text',
          text: (english ? [
            'Execute the exact revision that I approved in Agent Planner.',
            `Call ${grant.executeToolName} with plan_id=${request.planId}, revision=${String(request.revision)}, and grant_id=${grant.grantId}.`,
            'Do not rewrite the plan or substitute another revision. Report the blocker if preflight or capabilities changed.',
          ] : [
            '请执行我已在 Agent 方案设计器中批准的精确修订。',
            `请调用 ${grant.executeToolName}，参数 plan_id=${request.planId}、revision=${String(request.revision)}、grant_id=${grant.grantId}。`,
            '不要改写方案，不要改用其他修订；如果预检或能力已变化，请报告阻塞原因。',
          ]).join('\n'),
        }], 'queue', signal)
        if (!result.ok) {
          throw new Error(`product-subagent-console prompt failed: ${result.error.code}`)
        }
        return grant
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
      })
    },
  }, SubagentWorkbenchView))
}
