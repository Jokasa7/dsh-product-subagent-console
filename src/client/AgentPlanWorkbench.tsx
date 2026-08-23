import {
  cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState,
  type ChangeEvent, type ReactNode,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  agentPlanContentSchema,
  type AgentPlanContent,
  type AgentPlanRevision,
  type ApprovePlanRequest,
  type ExecutionCapabilitySnapshot,
  type PlanDiagnostic,
  type PlanPreflightResult,
  type PlanRepositorySnapshot,
  type PlanRevisionRequest,
  type PlanRole,
  type PlanTask,
  type SavePlanRequest,
} from '../plan-types.js'
import { AgentPlanCanvas, type AgentPlanCanvasCopy } from './AgentPlanCanvas.js'
import css from './AgentPlanWorkbench.module.css'

/** Browser actions supplied by the client entry; the component never speaks RPC directly. */
export interface AgentPlanWorkbenchInjected {
  readonly listPlans: (
    parentSessionIds: readonly SessionId[],
    signal: AbortSignal,
  ) => Promise<PlanRepositorySnapshot>
  readonly watchPlans: (
    parentSessionIds: readonly SessionId[],
    hostInstanceId: string,
    afterRevision: number,
    signal: AbortSignal,
  ) => Promise<PlanRepositorySnapshot>
  readonly savePlan: (request: SavePlanRequest, signal: AbortSignal) => Promise<AgentPlanRevision>
  readonly preflightPlan: (
    request: PlanRevisionRequest,
    signal: AbortSignal,
  ) => Promise<PlanPreflightResult>
  readonly approvePlan: (
    request: ApprovePlanRequest,
    signal: AbortSignal,
  ) => Promise<AgentPlanRevision>
  readonly getExecutionCapabilities: (
    parentSessionId: SessionId,
    signal: AbortSignal,
  ) => Promise<ExecutionCapabilitySnapshot>
  /** Queue a visible user message in the owning conversation; never call an LLM invisibly. */
  readonly requestPlanDesign: (
    parentSessionId: SessionId,
    objective: string,
    signal: AbortSignal,
  ) => Promise<void>
}

const WORKBENCH_COPY_ZH_VALUES = {
  manualPlanTitle: '新的 Agent 方案',
  manualObjective: '描述希望多个 Agent 协作完成的目标',
  manualSuccessCriterion: '产出满足目标且可验证',
  manualRationale: '由用户创建草案，保存后通过预检确认是否适合多 Agent。',
  manualRoleName: '执行者',
  manualRoleResponsibility: '完成分配到的任务并返回可验证结果',
  manualTaskTitle: '待定义任务',
  manualTaskBrief: '补充该任务要完成的具体工作。',
  manualExpectedOutput: '可检查的任务结果',
  manualCompletionCriterion: '结果完整且可以验证',
  newRoleName: '新角色',
  newRoleResponsibility: '描述该角色负责什么，以及不负责什么。',
  newTaskTitle: '新任务',
  newTaskBrief: '描述此任务要完成的具体工作。',
  conflictError: '方案已被其他更新改动。请刷新后重新应用本次修改。',
  planToolUnavailableError: '当前 Agent 预设没有启用方案设计工具。请在 Agent 预设中启用插件的方案工具后，用该预设新建对话。',
  conversationNotReadyError: '当前对话尚未就绪，请刷新页面后重试。',
  genericError: '操作失败。请刷新状态后重试。',
  noTransportProviderError: '当前 Profile 没有可用的子代理 Provider，无法创建可执行草案。请先安装并配置 Provider。',
  noDiagnostics: '没有发现问题，可以批准此修订。',
  acceptWarning: '我已阅读并接受此警告',
  planName: '方案名称',
  objective: '目标',
  successCriteria: '成功标准',
  onePerLineRefine: '每行一条，可在预检前继续细化。',
  collaborationPattern: '协作模式',
  optimizationTarget: '优化目标',
  executionBackend: '执行后端',
  recommendMultiAgent: '推荐使用多 Agent',
  recommendationRationale: '推荐理由',
  overallBudget: '总体预算',
  maxAgents: '最多 Agent',
  maxConcurrent: '最大并发',
  timeoutMinutes: '超时（分钟）',
  rolesAndProvider: '角色与 Provider',
  addRole: '添加角色',
  name: '名称',
  responsibility: '职责',
  boundaries: '边界',
  onePerLine: '每行一条。',
  transportProvider: '子代理 Provider',
  llmProvider: '模型 Provider',
  model: '模型',
  agentPreset: 'Agent 预设',
  context: '上下文',
  toolPolicy: '工具策略',
  allowedTools: '允许的工具',
  oneToolPerLine: '每行一个工具名。',
  unsupportedExecutionField: '当前执行后端不能强制此设置；填写后预检会阻止执行。',
  deleteRole: '删除角色',
  taskName: '任务名称',
  taskBrief: '任务说明',
  assignedRole: '执行角色',
  risk: '风险',
  approvalRequired: '此任务执行前需要批准',
  expectedOutput: '预期输出',
  completionCriteria: '完成标准',
  resourceClaims: '资源声明',
  resourceClaimsHint: '每行一个相对资源标识，用于检测并行写冲突。',
  taskBudgetHint: '任务预算提示',
  maxTokens: '最多 Tokens',
  maxCostUsd: '最高成本（USD）',
  dependencies: '依赖',
  noOtherTasks: '当前没有其他任务。',
  dependencyTypeLabel: '{title} 的依赖类型',
  dependencyOrderOnly: '顺序',
  dependencyContext: '传递上下文',
  deleteTask: '删除任务',
  objectiveRequired: '先输入希望完成的目标。',
  designRequested: '已把方案设计请求发送到当前对话。生成完成后会出现在方案选择器中。',
  invalidPlan: '方案中仍有空白或无效字段，请检查右侧编辑器后再保存。',
  savedRevision: '已保存修订 {revision}。',
  preflightComplete: '预检完成。',
  preflightBlocked: '预检发现阻塞问题。',
  approvedRevision: '修订 {revision} 已批准，内容已锁定。',
  createdRevision: '已基于批准内容创建修订 {revision}。',
  generatorTitle: '让当前对话设计 Agent 方案',
  generatorDescription: '输入目标后发送一条可见消息；Agent 只生成草案，不会直接启动子 Agent。',
  generatorPlaceholder: '例如：并行检查前端、后端和测试，最后汇总风险',
  sending: '正在发送…',
  generatePlan: '生成方案',
  createManually: '手动新建',
  loadingProviders: '正在读取 Provider…',
  currentPlan: '当前方案',
  noSavedPlans: '暂无已保存方案',
  unsavedDraft: '未保存草案',
  notSelected: '未选择',
  temporaryStorage: '临时保存，仅在本次运行中保留',
  refresh: '刷新',
  addTask: '添加任务',
  disconnected: '与方案服务的连接已中断；当前内容可能不是最新状态。',
  retry: '重试',
  emptyTitle: '还没有 Agent 方案',
  emptyDescription: '让当前对话先生成一份草案，或手动建立一个最小方案。',
  editorAria: 'Agent 方案编辑器',
  planSettings: '方案设置',
  taskSettings: '任务设置',
  approvedReadOnly: '已批准 · 只读',
  reviewTitle: '保存与预检',
  reviewDescription: '预检只针对已保存的精确修订；任何编辑都会让旧预检失效。',
  creatingRevision: '正在创建…',
  createRevision: '创建新修订',
  discardChanges: '撤销未保存修改',
  saving: '正在保存…',
  saveDraft: '保存草案',
  checking: '正在检查…',
  runPreflight: '运行预检',
  approving: '正在批准…',
  approveRevision: '批准此修订',
  preflightEmpty: '保存后运行预检，系统会检查依赖、能力、Provider、工具与预算。',
  canApprove: '可以批准',
  blockingIssues: '存在阻塞问题',
  parallelWaves: '{count} 个并行批次',
  stateDraft: '草案',
  stateApproved: '已批准',
  stateSuperseded: '已替代',
} as const

/** Complete user-facing text for the Agent plan workbench. */
export type AgentPlanWorkbenchCopy = {
  readonly [Key in keyof typeof WORKBENCH_COPY_ZH_VALUES]: string
}

export const AGENT_PLAN_WORKBENCH_COPY_ZH: AgentPlanWorkbenchCopy = WORKBENCH_COPY_ZH_VALUES

export const AGENT_PLAN_WORKBENCH_COPY_EN: AgentPlanWorkbenchCopy = {
  manualPlanTitle: 'New Agent plan',
  manualObjective: 'Describe the goal that Agents should complete together',
  manualSuccessCriterion: 'The result satisfies the goal and can be verified',
  manualRationale: 'This draft was created manually. Preflight will verify whether multiple Agents are appropriate.',
  manualRoleName: 'Worker',
  manualRoleResponsibility: 'Complete assigned tasks and return verifiable results',
  manualTaskTitle: 'Define this task',
  manualTaskBrief: 'Describe the specific work for this task.',
  manualExpectedOutput: 'A result that can be reviewed',
  manualCompletionCriterion: 'The result is complete and verifiable',
  newRoleName: 'New role',
  newRoleResponsibility: 'Describe what this role owns and what is out of scope.',
  newTaskTitle: 'New task',
  newTaskBrief: 'Describe the specific work for this task.',
  conflictError: 'This plan changed elsewhere. Refresh it, then apply your changes again.',
  planToolUnavailableError: 'Plan design is not enabled for this Agent preset. Enable the plugin plan tool in the preset, then start a new conversation with that preset.',
  conversationNotReadyError: 'This conversation is not ready yet. Refresh the page and try again.',
  genericError: 'The action failed. Refresh the current state and try again.',
  noTransportProviderError: 'This profile has no available subagent Provider. Install and configure a Provider before creating an executable draft.',
  noDiagnostics: 'No issues found. This revision can be approved.',
  acceptWarning: 'I have reviewed and accept this warning',
  planName: 'Plan name',
  objective: 'Objective',
  successCriteria: 'Success criteria',
  onePerLineRefine: 'Enter one item per line. You can refine these before preflight.',
  collaborationPattern: 'Collaboration pattern',
  optimizationTarget: 'Optimization target',
  executionBackend: 'Execution backend',
  recommendMultiAgent: 'Recommend multiple Agents',
  recommendationRationale: 'Recommendation rationale',
  overallBudget: 'Overall budget',
  maxAgents: 'Maximum Agents',
  maxConcurrent: 'Maximum concurrency',
  timeoutMinutes: 'Timeout (minutes)',
  rolesAndProvider: 'Roles and Providers',
  addRole: 'Add role',
  name: 'Name',
  responsibility: 'Responsibility',
  boundaries: 'Boundaries',
  onePerLine: 'Enter one item per line.',
  transportProvider: 'Subagent Provider',
  llmProvider: 'Model Provider',
  model: 'Model',
  agentPreset: 'Agent preset',
  context: 'Context',
  toolPolicy: 'Tool policy',
  allowedTools: 'Allowed tools',
  oneToolPerLine: 'Enter one tool name per line.',
  unsupportedExecutionField: 'The current execution backend cannot enforce this setting; preflight blocks execution when it is set.',
  deleteRole: 'Delete role',
  taskName: 'Task name',
  taskBrief: 'Task brief',
  assignedRole: 'Assigned role',
  risk: 'Risk',
  approvalRequired: 'Require approval before this task runs',
  expectedOutput: 'Expected output',
  completionCriteria: 'Completion criteria',
  resourceClaims: 'Resource claims',
  resourceClaimsHint: 'Enter one relative resource identifier per line to detect parallel write conflicts.',
  taskBudgetHint: 'Task budget hint',
  maxTokens: 'Maximum tokens',
  maxCostUsd: 'Maximum cost (USD)',
  dependencies: 'Dependencies',
  noOtherTasks: 'There are no other tasks yet.',
  dependencyTypeLabel: 'Dependency type for {title}',
  dependencyOrderOnly: 'Order only',
  dependencyContext: 'Pass context',
  deleteTask: 'Delete task',
  objectiveRequired: 'Enter the goal first.',
  designRequested: 'The plan-design request was sent to this conversation. The draft will appear in the plan selector when it is ready.',
  invalidPlan: 'Some required fields are blank or invalid. Review the editor before saving.',
  savedRevision: 'Saved revision {revision}.',
  preflightComplete: 'Preflight completed.',
  preflightBlocked: 'Preflight found blocking issues.',
  approvedRevision: 'Revision {revision} is approved and locked.',
  createdRevision: 'Created revision {revision} from the approved plan.',
  generatorTitle: 'Design an Agent plan in this conversation',
  generatorDescription: 'Enter a goal to send a visible message. The Agent creates a draft and does not start child Agents.',
  generatorPlaceholder: 'For example: review the frontend, backend, and tests in parallel, then summarize the risks',
  sending: 'Sending…',
  generatePlan: 'Generate plan',
  createManually: 'Create manually',
  loadingProviders: 'Loading Providers…',
  currentPlan: 'Current plan',
  noSavedPlans: 'No saved plans',
  unsavedDraft: 'Unsaved draft',
  notSelected: 'Not selected',
  temporaryStorage: 'Saved temporarily for this run only',
  refresh: 'Refresh',
  addTask: 'Add task',
  disconnected: 'The plan service is disconnected. The current content may be stale.',
  retry: 'Retry',
  emptyTitle: 'No Agent plan yet',
  emptyDescription: 'Ask this conversation to generate a draft, or create a minimal plan manually.',
  editorAria: 'Agent plan editor',
  planSettings: 'Plan settings',
  taskSettings: 'Task settings',
  approvedReadOnly: 'Approved · Read only',
  reviewTitle: 'Save and preflight',
  reviewDescription: 'Preflight checks one exact saved revision. Any edit invalidates the previous result.',
  creatingRevision: 'Creating…',
  createRevision: 'Create new revision',
  discardChanges: 'Discard unsaved changes',
  saving: 'Saving…',
  saveDraft: 'Save draft',
  checking: 'Checking…',
  runPreflight: 'Run preflight',
  approving: 'Approving…',
  approveRevision: 'Approve revision',
  preflightEmpty: 'Save and run preflight to check dependencies, capabilities, Providers, tools, and budgets.',
  canApprove: 'Ready to approve',
  blockingIssues: 'Blocking issues found',
  parallelWaves: '{count} parallel waves',
  stateDraft: 'Draft',
  stateApproved: 'Approved',
  stateSuperseded: 'Superseded',
}

/** Props for the self-contained Agent plan editor. */
export interface AgentPlanWorkbenchProps {
  readonly sessionId: SessionId
  readonly injected: AgentPlanWorkbenchInjected
  /** Pause background reads while another workbench mode is visible. */
  readonly active?: boolean
  readonly copy?: AgentPlanWorkbenchCopy
  readonly canvasCopy?: AgentPlanCanvasCopy
}

type EditorState = {
  readonly planId?: string
  readonly revision: number
  readonly state: 'draft' | 'approved'
  readonly content: AgentPlanContent
  readonly dirty: boolean
}

type LoadState = {
  readonly status: 'loading' | 'ready' | 'error'
  readonly snapshot?: PlanRepositorySnapshot
}

type ActionName = 'generate' | 'manual' | 'save' | 'preflight' | 'approve' | 'new-revision' | null

function contentFromRevision(revision: AgentPlanRevision): AgentPlanContent {
  return {
    title: revision.title,
    objective: revision.objective,
    successCriteria: structuredClone(revision.successCriteria),
    recommendation: structuredClone(revision.recommendation),
    pattern: revision.pattern,
    optimizationTarget: revision.optimizationTarget,
    backendPreference: revision.backendPreference,
    budget: structuredClone(revision.budget),
    roles: structuredClone(revision.roles),
    tasks: structuredClone(revision.tasks),
  }
}

function editorFromRevision(revision: AgentPlanRevision): EditorState {
  return {
    planId: revision.planId,
    revision: revision.revision,
    state: revision.state === 'approved' ? 'approved' : 'draft',
    content: contentFromRevision(revision),
    dirty: false,
  }
}

function formatCopy(template: string, values: Readonly<Record<string, string | number>>): string {
  let result = template
  for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value))
  return result
}

function revisionStateLabel(
  state: AgentPlanRevision['state'],
  copy: AgentPlanWorkbenchCopy,
): string {
  if (state === 'approved') return copy.stateApproved
  if (state === 'superseded') return copy.stateSuperseded
  return copy.stateDraft
}

function preferredTransport(capabilities: ExecutionCapabilitySnapshot): ExecutionCapabilitySnapshot['transportProviders'][number] | undefined {
  return capabilities.transportProviders.find(provider => !provider.inheritsParentContext)
    ?? capabilities.transportProviders[0]
}

function selectedTransport(
  capabilities: ExecutionCapabilitySnapshot | undefined,
  role: PlanRole,
): ExecutionCapabilitySnapshot['transportProviders'][number] | undefined {
  return capabilities?.transportProviders.find(provider => provider.name === role.transportProvider)
}

function canEnforceModelRoute(
  capabilities: ExecutionCapabilitySnapshot | undefined,
  role: PlanRole,
): boolean {
  return selectedTransport(capabilities, role)?.modelRouting === 'enforced'
}

function canEnforceRoleComposition(
  content: AgentPlanContent,
  capabilities: ExecutionCapabilitySnapshot | undefined,
): boolean {
  return content.backendPreference === 'agent-team' && capabilities?.adapters.agentTeam === true
}

function createManualPlan(
  objective: string,
  copy: AgentPlanWorkbenchCopy,
  transport: ExecutionCapabilitySnapshot['transportProviders'][number],
): AgentPlanContent {
  return {
    title: objective.trim().slice(0, 160) || copy.manualPlanTitle,
    objective: objective.trim() || copy.manualObjective,
    successCriteria: [copy.manualSuccessCriterion],
    recommendation: {
      useMultiAgent: true,
      rationale: copy.manualRationale,
      userOverride: false,
    },
    pattern: 'manager-workers',
    optimizationTarget: 'balanced',
    backendPreference: 'auto',
    budget: {
      maxAgents: 5,
      maxConcurrent: 4,
      planTimeoutMs: 1_800_000,
    },
    roles: [{
      roleId: 'role-1',
      name: copy.manualRoleName,
      responsibility: copy.manualRoleResponsibility,
      boundaries: [],
      transportProvider: transport.name,
      contextMode: transport.inheritsParentContext ? 'fork' : 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'task-1',
      title: copy.manualTaskTitle,
      brief: copy.manualTaskBrief,
      roleId: 'role-1',
      dependsOn: [],
      expectedOutput: { description: copy.manualExpectedOutput },
      completionCriteria: [copy.manualCompletionCriterion],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
}

function draftLines(value: string): string[] {
  return value.split(/\r?\n/u)
}

function normalizedContent(content: AgentPlanContent): AgentPlanContent {
  return {
    ...content,
    successCriteria: lines(content.successCriteria.join('\n')),
    roles: content.roles.map(role => ({
      ...role,
      boundaries: lines(role.boundaries.join('\n')),
      toolPolicy: role.toolPolicy.mode === 'allowlist'
        ? { mode: 'allowlist', tools: lines(role.toolPolicy.tools.join('\n')) }
        : role.toolPolicy,
    })),
    tasks: content.tasks.map(task => ({
      ...task,
      completionCriteria: lines(task.completionCriteria.join('\n')),
      resourceClaims: lines(task.resourceClaims.join('\n')),
    })),
  }
}

function uniqueIdentifier(prefix: string, existing: ReadonlySet<string>): string {
  let index = existing.size + 1
  while (existing.has(`${prefix}-${String(index)}`)) index += 1
  return `${prefix}-${String(index)}`
}

function latestPlans(revisions: readonly AgentPlanRevision[]): readonly AgentPlanRevision[] {
  const result = new Map<string, AgentPlanRevision>()
  for (const revision of revisions) {
    const previous = result.get(revision.planId)
    if (previous === undefined || revision.revision > previous.revision) {
      result.set(revision.planId, revision)
    }
  }
  return [...result.values()].sort((left, right) => (
    right.updatedAt - left.updatedAt || right.revision - left.revision
  ))
}

function updateOptionalRoleField(
  role: PlanRole,
  field: 'llmProvider' | 'model' | 'agentPreset',
  value: string,
): PlanRole {
  const next = structuredClone(role)
  if (value.trim().length === 0) delete next[field]
  else next[field] = value
  return next
}

function safeActionMessage(error: unknown, copy: AgentPlanWorkbenchCopy): string {
  const message = error instanceof Error ? error.message : ''
  if (/revision conflict|expected revision|actual revision/iu.test(message)) {
    return copy.conflictError
  }
  if (/(?:plan design tool|design_subagent_plan).*unavailable/iu.test(message)) {
    return copy.planToolUnavailableError
  }
  if (/current session is unavailable/iu.test(message)) {
    return copy.conversationNotReadyError
  }
  if (/aborted|aborterror/iu.test(message)) return ''
  return copy.genericError
}

function warningIds(preflight: PlanPreflightResult | null): readonly string[] {
  if (preflight === null) return []
  return [...new Set(preflight.diagnostics
    .filter(item => item.severity === 'warning')
    .map(item => item.diagnosticId))]
}

function numberValue(event: ChangeEvent<HTMLInputElement>): number {
  return Number(event.currentTarget.value)
}

function DiagnosticList({
  diagnostics, accepted, onAccepted, onSelect, copy,
}: {
  readonly diagnostics: readonly PlanDiagnostic[]
  readonly accepted: ReadonlySet<string>
  readonly onAccepted: (diagnosticId: string, value: boolean) => void
  readonly onSelect: (taskId: string) => void
  readonly copy: AgentPlanWorkbenchCopy
}): ReactNode {
  if (diagnostics.length === 0) {
    return <p className={css.diagnosticEmpty}>{copy.noDiagnostics}</p>
  }
  return (
    <ul className={css.diagnosticList}>
      {diagnostics.map(diagnostic => (
        <li key={diagnostic.diagnosticId} data-severity={diagnostic.severity}>
          <div>
            <span className={css.severity}>{diagnostic.severity}</span>
            <code>{diagnostic.code}</code>
          </div>
          <p>{diagnostic.message}</p>
          {diagnostic.fixHint === undefined ? null : <small>{diagnostic.fixHint}</small>}
          {diagnostic.nodeIds.length === 0 ? null : (
            <div className={css.diagnosticNodes}>
              {diagnostic.nodeIds.map(nodeId => (
                <button key={nodeId} type="button" onClick={() => { onSelect(nodeId) }}>{nodeId}</button>
              ))}
            </div>
          )}
          {diagnostic.severity !== 'warning' ? null : (
            <label className={css.acceptWarning}>
              <input
                type="checkbox"
                checked={accepted.has(diagnostic.diagnosticId)}
                onChange={(event) => { onAccepted(diagnostic.diagnosticId, event.currentTarget.checked) }}
              />
              {copy.acceptWarning}
            </label>
          )}
        </li>
      ))}
    </ul>
  )
}

function Field({ label, hint, children }: {
  readonly label: string
  readonly hint?: string | undefined
  readonly children: ReactNode
}): ReactNode {
  const hintId = `${useId()}-hint`
  const control = isValidElement<{
    readonly 'aria-label'?: string
    readonly 'aria-describedby'?: string
  }>(children)
    ? cloneElement(children, {
      'aria-label': children.props['aria-label'] ?? label,
      ...(hint === undefined
        ? {}
        : {
          'aria-describedby': [children.props['aria-describedby'], hintId]
            .filter(Boolean)
            .join(' '),
        }),
    })
    : children
  return (
    <label className={css.field}>
      <span>{label}</span>
      {control}
      {hint === undefined ? null : <small id={hintId}>{hint}</small>}
    </label>
  )
}

function RootEditor({
  content, disabled, update, copy, capabilities,
}: {
  readonly content: AgentPlanContent
  readonly disabled: boolean
  readonly update: (next: AgentPlanContent) => void
  readonly copy: AgentPlanWorkbenchCopy
  readonly capabilities?: ExecutionCapabilitySnapshot
}): ReactNode {
  const transportProviders = capabilities?.transportProviders ?? []
  const defaultTransport = capabilities === undefined ? undefined : preferredTransport(capabilities)
  const updateRole = (roleId: string, recipe: (role: PlanRole) => PlanRole): void => {
    update({
      ...content,
      roles: content.roles.map(role => role.roleId === roleId ? recipe(role) : role),
    })
  }
  const addRole = (): void => {
    const transport = defaultTransport
      ?? transportProviders.find(provider => provider.name === content.roles[0]?.transportProvider)
    if (transport === undefined) return
    const roleId = uniqueIdentifier('role', new Set(content.roles.map(role => role.roleId)))
    update({
      ...content,
      roles: [...content.roles, {
        roleId,
        name: copy.newRoleName,
        responsibility: copy.newRoleResponsibility,
        boundaries: [],
        transportProvider: transport.name,
        contextMode: transport.inheritsParentContext ? 'fork' : 'fresh',
        toolPolicy: { mode: 'inherit' },
      }],
    })
  }
  const removeRole = (roleId: string): void => {
    const remaining = content.roles.filter(role => role.roleId !== roleId)
    const fallback = remaining[0]
    if (fallback === undefined) return
    update({
      ...content,
      roles: remaining,
      tasks: content.tasks.map(task => task.roleId === roleId
        ? { ...task, roleId: fallback.roleId }
        : task),
    })
  }
  return (
    <div className={css.editorBody}>
      <Field label={copy.planName}>
        <input
          disabled={disabled}
          value={content.title}
          onChange={(event) => { update({ ...content, title: event.currentTarget.value }) }}
        />
      </Field>
      <Field label={copy.objective}>
        <textarea
          disabled={disabled}
          rows={5}
          value={content.objective}
          onChange={(event) => { update({ ...content, objective: event.currentTarget.value }) }}
        />
      </Field>
      <Field label={copy.successCriteria} hint={copy.onePerLineRefine}>
        <textarea
          disabled={disabled}
          rows={4}
          value={content.successCriteria.join('\n')}
          onChange={(event) => { update({ ...content, successCriteria: draftLines(event.currentTarget.value) }) }}
        />
      </Field>
      <div className={css.fieldGrid}>
        <Field label={copy.collaborationPattern}>
          <select
            disabled={disabled}
            value={content.pattern}
            onChange={(event) => { update({
              ...content,
              pattern: event.currentTarget.value as AgentPlanContent['pattern'],
            }) }}
          >
            <option value="single-agent">single-agent</option>
            <option value="manager-workers">manager-workers</option>
            <option value="parallel-fanout-fanin">parallel-fanout-fanin</option>
            <option value="sequential-dag">sequential-dag</option>
            <option value="competing-hypotheses">competing-hypotheses</option>
            <option value="peer-team">peer-team</option>
          </select>
        </Field>
        <Field label={copy.optimizationTarget}>
          <select
            disabled={disabled}
            value={content.optimizationTarget}
            onChange={(event) => { update({
              ...content,
              optimizationTarget: event.currentTarget.value as AgentPlanContent['optimizationTarget'],
            }) }}
          >
            <option value="balanced">balanced</option>
            <option value="quality">quality</option>
            <option value="latency">latency</option>
            <option value="cost">cost</option>
          </select>
        </Field>
        <Field label={copy.executionBackend}>
          <select
            disabled={disabled}
            value={content.backendPreference}
            onChange={(event) => { update({
              ...content,
              backendPreference: event.currentTarget.value as AgentPlanContent['backendPreference'],
            }) }}
          >
            <option value="auto">auto</option>
            <option value="workflow">workflow</option>
            <option value="agent-team" disabled={capabilities?.adapters.agentTeam !== true}>agent-team</option>
          </select>
        </Field>
      </div>
      <label className={css.checkField}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={content.recommendation.useMultiAgent}
          onChange={(event) => { update({
            ...content,
            recommendation: { ...content.recommendation, useMultiAgent: event.currentTarget.checked },
          }) }}
        />
        {copy.recommendMultiAgent}
      </label>
      <Field label={copy.recommendationRationale}>
        <textarea
          disabled={disabled}
          rows={3}
          value={content.recommendation.rationale}
          onChange={(event) => { update({
            ...content,
            recommendation: { ...content.recommendation, rationale: event.currentTarget.value },
          }) }}
        />
      </Field>
      <fieldset className={css.group}>
        <legend>{copy.overallBudget}</legend>
        <div className={css.fieldGrid}>
          <Field label={copy.maxAgents}>
            <input
              type="number"
              min={1}
              max={32}
              disabled={disabled}
              value={content.budget.maxAgents}
              onChange={(event) => { update({
                ...content,
                budget: { ...content.budget, maxAgents: numberValue(event) },
              }) }}
            />
          </Field>
          <Field label={copy.maxConcurrent}>
            <input
              type="number"
              min={1}
              max={16}
              disabled={disabled}
              value={content.budget.maxConcurrent}
              onChange={(event) => { update({
                ...content,
                budget: { ...content.budget, maxConcurrent: numberValue(event) },
              }) }}
            />
          </Field>
          <Field label={copy.timeoutMinutes}>
            <input
              type="number"
              min={1}
              max={120}
              disabled={disabled}
              value={Math.round(content.budget.planTimeoutMs / 60_000)}
              onChange={(event) => { update({
                ...content,
                budget: { ...content.budget, planTimeoutMs: numberValue(event) * 60_000 },
              }) }}
            />
          </Field>
        </div>
      </fieldset>
      <section className={css.roles}>
        <header>
          <div><strong>{copy.rolesAndProvider}</strong><span>{content.roles.length}/32</span></div>
          <button
            type="button"
            disabled={disabled || content.roles.length >= 32 || transportProviders.length === 0}
            onClick={addRole}
          >{copy.addRole}</button>
        </header>
        {content.roles.map(role => (
          <details
            key={role.roleId}
            className={css.roleCard}
            ref={(element) => {
              if (element === null || element.dataset.initialOpen === 'true') return
              element.open = true
              element.dataset.initialOpen = 'true'
            }}
          >
            <summary><strong>{role.name}</strong><code>{role.roleId}</code></summary>
            <div className={css.roleFields}>
              <Field label={copy.name}>
                <input
                  disabled={disabled}
                  value={role.name}
                  onChange={(event) => { updateRole(role.roleId, item => ({
                    ...item, name: event.currentTarget.value,
                  })) }}
                />
              </Field>
              <Field label={copy.responsibility}>
                <textarea
                  disabled={disabled}
                  rows={3}
                  value={role.responsibility}
                  onChange={(event) => { updateRole(role.roleId, item => ({
                    ...item, responsibility: event.currentTarget.value,
                  })) }}
                />
              </Field>
              <Field label={copy.boundaries} hint={copy.onePerLine}>
                <textarea
                  disabled={disabled}
                  rows={2}
                  value={role.boundaries.join('\n')}
                  onChange={(event) => { updateRole(role.roleId, item => ({
                    ...item, boundaries: draftLines(event.currentTarget.value),
                  })) }}
                />
              </Field>
              <div className={css.fieldGrid}>
                <Field label={copy.transportProvider}>
                  <select
                    disabled={disabled}
                    value={role.transportProvider}
                    onChange={(event) => {
                      const selected = transportProviders.find(provider => provider.name === event.currentTarget.value)
                      updateRole(role.roleId, item => ({
                        ...item,
                        transportProvider: event.currentTarget.value,
                        contextMode: selected?.inheritsParentContext === true ? 'fork' : 'fresh',
                      }))
                    }}
                  >
                    {transportProviders.some(provider => provider.name === role.transportProvider)
                      ? null
                      : <option value={role.transportProvider}>{role.transportProvider}</option>}
                    {transportProviders.map(provider => (
                      <option key={provider.name} value={provider.name}>
                        {provider.displayName ?? provider.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={copy.llmProvider}
                  hint={canEnforceModelRoute(capabilities, role) ? undefined : copy.unsupportedExecutionField}
                >
                  <input
                    disabled={disabled || (!canEnforceModelRoute(capabilities, role) && role.llmProvider === undefined)}
                    value={role.llmProvider ?? ''}
                    onChange={(event) => { updateRole(
                      role.roleId,
                      item => updateOptionalRoleField(item, 'llmProvider', event.currentTarget.value),
                    ) }}
                  />
                </Field>
                <Field
                  label={copy.model}
                  hint={canEnforceModelRoute(capabilities, role) ? undefined : copy.unsupportedExecutionField}
                >
                  <input
                    disabled={disabled || (!canEnforceModelRoute(capabilities, role) && role.model === undefined)}
                    value={role.model ?? ''}
                    onChange={(event) => { updateRole(
                      role.roleId,
                      item => updateOptionalRoleField(item, 'model', event.currentTarget.value),
                    ) }}
                  />
                </Field>
                <Field
                  label={copy.agentPreset}
                  hint={canEnforceRoleComposition(content, capabilities) ? undefined : copy.unsupportedExecutionField}
                >
                  <input
                    disabled={disabled || (!canEnforceRoleComposition(content, capabilities) && role.agentPreset === undefined)}
                    value={role.agentPreset ?? ''}
                    onChange={(event) => { updateRole(
                      role.roleId,
                      item => updateOptionalRoleField(item, 'agentPreset', event.currentTarget.value),
                    ) }}
                  />
                </Field>
                <Field label={copy.context}>
                  <select
                    disabled={disabled}
                    value={role.contextMode}
                    onChange={(event) => { updateRole(role.roleId, item => ({
                      ...item,
                      contextMode: event.currentTarget.value as PlanRole['contextMode'],
                    })) }}
                  >
                    <option value="fresh">fresh</option>
                    <option value="fork">fork</option>
                  </select>
                </Field>
                <Field label={copy.toolPolicy}>
                  <select
                    disabled={disabled}
                    value={role.toolPolicy.mode}
                    onChange={(event) => { updateRole(role.roleId, item => ({
                      ...item,
                      toolPolicy: event.currentTarget.value === 'allowlist'
                        ? { mode: 'allowlist', tools: [] }
                        : { mode: 'inherit' },
                    })) }}
                  >
                    <option value="inherit">inherit</option>
                    <option
                      value="allowlist"
                      disabled={!canEnforceRoleComposition(content, capabilities)}
                    >allowlist</option>
                  </select>
                </Field>
              </div>
              {role.toolPolicy.mode !== 'allowlist' ? null : (
                <Field
                  label={copy.allowedTools}
                  hint={canEnforceRoleComposition(content, capabilities)
                    ? copy.oneToolPerLine
                    : copy.unsupportedExecutionField}
                >
                  <textarea
                    disabled={disabled}
                    rows={3}
                    value={role.toolPolicy.tools.join('\n')}
                    onChange={(event) => { updateRole(role.roleId, item => ({
                      ...item,
                      toolPolicy: { mode: 'allowlist', tools: draftLines(event.currentTarget.value) },
                    })) }}
                  />
                </Field>
              )}
              <button
                type="button"
                className={css.dangerButton}
                disabled={disabled || content.roles.length <= 1}
                onClick={() => { removeRole(role.roleId) }}
              >{copy.deleteRole}</button>
            </div>
          </details>
        ))}
      </section>
    </div>
  )
}

function TaskEditor({
  content, task, disabled, update, remove, copy, capabilities,
}: {
  readonly content: AgentPlanContent
  readonly task: PlanTask
  readonly disabled: boolean
  readonly update: (task: PlanTask) => void
  readonly remove: () => void
  readonly copy: AgentPlanWorkbenchCopy
  readonly capabilities?: ExecutionCapabilitySnapshot
}): ReactNode {
  const supportsTaskControls = canEnforceRoleComposition(content, capabilities)
  const dependencyById = new Map(task.dependsOn.map(item => [item.taskId, item] as const))
  const setDependency = (taskId: string, enabled: boolean): void => {
    const next = task.dependsOn.filter(item => item.taskId !== taskId)
    if (enabled) next.push({ taskId, mode: 'order-only' })
    update({ ...task, dependsOn: next })
  }
  const setDependencyMode = (taskId: string, mode: 'order-only' | 'context'): void => {
    update({
      ...task,
      dependsOn: task.dependsOn.map(item => item.taskId === taskId ? { ...item, mode } : item),
    })
  }
  const setOptionalBudget = (field: 'maxTokens' | 'maxCostUsd', raw: string): void => {
    const next = { ...task.budgetHint }
    if (raw.length === 0) delete next[field]
    else next[field] = Number(raw)
    const { budgetHint: _previous, ...withoutBudgetHint } = task
    update(Object.keys(next).length === 0
      ? withoutBudgetHint
      : { ...withoutBudgetHint, budgetHint: next })
  }
  return (
    <div className={css.editorBody}>
      <code className={css.editorId}>{task.taskId}</code>
      <Field label={copy.taskName}>
        <input
          disabled={disabled}
          value={task.title}
          onChange={(event) => { update({ ...task, title: event.currentTarget.value }) }}
        />
      </Field>
      <Field label={copy.taskBrief}>
        <textarea
          disabled={disabled}
          rows={5}
          value={task.brief}
          onChange={(event) => { update({ ...task, brief: event.currentTarget.value }) }}
        />
      </Field>
      <div className={css.fieldGrid}>
        <Field label={copy.assignedRole}>
          <select
            disabled={disabled}
            value={task.roleId}
            onChange={(event) => { update({ ...task, roleId: event.currentTarget.value }) }}
          >
            {content.roles.map(role => <option key={role.roleId} value={role.roleId}>{role.name}</option>)}
          </select>
        </Field>
        <Field label={copy.risk}>
          <select
            disabled={disabled}
            value={task.risk}
            onChange={(event) => { update({ ...task, risk: event.currentTarget.value as PlanTask['risk'] }) }}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
      </div>
      <label className={css.checkField}>
        <input
          type="checkbox"
          disabled={disabled || (!supportsTaskControls && !task.approvalRequired)}
          checked={task.approvalRequired}
          onChange={(event) => { update({ ...task, approvalRequired: event.currentTarget.checked }) }}
        />
        {copy.approvalRequired}
      </label>
      <Field label={copy.expectedOutput}>
        <textarea
          disabled={disabled}
          rows={3}
          value={task.expectedOutput.description}
          onChange={(event) => { update({
            ...task,
            expectedOutput: { ...task.expectedOutput, description: event.currentTarget.value },
          }) }}
        />
      </Field>
      <Field label={copy.completionCriteria} hint={copy.onePerLine}>
        <textarea
          disabled={disabled}
          rows={3}
          value={task.completionCriteria.join('\n')}
          onChange={(event) => { update({ ...task, completionCriteria: draftLines(event.currentTarget.value) }) }}
        />
      </Field>
      <Field label={copy.resourceClaims} hint={copy.resourceClaimsHint}>
        <textarea
          disabled={disabled}
          rows={3}
          value={task.resourceClaims.join('\n')}
          onChange={(event) => { update({ ...task, resourceClaims: draftLines(event.currentTarget.value) }) }}
        />
      </Field>
      <fieldset className={css.group}>
        <legend>{copy.taskBudgetHint}</legend>
        {supportsTaskControls ? null : <p>{copy.unsupportedExecutionField}</p>}
        <div className={css.fieldGrid}>
          <Field label={copy.maxTokens}>
            <input
              type="number"
              min={1}
              disabled={disabled || (!supportsTaskControls && task.budgetHint?.maxTokens === undefined)}
              value={task.budgetHint?.maxTokens ?? ''}
              onChange={(event) => { setOptionalBudget('maxTokens', event.currentTarget.value) }}
            />
          </Field>
          <Field label={copy.maxCostUsd}>
            <input
              type="number"
              min={0}
              step="0.01"
              disabled={disabled || (!supportsTaskControls && task.budgetHint?.maxCostUsd === undefined)}
              value={task.budgetHint?.maxCostUsd ?? ''}
              onChange={(event) => { setOptionalBudget('maxCostUsd', event.currentTarget.value) }}
            />
          </Field>
        </div>
      </fieldset>
      <fieldset className={css.dependencies}>
        <legend>{copy.dependencies}</legend>
        {content.tasks.filter(candidate => candidate.taskId !== task.taskId).length === 0
          ? <p>{copy.noOtherTasks}</p>
          : content.tasks.filter(candidate => candidate.taskId !== task.taskId).map((candidate) => {
              const dependency = dependencyById.get(candidate.taskId)
              return (
                <div key={candidate.taskId} className={css.dependencyRow}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={dependency !== undefined}
                      onChange={(event) => { setDependency(candidate.taskId, event.currentTarget.checked) }}
                    />
                    <span>{candidate.title}</span>
                    <code>{candidate.taskId}</code>
                  </label>
                  <select
                    aria-label={formatCopy(copy.dependencyTypeLabel, { title: candidate.title })}
                    disabled={disabled || dependency === undefined}
                    value={dependency?.mode ?? 'order-only'}
                    onChange={(event) => { setDependencyMode(
                      candidate.taskId,
                      event.currentTarget.value as 'order-only' | 'context',
                    ) }}
                  >
                    <option value="order-only">{copy.dependencyOrderOnly}</option>
                    <option value="context">{copy.dependencyContext}</option>
                  </select>
                </div>
              )
            })}
      </fieldset>
      <button
        type="button"
        className={css.dangerButton}
        disabled={disabled || content.tasks.length <= 1}
        onClick={remove}
      >{copy.deleteTask}</button>
    </div>
  )
}

/**
 * Render the editable plan mode: prompt generation, immutable-revision editing,
 * deterministic preflight, explicit warning acceptance, and approval.
 */
export function AgentPlanWorkbench({
  sessionId, injected, active = true, canvasCopy, copy = AGENT_PLAN_WORKBENCH_COPY_ZH,
}: AgentPlanWorkbenchProps): ReactNode {
  const instanceId = useId()
  const generatorTitleId = `${instanceId}-generator-title`
  const editorId = `${instanceId}-editor`
  const reviewTitleId = `${instanceId}-review-title`
  const [loadRequest, setLoadRequest] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [selection, setSelection] = useState<'root' | string>('root')
  const [objective, setObjective] = useState('')
  const [preflight, setPreflight] = useState<PlanPreflightResult | null>(null)
  const [acceptedWarnings, setAcceptedWarnings] = useState<ReadonlySet<string>>(new Set())
  const [capabilities, setCapabilities] = useState<ExecutionCapabilitySnapshot | undefined>()
  const [action, setAction] = useState<ActionName>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const actionController = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const run = async (): Promise<void> => {
      try {
        let snapshot = await injected.listPlans([sessionId], controller.signal)
        while (!controller.signal.aborted) {
          setLoad(previous => previous.snapshot?.hostInstanceId === snapshot.hostInstanceId
            && previous.snapshot.revision === snapshot.revision
            && previous.status === 'ready'
            ? previous
            : { status: 'ready', snapshot })
          snapshot = await injected.watchPlans(
            [sessionId],
            snapshot.hostInstanceId,
            snapshot.revision,
            controller.signal,
          )
        }
      } catch {
        if (!controller.signal.aborted) {
          setLoad(previous => ({
            status: 'error',
            ...(previous.snapshot === undefined ? {} : { snapshot: previous.snapshot }),
          }))
        }
      }
    }
    void run()
    return () => { controller.abort() }
  }, [active, injected, loadRequest, sessionId])

  useEffect(() => () => { actionController.current?.abort() }, [])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void injected.getExecutionCapabilities(sessionId, controller.signal)
      .then(snapshot => { if (!controller.signal.aborted) setCapabilities(snapshot) })
      .catch(() => {})
    return () => { controller.abort() }
  }, [active, injected, sessionId])

  const plans = useMemo(() => latestPlans(load.snapshot?.plans ?? []), [load.snapshot?.plans])
  const selectedStoredPlan = plans.find(plan => plan.planId === selectedPlanId)

  useEffect(() => {
    if (plans.length === 0) return
    if (editor?.planId === undefined && editor?.dirty === true) return
    const selected = plans.find(plan => plan.planId === selectedPlanId) ?? plans[0]
    if (selected === undefined) return
    if (selectedPlanId !== selected.planId) setSelectedPlanId(selected.planId)
    setEditor((previous) => {
      if (previous?.dirty === true) return previous
      if (previous?.planId === selected.planId && previous.revision >= selected.revision) return previous
      return editorFromRevision(selected)
    })
  }, [editor?.dirty, editor?.planId, plans, selectedPlanId])

  const editable = editor !== null && editor.state === 'draft'
  const selectedTask = selection === 'root'
    ? undefined
    : editor?.content.tasks.find(task => task.taskId === selection)
  const warnings = warningIds(preflight)
  const warningsAccepted = warnings.every(diagnosticId => acceptedWarnings.has(diagnosticId))
  const canApprove = editor?.planId !== undefined
    && editor.state === 'draft'
    && !editor.dirty
    && preflight?.valid === true
    && preflight.planId === editor.planId
    && preflight.revision === editor.revision
    && warningsAccepted

  const beginAction = (name: Exclude<ActionName, null>): AbortSignal => {
    actionController.current?.abort()
    const controller = new AbortController()
    actionController.current = controller
    setAction(name)
    setActionError(null)
    setMessage(null)
    return controller.signal
  }

  const finishAction = (): void => {
    setAction(null)
    actionController.current = null
  }

  const updateContent = (content: AgentPlanContent): void => {
    setEditor(previous => previous === null ? null : { ...previous, content, dirty: true })
    setPreflight(null)
    setAcceptedWarnings(new Set())
  }

  const refresh = (): void => {
    if (editor?.dirty === true) return
    setLoad(previous => ({
      status: 'loading',
      ...(previous.snapshot === undefined ? {} : { snapshot: previous.snapshot }),
    }))
    setLoadRequest(value => value + 1)
  }

  const requestDesign = async (): Promise<void> => {
    if (objective.trim().length === 0) {
      setActionError(copy.objectiveRequired)
      return
    }
    const signal = beginAction('generate')
    try {
      await injected.requestPlanDesign(sessionId, objective.trim(), signal)
      setMessage(copy.designRequested)
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const save = async (): Promise<void> => {
    if (editor === null) return
    const parsed = agentPlanContentSchema.safeParse(normalizedContent(editor.content))
    if (!parsed.success) {
      setActionError(copy.invalidPlan)
      return
    }
    const signal = beginAction('save')
    try {
      const saved = await injected.savePlan({
        parentSessionId: String(sessionId),
        ...(editor.planId === undefined ? {} : { planId: editor.planId }),
        expectedRevision: editor.revision,
        content: parsed.data,
      }, signal)
      setSelectedPlanId(saved.planId)
      setEditor(editorFromRevision(saved))
      setPreflight(null)
      setAcceptedWarnings(new Set())
      setMessage(formatCopy(copy.savedRevision, { revision: saved.revision }))
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const runPreflight = async (): Promise<void> => {
    if (editor?.planId === undefined || editor.dirty) return
    const signal = beginAction('preflight')
    try {
      const result = await injected.preflightPlan({
        parentSessionId: String(sessionId),
        planId: editor.planId,
        revision: editor.revision,
      }, signal)
      setPreflight(result)
      setAcceptedWarnings(new Set())
      setMessage(result.valid ? copy.preflightComplete : copy.preflightBlocked)
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const approve = async (): Promise<void> => {
    if (!canApprove || editor?.planId === undefined || preflight === null) return
    const signal = beginAction('approve')
    try {
      const approved = await injected.approvePlan({
        parentSessionId: String(sessionId),
        planId: editor.planId,
        revision: editor.revision,
        capabilityDigest: preflight.capabilityDigest,
        acceptedWarningIds: [...acceptedWarnings],
      }, signal)
      setEditor(editorFromRevision(approved))
      setMessage(formatCopy(copy.approvedRevision, { revision: approved.revision }))
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const createNewRevision = async (): Promise<void> => {
    if (editor?.planId === undefined || editor.state !== 'approved') return
    const signal = beginAction('new-revision')
    try {
      const saved = await injected.savePlan({
        parentSessionId: String(sessionId),
        planId: editor.planId,
        expectedRevision: editor.revision,
        content: editor.content,
      }, signal)
      setEditor(editorFromRevision(saved))
      setPreflight(null)
      setAcceptedWarnings(new Set())
      setMessage(formatCopy(copy.createdRevision, { revision: saved.revision }))
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const addTask = (): void => {
    if (editor === null || !editable || editor.content.tasks.length >= 128) return
    const role = editor.content.roles[0]
    if (role === undefined) return
    const taskId = uniqueIdentifier('task', new Set(editor.content.tasks.map(task => task.taskId)))
    const task: PlanTask = {
      taskId,
      title: copy.newTaskTitle,
      brief: copy.newTaskBrief,
      roleId: role.roleId,
      dependsOn: [],
      expectedOutput: { description: copy.manualExpectedOutput },
      completionCriteria: [copy.manualCompletionCriterion],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }
    updateContent({ ...editor.content, tasks: [...editor.content.tasks, task] })
    setSelection(taskId)
  }

  const removeTask = (taskId: string): void => {
    if (editor === null || editor.content.tasks.length <= 1) return
    updateContent({
      ...editor.content,
      tasks: editor.content.tasks
        .filter(task => task.taskId !== taskId)
        .map(task => ({
          ...task,
          dependsOn: task.dependsOn.filter(dependency => dependency.taskId !== taskId),
        })),
    })
    setSelection('root')
  }

  const startManual = async (): Promise<void> => {
    const signal = beginAction('manual')
    try {
      const snapshot = capabilities ?? await injected.getExecutionCapabilities(sessionId, signal)
      setCapabilities(snapshot)
      const transport = preferredTransport(snapshot)
      if (transport === undefined) {
        setActionError(copy.noTransportProviderError)
        return
      }
      setSelectedPlanId(null)
      setEditor({
        revision: 0,
        state: 'draft',
        content: createManualPlan(objective, copy, transport),
        dirty: true,
      })
      setSelection('root')
      setPreflight(null)
      setAcceptedWarnings(new Set())
      setMessage(null)
    } catch (error: unknown) {
      const safe = safeActionMessage(error, copy)
      if (safe.length > 0) setActionError(safe)
    } finally {
      finishAction()
    }
  }

  const discardChanges = (): void => {
    if (selectedStoredPlan === undefined) {
      setEditor(null)
      setSelection('root')
      return
    }
    setEditor(editorFromRevision(selectedStoredPlan))
    setPreflight(null)
    setAcceptedWarnings(new Set())
  }

  return (
    <section className={css.root} aria-busy={load.status === 'loading' || action !== null}>
      <section className={css.generator} aria-labelledby={generatorTitleId}>
        <div>
          <h3 id={generatorTitleId}>{copy.generatorTitle}</h3>
          <p>{copy.generatorDescription}</p>
        </div>
        <textarea
          aria-label={copy.objective}
          rows={2}
          placeholder={copy.generatorPlaceholder}
          value={objective}
          onChange={(event) => { setObjective(event.currentTarget.value) }}
        />
        <div className={css.generatorActions}>
          <button type="button" disabled={action !== null} onClick={() => { void requestDesign() }}>
            {action === 'generate' ? copy.sending : copy.generatePlan}
          </button>
          <button
            type="button"
            disabled={action !== null || editor?.dirty === true}
            onClick={() => { void startManual() }}
          >
            {action === 'manual' ? copy.loadingProviders : copy.createManually}
          </button>
        </div>
      </section>

      <div className={css.toolbar}>
        <label>
          <span>{copy.currentPlan}</span>
          <select
            value={selectedPlanId ?? ''}
            disabled={plans.length === 0 || editor?.dirty === true || action !== null}
            onChange={(event) => {
              const next = plans.find(plan => plan.planId === event.currentTarget.value)
              if (next === undefined) return
              setSelectedPlanId(next.planId)
              setEditor(editorFromRevision(next))
              setSelection('root')
              setPreflight(null)
              setAcceptedWarnings(new Set())
            }}
          >
            {editor?.planId === undefined
              ? <option value="">{editor === null ? copy.noSavedPlans : copy.unsavedDraft}</option>
              : null}
            {plans.map(plan => (
              <option key={plan.planId} value={plan.planId}>
                {plan.title} · r{String(plan.revision)} · {revisionStateLabel(plan.state, copy)}
              </option>
            ))}
          </select>
        </label>
        <div className={css.toolbarStatus}>
          <span data-state={editor?.state}>{editor === null
            ? copy.notSelected
            : editor.planId === undefined
              ? copy.unsavedDraft
              : `r${String(editor.revision)} · ${revisionStateLabel(editor.state, copy)}`}</span>
          <span>{copy.temporaryStorage}</span>
        </div>
        <div className={css.toolbarActions}>
          <button type="button" disabled={editor?.dirty === true || action !== null} onClick={refresh}>{copy.refresh}</button>
          <button type="button" disabled={!editable || action !== null} onClick={addTask}>{copy.addTask}</button>
        </div>
      </div>

      {load.status === 'error' ? (
        <div className={css.failure} role="alert">
          <span>{copy.disconnected}</span>
          <button type="button" disabled={editor?.dirty === true} onClick={refresh}>{copy.retry}</button>
        </div>
      ) : null}
      {actionError === null ? null : <div className={css.failure} role="alert">{actionError}</div>}
      {message === null ? null : <div className={css.success} role="status">{message}</div>}

      {editor === null ? (
        <div className={css.empty}>
          <strong>{copy.emptyTitle}</strong>
          <p>{copy.emptyDescription}</p>
        </div>
      ) : (
        <div className={css.layout}>
          <div className={css.canvasColumn}>
            <AgentPlanCanvas
              planKey={editor.planId ?? 'unsaved'}
              content={editor.content}
              diagnostics={preflight?.diagnostics ?? []}
              selected={selection}
              onSelect={setSelection}
              editorId={editorId}
              {...(canvasCopy === undefined ? {} : { copy: canvasCopy })}
            />
          </div>
          <aside id={editorId} className={css.inspector} aria-label={copy.editorAria}>
            <header className={css.inspectorHeader}>
              <div>
                <span>{selection === 'root' ? copy.planSettings : copy.taskSettings}</span>
                <strong>{selection === 'root' ? editor.content.title : selectedTask?.title ?? selection}</strong>
              </div>
              {editor.state === 'approved' ? <span className={css.locked}>{copy.approvedReadOnly}</span> : null}
            </header>
            {selection === 'root' || selectedTask === undefined
              ? <RootEditor
                content={editor.content}
                disabled={!editable}
                update={updateContent}
                copy={copy}
                {...(capabilities === undefined ? {} : { capabilities })}
              />
              : <TaskEditor
                content={editor.content}
                task={selectedTask}
                disabled={!editable}
                update={(task) => { updateContent({
                  ...editor.content,
                  tasks: editor.content.tasks.map(item => item.taskId === task.taskId ? task : item),
                }) }}
                remove={() => { removeTask(selectedTask.taskId) }}
                copy={copy}
                {...(capabilities === undefined ? {} : { capabilities })}
              />}
          </aside>
        </div>
      )}

      {editor === null ? null : (
        <section className={css.review} aria-labelledby={reviewTitleId}>
          <header>
            <div>
              <h3 id={reviewTitleId}>{copy.reviewTitle}</h3>
              <p>{copy.reviewDescription}</p>
            </div>
            <div className={css.reviewActions}>
              {editor.state === 'approved' ? (
                <button
                  type="button"
                  disabled={action !== null}
                  onClick={() => { void createNewRevision() }}
                >{action === 'new-revision' ? copy.creatingRevision : copy.createRevision}</button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!editor.dirty || action !== null}
                    onClick={discardChanges}
                  >{copy.discardChanges}</button>
                  <button
                    type="button"
                    disabled={!editor.dirty || action !== null}
                    onClick={() => { void save() }}
                  >{action === 'save' ? copy.saving : copy.saveDraft}</button>
                  <button
                    type="button"
                    disabled={editor.dirty || editor.planId === undefined || action !== null}
                    onClick={() => { void runPreflight() }}
                  >{action === 'preflight' ? copy.checking : copy.runPreflight}</button>
                  <button
                    type="button"
                    className={css.primaryButton}
                    disabled={!canApprove || action !== null}
                    onClick={() => { void approve() }}
                  >{action === 'approve' ? copy.approving : copy.approveRevision}</button>
                </>
              )}
            </div>
          </header>
          {preflight === null ? (
            <p className={css.preflightEmpty}>{copy.preflightEmpty}</p>
          ) : (
            <>
              <div className={css.preflightSummary} data-valid={preflight.valid || undefined}>
                <strong>{preflight.valid ? copy.canApprove : copy.blockingIssues}</strong>
                <span>{preflight.resolvedBackend} · {formatCopy(copy.parallelWaves, { count: preflight.parallelWaves.length })}</span>
              </div>
              <DiagnosticList
                diagnostics={preflight.diagnostics}
                accepted={acceptedWarnings}
                onAccepted={(code, value) => {
                  setAcceptedWarnings((previous) => {
                    const next = new Set(previous)
                    if (value) next.add(code)
                    else next.delete(code)
                    return next
                  })
                }}
                onSelect={(taskId) => {
                  if (editor.content.tasks.some(task => task.taskId === taskId)) setSelection(taskId)
                }}
                copy={copy}
              />
            </>
          )}
        </section>
      )}
    </section>
  )
}
