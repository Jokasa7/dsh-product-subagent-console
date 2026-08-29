# Agent Foundry

[简体中文](agent-foundry.zh.md)

Agent Foundry turns an approved plan and its authoritative DSH lifecycle into an evidence-backed execution view. Open it from **Subagents → Deviation** or **Subagents → Recovery**.

## Execution Twin

The canvas keeps planned tasks and actual attempts visibly separate. A connector appears only when an execution snapshot contains an exact `planId`, revision, task, and attempt binding. Selecting a node opens its Evidence Passport with:

- lifecycle and conformance state;
- planned role, effect contract, and dependencies;
- actual attempt, recorded Provider/model configuration when available, and timing;
- verifier receipts and the events that support them;
- open findings and the first provable divergence;
- stable run, plan, cursor, and projection identifiers.

## Time travel

Move the **Run timeline** slider to reconstruct the run at an earlier event cursor. While paused:

- new live events do not move the selected cursor;
- the canvas, receipts, findings, and Ask request use that exact cursor;
- Capsule, telemetry, and recovery actions are disabled because they require current facts.

Choose **Return live** to resume the latest cursor.

## Ask this run

Select a factual query type, optionally select a task or attempt, and enter a question. When you choose **Send to current conversation**, the plugin sends a bounded, allowlisted fact packet to that conversation and therefore to its configured model Provider. It does not attach the raw conversation transcript, raw model output, stderr, environment variables, or hidden reasoning.

Available query types cover summary, why-running, first divergence, active tasks, recorded configuration, cancel impact, recovery impact, and evidence. Configuration facts come only from authoritative DSH events or transport, model-route, and tool-policy fields actually applied and recorded with `adapter` authority by the Workflow adapter. Planned fields are never presented as runtime observations, and unavailable fields remain unknown.

## Recovery preview

Recovery shows affected tasks, reusable completed-and-verified tasks, blockers, and Retry or Fork proposals derived from the current conformance report. These proposals never execute automatically in DSH `0.1.1-rc.2`.

Whole-run cancel is available only for a current nonterminal Workflow execution. It requires two visible confirmations and then a short-lived, single-use Host grant tied to the exact Session, run, proposal, plan revision, capability digest, and event cursor. A newer run event invalidates the grant.

The loopback Web Client is part of the trusted local DSH profile. The current public DSH connection API does not expose an authenticated caller Session to plugin RPC handlers, so the grant protects against stale or accidental operations rather than a malicious installed local plugin.

## Run Capsule

**Export Run Capsule** creates a self-contained offline HTML viewer and manifest. Identifiers are pseudonymized, content is allowlisted, evidence references are closed, and large runs are deterministically bounded. By default the Capsule excludes objectives and task briefs; always inspect an export before sharing it.

The manifest includes its own digest, source/exported counts, redaction policy, plan contract, execution projection, conformance findings, recovery preview, bounded events, and verifier receipts.

## Recipe candidates

Select at least three runs and choose **Check historical runs**. A candidate is created only when all selected runs:

- use one comparable canonical plan contract;
- use the same capability digest and verifier suite;
- finish successfully with conformance state `confirmed`;
- have no open blocking conformance findings;
- pass every required verifier with a non-model authoritative receipt whose evidence events belong to that run.

The candidate records the plan template, permission profile, budget envelope, capability requirements, and source-run digests. Historical tool enforcement is never inferred: inherited permissions remain unresolved, and explicit allowlists remain “not attested” until the new draft is checked in the current environment.

Enter a new objective and choose **Create draft, preflight, and open Plan**. This creates a new draft and current preflight only. It never approves or executes the plan. Exporting a candidate downloads one ZIP containing `recipe.json`, `SKILL.md`, and `checksums.json`; it does not install them. One archive keeps the three reviewed files together even when the browser blocks automatic multi-file downloads.

## Single-Agent versus multi-Agent advisor

The advisor classifies a run from its actual materialized task Agents, never from the plan's pattern label. It requires at least three verified single-Agent runs and three verified multi-Agent runs with the same terminal workload semantics, execution configuration, capability digest, and verifier suite. It compares median duration only after those gates pass. A direction is shown only when one median is at least 10% lower; otherwise the result is `no-claim`. Missing or non-comparable evidence always produces an insufficient-evidence result.

## Telemetry preview

OTLP JSON export is disabled by default. When explicitly enabled in plugin configuration, it creates a bounded offline JSON preview only; the plugin does not configure or contact a telemetry backend.

See [Data and Privacy](data-and-privacy.md) for storage, redaction, and cleanup details.
