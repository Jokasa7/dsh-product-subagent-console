# Changelog

All notable user-visible changes are documented here.

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

[0.4.0-alpha.2]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.4.0-alpha.1
