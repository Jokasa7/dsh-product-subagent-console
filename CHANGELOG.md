# Changelog

All notable user-visible changes are documented here.

## [0.4.0-alpha.1] - 2026-08-22

### Added

- An Agent Planner that creates editable roles, tasks, dependencies, Providers, tools, and budgets from a goal.
- Save, preflight, warning review, approval, and locked plan revisions.
- Workflow execution for approved plans and cancellation for active executions.
- A Compare view that places planned tasks beside their actual attempts, status, timing, and child sessions.
- English and Simplified Chinese interfaces and guides for Runtime, Plan, and Compare.

### Changed

- The Subagents workbench now uses three dedicated modes: Runtime, Plan, and Compare.
- Runtime handling now settles interrupted or unresponsive executions without leaving them active indefinitely.

## [0.1.0-alpha.2] - 2026-08-22

### Added

- A Subagents tab for DeepSeek Harness conversations.
- A draggable branch canvas for native child sessions and compatible Provider runs.
- Task, Agent, status, duration, and lifecycle details.
- Direct navigation to native child conversations.
- English and Simplified Chinese interfaces and user guides.

### Compatibility

- DeepSeek Harness `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.

[0.4.0-alpha.1]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.4.0-alpha.1
[0.1.0-alpha.2]: https://github.com/Jokasa7/dsh-product-subagent-console/releases/tag/v0.1.0-alpha.2
