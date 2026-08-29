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
7. Select **Review execution request**, read the impact notice, then select **Confirm and send execution request**. The request is posted visibly to the current conversation and is bound to that exact approved revision.
8. Follow the run in **Live** and inspect its plan-to-runtime evidence in **Deviation**.

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

Editing a draft invalidates its previous preflight result. Run preflight again before approval. If the DSH capability set changes after approval, the approved revision is never rewritten in place: create a new revision from its approved content, save it, rerun preflight, approve that new revision, and only then request execution.

## From approval to authoritative execution

Approval and execution are separate decisions. The execution flow issues a short-lived, single-use grant only after the second confirmation. The Host rechecks the Session, plan revision, approval state, capability digest, and preflight result before starting Workflow. A duplicate active start for the same revision is rejected.

**Deviation** shows the approved contract beside the attempts created for that execution. Select a plan task, attempt, or execution node to inspect its status, role, timing, dependencies, child-session identity, verifier receipts, and conformance findings. Use **Recovery** to preview the effect of stopping or reworking the run; whole-run cancellation uses its own two-step grant.

Plan and execution snapshots are persisted with the bounded Foundry journal by default. After a restart, incomplete work is recovered as `unknown` rather than guessed as successful. See [Data and Privacy](data-and-privacy.md) for storage controls.

## Current execution support

- Approved plans execute through DSH Workflow.
- One Workflow execution currently uses one transport Provider across its roles.
- Role tool policies must inherit the Provider defaults. Role-level allowlists and Agent Presets are not currently executable.
- Task approval points and task-level token or cost hints are not currently executable.
- Output schemas are available only when the selected Provider reports support.
- Plan-level Agent count, concurrency, and timeout are enforced. Request and token limits may be advisory; cost limits are not currently enforceable.
- Agent Teams is not currently an executable backend.
- Retry and Fork are non-executing recovery proposals in v0.9, and task-level cancellation cannot be sent; only whole-run Workflow cancellation can be sent.
- Historical Recipe evidence never bypasses current capability and permission preflight.

For setup or execution errors, see [Troubleshooting](troubleshooting.md).
