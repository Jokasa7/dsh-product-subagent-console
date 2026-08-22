import {
  MAX_PLAN_EDGES,
  type AgentPlanRevision,
  type CapabilitySupport,
  type ExecutionCapabilitySnapshot,
  type PlanBackend,
  type PlanDiagnostic,
  type PlanPreflightResult,
  type PlanTask,
  parseAgentPlanRevision,
} from './plan-types.js'

function diagnostic(
  severity: PlanDiagnostic['severity'],
  code: string,
  message: string,
  options: {
    readonly nodeIds?: readonly string[]
    readonly fixHint?: string
    readonly support?: CapabilitySupport
  } = {},
): PlanDiagnostic {
  return {
    severity,
    code,
    message,
    nodeIds: [...(options.nodeIds ?? [])],
    ...(options.fixHint === undefined ? {} : { fixHint: options.fixHint }),
    ...(options.support === undefined ? {} : { support: options.support }),
  }
}

function resolveBackend(
  plan: AgentPlanRevision,
  capabilities: ExecutionCapabilitySnapshot,
): PlanBackend {
  if (plan.backendPreference === 'workflow') return 'workflow'
  if (plan.backendPreference === 'agent-team') return 'agent-team'
  if (plan.pattern === 'peer-team' && capabilities.adapters.agentTeam) return 'agent-team'
  if (capabilities.adapters.workflow) return 'workflow'
  return capabilities.adapters.agentTeam ? 'agent-team' : 'workflow'
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    else seen.add(value)
  }
  return [...duplicates]
}

/** Return deterministic topological ready waves, or the acyclic prefix when a cycle exists. */
export function deriveParallelWaves(tasks: readonly PlanTask[]): readonly (readonly string[])[] {
  const known = new Set(tasks.map(task => task.taskId))
  const remaining = new Map(tasks.map(task => [
    task.taskId,
    new Set(task.dependsOn.map(edge => edge.taskId).filter(id => known.has(id))),
  ] as const))
  const waves: string[][] = []
  while (remaining.size > 0) {
    const ready = tasks
      .map(task => task.taskId)
      .filter(taskId => remaining.get(taskId)?.size === 0)
    if (ready.length === 0) break
    waves.push(ready)
    for (const taskId of ready) remaining.delete(taskId)
    for (const dependencies of remaining.values()) {
      for (const taskId of ready) dependencies.delete(taskId)
    }
  }
  return waves
}

function normalizeScope(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}

function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function supportDiagnostic(
  diagnostics: PlanDiagnostic[],
  field: string,
  support: CapabilitySupport,
  requested: boolean,
): void {
  if (!requested || support === 'enforced') return
  diagnostics.push(diagnostic(
    support === 'unsupported' ? 'error' : 'warning',
    `budget.${field}.${support}`,
    support === 'unsupported'
      ? `The selected backend cannot enforce the requested ${field} budget.`
      : `The requested ${field} budget is advisory for the selected backend.`,
    { support },
  ))
}

/**
 * Validate one immutable plan revision against one exact runtime capability snapshot.
 * This function never calls a model and never mutates or silently downgrades the plan.
 */
export function preflightAgentPlan(
  rawPlan: unknown,
  capabilities: ExecutionCapabilitySnapshot,
): PlanPreflightResult {
  const plan = parseAgentPlanRevision(rawPlan)
  const diagnostics: PlanDiagnostic[] = []
  const backend = resolveBackend(plan, capabilities)
  const roleIds = plan.roles.map(role => role.roleId)
  const taskIds = plan.tasks.map(task => task.taskId)
  const roles = new Map(plan.roles.map(role => [role.roleId, role] as const))
  const tasks = new Map(plan.tasks.map(task => [task.taskId, task] as const))
  const providerCapabilities = new Map(
    capabilities.transportProviders.map(provider => [provider.name, provider] as const),
  )
  const llmRoutes = new Map(capabilities.llmRoutes.map(route => [route.provider, route] as const))
  const presets = new Set(capabilities.agentPresets)
  const tools = new Set(capabilities.tools)

  for (const id of duplicateValues(roleIds)) {
    diagnostics.push(diagnostic('error', 'role.duplicate-id', `Role id "${id}" is duplicated.`, { nodeIds: [id] }))
  }
  for (const id of duplicateValues(taskIds)) {
    diagnostics.push(diagnostic('error', 'task.duplicate-id', `Task id "${id}" is duplicated.`, { nodeIds: [id] }))
  }

  const edgeCount = plan.tasks.reduce((total, task) => total + task.dependsOn.length, 0)
  if (edgeCount > MAX_PLAN_EDGES) {
    diagnostics.push(diagnostic(
      'error',
      'plan.too-many-edges',
      `The plan has ${String(edgeCount)} dependency edges; the maximum is ${String(MAX_PLAN_EDGES)}.`,
    ))
  }

  for (const role of plan.roles) {
    const provider = providerCapabilities.get(role.transportProvider)
    if (provider === undefined) {
      diagnostics.push(diagnostic(
        'error',
        'provider.transport-unavailable',
        `Transport Provider "${role.transportProvider}" is unavailable.`,
        { nodeIds: [role.roleId] },
      ))
    } else if (role.contextMode === 'fork' && !provider.inheritsParentContext) {
      diagnostics.push(diagnostic(
        'error',
        'provider.context-fork-unsupported',
        `Provider "${provider.name}" does not inherit the parent context requested by role "${role.name}".`,
        { nodeIds: [role.roleId], support: 'unsupported' },
      ))
    } else if (role.contextMode === 'fresh' && provider.inheritsParentContext) {
      diagnostics.push(diagnostic(
        'error',
        'provider.fresh-context-unsupported',
        `Provider "${provider.name}" always inherits parent context and cannot enforce a fresh context.`,
        { nodeIds: [role.roleId], support: 'unsupported' },
      ))
    }
    if (role.llmProvider !== undefined) {
      const route = llmRoutes.get(role.llmProvider)
      if (route === undefined) {
        diagnostics.push(diagnostic(
          'error',
          'provider.llm-unavailable',
          `LLM Provider "${role.llmProvider}" is unavailable.`,
          { nodeIds: [role.roleId] },
        ))
      } else if (role.model !== undefined && !route.models.includes(role.model)) {
        diagnostics.push(diagnostic(
          'warning',
          route.catalogStatus === 'available'
            ? 'provider.model-not-in-advisory-catalog'
            : 'provider.model-catalog-unavailable',
          route.catalogStatus === 'available'
            ? `Model "${role.model}" is not listed in the advisory catalog for "${role.llmProvider}".`
            : `The model catalog for "${role.llmProvider}" is unavailable; model membership is unknown.`,
          { nodeIds: [role.roleId], support: 'advisory' },
        ))
      }
    } else if (role.model !== undefined) {
      diagnostics.push(diagnostic(
        'error',
        'provider.model-without-llm-provider',
        `Role "${role.name}" selects a model without selecting an LLM Provider.`,
        { nodeIds: [role.roleId] },
      ))
    }
    if (role.agentPreset !== undefined && !presets.has(role.agentPreset)) {
      diagnostics.push(diagnostic(
        'error',
        'preset.unavailable',
        `Agent Preset "${role.agentPreset}" is unavailable.`,
        { nodeIds: [role.roleId] },
      ))
    }
    if (role.toolPolicy.mode === 'allowlist') {
      if (capabilities.scopeStatus === 'unavailable') {
        diagnostics.push(diagnostic(
          'error',
          'tool.agent-scope-unavailable',
          'The parent Agent is not live, so its exact tool scope cannot be preflighted.',
          { nodeIds: [role.roleId], support: 'unsupported' },
        ))
      }
      for (const name of role.toolPolicy.tools) {
        if (!tools.has(name)) {
          diagnostics.push(diagnostic(
            'error',
            'tool.unavailable',
            `Tool "${name}" is unavailable.`,
            { nodeIds: [role.roleId] },
          ))
        }
      }
      if (provider !== undefined && !provider.toolFilter) {
        diagnostics.push(diagnostic(
          'error',
          'tool.allowlist-unsupported',
          `Provider "${provider.name}" cannot enforce the tool allowlist.`,
          { nodeIds: [role.roleId], support: 'unsupported' },
        ))
      }
    }
  }

  const dependencyKeys = new Set<string>()
  for (const task of plan.tasks) {
    if (!roles.has(task.roleId)) {
      diagnostics.push(diagnostic(
        'error',
        'task.role-missing',
        `Task "${task.title}" references missing role "${task.roleId}".`,
        { nodeIds: [task.taskId, task.roleId] },
      ))
    }
    for (const dependency of task.dependsOn) {
      if (dependency.taskId === task.taskId) {
        diagnostics.push(diagnostic(
          'error',
          'task.self-dependency',
          `Task "${task.title}" depends on itself.`,
          { nodeIds: [task.taskId] },
        ))
      } else if (!tasks.has(dependency.taskId)) {
        diagnostics.push(diagnostic(
          'error',
          'task.dependency-missing',
          `Task "${task.title}" references missing dependency "${dependency.taskId}".`,
          { nodeIds: [task.taskId, dependency.taskId] },
        ))
      }
      const key = `${task.taskId}\u0000${dependency.taskId}`
      if (dependencyKeys.has(key)) {
        diagnostics.push(diagnostic(
          'error',
          'task.dependency-duplicate',
          `Task "${task.title}" repeats dependency "${dependency.taskId}".`,
          { nodeIds: [task.taskId, dependency.taskId] },
        ))
      }
      dependencyKeys.add(key)
    }
    if (task.approvalRequired) {
      diagnostics.push(diagnostic(
        'error',
        'task.runtime-approval-unsupported',
        `Task "${task.title}" requires a runtime approval checkpoint that the selected adapters cannot enforce yet.`,
        { nodeIds: [task.taskId], support: 'unsupported' },
      ))
    }
    const role = roles.get(task.roleId)
    const provider = role === undefined ? undefined : providerCapabilities.get(role.transportProvider)
    if (task.expectedOutput.schema !== undefined && provider !== undefined && !provider.outputSchema) {
      diagnostics.push(diagnostic(
        'error',
        'task.output-schema-unsupported',
        `Provider "${provider.name}" cannot enforce the output schema for task "${task.title}".`,
        { nodeIds: [task.taskId], support: 'unsupported' },
      ))
    }
  }

  const waves = deriveParallelWaves(plan.tasks)
  const scheduledCount = waves.reduce((total, wave) => total + wave.length, 0)
  if (scheduledCount !== new Set(taskIds).size) {
    const scheduled = new Set(waves.flat())
    diagnostics.push(diagnostic(
      'error',
      'plan.cycle',
      'The task dependency graph contains a cycle and cannot be scheduled.',
      { nodeIds: taskIds.filter(id => !scheduled.has(id)) },
    ))
  }

  for (const wave of waves) {
    for (let leftIndex = 0; leftIndex < wave.length; leftIndex += 1) {
      const leftId = wave[leftIndex]
      const left = leftId === undefined ? undefined : tasks.get(leftId)
      if (left === undefined) continue
      for (let rightIndex = leftIndex + 1; rightIndex < wave.length; rightIndex += 1) {
        const rightId = wave[rightIndex]
        const right = rightId === undefined ? undefined : tasks.get(rightId)
        if (right === undefined) continue
        if (!left.resourceClaims.some(a => right.resourceClaims.some(b => scopesOverlap(a, b)))) continue
        diagnostics.push(diagnostic(
          'error',
          'task.parallel-write-conflict',
          `Parallel tasks "${left.title}" and "${right.title}" have overlapping write scopes.`,
          {
            nodeIds: [left.taskId, right.taskId],
            fixHint: 'Add an ordering dependency or isolate their writable workspaces.',
          },
        ))
      }
    }
  }

  const sinks = plan.tasks.filter(task => !plan.tasks.some(candidate => (
    candidate.dependsOn.some(edge => edge.taskId === task.taskId)
  )))
  if (sinks.length > 1 && plan.tasks.length > 1) {
    diagnostics.push(diagnostic(
      'warning',
      'plan.multiple-unconsumed-results',
      'The plan has multiple terminal outputs and no single synthesis task.',
      {
        nodeIds: sinks.map(task => task.taskId),
        fixHint: 'Add a final synthesis task or explicitly accept multiple independent deliverables.',
      },
    ))
  }

  if (plan.tasks.length > plan.budget.maxAgents) {
    diagnostics.push(diagnostic(
      'error',
      'budget.max-agents-exceeded',
      `The plan needs ${String(plan.tasks.length)} task Agents but maxAgents is ${String(plan.budget.maxAgents)}.`,
      { nodeIds: taskIds, support: 'enforced' },
    ))
  }
  if (plan.budget.maxAgents > capabilities.limits.maxAgents) {
    diagnostics.push(diagnostic(
      'error',
      'budget.host-max-agents-exceeded',
      `maxAgents ${String(plan.budget.maxAgents)} exceeds the Host limit ${String(capabilities.limits.maxAgents)}.`,
      { support: 'enforced' },
    ))
  }
  if (plan.budget.maxConcurrent > capabilities.limits.maxConcurrent) {
    diagnostics.push(diagnostic(
      'error',
      'budget.host-concurrency-exceeded',
      `maxConcurrent ${String(plan.budget.maxConcurrent)} exceeds the Host limit ${String(capabilities.limits.maxConcurrent)}.`,
      { support: 'enforced' },
    ))
  }
  supportDiagnostic(diagnostics, 'max-agents', capabilities.budgetSupport.maxAgents, true)
  supportDiagnostic(diagnostics, 'max-concurrent', capabilities.budgetSupport.maxConcurrent, true)
  supportDiagnostic(diagnostics, 'plan-timeout', capabilities.budgetSupport.planTimeout, true)
  supportDiagnostic(diagnostics, 'requests', capabilities.budgetSupport.requests, plan.budget.maxRequests !== undefined)
  supportDiagnostic(diagnostics, 'tokens', capabilities.budgetSupport.tokens, plan.budget.maxTokens !== undefined)
  supportDiagnostic(diagnostics, 'cost', capabilities.budgetSupport.cost, plan.budget.maxCostUsd !== undefined)

  if (!plan.recommendation.useMultiAgent && plan.tasks.length > 1 && !plan.recommendation.userOverride) {
    diagnostics.push(diagnostic(
      'error',
      'plan.multi-agent-not-recommended',
      'The planner does not recommend multi-Agent execution and no user override was recorded.',
    ))
  } else if (!plan.recommendation.useMultiAgent && plan.recommendation.userOverride) {
    diagnostics.push(diagnostic(
      'warning',
      'plan.multi-agent-user-override',
      'Multi-Agent execution is a user override rather than the planner recommendation.',
    ))
  }
  if (plan.recommendation.useMultiAgent && plan.recommendation.singleAgentAlternative === undefined) {
    diagnostics.push(diagnostic(
      'warning',
      'plan.single-agent-alternative-missing',
      'The plan does not describe a single-Agent alternative for comparison.',
    ))
  }
  if (plan.tasks.length > 1 && !waves.some(wave => wave.length > 1)) {
    diagnostics.push(diagnostic(
      'warning',
      'plan.no-parallelism',
      'The plan has multiple Agents but no tasks can execute in parallel.',
      { fixHint: 'Use a single Agent unless the sequential specialization has a clear quality benefit.' },
    ))
  }

  if (backend === 'workflow') {
    if (!capabilities.adapters.workflow) {
      diagnostics.push(diagnostic('error', 'backend.workflow-unavailable', 'The Workflow adapter is unavailable.'))
    }
    if (plan.pattern === 'peer-team') {
      diagnostics.push(diagnostic(
        'error',
        'backend.peer-team-requires-agent-team',
        'The peer-team pattern requires the experimental Agent Team adapter.',
      ))
    }
    const transports = new Set(plan.roles.map(role => role.transportProvider))
    if (transports.size > 1) {
      diagnostics.push(diagnostic(
        'error',
        'backend.workflow-mixed-transports',
        'One Workflow execution cannot enforce different transport Providers per role.',
        { nodeIds: roleIds, support: 'unsupported' },
      ))
    }
    for (const role of plan.roles) {
      const provider = providerCapabilities.get(role.transportProvider)
      if (role.llmProvider !== undefined || role.model !== undefined) {
        const support = provider?.modelRouting ?? 'unsupported'
        diagnostics.push(diagnostic(
          support === 'enforced' ? 'info' : support === 'advisory' ? 'warning' : 'error',
          `backend.workflow-model-routing-${support}`,
          support === 'enforced'
            ? `The model route for role "${role.name}" can be enforced.`
            : support === 'advisory'
              ? `The model route for role "${role.name}" is advisory for this transport.`
              : `The transport for role "${role.name}" cannot enforce the requested model route.`,
          { nodeIds: [role.roleId], support },
        ))
      }
      if (role.agentPreset !== undefined) {
        diagnostics.push(diagnostic(
          'error',
          'backend.workflow-preset-unsupported',
          `Workflow cannot apply Agent Preset "${role.agentPreset}" to role "${role.name}".`,
          { nodeIds: [role.roleId], support: 'unsupported' },
        ))
      }
      if (role.toolPolicy.mode === 'allowlist') {
        diagnostics.push(diagnostic(
          'error',
          'backend.workflow-tool-policy-unsupported',
          `Workflow cannot apply a per-node tool allowlist to role "${role.name}".`,
          { nodeIds: [role.roleId], support: 'unsupported' },
        ))
      }
    }
  } else {
    if (!capabilities.adapters.agentTeam || !capabilities.experimentalAgentTeam) {
      diagnostics.push(diagnostic(
        'error',
        'backend.agent-team-unavailable',
        'The experimental Agent Team adapter is unavailable or disabled.',
      ))
    }
    for (const role of plan.roles) {
      if (
        role.llmProvider !== undefined
        || role.model !== undefined
        || role.agentPreset !== undefined
        || role.toolPolicy.mode !== 'inherit'
      ) {
        diagnostics.push(diagnostic(
          'error',
          'backend.agent-team-role-composition-unsupported',
          `Agent Teams cannot enforce the model, Preset, or tool composition requested by role "${role.name}".`,
          { nodeIds: [role.roleId], support: 'unsupported' },
        ))
      }
    }
  }

  return {
    planId: plan.planId,
    revision: plan.revision,
    capabilityDigest: capabilities.digest,
    resolvedBackend: backend,
    valid: !diagnostics.some(item => item.severity === 'error'),
    diagnostics,
    parallelWaves: waves.map(wave => [...wave]),
  }
}
