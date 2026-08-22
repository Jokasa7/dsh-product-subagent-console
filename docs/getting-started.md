# Getting Started

English · [简体中文](getting-started.zh.md)

This guide installs DSH Product Subagent Console and enables its Runtime, Plan, and Compare views in a DeepSeek Harness conversation.

## Requirements

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `^22.19.0` or `>=24.0.0`
- A working DSH Web profile

Install a compatible Provider Bundle only when a delegated task or plan uses that external coding Agent.

## Install

Download the `.tgz` archive and `SHA256SUMS.txt` from the matching [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases).

Verify and install the archive:

```sh
sha256sum --check SHA256SUMS.txt
dsh plugin --profile web add ./dsh-product-subagent-console-0.4.0-alpha.1.tgz
dsh --profile web --dump-config
```

The configuration output should contain `product-subagent-console`. Restart the Web profile after installation.

On Windows PowerShell, compare the following result with `SHA256SUMS.txt`:

```powershell
Get-FileHash .\dsh-product-subagent-console-0.4.0-alpha.1.tgz -Algorithm SHA256
```

## Add an external Provider

Keep every Provider on the same supported DSH version family. For example:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.1.1-rc.2
dsh plugin --profile web add @deepseek-ai/dsh-subagent-claude-code@0.1.1-rc.2
```

Complete that Provider's normal authentication and configuration, then restart the Web profile. Installing this console does not install or authenticate an external coding Agent.

## Configure an Agent Preset

Open **Settings → Agent Presets**, copy a preset, and add only the tools you need.

### Observe regular delegated tasks

Enable the official delegation tool for the selected Provider. Tasks started through compatible DSH delegation appear in **Subagents → Runtime**.

### Design and execute plans

Add the plugin's planner tool:

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

Save the preset and create a new conversation with it. Existing conversations keep the preset version with which they were created.

## Use the workbench

The **Subagents** tab has three modes:

- **Runtime** shows current and completed delegated runs. Pan, zoom, rearrange cards, select a card for details, or open a native child conversation.
- **Plan** generates or manually creates an Agent plan. Edit the draft, save it, run preflight, review warnings, and approve the exact revision you want to run.
- **Compare** starts an approved plan and shows each planned task beside its actual attempt. You can inspect status and timing or request cancellation while the execution is active.

Plans and execution history are temporary for the current Host run. See [Agent Planner](agent-planner.md) for the complete plan workflow.

## Update

Download and verify the new Release archive, stop the Web profile, install the new archive with `dsh plugin --profile web add`, and restart the profile. Update the console and DSH packages together whenever the compatibility version changes.

## Uninstall

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

Restart the Web profile after removal.

For common setup and execution problems, see [Troubleshooting](troubleshooting.md).
