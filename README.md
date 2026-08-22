# DSH Product Subagent Console

English · [简体中文](README.zh.md)

[![CI](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml/badge.svg)](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jokasa7/dsh-product-subagent-console?include_prereleases)](https://github.com/Jokasa7/dsh-product-subagent-console/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Plan, run, and inspect multi-Agent work without leaving a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation.

> Requires DSH `0.1.1-rc.2`. This is an independent community plugin.

![DSH Product Subagent Console](docs/assets/subagent-canvas-live.jpg)

## Highlights

- **Runtime** — follow native child sessions and compatible Provider runs on a draggable branch canvas.
- **Plan** — turn a goal into editable roles, tasks, dependencies, parallel waves, Providers, tools, and budgets.
- **Compare** — match approved plan tasks with their actual Workflow attempts, status, timing, and child sessions.
- Review details from any card, fit or rearrange the canvas, and open native child conversations directly.
- Use the full interface in English or Simplified Chinese.

## Install

Download the `.tgz` file and `SHA256SUMS.txt` from the matching [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases), verify the archive, then add it to the Web profile:

```sh
sha256sum --check SHA256SUMS.txt
dsh plugin --profile web add ./dsh-product-subagent-console-0.4.0-alpha.1.tgz
dsh --profile web --dump-config
```

Restart the Web profile after installation.

## Enable Agent Planner

Add the planner tool to a copied **Agent Preset**, save it, and create a new conversation with that preset:

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

Preset changes apply to new conversations only. Regular delegated runs remain visible in **Runtime** even when the planner tool is not enabled.

## Use

1. Open **Subagents → Plan**, enter a goal, and generate or create a draft.
2. Edit the canvas and settings, save the revision, then run preflight.
3. Resolve blocking issues, review any warnings, and approve the revision.
4. Open **Compare**, request execution, and follow each planned task against its actual run.

See [Agent Planner](docs/agent-planner.md) for the complete workflow and field guide.

## Compatibility

- DeepSeek Harness Web profile `0.1.1-rc.2`
- Node.js `^22.19.0` or `>=24.0.0`
- Compatible Provider Bundles for any external coding Agents used by a plan or delegated task

Keep the plugin and all DSH packages on the same supported version family.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Agent Planner](docs/agent-planner.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## Uninstall

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

Restart the Web profile after removal.

## Support

Use [GitHub Issues](https://github.com/Jokasa7/dsh-product-subagent-console/issues) for reproducible bugs and feature requests. Report security issues through the private channel described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
