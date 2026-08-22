# Agent Planner

English · [简体中文](agent-planner.zh.md)

Agent Planner turns a goal into a reviewable execution plan, then keeps that plan beside the runs it produces.

Use it when work has independent branches, specialist roles, or clear dependencies. A simple task can remain a single-Agent plan.

## Enable the planner

Add the planner tool to a copied **Agent Preset**:

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

Save the preset and create a new conversation with it.

## From goal to execution

1. Open **Subagents → Plan** and enter the result you want.
2. Select **Generate plan**. The current conversation creates a draft; no child Agent starts at this stage. You can also start with a manual draft.
3. Select cards on the canvas and refine the plan in the editor.
4. Save the draft and run preflight.
5. Resolve blocking issues and explicitly accept any warnings you are comfortable with.
6. Approve the revision. Approved content is locked; create a new revision when further edits are needed.
7. Open **Compare**, select the approved plan, and request execution.

## What you can edit

- **Plan** — objective, success criteria, collaboration pattern, optimization target, backend, and overall budget.
- **Roles** — responsibilities, boundaries, transport Provider, model route, Agent Preset, context mode, and allowed tools.
- **Tasks** — brief, assigned role, risk, expected output, completion criteria, resources, budget hints, and approval requirement.
- **Dependencies** — order-only edges control scheduling; context edges also pass the upstream result to the dependent task.

Resource claims are relative identifiers such as `frontend/auth` or `docs/readme`. Preflight uses them to warn when parallel tasks may touch the same resource.

## Preflight

Preflight checks the exact saved revision against the current DSH profile. It reports:

- invalid or cyclic task dependencies;
- resolved parallel waves and concurrency limits;
- unavailable Providers, model routes, Agent Presets, or tools;
- unsupported execution backends or capabilities;
- budget and possible parallel-resource conflicts.

Editing a draft invalidates its previous preflight result. Run preflight again before approval. If the DSH capability set changes after approval, preflight must also be repeated before execution.

## Compare planned and actual work

The **Compare** view shows the approved plan and the attempts created for that execution. Select a plan task, attempt, or execution node to inspect its status, role, timing, dependencies, and child-session identity.

While an execution is queued or running, **Cancel execution** requests cancellation. The final state appears when DSH reports the execution as settled.

## Current execution support

- Approved plans execute through DSH Workflow.
- One Workflow execution currently uses one transport Provider across its roles.
- Agent Teams is not currently an executable backend.
- Request, token, and cost limits may be enforced, advisory, or unavailable depending on the active Provider. Preflight shows the available support.
- Plans and execution history are held for the current Host run and are cleared when that Host restarts.

For setup or execution errors, see [Troubleshooting](troubleshooting.md).
