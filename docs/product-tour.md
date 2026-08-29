# Complete Product Tour

English · [简体中文](product-tour.zh.md)

This tour follows one bounded multi-Agent job from design to reusable evidence. Everything stays inside the **Subagents** tab of the current DeepSeek Harness conversation.

The screenshots below come from the Simplified Chinese DSH locale; the plugin follows the active interface language.

## 1. Turn a goal into a reviewable plan

Open **Plan**, describe the result, and generate a draft. The canvas exposes roles, responsibilities, tasks, dependencies, Providers, tools, verifier contracts, and the shared budget before any child Agent starts.

![An editable Agent plan with task dependencies](assets/agent-plan-zh.jpg)

Select a task to tighten its brief, completion criteria, resource claims, effect type, and required verifiers. Save the exact revision and run preflight. Blocking capability, dependency, concurrency, or budget issues must be fixed before approval.

Approval locks that revision and its capability digest. Starting the run is a separate, visible confirmation.

## 2. Follow authoritative delegation in Live

**Live** shows native child sessions and compatible Provider runs under their real parent. Each card summarizes the current responsibility and lifecycle; selecting it opens the detailed facts and native child-session action when available.

![The live parent-child task canvas](assets/agent-runtime-zh.jpg)

Drag cards, pan, zoom, fit, or auto-arrange the canvas without changing execution. The view keeps active work easy to find even when a run has many branches.

## 3. Reconstruct what actually happened

Open **Deviation** after execution begins. The Execution Twin maps approved plan tasks to actual attempts and preserves missing, unexpected, retried, cancelled, and completed work as separate facts.

![Planned tasks mapped to actual attempts](assets/agent-compare-zh.jpg)

The timeline cursor can pause the view at an earlier event. While paused, the graph, selected node, Evidence Passport, and conformance findings are all reconstructed at that cursor instead of silently mixing in newer facts.

The Evidence Passport separates four questions:

- What did the approved plan require?
- What Provider, model, attempt, and lifecycle did DSH actually report?
- Which authoritative verifier receipts support the result?
- What is the first provable divergence, if one exists?

## 4. Ask the run, with evidence attached

Choose a factual query such as **Why it is running**, **First divergence**, **Recorded configuration**, **Cancel impact**, or **Evidence**. Add your own question and send it to the current conversation. Configuration facts come only from authoritative DSH events or route fields actually applied by the Workflow adapter; unavailable fields remain unknown.

The plugin supplies a bounded fact packet with the exact Session, run, task, event cursor, event IDs, and receipt IDs. It does not ask the model to invent hidden progress or internal Agent state.

## 5. Preview recovery before control

**Recovery** classifies tasks that are affected, reusable, or blocked and proposes Retry or Fork. These proposals never execute automatically in v0.9.

Whole-run cancellation is the only live control currently exposed. It requires two explicit clicks, a short-lived grant bound to the current run and event cursor, and a final result recorded in the event ledger. If the run changes, the page is historical, the grant expires, or the host restarts, the request fails closed.

![Recovery impact preview with reusable tasks and guarded controls](assets/agent-recovery-zh.jpg)

## 6. Carry evidence forward safely

- **Run Capsule** downloads a bounded, redacted offline HTML report. Review it before sharing; objectives and task briefs are excluded unless explicitly requested by an API caller.
- **Recipe** requires at least three exactly comparable, verifier-passing runs. A candidate records the plan contract, Provider requirements, permission uncertainty, verifier suite, and budget envelope, then exports as one reviewable ZIP.
- **Create draft** binds only the new objective, runs current-environment preflight, and opens Plan. It never approves or executes automatically.
- **Single vs multi-Agent advisor** makes no recommendation unless both groups have enough comparable, verified runs.
- **OTLP JSON preview** is offline and disabled by default; no network exporter is enabled by this plugin.

## A safe end-to-end test

Start a new conversation with the planner tool enabled and enter:

> Design a read-only three-task plan for this workspace. Task A reads only the first paragraph of README.md. Task B reads only the name and version fields from package.json. Run A and B in parallel. Task C uses only those two results to return a three-line summary. Each task must stop immediately after obtaining its requested result. Create the draft only; do not execute it.

Then:

1. Review task boundaries and context dependencies in **Plan**.
2. Save, preflight, and approve the exact revision.
3. Confirm the separate execution request.
4. Watch the real branches in **Live**.
5. Pause the cursor in **Deviation** and inspect a task's Evidence Passport.
6. Ask for the first divergence or evidence in the current conversation.
7. Open **Recovery** and review the impact preview without sending control.
8. Export a Capsule and inspect the local file before sharing it.

Installation and preset setup are in [Getting Started](getting-started.md). Field definitions and current execution boundaries are in [Agent Planner](agent-planner.md); Foundry evidence semantics are in [Agent Foundry](agent-foundry.md).
