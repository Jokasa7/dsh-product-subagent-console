# Changelog

All notable user-visible changes are documented here.

## [0.9.0] - 2026-08-28

### Added

- Four connected Subagents modes: Live, Plan, Deviation, and Recovery.
- An event-backed Execution Twin with a historical timeline, Evidence Passport, verifier receipts, conformance findings, and first-divergence detection.
- Structured **Ask this run** queries that attach bounded Session, run, task, cursor, event, and receipt references to the current conversation.
- A two-step execution confirmation and a separate two-step whole-run cancellation grant bound to the exact live facts.
- Redacted offline Run Capsules with integrity checks, closed evidence references, deterministic size limits, and no network dependency.
- Evidence-gated Recipe candidates from at least three comparable verifier-passing runs, draft instantiation with current-environment preflight, and a single ZIP export containing `recipe.json`, `SKILL.md`, and checksums.
- A conservative single-Agent versus multi-Agent advisor that refuses to make a performance claim when evidence is insufficient.
- Optional offline OTLP JSON preview, disabled by default.
- Bounded local Foundry persistence with hash-chain verification, restart reconciliation, corruption quarantine, and visible degraded storage state.

### Changed

- Approved plan execution now requires an explicit review and confirmation and rejects stale capabilities or duplicate active starts.
- Recovery shows affected, completed-and-reusable, and blocked tasks before control; Retry and Fork remain non-executing proposals, and task-level cancellation is unavailable.
- Hidden Foundry views abort stale operations and disable control until current facts have reloaded.
- Plans, executions, events, receipts, findings, control outcomes, Recipes, and Capsules use stricter versioned schemas and bounded inputs.

### Compatibility

- DeepSeek Harness `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.

## [0.4.0-alpha.2] - 2026-08-23

### Changed

- Manual plans now use an available configured Provider and stop with a clear setup message when none is available.
- Preflight evaluates current Provider capabilities, validates output schemas and write scopes, identifies each warning independently, and blocks settings the Workflow adapter cannot enforce.
- Approved revisions reject duplicate starts and remain valid while their visible execution request waits in the conversation.
- Switching modes preserves the current draft while pausing hidden background activity; switching conversations starts with clean local state.
- Large task trees keep running Agents visible, stay responsive, and avoid unnecessary canvas rearrangement on status or text updates.
- Interrupted or unresponsive plugin-owned delegation and Workflow attempts settle as `unknown` when success cannot be established.

### Compatibility

- DeepSeek Harness `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.

## [0.4.0-alpha.1] - 2026-08-22

### Added

- An Agent Planner that creates editable roles, tasks, dependencies, Providers, tools, and budgets from a goal.
- Save, preflight, warning review, approval, and locked plan revisions.
- Workflow execution for approved plans and cancellation for active executions.
- A Compare view that places planned tasks beside their actual attempts, status, timing, and child sessions.
- English and Simplified Chinese interfaces and guides for Runtime, Plan, and Compare.

### Changed

- The Subagents workbench now uses three dedicated modes: Runtime, Plan, and Compare.
- Plugin-owned runtime handling settles interrupted or unresponsive attempts without leaving them active indefinitely; unconfirmed outcomes are recorded as `unknown`.

### Compatibility

- DeepSeek Harness `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.

[0.9.0]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.9.0
[0.4.0-alpha.2]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.4.0-alpha.1
