# Getting Started

[简体中文](getting-started.zh.md)

## Requirements

- DeepSeek Harness Web or Desktop profile `0.1.1-rc.2`
- Node.js `^22.19.0` or `>=24.0.0`
- A configured compatible subagent Provider
- A matching Provider Bundle when using Codex, Claude Code, or another external coding Agent

## Install the release package

Download `dsh-product-subagent-console-0.9.0.tgz` and `SHA256SUMS.txt` from the same GitHub Release.

```sh
sha256sum --check SHA256SUMS.txt

# DSH Desktop — use Open DSH Terminal
dsh plugin add ./dsh-product-subagent-console-0.9.0.tgz

# Web profile
dsh plugin --profile web add ./dsh-product-subagent-console-0.9.0.tgz
```

On Windows PowerShell, the archive can also be checked with:

```powershell
Get-FileHash .\dsh-product-subagent-console-0.9.0.tgz -Algorithm SHA256
```

`dsh` is normally available inside **Open DSH Terminal**. If you are testing from a source checkout in ordinary PowerShell, call the repository-local CLI and name the profile explicitly:

```powershell
pnpm exec dsh plugin --profile desktop add --save-exact --ignore-scripts `
  ".\release\dsh-product-subagent-console-0.9.0.tgz"
```

Restart the selected profile after installation. The plugin should appear in the startup plugin list and add **Subagents** to each conversation.

## Enable the Planner tool

Copy an Agent Preset, add the bundle entry below, save it, and create a new conversation with that preset:

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

Existing conversations retain the preset revision with which they were created.

## First safe test

Use a disposable workspace and ask the Agent:

> Create a read-only three-task plan. Task A reads only the first paragraph of README.md. Task B reads only the `name` and `version` fields from package.json. Run A and B in parallel. Task C returns a three-line summary using only those results. Create the draft only; do not execute it.

Then verify:

1. **Plan** shows two parallel tasks feeding one synthesis task.
2. Preflight identifies the actual Provider and current tool/capability support.
3. Saving creates a numbered draft revision; approval targets only that exact revision.
4. **Request execution** first shows a review step and then sends one visible execution request to the current conversation.
5. **Live** shows only child relationships published by DSH or a compatible Provider lifecycle.
6. **Deviation** shows the exact plan-to-attempt binding and Evidence Passport after the run.
7. Moving the timeline slider pauses historical inspection; **Return live** restores the latest cursor.
8. **Recovery** displays an impact preview. A completed run cannot be cancelled.

Add a required lifecycle verifier to the final synthesis task before approval. After each execution fully settles, run that same approved revision again until it has three successful, conformance-confirmed executions with authoritative passing receipts. Selecting those three runs and choosing **Check historical runs** should expose the permission status and allow a new objective to create a fresh draft plus current preflight. Regenerating a slightly different plan does not count as the same Recipe contract.

## Next steps

- Follow the [Product Tour](product-tour.md).
- Learn plan fields and safety gates in [Agent Planner](agent-planner.md).
- Learn evidence, recovery, Capsule, and Recipe flows in [Agent Foundry](agent-foundry.md).
- Review local persistence and exports in [Data and Privacy](data-and-privacy.md).
- Use [Troubleshooting](troubleshooting.md) if the tab, Provider, preflight, or fact stream is unavailable.
